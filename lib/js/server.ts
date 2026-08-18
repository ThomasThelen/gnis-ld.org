import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import minimist from 'minimist';
import * as wellknown from 'wellknown';

import app_config from '../../config.app';

const h_argv = minimist(process.argv.slice(2));
const N_PORT: number = h_argv.p || h_argv.port || 80;

const P_BASE = app_config.data_uri;
const S_DATA_HOST = app_config.data_host;
const S_DATA_PATH = app_config.data_path;
const P_BASE_GNIS = `${P_BASE}/gnis`;


const PD_ROOT = path.resolve(__dirname, '..');

const PD_LIB = path.join(PD_ROOT, 'lib');
const PD_LIB_WEBAPP = path.join(PD_LIB, 'webapp');
const PD_RESOURCES = path.join(PD_LIB_WEBAPP, '_resources');

const PD_DIST = path.join(PD_ROOT, 'dist');
const PD_DIST_WEBAPP = path.join(PD_DIST, 'webapp');
const PD_DIST_JS = path.join(PD_DIST, 'js');


const P_ENDPOINT = app_config.sparql_endpoint;
const D_URL_ENDPOINT = new url.URL(P_ENDPOINT);

const S_PREFIXES = `
	prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
	prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>
	prefix xsd: <http://www.w3.org/2001/XMLSchema#>
	prefix geo: <http://www.opengis.net/ont/geosparql#>
	prefix gnis: <${P_BASE_GNIS}/ontology/>
	prefix gnisf: <${P_BASE_GNIS}/feature/>
	prefix gnisp: <${P_BASE_GNIS}/place/>
`;

/**
 * Ends a response with a geometry 404.
 *
 * @param d_res - Response to end.
 */
const _404 = (d_res: Response): void => {
	d_res.status(404).end('No such geometry');
};

type SparqlCallback = (
	e_query: Error | null,
	d_sparql_res: { statusCode: number },
	s_res_body: string
) => void;

/**
 * Submits a SPARQL query to the endpoint via HTTP.
 *
 * @param s_accept - Accept header for the response serialization.
 * @param s_query - Query text; the shared prefixes are prepended.
 * @param fk_query - Callback receiving the error, response status, and body.
 */
const sparql_query = (s_accept: string, s_query: string, fk_query: SparqlCallback): void => {
	fetch(P_ENDPOINT, {
		method: 'POST',
		headers: {
			accept: s_accept,
			'content-type': 'application/sparql-query;charset=UTF-8',
		},
		body: S_PREFIXES + '\n' + s_query,
	}).then(async (d_fetch_res) => {
		fk_query(null, {statusCode: d_fetch_res.status}, await d_fetch_res.text());
	}).catch((e_query) => {
		fk_query(e_query, {statusCode: 500}, '');
	});
};

const k_app = express();
k_app.use(createProxyMiddleware({
	target: D_URL_ENDPOINT.origin,
	// exact match: a bare string is a prefix filter
	pathFilter: (s_path: string) => '/sparql' === s_path,
	pathRewrite: {
		'^/sparql': '/repositories/gnis-ld',
	},
}));
// Proxy that takes /data and redirects to GraphDB for a graph dump
k_app.use(createProxyMiddleware({
	target: D_URL_ENDPOINT.origin,
	// exact match: the '/data' prefix would swallow /dataset
	pathFilter: (s_path: string) => '/data' === s_path,
	pathRewrite: {
		'^/data': '/repositories/gnis-ld/statements',
	},
	on: {
		proxyReq: (proxyReq) => {
			// Add the query parameters to the GraphDB request since it can't
			// be done in the pathRewrite expression
			proxyReq.path += '?infer=false&context=null&Accept=text%2Fplain';
		},
	},
}));

// views
k_app.set('views', path.join(PD_LIB_WEBAPP, '_layouts'));
k_app.set('view engine', 'pug');

const PD_ARCHIVES = path.resolve(PD_ROOT, app_config.archive_path);
const R_DUMP = /\.nt(\.gz)?$/;

interface ReleaseSidecar {
	id?: string;
	published?: string;
	triples?: string;
	size?: string;
}

interface Release {
	id: string;
	published: string;
	triples: string;
	size: string;
	url: string;
	historical?: Release;
}

/**
 * Formats a byte count for display.
 *
 * @param n_bytes - Size in bytes.
 * @returns Human-readable size (KB/MB/GB).
 */
const format_size = (n_bytes: number): string => {
	if (n_bytes >= 1e9) return (n_bytes / 1e9).toFixed(1) + ' GB';
	if (n_bytes >= 1e6) return (n_bytes / 1e6).toFixed(1) + ' MB';
	return Math.max(1, Math.round(n_bytes / 1e3)) + ' KB';
};

/**
 * Scans the archive volume for release dumps.
 *
 * @returns Releases sorted newest first, each with its historical companion
 * dump attached when present.
 */
const list_releases = (): Release[] => {
	let a_files: string[];
	try {
		a_files = fs.readdirSync(PD_ARCHIVES);
	}
	catch (e_read) {
		return [];
	}
	const a_releases: Release[] = [];
	// historical companion dumps (records retained for features dropped
	// upstream), keyed by release id and attached to their release below
	const h_historical: Record<string, Release> = {};
	for (const s_file of a_files) {
		if (!R_DUMP.test(s_file)) continue;
		let d_stat: fs.Stats;
		try {
			d_stat = fs.statSync(path.join(PD_ARCHIVES, s_file));
		}
		catch (e_stat) {
			continue;
		}
		let h_meta: ReleaseSidecar = {};
		try {
			h_meta = JSON.parse(fs.readFileSync(path.join(PD_ARCHIVES, s_file.replace(R_DUMP, '.meta.json')), 'utf8'));
		}
		catch (e_meta) { }
		// release ids are YYMMDD build dates: gnis-ld-260811.nt.gz -> 260811
		const m_date = s_file.match(/(\d{6})(?=\.nt(?:\.gz)?$)/);
		const h_entry: Release = {
			id: h_meta.id || (m_date ? m_date[1] : s_file.replace(R_DUMP, '')),
			published: h_meta.published || (m_date
				? `20${m_date[1].slice(0, 2)}-${m_date[1].slice(2, 4)}-${m_date[1].slice(4, 6)}`
				: d_stat.mtime.toISOString().slice(0, 10)),
			triples: h_meta.triples || '—',
			size: h_meta.size || format_size(d_stat.size),
			url: '/archive/' + s_file,
		};
		if (/historical/i.test(s_file)) h_historical[h_entry.id] = h_entry;
		else a_releases.push(h_entry);
	}
	for (const h_release of a_releases) {
		if (h_historical[h_release.id]) h_release.historical = h_historical[h_release.id];
	}
	// newest first; the first entry is the current release
	a_releases.sort((h_a, h_b) => String(h_b.published).localeCompare(String(h_a.published)));
	return a_releases;
};

// machine-readable release manifest, generated from the archive volume
// (registered before the /resource static mount so it wins)
k_app.get('/resource/metadata/releases.json', (d_req: Request, d_res: Response) => {
	d_res.json(list_releases());
});

// VoID/DCAT description: the static base document plus release records
// generated from the archive volume
k_app.get('/resource/metadata/void.ttl', (d_req: Request, d_res: Response) => {
	let s_void = fs.readFileSync(path.join(PD_RESOURCES, 'metadata/void.ttl'), 'utf8');
	const p_dataset = `http://${S_DATA_HOST}${S_DATA_PATH}/gnis`;
	for (const h_release of list_releases()) {
		const s_slug = h_release.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const s_historical = h_release.historical ? ` ;
    dcat:distribution [
        a dcat:Distribution ;
        dct:title "Historical companion: records retained for features dropped upstream" ;
        dcat:accessURL <https://${S_DATA_HOST}${h_release.historical.url}> ;
        dcat:mediaType "application/n-triples" ;
    ]` : '';
		s_void += `
<${p_dataset}/release/${s_slug}> a dcat:Dataset ;
    dct:isVersionOf <${p_dataset}> ;
    dct:issued "${h_release.published}"^^xsd:date ;
    dcat:distribution [
        a dcat:Distribution ;
        dcat:accessURL <https://${S_DATA_HOST}${h_release.url}> ;
        dcat:mediaType "application/n-triples" ;
    ]${s_historical} .
`;
	}
	d_res.type('text/turtle').send(s_void);
});

// static routing
k_app.use('/script', express.static(PD_DIST_JS));
k_app.use('/style', express.static(path.join(PD_DIST_WEBAPP, '_styles')));
k_app.use('/resource', express.static(path.join(PD_LIB_WEBAPP, '_resources')));
k_app.use('/images', express.static(path.join(PD_LIB_WEBAPP, '_images')));
k_app.use('/robots.txt', express.static(path.join(PD_LIB_WEBAPP, '_resources/robots.txt')));
// archived database dumps, stored on disk (a mounted volume in production)
k_app.use('/archive', express.static(PD_ARCHIVES));
// index
k_app.get([
	'/',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('index', { base_url: S_DATA_HOST });
});

// explore page (formerly /queries)
k_app.get([
	'/explore',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('queries', { base_url: S_DATA_HOST });
});
k_app.get([
	'/queries',
], (d_req: Request, d_res: Response) => {
	d_res.redirect('/explore');
});

// search page
k_app.get([
	'/search',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('search', { base_url: S_DATA_HOST });
});

// landing page
k_app.get([
	'/lod/',
], (d_req: Request, d_res: Response) => {
	d_res.redirect('/');
});

// about page
k_app.get([
	'/about',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('about');
});

// integrations page
k_app.get([
	'/integrations',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('integrations', { base_url: S_DATA_HOST });
});

// entity linking folded into search; old links keep working
k_app.get([
	'/link',
], (d_req: Request, d_res: Response) => {
	d_res.redirect('/search');
});

// downloads page; the release list is scanned from the archive volume, so
// publishing a release is just dropping a dump file there
k_app.get([
	'/downloads',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('downloads', { releases: list_releases() });
});

// documentation page
k_app.get([
	'/docs',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('docs', { base_url: S_DATA_HOST });
});

// VoID well-known location -> the dataset description document
k_app.get('/.well-known/void', (d_req: Request, d_res: Response) => {
	d_res.redirect('/resource/metadata/void.ttl');
});

// data page (dataset overview + vocabularies)
k_app.get([
	'/dataset',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('dataset', { base_url: S_DATA_HOST });
});
// vocabularies page
k_app.get([
	'/vocabularies',
], (d_req: Request, d_res: Response) => {
	d_res.type('text/html');
	d_res.render('vocabularies', { base_url: S_DATA_HOST });
});

/**
 * Fetches the WKT literal for a geometry. The literal lives in the graph
 * (geo:asWKT), so lookups go to the SPARQL endpoint like everything else.
 *
 * @param p_guri - Geometry URI.
 * @param fk_wkt - Callback receiving the error, or the WKT string (null when
 * the geometry does not exist).
 */
const geometry_wkt = (
	p_guri: string,
	fk_wkt: (e_wkt: Error | null, s_wkt?: string | null) => void
): void => {
	sparql_query('application/sparql-results+json',
		`select ?wkt where { <${p_guri}> geo:asWKT ?wkt } limit 1`,
		(e_query, d_sparql_res, s_res_body) => {
			if (e_query || 200 !== d_sparql_res.statusCode) return fk_wkt(e_query || new Error(`endpoint returned ${d_sparql_res.statusCode}`));
			let a_bindings: Array<{ wkt: { value: string } }>;
			try {
				a_bindings = JSON.parse(s_res_body).results.bindings;
			}
			catch (e_parse) {
				return fk_wkt(e_parse as Error);
			}
			if (!a_bindings.length) return fk_wkt(null, null);
			// strip the optional leading <CRS> qualifier off the literal
			fk_wkt(null, a_bindings[0].wkt.value.replace(/^<[^>]*>\s*/, ''));
		});
};

// Geometry URIs live at /geometry/* (the /lod/geometry/* alias is kept for
// old links)
k_app.get(['/geometry/*', '/lod/geometry/*'], (d_req: Request, d_res: Response) => {
	const p_guri = app_config.geom_uri + d_req.url.replace(/^(\/lod)?\/geometry/, '');

	// CORS header
	d_res.set('Access-Control-Allow-Origin', '*');

	const send_geometry = (f_transform: (s_wkt: string) => string, s_media_type: string): void => {
		geometry_wkt(p_guri, (e_wkt, s_wkt) => {
			if (e_wkt) {
				console.error(e_wkt);
				d_res.status(500).send('failed to fetch geometry from the graph');
				return;
			}
			if (!s_wkt) return _404(d_res);
			d_res.type(s_media_type);
			d_res.send(f_transform(s_wkt));
		});
	};

	const geojson = (s_wkt: string): string => JSON.stringify(wellknown.parse(s_wkt));

	// content negotiation
	d_res.format({
		'text/html': () => {
			d_res.type('text/html');
			d_res.render('geometry');
		},

		// Well-Known Text
		'text/plain': () => send_geometry((s_wkt) => s_wkt, 'text/plain'),

		// GeoJSON
		'application/json': () => send_geometry(geojson, 'application/json'),

		// actual GeoJSON
		'application/vnd.geo+json': () => send_geometry(geojson, 'application/vnd.geo+json'),
	});
});


// request for the page about the resource
k_app.get([
	'/lod/page/*',
], (d_req: Request, d_res: Response) => {
	d_res.redirect(`//stko-kwg.geog.ucsb.edu/browse/#http://${S_DATA_HOST}${d_req.url}`);
});

// request for usgs / gnis ontology
k_app.get('/lod/:dataset/ontology', (d_req: Request, d_res: Response) => {
	d_res.sendFile(path.join(PD_RESOURCES, 'ontologies', `${d_req.params.dataset}.ttl`));
});

/**
 * Content-negotiates an entity request: RDF serializations are answered from
 * the endpoint, browsers are redirected to the KnowWhereGraph browser.
 *
 * @param d_req - Entity request.
 * @param d_res - Response to write.
 * @param f_next - Passes non-GET/HEAD requests through to the next handler.
 */
const negotiate_feature = (d_req: Request, d_res: Response, f_next: NextFunction): void => {
	const {
		dataset: s_dataset,
		group: s_group,
		thing: s_thing,
	} = d_req.params;

	// redirection
	const p_redirect = `//stko-kwg.geog.ucsb.edu/browse/#http://${S_DATA_HOST}${S_DATA_PATH}/${s_dataset}/${s_group}/${s_thing}`;

	// entity uri (originalUrl: this handler is mounted with app.use, which
	// strips the matched prefix from req.url)
	const p_entity = P_BASE.replace(/\/[^/]*$/, '') + d_req.originalUrl;

	// HTTP head request
	const b_head_only = 'HEAD' === d_req.method;

	// non-GET
	if (!b_head_only && 'GET' !== d_req.method) {
		return f_next();
	}

	// default is to redirect to page
	const f_redirect = () => {
		d_res.redirect(p_redirect);
	};

	// application/rdf+xml
	const f_rdf_xml = () => {
		sparql_query('application/rdf+xml', `describe <${p_entity}>`, (e_query, d_sparql_res, s_res_body) => {
			// response mime type
			d_res.type('application/rdf+xml');

			// response status code
			d_res.statusCode = e_query ? 500 : d_sparql_res.statusCode;

			// head only; don't send body
			if (b_head_only) return d_res.end();

			// otherwise; send body
			d_res.send(s_res_body);
		});
	};

	// content negotiation. rdf+xml first: res.format hands */* clients the
	// first key (the LD default); browsers match text/html explicitly.
	d_res.format({
		'application/rdf+xml': f_rdf_xml,

		// GraphDB negotiates these serializations itself; pass them through
		'text/turtle': () => {
			sparql_query('text/turtle', `describe <${p_entity}>`, (e_query, d_sparql_res, s_res_body) => {
				// response mime type
				d_res.type('text/turtle');

				// response status code
				d_res.statusCode = e_query ? 500 : d_sparql_res.statusCode;

				// head only; don't send body
				if (b_head_only) return d_res.end();

				// otherwise; send body
				d_res.send(s_res_body);
			});
		},

		'application/nquads': () => {
			sparql_query('application/n-triples', `describe <${p_entity}>`, (e_query, d_sparql_res, s_res_body) => {
				// response mime type
				d_res.type('application/nquads');

				// response status code
				d_res.statusCode = e_query ? 500 : d_sparql_res.statusCode;

				// head only; don't send body
				if (b_head_only) return d_res.end();

				// otherwise; send body
				d_res.send(s_res_body);
			});
		},

		'text/html': f_redirect,
		default: f_rdf_xml,
	});
};

// request for thing
k_app.use([
	'/lod/:dataset/:group/:thing',
], negotiate_feature);

// catch-all 404: a styled page for browsers, plain text for everyone else.
// text/plain first: */* clients get the first key; browsers ask for
// text/html explicitly and match it regardless of order.
k_app.use((d_req: Request, d_res: Response) => {
	d_res.status(404);
	d_res.format({
		'text/plain': () => {
			d_res.send('404: no such resource');
		},
		'text/html': () => {
			d_res.render('notfound', { base_url: S_DATA_HOST });
		},
		default: () => {
			d_res.type('text/plain').send('404: no such resource');
		},
	});
});

// bind to port
k_app.listen(N_PORT, () => {
	console.log(`running on port ${N_PORT}`);
});
