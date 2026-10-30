import {prefixes, $, el, safeUri, shortLabel, termLabel, postSparql, parseSelect, SelectResults, SparqlBinding, SparqlTerm} from './shared/sparql';

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
const MAX_PANEL_ROWS = 300;
// Zoom factor per pixel of wheel scroll. A mouse wheel notch is about 100
// pixels, which zooms by about 10%.
const ZOOM_PER_PIXEL = 0.001;
// Zoom factor of one click on the + or - button
const ZOOM_STEP = 1.25;
// Pointer movement, in pixels, below which a press on a node is a click
// rather than a drag
const CLICK_SLOP = 4;
// An IRI that contains one of these characters can't be written as <IRI>
// in a query
const R_IRI_UNSAFE = /[<>"{}|^`\\\s]/;

const SVG_NS = 'http://www.w3.org/2000/svg';

type QueryResult =
	| { kind: 'select'; json: SelectResults; body: string }
	| { kind: 'raw'; body: string };

interface Sim { alpha: number; stop: boolean; running: boolean }

let lastResult: QueryResult | null = null;
let sim: Sim | null = null;   // running graph simulation, stopped when the graph rerenders
let runSeq = 0;   // request token
let blobUrl: string | null = null;
let panelSeq = 0;   // node panel request token
let selectedNode: SVGElement | null = null;


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
		renderGraph();
		renderTable();
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
 * Builds a node/edge graph from a result set. Each row uses its
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
 * Hides the node panel and clears the node selection.
 */
function closeNodePanel(): void {
	panelSeq++;
	$('#node-panel').classList.remove('open');
	$('#node-panel').setAttribute('aria-hidden', 'true');
	if (selectedNode) selectedNode.classList.remove('selected');
	selectedNode = null;
}

/**
 * Shows a node's data in the node panel. An IRI node's triples are queried
 * from the endpoint. A literal node shows its full value.
 *
 * @param node - The clicked node.
 * @param g - The node's SVG group, marked as selected.
 */
function openNodePanel(node: GNode, g: SVGElement): void {
	const seq = ++panelSeq;
	if (selectedNode) selectedNode.classList.remove('selected');
	selectedNode = g;
	g.classList.add('selected');

	const panel = $('#node-panel');
	const title = $('#node-panel-title');
	const body = $('#node-panel-body');
	panel.classList.add('open');
	panel.setAttribute('aria-hidden', 'false');
	title.textContent = node.label;
	body.innerHTML = '';

	if (node.kind === 'literal') {
		body.appendChild(el('p', {class: 'node-literal'}, node.full));
		return;
	}

	body.appendChild(safeUri(node.full)
		? el('a', {class: 'node-iri', href: node.full, target: '_blank', rel: 'noopener'}, node.full)
		: el('p', {class: 'node-iri'}, node.full));
	if (R_IRI_UNSAFE.test(node.full)) return;

	const status = el('p', {class: 'node-status'}, 'Loading…');
	body.appendChild(status);
	postSparql('SELECT ?p ?o WHERE { <' + node.full + '> ?p ?o } LIMIT ' + (MAX_PANEL_ROWS + 1), undefined, false)
	.then(({body: s_body}) => {
		if (seq !== panelSeq) return;
		const rows = parseSelect(s_body).results.bindings;
		status.remove();
		if (!rows.length) {
			body.appendChild(el('p', {class: 'node-status'}, 'No triples have this IRI as their subject.'));
			return;
		}
		const list = el('dl', {class: 'node-props'});
		for (const row of rows.slice(0, MAX_PANEL_ROWS)) {
			const p = row.p!, o = row.o!;
			list.appendChild(el('dt', {title: p.value}, shortLabel(p.value)));
			const dd = el('dd');
			if (o.type === 'uri' && safeUri(o.value)) {
				dd.appendChild(el('a', {href: o.value, target: '_blank', rel: 'noopener', title: o.value}, shortLabel(o.value)));
			}
			else {
				dd.textContent = o.value;
				if (o['xml:lang']) dd.appendChild(el('span', {class: 'node-lang'}, '@' + o['xml:lang']));
			}
			list.appendChild(dd);
		}
		body.appendChild(list);
		if (rows.length > MAX_PANEL_ROWS) {
			body.appendChild(el('p', {class: 'node-status'}, 'Showing the first ' + MAX_PANEL_ROWS + ' triples.'));
		}
	})
	.catch((err) => {
		if (seq !== panelSeq) return;
		status.textContent = err.message;
		status.classList.add('error');
	});
}

/**
 * Renders the interactive force-directed graph of the last result.
 */
function renderGraph() {
	const pane = $('#graph-view');
	pane.innerHTML = '';
	closeNodePanel();
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
			let dragged = false;
			const move = (mv: PointerEvent) => {
				if (!dragged && Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) < CLICK_SLOP) return;
				dragged = true;
				const p = svgPoint(mv);
				if (!p) return;
				const vp = toViewport(p);
				node.x = vp.x;
				node.y = vp.y;
				kick(0.3);
			};
			const up = (upEv: PointerEvent) => {
				node.fixed = false;
				if (!dragged && upEv.type === 'pointerup') openNodePanel(node, g);
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

	// Multiplies the scale by a factor, between 0.2 and 6, keeping the point
	// p (in svg user units) at the same place on screen
	const zoomAt = (p: {x: number; y: number}, factor: number): void => {
		const before = toViewport(p);
		scale = Math.min(6, Math.max(0.2, scale * factor));
		tx = p.x - before.x * scale;
		ty = p.y - before.y * scale;
		applyTransform();
	};

	svg.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		const p = svgPoint(ev);
		if (!p) return;
		// deltaMode 1 reports lines instead of pixels
		const pixels = ev.deltaY * (ev.deltaMode === 1 ? 16 : 1);
		zoomAt(p, Math.exp(-pixels * ZOOM_PER_PIXEL));
	}, {passive: false});

	const controls = el('div', {class: 'zoom-controls'});
	for (const [text, label, factor] of [['+', 'Zoom in', ZOOM_STEP], ['−', 'Zoom out', 1 / ZOOM_STEP]] as const) {
		const btn = el('button', {type: 'button', 'aria-label': label, title: label}, text);
		btn.addEventListener('click', () => zoomAt({x: W / 2, y: H / 2}, factor));
		controls.appendChild(btn);
	}
	// A press on the buttons does not reach the document, so it leaves the
	// node panel open
	controls.addEventListener('pointerdown', (ev) => ev.stopPropagation());
	pane.appendChild(controls);

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

	// force simulation
	const mySim: Sim = {alpha: 1, stop: false, running: false};
	sim = mySim;
	const REST = 95;

	const tick = () => {
		if (mySim.stop) { mySim.running = false; return; }
		// repulsion between nodes
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
		// springs between nodes
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

	$('#node-panel-close').addEventListener('click', closeNodePanel);
	// A press outside the panel closes it. A press on a node does not reach
	// the document, because the node's handler stops its propagation.
	document.addEventListener('pointerdown', (ev) => {
		if (!$('#node-panel').contains(ev.target as Node)) closeNodePanel();
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

