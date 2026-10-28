#!/usr/bin/env node
// Builds the web app and publishes it to the Cloudflare Pages project "dek".
//
//   node tools/deploy-web.mjs              production: branch main, https://dek-7o4.pages.dev
//   node tools/deploy-web.mjs --preview    preview: branch rebuild, https://rebuild.dek-7o4.pages.dev
//   node tools/deploy-web.mjs --dry-run    build and check only, upload nothing
//
// Pushing to git ships nothing; this script is the only way the site changes. A
// production deploy refuses a dirty working tree, so what is live is always a commit.
// After the upload it fetches /version.json from the deployment and compares it with
// the build: "deployed" means the new files are being served, not that wrangler exited 0.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = ['--preview', '--dry-run'];
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !FLAGS.includes(a));
if (unknown.length) {
  console.error(`unknown flag: ${unknown.join(' ')}\nusage: node tools/deploy-web.mjs [--preview] [--dry-run]`);
  process.exit(2);
}
const preview = args.has('--preview');
const branch = preview ? 'rebuild' : 'main';
const WIN = process.platform === 'win32';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
if (!preview && dirty && !args.has('--dry-run')) {
  console.error('refusing a production deploy from a working tree with uncommitted changes: commit first');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const buildId = `${sha}${dirty ? '-dirty' : ''}-${stamp}`;

const env = { ...process.env, VITE_BUILD_ID: buildId, VITE_APP_ENV: preview ? 'preview' : 'production' };
const build = spawnSync(WIN ? 'npm.cmd' : 'npm', ['--workspace', 'apps/web', 'run', 'build'],
  { cwd: ROOT, env, stdio: 'inherit', shell: WIN });
if (build.status !== 0) process.exit(build.status ?? 1);

const dist = join(ROOT, 'apps', 'web', 'dist');
for (const f of ['index.html', 'sw.js', 'version.json', '_headers', 'manifest.webmanifest']) {
  if (!existsSync(join(dist, f))) {
    console.error(`the build is missing ${f}`);
    process.exit(1);
  }
}
const { version } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
console.log(`build ${buildId}, version ${version}`);
if (args.has('--dry-run')) process.exit(0);

// wrangler from this repo when installed, otherwise the pinned version the legacy app used
const local = join(ROOT, 'node_modules', '.bin', WIN ? 'wrangler.cmd' : 'wrangler');
const [cmd, pre] = existsSync(local) ? [local, []] : [WIN ? 'npx.cmd' : 'npx', ['--yes', 'wrangler@4.147.0']];
const up = spawnSync(cmd, [...pre, 'pages', 'deploy', dist, '--project-name=dek', `--branch=${branch}`,
  '--commit-dirty=true', `--commit-message=${buildId}`], { cwd: ROOT, encoding: 'utf8', shell: WIN });
process.stdout.write(up.stdout ?? '');
process.stderr.write(up.stderr ?? '');
if (up.status !== 0) process.exit(up.status ?? 1);

const said = `${up.stdout ?? ''}${up.stderr ?? ''}`;
const deployment = said.match(/https:\/\/[a-z0-9-]+\.dek-7o4\.pages\.dev/)?.[0];
const alias = preview ? 'https://rebuild.dek-7o4.pages.dev' : 'https://dek-7o4.pages.dev';
for (const target of [deployment, alias].filter(Boolean)) {
  let live = false;
  for (let i = 0; i < 12 && !live; i += 1) {
    try {
      const r = await fetch(`${target}/version.json`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      live = r.ok && (await r.json()).version === version;
    } catch {
      // not reachable yet: Pages propagates within seconds
    }
    if (!live) await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`${live ? 'LIVE' : 'NOT LIVE'} ${target} version ${version}`);
  if (!live) process.exitCode = 1;
}
