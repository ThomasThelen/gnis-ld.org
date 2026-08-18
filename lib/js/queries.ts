import {prefixes, $, el, safeUri, shortLabel, termLabel, postSparql, SelectResults, SparqlBinding, SparqlTerm} from './shared/sparql';

const EXAMPLES: Record<string, string> = {
	california: prefixes('rdf', 'rdfs', 'gnis', 'gnisf-alias') +
`SELECT ?feature ?label ?type WHERE {
  ?feature gnis:state gnisf-alias:California .
  ?feature rdfs:label ?label .
  ?feature rdf:type ?type .
} LIMIT 500`,
	rainier: prefixes('gnis') +
`SELECT ?feature ?predicate ?value WHERE {
  ?feature gnis:alternativeName "Mount Tacoma"@en .
  ?feature ?predicate ?value .
} LIMIT 100`,
	juneau: prefixes('rdf', 'rdfs', 'gnis', 'gnisf-alias') +
`SELECT ?feature ?label ?type WHERE {
  ?feature gnis:county gnisf-alias:Alaska.Juneau .
  ?feature rdfs:label ?label .
  ?feature rdf:type ?type .
} LIMIT 100`,
	waterfalls: prefixes('rdf', 'usgs', 'gnis') +
`SELECT ?feature ?name WHERE {
  ?feature rdf:type usgs:Waterfall .
  ?feature gnis:officialName ?name .
} LIMIT 100`,
	reservoirs: prefixes('rdf', 'usgs', 'gnis') +
`SELECT ?reservoir ?name ?citation WHERE {
  ?reservoir rdf:type usgs:Reservoir .
  ?reservoir gnis:officialName ?name .
  ?reservoir gnis:citation ?citation .
} LIMIT 100`,
};

const MAX_GRAPH_NODES = 300;
const MAX_TABLE_ROWS = 500;
const MAX_CATEGORIES = 14;
const MARK_HUE = '#2f80c3';

const SVG_NS = 'http://www.w3.org/2000/svg';

type QueryResult =
	| { kind: 'select'; json: SelectResults; body: string }
	| { kind: 'raw'; body: string };

type ViewName = 'graph' | 'types' | 'bubbles';

interface Sim { alpha: number; stop: boolean; running: boolean }

interface Cat { label: string; count: number }

interface Aggregate { catVar: string; subjVar: string; cats: Cat[] }

let lastResult: QueryResult | null = null;
let dirty: Record<ViewName, boolean> = {graph: false, types: false, bubbles: false};
let sim: Sim | null = null;   // running graph simulation, stopped when the graph rerenders
let runSeq = 0;   // request token
let blobUrl: string | null = null;

// ---------- small helpers ----------

/**
 * Creates an SVG element.
 *
 * @param tag - SVG tag name.
 * @param attrs - Attributes to set on the element.
 * @returns The new element, cast to T.
 */
function svgEl<T extends SVGElement = SVGElement>(
	tag: string,
	attrs?: Record<string, string | number>
): T {
	const node = document.createElementNS(SVG_NS, tag);
	for (const k in (attrs || {})) node.setAttribute(k, String((attrs as Record<string, string | number>)[k]));
	return node as T;
}

/**
 * Replaces a pane's content with an empty-state message.
 *
 * @param pane - Pane to clear.
 * @param message - Message to show.
 */
function emptyState(pane: HTMLElement, message: string): void {
	pane.innerHTML = '';
	pane.appendChild(el('div', {class: 'empty-state'}, message));
}

/**
 * Returns the name of the currently active view tab.
 *
 * @returns The active view, defaulting to the graph.
 */
function activeView(): ViewName {
	const tab = document.querySelector<HTMLElement>('.view-tab.active');
	return (tab?.dataset.view as ViewName) || 'graph';
}

/**
 * Marks every view stale and renders only the visible pane; the others
 * render lazily on tab activation.
 */
function markDirtyAndRender() {
	dirty = {graph: true, types: true, bubbles: true};
	renderView(activeView());
	renderTable();
}

/**
 * Renders a view if it is stale.
 *
 * @param view - View to render.
 */
function renderView(view: ViewName): void {
	if (!lastResult || !dirty[view]) return;
	dirty[view] = false;
	if (view === 'graph') renderGraph();
	else if (view === 'types') renderTypes();
	else renderBubbles();
}

/**
 * Sends the query in the editor to the endpoint and renders the response.
 */
function runQuery() {
	const query = $<HTMLTextAreaElement>('.query-input').value;
	const status = $('#query-status');
	const btn = $<HTMLButtonElement>('#run-btn');
	const seq = ++runSeq;
	btn.disabled = true;
	status.textContent = 'Running…';
	status.classList.remove('error');
	const t0 = performance.now();

	postSparql(query, 'application/sparql-results+json, text/turtle;q=0.9, */*;q=0.5')
	.then(({body}) => {
		if (seq !== runSeq) return;
		const ms = Math.round(performance.now() - t0);

		let json: SelectResults & { boolean?: boolean } | null = null;
		try {
			json = JSON.parse(body);
		}
		catch (e) { }

		if (json && json.head && json.results) {
			lastResult = {kind: 'select', json, body};
			const n = json.results.bindings.length;
			status.textContent = n + ' result' + (n === 1 ? '' : 's') + ' · ' + ms + ' ms';
		}
		else if (json && typeof json.boolean === 'boolean') {
			lastResult = {kind: 'raw', body};
			status.textContent = 'ASK → ' + json.boolean + ' · ' + ms + ' ms';
		}
		else {
			lastResult = {kind: 'raw', body};
			status.textContent = 'Non-tabular response · ' + ms + ' ms';
		}
		markDirtyAndRender();
	})
	.catch((err) => {
		if (seq !== runSeq) return;
		status.textContent = err.message;
		status.classList.add('error');
	})
	.then(() => {
		if (seq === runSeq) btn.disabled = false;
	});
}

/**
 * Finds a categorical breakdown of a result set: a subject variable and a
 * low-cardinality URI variable to group it by.
 *
 * @param json - SELECT result set.
 * @returns The chosen variables and per-category subject counts, or null
 * when no categorical variable exists.
 */
function aggregate(json: SelectResults): Aggregate | null {
	const vars = json.head.vars;
	const rows = json.results.bindings;
	if (!rows.length) return null;

	const subjVar = vars.find((v) => rows.some((r) => r[v]?.type === 'uri'));
	if (!subjVar) return null;

	let catVar: string | null = null;
	if (vars.includes('type') && 'type' !== subjVar) {
		catVar = 'type';
	}
	else {
		let best = Infinity;
		for (const v of vars) {
			if (v === subjVar) continue;
			const values = new Set<string>();
			let allUri = true;
			for (const r of rows) {
				const term = r[v];
				if (!term) continue;
				if (term.type !== 'uri') { allUri = false; break; }
				values.add(term.value);
			}
			if (allUri && values.size >= 2 && values.size <= 60 && values.size < best) {
				best = values.size;
				catVar = v;
			}
		}
	}
	if (!catVar) return null;

	const counts = new Map<string, Set<string>>(); // category label -> Set of subjects
	for (const r of rows) {
		const cterm = r[catVar];
		const sterm = r[subjVar];
		if (!cterm || !sterm) continue;
		const label = shortLabel(cterm.value);
		if (!counts.has(label)) counts.set(label, new Set());
		counts.get(label)!.add(sterm.value);
	}

	let cats = Array.from(counts.entries())
		.map(([label, subjects]) => ({label, count: subjects.size}))
		.sort((a, b) => b.count - a.count);

	if (cats.length > MAX_CATEGORIES) {
		const rest = cats.slice(MAX_CATEGORIES);
		cats = cats.slice(0, MAX_CATEGORIES);
		cats.push({label: 'Other', count: rest.reduce((s, c) => s + c.count, 0)});
	}
	return {catVar, subjVar, cats};
}

/**
 * Aggregates the last result for a chart pane, rendering an empty state
 * when that is not possible.
 *
 * @param pane - Pane to receive the empty state on failure.
 * @returns The aggregate, or null when one could not be built.
 */
function requireAggregate(pane: HTMLElement): Aggregate | null {
	if (!lastResult || lastResult.kind !== 'select') {
		emptyState(pane, 'This response is not a SELECT result set — see the table below.');
		return null;
	}
	const agg = aggregate(lastResult.json);
	if (!agg || !agg.cats.length) {
		emptyState(pane, 'No categorical variable to chart. Include something like ?type in your SELECT.');
		return null;
	}
	return agg;
}

/**
 * Renders the bar chart of category counts.
 */
function renderTypes() {
	const pane = $('#types-view');
	const agg = requireAggregate(pane);
	if (!agg) return;
	pane.innerHTML = '';

	const cats = agg.cats;
	const max = Math.max(...cats.map((c) => c.count));

	const GUTTER = 230;      // category labels
	const VALUE_GAP = 56;    // room for value labels at bar tips
	const W = 1000;
	const ROW = 34;
	const BAR = 22;          // ≤24px thick
	const PAD_TOP = 12;
	const H = PAD_TOP * 2 + cats.length * ROW;
	const plotW = W - GUTTER - VALUE_GAP - 16;

	const svg = svgEl('svg', {viewBox: '0 0 ' + W + ' ' + H, class: 'bar-chart', role: 'img',
		'aria-label': 'Count of results by ' + agg.catVar});

	cats.forEach((c, i) => {
		const y = PAD_TOP + i * ROW + (ROW - BAR) / 2;
		const w = Math.max((c.count / max) * plotW, 2);
		const g = svgEl('g', {class: 'bar-row'});

		const name = svgEl('text', {x: GUTTER - 12, y: y + BAR / 2, class: 'bar-name'});
		name.textContent = c.label;
		g.appendChild(name);

		// square at the baseline, 4px rounded data-end
		const r = Math.min(4, w);
		const x0 = GUTTER;
		const bar = svgEl('path', {d:
			'M' + x0 + ' ' + y +
			' H' + (x0 + w - r) +
			' Q' + (x0 + w) + ' ' + y + ' ' + (x0 + w) + ' ' + (y + r) +
			' V' + (y + BAR - r) +
			' Q' + (x0 + w) + ' ' + (y + BAR) + ' ' + (x0 + w - r) + ' ' + (y + BAR) +
			' H' + x0 + ' Z',
			fill: MARK_HUE});
		const title = svgEl('title');
		title.textContent = c.label + ': ' + c.count.toLocaleString();
		bar.appendChild(title);
		g.appendChild(bar);

		const value = svgEl('text', {x: x0 + w + 10, y: y + BAR / 2, class: 'bar-value'});
		value.textContent = c.count.toLocaleString();
		g.appendChild(value);

		svg.appendChild(g);
	});

	pane.appendChild(svg);
}

/**
 * Renders the bubble chart of category counts.
 */
function renderBubbles() {
	const pane = $('#bubbles-view');
	const agg = requireAggregate(pane);
	if (!agg) return;
	pane.innerHTML = '';

	const cats = agg.cats;
	const W = 1000, H = 560;
	const max = Math.max(...cats.map((c) => c.count));
	const R_MIN = 22, R_MAX = 110;
	const scale = (count: number): number => R_MIN + (R_MAX - R_MIN) * Math.sqrt(count / max);

	// seed on a ring, then relax with a simple collision push toward center
	const nodes = cats.map((c, i) => {
		const angle = (i / cats.length) * Math.PI * 2;
		return {
			...c,
			r: scale(c.count),
			x: W / 2 + 200 * Math.cos(angle),
			y: H / 2 + 140 * Math.sin(angle),
		};
	});
	for (let step = 0; step < 400; step++) {
		for (const n of nodes) {
			n.x += (W / 2 - n.x) * 0.02;
			n.y += (H / 2 - n.y) * 0.02;
		}
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i], b = nodes[j];
				let dx = b.x - a.x, dy = b.y - a.y;
				let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
				const overlap = a.r + b.r + 6 - d;
				if (overlap > 0) {
					const push = overlap / 2;
					dx /= d; dy /= d;
					a.x -= dx * push; a.y -= dy * push;
					b.x += dx * push; b.y += dy * push;
				}
			}
		}
	}

	const svg = svgEl('svg', {viewBox: '0 0 ' + W + ' ' + H, class: 'bubble-chart', role: 'img',
		'aria-label': 'Results by ' + agg.catVar + ', bubble area proportional to count'});

	for (const n of nodes) {
		const g = svgEl('g', {class: 'bubble'});
		// 2px surface ring keeps touching bubbles legible
		const circle = svgEl('circle', {cx: n.x, cy: n.y, r: n.r, fill: MARK_HUE,
			stroke: '#fff', 'stroke-width': 2});
		const title = svgEl('title');
		title.textContent = n.label + ': ' + n.count.toLocaleString();
		circle.appendChild(title);
		g.appendChild(circle);

		// label inside when it fits, otherwise below the bubble in ink
		const fits = n.label.length * 7.5 < n.r * 1.7;
		if (fits) {
			const name = svgEl('text', {x: n.x, y: n.y - 4, class: 'bubble-name inside'});
			name.textContent = n.label;
			const value = svgEl('text', {x: n.x, y: n.y + 14, class: 'bubble-value inside'});
			value.textContent = n.count.toLocaleString();
			g.appendChild(name);
			g.appendChild(value);
		}
		else {
			const name = svgEl('text', {x: n.x, y: n.y + n.r + 16, class: 'bubble-name'});
			name.textContent = n.label + ' · ' + n.count.toLocaleString();
			g.appendChild(name);
		}
		svg.appendChild(g);
	}

	pane.appendChild(svg);
}

interface GNode {
	id: string;
	label: string;
	full: string;
	kind: 'uri' | 'literal';
	x: number; y: number; vx: number; vy: number;
	fixed: boolean;
	edgeCount: number;
}

interface GEdge { s: GNode; t: GNode; label: string }

/**
 * Builds a node/edge graph from a result set. Each row contributes its
 * first URI as the subject, connected to the row's other bound terms.
 *
 * @param json - SELECT result set.
 * @returns The nodes and edges, plus whether the node cap truncated the graph.
 */
function buildGraph(json: SelectResults) {
	const vars = json.head.vars;
	const nodes = new Map<string, GNode>();
	const edges = new Map<string, GEdge>();
	let truncated = false;

	const nodeFor = (term: SparqlTerm): GNode | null => {
		const key = term.type === 'uri' ? 'uri:' + term.value : 'lit:' + term.value;
		let node = nodes.get(key);
		if (!node) {
			if (nodes.size >= MAX_GRAPH_NODES) { truncated = true; return null; }
			node = {
				id: key,
				label: termLabel(term),
				full: term.value,
				kind: term.type === 'uri' ? 'uri' : 'literal',
				x: 0, y: 0, vx: 0, vy: 0, fixed: false,
				edgeCount: 0,
			};
			nodes.set(key, node);
		}
		return node;
	};

	const addEdge = (s: GNode | null, t: GNode | null, label: string): void => {
		if (!s || !t || s === t) return;
		const key = s.id + '\t' + t.id + '\t' + label;
		if (!edges.has(key)) {
			edges.set(key, {s, t, label});
			s.edgeCount++;
			t.edgeCount++;
		}
	};

	for (const row of json.results.bindings) {
		const bound = vars.filter((v) => row[v]);
		const subjVar = bound.find((v) => row[v]!.type === 'uri');
		if (!subjVar) continue;
		const subj = nodeFor(row[subjVar]!);

		if (bound.length === 3 && vars.length === 3 &&
				subjVar === bound[0] && row[bound[1]]!.type === 'uri') {
			addEdge(subj, nodeFor(row[bound[2]]!), shortLabel(row[bound[1]]!.value));
			continue;
		}
		for (const v of bound) {
			if (v === subjVar) continue;
			addEdge(subj, nodeFor(row[v]!), v);
		}
	}

	return {
		nodes: Array.from(nodes.values()),
		edges: Array.from(edges.values()),
		truncated,
	};
}

/**
 * Renders the interactive force-directed graph of the last result.
 */
function renderGraph() {
	const pane = $('#graph-view');
	pane.innerHTML = '';
	if (sim) { sim.stop = true; sim = null; }

	if (!lastResult || lastResult.kind !== 'select') {
		emptyState(pane, 'This response is not a SELECT result set — see the table below.');
		return;
	}

	const graph = buildGraph(lastResult.json);
	if (!graph.nodes.length) {
		emptyState(pane, 'No URI-valued results to draw. Include an entity variable (like ?feature) in your SELECT to see a graph.');
		return;
	}

	if (graph.truncated) {
		pane.appendChild(el('div', {class: 'graph-note'},
			'Showing the first ' + MAX_GRAPH_NODES + ' nodes. Add filters or lower the LIMIT to see everything at once.'));
	}

	const W = 1000, H = 620;
	const svg = svgEl<SVGSVGElement>('svg', {viewBox: '0 0 ' + W + ' ' + H, class: 'graph-svg'});
	const viewport = svgEl('g');
	svg.appendChild(viewport);
	pane.appendChild(svg);

	// initial ring placement
	const n = graph.nodes.length;
	graph.nodes.forEach((node, i) => {
		const angle = (i / n) * Math.PI * 2;
		const r = 60 + (240 * (i % 5)) / 5;
		node.x = W / 2 + r * Math.cos(angle);
		node.y = H / 2 + r * Math.sin(angle) * 0.7;
	});

	// draw edges beneath nodes
	const edgeLines = graph.edges.map((e) => {
		const g = svgEl('g', {class: 'gedge'});
		const line = svgEl('line');
		const label = svgEl('text');
		label.textContent = e.label;
		g.appendChild(line);
		g.appendChild(label);
		viewport.appendChild(g);
		return {e, line, label};
	});

	// pan & zoom state (in svg user units)
	let scale = 1, tx = 0, ty = 0;
	const applyTransform = () => {
		viewport.setAttribute('transform', 'translate(' + tx.toFixed(3) + ' ' + ty.toFixed(3) + ') scale(' + scale.toFixed(4) + ')');
	};

	// Client coordinates -> svg user units. getScreenCTM accounts for the
	// viewBox scaling *and* preserveAspectRatio letterboxing; it is null
	// while the pane is hidden, in which case we bail out.
	const svgPoint = (ev: MouseEvent): {x: number; y: number} | null => {
		const ctm = svg.getScreenCTM();
		if (!ctm) return null;
		const pt = svg.createSVGPoint();
		pt.x = ev.clientX;
		pt.y = ev.clientY;
		const p = pt.matrixTransform(ctm.inverse());
		return {x: p.x, y: p.y};
	};

	// svg user units -> viewport (pre-transform) coordinates
	const toViewport = (p: {x: number; y: number}) => ({x: (p.x - tx) / scale, y: (p.y - ty) / scale});

	const nodeDots = graph.nodes.map((node) => {
		const g = svgEl('g', {class: 'gnode ' + node.kind});
		const r = node.kind === 'uri' ? Math.min(9 + node.edgeCount * 0.4, 18) : 6;
		const circle = svgEl('circle', {r});
		const label = svgEl('text', {dy: r + 12});
		label.textContent = node.label;
		const title = svgEl('title');
		title.textContent = node.full;
		g.appendChild(circle);
		g.appendChild(label);
		g.appendChild(title);
		viewport.appendChild(g);

		if (node.kind === 'uri' && safeUri(node.full)) {
			g.addEventListener('dblclick', () => window.open(node.full, '_blank', 'noopener'));
		}
		g.addEventListener('pointerdown', (ev) => {
			if (ev.button !== 0) return;
			ev.stopPropagation();
			ev.preventDefault();
			node.fixed = true;
			const move = (mv: PointerEvent) => {
				const p = svgPoint(mv);
				if (!p) return;
				const vp = toViewport(p);
				node.x = vp.x;
				node.y = vp.y;
				kick(0.3);
			};
			const up = () => {
				node.fixed = false;
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
				window.removeEventListener('pointercancel', up);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
			window.addEventListener('pointercancel', up);
		});
		return {node, g};
	});

	svg.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		const p = svgPoint(ev);
		if (!p) return;
		const before = toViewport(p);
		const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
		scale = Math.min(6, Math.max(0.2, scale * factor));
		// keep the point under the cursor fixed
		tx = p.x - before.x * scale;
		ty = p.y - before.y * scale;
		applyTransform();
	}, {passive: false});

	svg.addEventListener('pointerdown', (ev) => {
		if (ev.button !== 0) return;
		const start = svgPoint(ev);
		if (!start) return;
		const origin = {tx, ty};
		const move = (mv: PointerEvent) => {
			const p = svgPoint(mv);
			if (!p) return;
			tx = origin.tx + (p.x - start.x);
			ty = origin.ty + (p.y - start.y);
			applyTransform();
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	});

	// force simulation — restartable, so drags after cool-down still animate
	const mySim: Sim = {alpha: 1, stop: false, running: false};
	sim = mySim;
	const REST = 95;

	const tick = () => {
		if (mySim.stop) { mySim.running = false; return; }
		// repulsion
		for (let i = 0; i < graph.nodes.length; i++) {
			const a = graph.nodes[i];
			for (let j = i + 1; j < graph.nodes.length; j++) {
				const b = graph.nodes[j];
				let dx = a.x - b.x, dy = a.y - b.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 1) { dx = Math.sin(i + j); dy = Math.cos(i - j); d2 = 1; }
				const f = Math.min(1800 / d2, 6) * mySim.alpha;
				const d = Math.sqrt(d2);
				a.vx += (dx / d) * f; a.vy += (dy / d) * f;
				b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
			}
		}
		// springs
		for (const e of graph.edges) {
			const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
			const d = Math.sqrt(dx * dx + dy * dy) || 1;
			const f = ((d - REST) / d) * 0.05 * mySim.alpha;
			e.s.vx += dx * f; e.s.vy += dy * f;
			e.t.vx -= dx * f; e.t.vy -= dy * f;
		}
		const V_MAX = 30;
		for (const node of graph.nodes) {
			node.vx += (W / 2 - node.x) * 0.002 * mySim.alpha;
			node.vy += (H / 2 - node.y) * 0.002 * mySim.alpha;
			if (!node.fixed) {
				node.vx = Math.max(-V_MAX, Math.min(V_MAX, node.vx * 0.85));
				node.vy = Math.max(-V_MAX, Math.min(V_MAX, node.vy * 0.85));
				node.x = Math.max(-W, Math.min(2 * W, node.x + node.vx));
				node.y = Math.max(-H, Math.min(2 * H, node.y + node.vy));
			}
			else {
				node.vx = 0; node.vy = 0;
			}
		}
		// paint (toFixed: raw floats below 1e-6 serialize in scientific
		// notation, which the SVG attribute parser rejects)
		for (const {e, line, label} of edgeLines) {
			line.setAttribute('x1', e.s.x.toFixed(2)); line.setAttribute('y1', e.s.y.toFixed(2));
			line.setAttribute('x2', e.t.x.toFixed(2)); line.setAttribute('y2', e.t.y.toFixed(2));
			label.setAttribute('x', ((e.s.x + e.t.x) / 2).toFixed(2));
			label.setAttribute('y', ((e.s.y + e.t.y) / 2 - 4).toFixed(2));
		}
		for (const {node, g} of nodeDots) {
			g.setAttribute('transform', 'translate(' + node.x.toFixed(2) + ' ' + node.y.toFixed(2) + ')');
		}
		mySim.alpha *= 0.995;
		if (mySim.alpha > 0.005) {
			requestAnimationFrame(tick);
		}
		else {
			mySim.running = false;
		}
	};

	// (Re)heat the simulation and make sure the loop is running.
	const kick = (alpha: number): void => {
		mySim.alpha = Math.max(mySim.alpha, alpha);
		if (!mySim.running && !mySim.stop) {
			mySim.running = true;
			requestAnimationFrame(tick);
		}
	};

	kick(1);
}

/**
 * Renders the table (or raw) view of the last result and refreshes the
 * download link.
 */
function renderTable() {
	const pane = $('#table-view');
	const meta = $('#table-meta');
	const download = $<HTMLAnchorElement>('#download-link');
	pane.innerHTML = '';
	if (!lastResult) return;

	// the download always carries the complete, untruncated response
	if (blobUrl) URL.revokeObjectURL(blobUrl);
	blobUrl = URL.createObjectURL(new Blob([lastResult.body], {type: 'text/plain'}));
	download.href = blobUrl;
	download.setAttribute('download', 'results' + (lastResult.kind === 'select' ? '.json' : '.txt'));
	download.hidden = false;

	if (lastResult.kind !== 'select') {
		meta.textContent = 'raw response';
		const pre = el('pre', {class: 'raw-pre'});
		pre.textContent = lastResult.body.length > 300000
			? lastResult.body.slice(0, 300000) + '\n… (truncated — use the download for the full response)'
			: lastResult.body;
		pane.appendChild(pre);
		return;
	}

	const json = lastResult.json;
	const vars = json.head.vars;
	const rows = json.results.bindings;
	meta.textContent = rows.length + ' row' + (rows.length === 1 ? '' : 's');
	if (!rows.length) {
		emptyState(pane, 'The query returned no results.');
		return;
	}

	const wrap = el('div', {class: 'table-wrap'});
	const table = el('table');
	const thead = el('thead');
	const headRow = el('tr');
	headRow.appendChild(el('th', {}, '#'));
	for (const v of vars) headRow.appendChild(el('th', {}, '?' + v));
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = el('tbody');
	rows.slice(0, MAX_TABLE_ROWS).forEach((row, i) => {
		const tr = el('tr');
		tr.appendChild(el('td', {class: 'row-num'}, String(i + 1)));
		for (const v of vars) {
			const td = el('td');
			const term = row[v];
			if (!term) {
				td.textContent = '';
			}
			else if (term.type === 'uri' && safeUri(term.value)) {
				td.appendChild(el('a', {
					href: term.value,
					target: '_blank',
					rel: 'noopener noreferrer',
					class: 'term-uri',
					title: term.value,
				}, shortLabel(term.value)));
			}
			else {
				td.textContent = term.value;
			}
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	});
	table.appendChild(tbody);
	wrap.appendChild(table);
	pane.appendChild(wrap);
	if (rows.length > MAX_TABLE_ROWS) {
		pane.appendChild(el('div', {class: 'graph-note'},
			'Showing the first ' + MAX_TABLE_ROWS + ' of ' + rows.length + ' rows — the download has all of them.'));
	}
}

document.addEventListener('DOMContentLoaded', () => {
	const input = $<HTMLTextAreaElement>('.query-input');
	input.value = EXAMPLES.california;

	document.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
		chip.addEventListener('click', () => {
			document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
			chip.classList.add('active');
			input.value = EXAMPLES[chip.dataset.example || ''] || '';
			runQuery();
		});
	});

	document.querySelectorAll<HTMLElement>('.view-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.view-tab').forEach((t) => t.classList.remove('active'));
			document.querySelectorAll('.view-pane').forEach((p) => p.classList.remove('active'));
			tab.classList.add('active');
			const view = (tab.dataset.view as ViewName) || 'graph';
			$('#' + view + '-view').classList.add('active');
			renderView(view);
		});
	});

	$('#run-btn').addEventListener('click', runQuery);
	input.addEventListener('keydown', (ev) => {
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
			ev.preventDefault();
			runQuery();
		}
	});

	runQuery();
});

