// OWNER: core platform builder. Compiles src/sw/sw.ts to dist/sw.js and injects the
// list of files this build emitted, plus a version derived from their contents
// (never hand-typed: a forgotten bump strands installed apps on old code).
//
// Paths are URL paths with forward slashes on every OS: on Windows, path.relative
// returns backslashes, and a precache entry like "/assets\index.js" 404s, which
// fails the worker's install so it never activates.
import { build } from 'esbuild';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const entry = fileURLToPath(new URL('../src/sw/sw.ts', import.meta.url));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);

const toUrlPath = (file) => '/' + relative(dist, file).split(sep).join('/').replace(/\\/g, '/');

const entries = files
  .map((f) => ({ file: f, url: toUrlPath(f) }))
  .filter(({ url }) => !url.endsWith('.map') && url !== '/sw.js' && url !== '/version.json' && !url.startsWith('/_'))
  .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

for (const { url } of entries) {
  if (url.includes('\\') || url.includes('//')) throw new Error(`bad precache path ${url}`);
}

// The version hashes the precached files in path order plus the worker's own
// sources, so the same build gives the same version on Windows and Linux, and a
// change to the worker alone still gets a new version.
const hash = createHash('sha256');
for (const { file, url } of entries) {
  hash.update(url);
  hash.update(readFileSync(file));
}
const swDir = fileURLToPath(new URL('../src/sw/', import.meta.url));
for (const name of readdirSync(swDir).filter((n) => n.endsWith('.ts')).sort()) {
  hash.update(name);
  hash.update(readFileSync(join(swDir, name), 'utf8').replace(/\r\n/g, '\n'));
}
const version = hash.digest('hex').slice(0, 12);
const precache = entries.map((e) => e.url);

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  outfile: join(dist, 'sw.js'),
  define: {
    'self.__DEK_PRECACHE': JSON.stringify(precache),
    'self.__DEK_VERSION': JSON.stringify(version),
  },
});
writeFileSync(join(dist, 'version.json'), JSON.stringify({ version, files: precache.length }));
console.log(`sw.js built: version ${version}, ${precache.length} files precached`);
