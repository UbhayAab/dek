// OWNER: core platform builder. Compiles src/sw/sw.ts to dist/sw.js and injects the
// list of files this build emitted, plus a version derived from their hashes (never
// hand-typed: a forgotten bump strands installed apps on old code).
import { build } from 'esbuild';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);
const precache = files
  .map((f) => '/' + relative(dist, f).split(/[\/]/).join('/'))
  .filter((f) => !f.endsWith('.map') && f !== '/sw.js' && !f.startsWith('/_'));
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(readFileSync(f));
const version = hash.digest('hex').slice(0, 12);

await build({
  entryPoints: [new URL('../src/sw/sw.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
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
