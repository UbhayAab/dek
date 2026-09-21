// Publish ONLY what a browser loads.
//
// `wrangler pages deploy .` uploads the working directory, which is this whole
// repository. Verified against production before this script existed:
//
//   /scripts/db-query.mjs               200
//   /scripts/probe-apps.mjs             200   <- the demo password is its default
//   /supabase/migrations/0112_apps.sql  200   <- every table, policy and function
//   /preview                            200   <- a mockup naming a real customer
//
// No access token was ever in any of them - db-query reads one from a path
// outside the repo - but the entire database schema and a working set of demo
// credentials were downloadable by anybody who guessed a filename.
//
// A .assetsignore file does NOT fix this: it is honoured by Workers Assets, not
// by `wrangler pages deploy`, which was confirmed by deploying one and finding
// /scripts/db-query.mjs still 200 on the fresh deployment URL. So the directory
// that gets uploaded has to genuinely contain only web assets.
//
// This DENIES rather than allows. An allow-list is the version that silently
// stops shipping a stylesheet somebody added last week; a deny-list fails in the
// safe direction, by shipping one file too many rather than one too few.
//
// Usage: node scripts/deploy-web.mjs [--dry]
import {
  cpSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

// Tooling, history, secrets-adjacent things, and anything a browser never asks
// for. Directory names and exact filenames; extensions are handled below.
const DENY_DIRS = new Set([
  'scripts', 'supabase', 'node_modules', 'shots', 'screenshots', 'docs', 'qa',
  // 's' is the smoke/burst screenshot directory. Sixty development screenshots
  // of the app mid-test were published to the live site because this list did
  // not know the name. Nothing in them was secret; that is not the point, and
  // it is the second time a directory has shipped because a deny-list had to be
  // told about it by hand. See gitIgnored() below for the general fix.
  's',
  '.git', '.github', '.githooks', '.wrangler', '.claude',
]);
const DENY_FILES = new Set([
  'package.json', 'package-lock.json', 'server.cjs', 'smoketest.mjs',
  '.assetsignore', '.gitignore',
]);
const DENY_EXT = ['.md', '.sql', '.log'];

// Probe scripts live at the repo root as well as in scripts/.
const isProbe = (n) => /^probe-.*\.mjs$/.test(n);
// Scratch. A harness written at the repo root during a piece of work, left
// behind, swept up by `git add -A` and then SERVED - which is exactly what
// happened to a pair of __geo_forms files, 200 on the live site until somebody
// noticed. They held nothing sensitive; the deny-list is not the place to find
// that out. Anything a person would call temporary is named like this.
const isScratch = (n) => /^(__|tmp[-_.]|scratch[-_.])/i.test(n);

// ANYTHING THE REPOSITORY ALREADY SAYS IS NOT SOURCE.
//
// The list above is a deny-list, which fails safe in the right direction but
// only against names somebody thought of. Twice now a directory has been
// published because nobody added it: __geo_forms, and then 's' with sixty
// development screenshots in it. Both were already in .gitignore.
//
// So ask git. A top-level entry that is git-ignored is by definition a local
// artefact rather than part of the product, and that covers every future scratch
// directory without anybody having to remember. Best effort: if git is not
// available the explicit list above still applies.
function gitIgnored(names) {
  if (!names.length) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'],
      { cwd: ROOT, input: names.join('\n'), encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch (e) {
    // check-ignore exits 1 when NOTHING matched, which is a normal answer.
    if (e.status === 1) return new Set();
    console.warn('deploy-web: could not ask git what is ignored; using the explicit list only');
    return new Set();
  }
}

const topLevel = readdirSync(ROOT);
const IGNORED = gitIgnored(topLevel);

const denied = (name) => DENY_DIRS.has(name)
  || IGNORED.has(name)
  || isScratch(name)
  || DENY_FILES.has(name)
  || DENY_EXT.some((e) => name.endsWith(e))
  || isProbe(name);

const staged = mkdtempSync(join(tmpdir(), 'dek-web-'));
const kept = [];
const skipped = [];

for (const name of topLevel) {
  if (denied(name)) { skipped.push(name); continue; }
  const from = join(ROOT, name);
  cpSync(from, join(staged, name), { recursive: statSync(from).isDirectory() });
  kept.push(name);
}

console.log('publishing :', kept.sort().join(' '));
console.log('withheld   :', skipped.sort().join(' '));

// A deploy that has quietly dropped the application is worse than one that
// shipped a stray file, so refuse rather than publish a broken site.
for (const must of ['index.html', 'sw.js', 'js', 'css']) {
  if (!existsSync(join(staged, must))) {
    console.error(`REFUSING: ${must} is missing from the staged directory`);
    rmSync(staged, { recursive: true, force: true });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Stamp sw.js with a version DERIVED from the bytes being shipped.
//
// VERSION was a hand-typed constant and nothing checked it. That was survivable
// while the service worker fetched code network-first: a forgotten bump only
// meant the precache lagged, and the network still served the new files. It is
// not survivable now that the code branch is cache-first, because a forgotten
// bump would freeze every installed client on old JavaScript indefinitely and
// silently.
//
// So it stops being something to remember. The version is the hash of what is
// in the staged directory, which cannot disagree with what is deployed.
const swHash = createHash('sha256');
const digestOf = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { digestOf(p); continue; }
    if (!/\.(html|js|mjs|css|webmanifest)$/i.test(name)) continue;
    if (name === 'sw.js') continue;        // it carries the hash; it cannot hash itself
    swHash.update(relative(staged, p).split(sep).join('/'));
    swHash.update(readFileSync(p));
  }
};
digestOf(staged);
const stamp = 'dek-' + swHash.digest('hex').slice(0, 12);

const swPath = join(staged, 'sw.js');
const swSrc = readFileSync(swPath, 'utf8');
const stamped = swSrc.replace(/const VERSION = '[^']*';/, `const VERSION = '${stamp}';`);
if (stamped === swSrc) {
  console.error('REFUSING: could not find the VERSION constant to stamp in sw.js');
  rmSync(staged, { recursive: true, force: true });
  process.exit(1);
}
writeFileSync(swPath, stamped);
console.log('sw version :', stamp, '(derived from the staged bytes)');

if (process.argv.includes('--dry')) {
  console.log('dry run, staged at', staged);
  process.exit(0);
}

try {
  // shell: true because node refuses to spawn a .cmd shim directly on Windows,
  // and the staged path is one we made ourselves in the OS temp dir.
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler.cmd'), [
    'pages', 'deploy', `"${staged}"`,
    '--project-name=dek', '--branch=main', '--commit-dirty=true',
  ], { stdio: 'inherit', shell: true });
} finally {
  rmSync(staged, { recursive: true, force: true });
}
