// Shared helpers for the query, search, and link pages. This is bundled into
// each page's script by esbuild via import, never published standalone under
// /script.

declare global {
	interface Window { GNIS_BASE?: string }
}

// A term in a SPARQL JSON results binding
export interface SparqlTerm {
	type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
	value: string;
	datatype?: string;
	'xml:lang'?: string;
}

export type SparqlBinding = Record<string, SparqlTerm | undefined>;

export interface SelectResults {
	head: { vars: string[] };
	results: { bindings: SparqlBinding[] };
}

export const BASE: string =
	(typeof window !== 'undefined' && window.GNIS_BASE) || 'gnis-ld.org';
export const LOD = 'http://' + BASE + '/lod';

// Every namespace a page may reference; each generated query declares only
// the prefixes it actually uses (via prefixes(...names)).
export const NS: Record<string, string> = {
	rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
	owl: 'http://www.w3.org/2002/07/owl#',
	usgs: LOD + '/usgs/ontology/',
	gnis: LOD + '/gnis/ontology/',
	'gnisf-alias': LOD + '/gnis/feature-alias/',
	geo: 'http://www.opengis.net/ont/geosparql#',
	geof: 'http://www.opengis.net/def/function/geosparql/',
	uom: 'http://www.opengis.net/def/uom/OGC/1.0/',
};

export const prefixes = (...a_names: string[]): string =>
	a_names.map((s) => 'PREFIX ' + s + ': <' + NS[s] + '>').join('\n') + '\n';

// The pages address elements they render themselves, so a missing element is
// a programming error; the non-null cast keeps call sites readable.
export const $ = <T extends HTMLElement = HTMLElement>(s_sel: string): T =>
	document.querySelector(s_sel) as T;

export function el(
	s_tag: string,
	h_attrs?: Record<string, string> | null,
	s_text?: string
): HTMLElement {
	const d_node = document.createElement(s_tag);
	for (const s_key in (h_attrs || {})) d_node.setAttribute(s_key, (h_attrs as Record<string, string>)[s_key]);
	if (s_text !== undefined) d_node.textContent = s_text;
	return d_node;
}

// Escape a user-supplied value for use inside a double-quoted SPARQL literal.
export function escapeLiteral(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
		.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

// Only plain web URLs are safe to hyperlink; anything else (javascript:,
// data:, urn:, ...) must be rendered as text.
export function safeUri(s_uri: string): boolean {
	return /^https?:\/\//i.test(s_uri);
}

// Shorten a URI to its local name for display.
export function shortLabel(s_uri: string): string {
	const a_parts = s_uri.replace(/[/#]+$/, '').split(/[/#]/).filter(Boolean);
	if (!a_parts.length) return s_uri;
	let s_local = a_parts[a_parts.length - 1];
	// purely numeric ids are ambiguous — qualify with the parent segment
	if (/^\d+$/.test(s_local) && a_parts.length > 1) {
		s_local = a_parts[a_parts.length - 2] + ':' + s_local;
	}
	try {
		return decodeURIComponent(s_local);
	}
	catch (e_decode) {
		return s_local;
	}
}

export function termLabel(h_term: SparqlTerm): string {
	if (h_term.type === 'uri') return shortLabel(h_term.value);
	let s_value = h_term.value;
	if (s_value.length > 40) s_value = s_value.slice(0, 37) + '…';
	return s_value;
}

// POST a query to the local endpoint. Resolves {res, body}; rejects with a
// readable message on a non-2xx response.
export function postSparql(
	s_query: string,
	s_accept?: string
): Promise<{ res: Response; body: string }> {
	return fetch('/sparql', {
		method: 'POST',
		headers: {
			'Accept': s_accept || 'application/sparql-results+json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: 'query=' + encodeURIComponent(s_query),
	})
	.then((d_res) => d_res.text().then((s_body) => ({res: d_res, body: s_body})))
	.then(({res, body}) => {
		if (!res.ok) throw new Error('Endpoint returned HTTP ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''));
		return {res, body};
	});
}

// Parse a response body that must be SPARQL SELECT results JSON.
export function parseSelect(s_body: string): SelectResults {
	let h_json: SelectResults;
	try {
		h_json = JSON.parse(s_body);
	}
	catch (e_parse) {
		throw new Error('Could not parse the endpoint response.');
	}
	if (!h_json.head || !h_json.results) {
		throw new Error('Unexpected response shape from the endpoint.');
	}
	return h_json;
}
