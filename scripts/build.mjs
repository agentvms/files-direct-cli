// npm run build: the program as one readable file (no minifying) in dist/, with the packages that carry native or large code left out of it.
// The version comes from package.json and the site's address from site.json, never from the source.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const origin = process.env.FD_BUILD_ORIGIN ?? JSON.parse(readFileSync('site.json', 'utf8')).origin;

// The worker that makes the small pictures of photos (cli/src/preview-worker.ts) is built apart, with its three picture readers, and kept in the file as text: the program starts it from there when it first needs it,
// so the file stays the one file. The comments esbuild adds for each module's path are left out (they differ between this checkout and the public one).
const worker = (
  await build({ entryPoints: ['src/cli/src/preview-worker.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', minify: false, legalComments: 'none', logLevel: 'silent' })
).outputFiles[0].text
  .split('\n')
  .filter((l) => !/^\/\/ /.test(l))
  .join('\n');

// ...in pieces of 400 characters, one to a line, written at the top of the file under a name of its own; the program joins them when it starts the worker.
// (The packed program may not hold a line over 1000 characters, its pack check; esbuild would write the pieces as one line, so they are written here.)
const parts = Array.from({ length: Math.ceil(worker.length / 400) }, (_, i) => JSON.stringify(worker.slice(i * 400, i * 400 + 400)));
const workerPieces = `const fdPreviewWorkerPieces = [\n${parts.join(',\n')},\n];`;

await build({
  entryPoints: ['src/cli/src/main.ts'],
  outfile: 'dist/files-direct.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  external: ['node-datachannel', 'node-datachannel/polyfill', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'zod'],
  banner: { js: '#!/usr/bin/env node\n' + workerPieces },
  define: { __FD_PREVIEW_WORKER__: 'fdPreviewWorkerPieces', __FD_VERSION__: JSON.stringify(pkg.version), __FD_ORIGIN__: JSON.stringify(origin) },
  logLevel: 'info',
});
