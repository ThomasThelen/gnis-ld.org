export interface AppConfig {
	archive_path: string;
	data_host: string;
	data_path: string;
	data_uri: string;
	geom_uri: string;
	sparql_endpoint: string;
	port: number;
	prefixes: Record<string, string>;
}

const S_DATA_PATH = process.env.USGS_DATA_PATH || '/lod';
// The graph store's SPARQL endpoint
const P_ENDPOINT = process.env.USGS_ENDPOINT_URL || 'http://localhost:7200/repositories/gnis-ld';
const DEPLOYMENT_HOST = process.env.BASE || 'gnis-ld.org';

const P_DATA_URI = `http://${DEPLOYMENT_HOST}${S_DATA_PATH}`;
// Geometry URIs live directly under the host (no /lod), matching the
// triplifier's GEO_BASE
const P_GEOM_URI = `http://${DEPLOYMENT_HOST}/geometry`;


// Directory holding archived database dumps, served at /archive.
// In production this is a mounted volume; relative paths resolve from the
// project root.
const S_ARCHIVE_PATH = process.env.USGS_ARCHIVE_PATH || 'archives';

const app_config: AppConfig = {
	archive_path: S_ARCHIVE_PATH,
	data_host: DEPLOYMENT_HOST,
	data_path: S_DATA_PATH,
	data_uri: P_DATA_URI,
	geom_uri: P_GEOM_URI,
	sparql_endpoint: P_ENDPOINT,
	port: 3006,
	prefixes: {
		rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
		rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
		xsd: 'http://www.w3.org/2001/XMLSchema#',
		qudt: 'http://qudt.org/schema/qudt/',
		unit: 'http://qudt.org/vocab/unit/',
		geosparql: 'http://www.opengis.net/ont/geosparql#',
		ago: 'http://awesemantic-geo.link/ontology/',

		usgs: `${P_DATA_URI}/usgs/ontology/`,
		gnis: `${P_DATA_URI}/gnis/ontology/`,
		gnisf: `${P_DATA_URI}/gnis/feature/`,
		nhd: `${P_DATA_URI}/nhd/ontology/`,
		nhdf: `${P_DATA_URI}/nhd/feature/`,
		cegis: `${P_DATA_URI}/cegis/ontology/`,
		cegisf: `${P_DATA_URI}/cegis/feature/`,
		'usgeo-point': `${P_GEOM_URI}/point/`,
		'usgeo-multipoint': `${P_GEOM_URI}/multipoint/`,
		'usgeo-linestring': `${P_GEOM_URI}/linestring/`,
		'usgeo-multilinestring': `${P_GEOM_URI}/multilinestring/`,
		'usgeo-polygon': `${P_GEOM_URI}/polygon/`,
		'usgeo-multipolygon': `${P_GEOM_URI}/multipolygon/`,
	},
};

export default app_config;
