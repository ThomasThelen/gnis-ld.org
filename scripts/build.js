// Usage: node scripts/build.js [--watch]
const fs = require('fs');
const path = require('path');

const esbuild = require('esbuild');
const less = require('less');

const PD_ROOT = path.resolve(__dirname, '..');
const PD_STYLES = path.join(PD_ROOT, 'lib/webapp/_styles');
const PD_DIST_STYLES = path.join(PD_ROOT, 'dist/webapp/_styles');
const PD_DIST_JS = path.join(PD_ROOT, 'dist/js');

const A_ENTRIES = ['lib/js/queries.ts', 'lib/js/search.ts'];

const B_WATCH = process.argv.includes('--watch');

/**
 * Bundles the page scripts with esbuild.
 *
 * @returns {Promise<void>} Resolves when the bundle (or watcher) is ready.
 */
async function build_js() {
	const h_options = {
		entryPoints: A_ENTRIES.map((s) => path.join(PD_ROOT, s)),
		bundle: true,
		minify: true,
		sourcemap: true,
		outdir: PD_DIST_JS,
	};
	if (B_WATCH) {
		const y_ctx = await esbuild.context(h_options);
		await y_ctx.watch();
	} else {
		await esbuild.build(h_options);
	}
	console.log(`bundled ${A_ENTRIES.length} scripts -> dist/js`);
}

/**
 * Compiles the LESS stylesheets, rebuilding on change in watch mode.
 *
 * @returns {Promise<void>} Resolves when the stylesheets are written.
 */
async function build_css() {
	fs.mkdirSync(PD_DIST_STYLES, { recursive: true });
	const a_files = fs.readdirSync(PD_STYLES).filter((s) => s.endsWith('.less'));
	for (const s_file of a_files) {
		const p_src = path.join(PD_STYLES, s_file);
		const { css } = await less.render(fs.readFileSync(p_src, 'utf8'), {
			filename: p_src,
			compress: true,
		});
		fs.writeFileSync(path.join(PD_DIST_STYLES, s_file.replace(/\.less$/, '.css')), css);
	}
	console.log(`compiled ${a_files.length} stylesheets -> dist/webapp/_styles`);
	if (B_WATCH) {
		fs.watch(PD_STYLES, () => build_css().catch((e) => console.error(e.message)));
	}
}

/**
 * Bundles the server with esbuild.
 *
 * @returns {Promise<void>} Resolves when the bundle (or watcher) is ready.
 */
async function build_server() {
	const h_options = {
		entryPoints: [path.join(PD_ROOT, 'lib/js/server.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		sourcemap: true,
		outfile: path.join(PD_ROOT, 'dist/server.js'),
	};
	if (B_WATCH) {
		const y_ctx = await esbuild.context(h_options);
		await y_ctx.watch();
	} else {
		await esbuild.build(h_options);
	}
	console.log('bundled server -> dist/server.js');
}

Promise.all([build_js(), build_css(), build_server()]).catch((e_build) => {
	console.error(e_build);
	process.exit(1);
});
