import {LOD, prefixes, $, el, escapeLiteral, safeUri, shortLabel, postSparql, parseSelect, SparqlBinding} from './shared/sparql';

const PAGE_SIZE = 50;

// Curated subset of usgs ontology classes for the type filter.
const TYPES = [
	'Summit', 'Stream', 'Lake', 'Valley', 'PopulatedPlace', 'Reservoir',
	'Spring', 'Island', 'Ridge', 'Glacier', 'Waterfall', 'Bay',
	'Beach', 'Basin', 'Swamp', 'Cliff',
];

interface Facets {
	name: string;
	lat: string;
	lon: string;
	radius: string;
	types: string[];
}

let offset = 0;
let lastFacets: Facets | null = null; // facets of the search being paged; Load more must not re-read the form
let inFlight = false;
const seenFeatures = new Set<string>(); // feature URIs already rendered, to dedup across pages

// ---------- facets ----------

/**
 * Reads the current facet values from the search form.
 *
 * @returns The trimmed field values and the checked feature types.
 */
function readFacets(): Facets {
	return {
		name: $<HTMLInputElement>('#f-name').value.trim(),
		lat: $<HTMLInputElement>('#f-lat').value.trim(),
		lon: $<HTMLInputElement>('#f-lon').value.trim(),
		radius: $<HTMLInputElement>('#f-radius').value.trim(),
		types: Array.from(document.querySelectorAll<HTMLInputElement>('.type-check:checked')).map((c) => c.value),
	};
}

/**
 * Returns whether the location filter is usable. It needs all three fields,
 * each holding a valid number; validity is checked here before use.
 *
 * @param f - Facets to inspect.
 * @returns True when latitude, longitude, and a positive radius are all present.
 */
function geoActive(f: Facets): boolean {
	return f.lat !== '' && f.lon !== '' && f.radius !== '' &&
		isFinite(Number(f.lat)) && isFinite(Number(f.lon)) && Number(f.radius) > 0;
}

/**
 * Returns whether the location filter is only partially filled in.
 *
 * @param f - Facets to inspect.
 * @returns True when at least one location field is set but the filter is not usable.
 */
function geoPartial(f: Facets): boolean {
	const filled = [f.lat, f.lon, f.radius].filter((v) => v !== '').length;
	return filled > 0 && !geoActive(f);
}

/**
 * Builds the SELECT query for one page of search results.
 *
 * @param f - Facets to filter by.
 * @param off - Result offset of the page.
 * @returns The complete SPARQL query text.
 */
function buildQuery(f: Facets, off: number): string {
	const used = ['rdf', 'rdfs']; // ?feature rdf:type / rdfs:label are always present
	const where = [
		'?feature rdfs:label ?label .',
		'?feature rdf:type ?type .',
	];
	if (f.types.length) {
		used.push('usgs');
		where.push('VALUES ?type { ' + f.types.map((t) => 'usgs:' + t).join(' ') + ' }');
	}
	else {
		where.push(`FILTER(STRSTARTS(STR(?type), "${LOD}/usgs/ontology/"))`);
	}
	if (f.name) {
		where.push(`FILTER(CONTAINS(LCASE(STR(?label)), "${escapeLiteral(f.name.toLowerCase())}"))`);
	}
	if (geoActive(f)) {
		used.push('geo', 'geof', 'uom');
		// Number() below guarantees only numeric values reach the query
		const n_lat = Number(f.lat);
		const n_lon = Number(f.lon);
		const n_metres = Number(f.radius) * 1000;
		where.push('?feature geo:hasGeometry ?geometry .');
		where.push('?geometry geo:asWKT ?wkt .');
		where.push(`FILTER(geof:distance(?wkt, "POINT(${n_lon} ${n_lat})"^^geo:wktLiteral, uom:metre) <= ${n_metres})`);
	}

	return prefixes(...used) +
`SELECT ?feature (SAMPLE(?label) AS ?name)
       (GROUP_CONCAT(DISTINCT STR(?type); separator=" ") AS ?types)
WHERE {
  ${where.join('\n  ')}
}
GROUP BY ?feature
ORDER BY ?name ?feature
LIMIT ${PAGE_SIZE} OFFSET ${off}`;
}

// ---------- search ----------

/**
 * Runs a search against the endpoint and renders the results.
 *
 * @param append - True to fetch the next page of the snapshotted facets;
 * false to start a fresh search from the form.
 */
function runSearch(append: boolean): void {
	if (inFlight) return;
	// A fresh search snapshots the form; Load more pages the *snapshotted*
	// facets so edits to the form can't be mixed with a stale offset.
	if (!append) {
		lastFacets = readFacets();
		seenFeatures.clear();
		const s = $('#search-status');
		if (geoPartial(lastFacets)) {
			s.textContent = 'The location filter needs all three values: latitude, longitude, and a radius in km.';
			s.classList.remove('error');
			return;
		}
		if (!lastFacets.name && !lastFacets.types.length && !geoActive(lastFacets)) {
			s.textContent = 'Type a name, or open Filters and pick a feature type or location first.';
			s.classList.remove('error');
			return;
		}
	}
	if (!lastFacets) return;
	const nextOffset = append ? offset + PAGE_SIZE : 0;
	const query = buildQuery(lastFacets, nextOffset);

	const status = $('#search-status');
	const loadMore = $<HTMLButtonElement>('#load-more');
	inFlight = true;
	loadMore.disabled = true;
	status.textContent = 'Searching…';
	status.classList.remove('error');

	postSparql(query)
	.then(({body}) => {
		const json = parseSelect(body);
		offset = nextOffset; // advance only after a successful page
		renderResults(json.results.bindings, append);
	})
	.catch((err) => {
		status.textContent = err.message;
		status.classList.add('error');
		loadMore.hidden = true;
	})
	.then(() => {
		inFlight = false;
		loadMore.disabled = false;
	});
}

/**
 * Renders a page of result rows into the list.
 *
 * @param rows - Bindings from the SELECT response.
 * @param append - True to add to the existing list; false to replace it.
 */
function renderResults(rows: SparqlBinding[], append: boolean): void {
	const list = $('#results-list');
	const status = $('#search-status');
	if (!append) list.innerHTML = '';

	for (const row of rows) {
		if (!row.feature) continue;
		if (seenFeatures.has(row.feature.value)) continue;
		seenFeatures.add(row.feature.value);
		const card = el('div', {class: 'result-card'});

		const displayName = row.name ? row.name.value : shortLabel(row.feature.value);
		if (safeUri(row.feature.value)) {
			card.appendChild(el('a', {
				class: 'result-name',
				href: row.feature.value,
				target: '_blank',
				rel: 'noopener noreferrer',
				title: row.feature.value,
			}, displayName));
		}
		else {
			card.appendChild(el('span', {class: 'result-name', title: row.feature.value}, displayName));
		}

		const uriRow = el('div', {class: 'uri-row'});
		const uri = row.feature.value;
		uriRow.appendChild(el('span', {class: 'uri-text', title: uri}, uri));
		const copy = el('button', {class: 'copy-btn', type: 'button'}, 'Copy');
		copy.addEventListener('click', () => {
			navigator.clipboard.writeText(uri).then(() => {
				copy.textContent = 'Copied';
				copy.classList.add('copied');
				setTimeout(() => {
					copy.textContent = 'Copy';
					copy.classList.remove('copied');
				}, 1500);
			});
		});
		uriRow.appendChild(copy);
		card.appendChild(uriRow);
		list.appendChild(card);
	}

	const total = list.children.length;
	if (!total) {
		status.textContent = 'No features matched.';
	}
	else {
		status.textContent = total + ' feature' + (total === 1 ? '' : 's') + (rows.length === PAGE_SIZE ? ' so far' : '');
	}
	$('#load-more').hidden = rows.length < PAGE_SIZE;
}

// ---------- wiring ----------

/**
 * Reflects the number of active filters on the Filters toggle button.
 */
function updateFilterButton() {
	const f = readFacets();
	const n = f.types.length + (geoActive(f) ? 1 : 0);
	$('#filter-toggle').textContent = n ? 'Filters (' + n + ')' : 'Filters';
}

document.addEventListener('DOMContentLoaded', () => {
	const typeList = $('#type-list');
	for (const t of TYPES) {
		const lbl = el('label', {class: 'type-option'});
		const box = el('input', {type: 'checkbox', class: 'type-check', value: t});
		lbl.appendChild(box);
		lbl.appendChild(document.createTextNode(' ' + t.replace(/([a-z])([A-Z])/g, '$1 $2')));
		typeList.appendChild(lbl);
	}

	const panel = $('#filter-panel');
	const toggle = $('#filter-toggle');
	toggle.addEventListener('click', () => {
		panel.hidden = !panel.hidden;
		toggle.setAttribute('aria-expanded', String(!panel.hidden));
		toggle.classList.toggle('open', !panel.hidden);
	});
	panel.addEventListener('change', updateFilterButton);
	panel.addEventListener('input', updateFilterButton);

	$('#search-form').addEventListener('submit', (ev) => {
		ev.preventDefault();
		runSearch(false);
	});

	$('#load-more').addEventListener('click', () => {
		runSearch(true);
	});
});

