#!/usr/bin/env node
// Deploy Edge Functions through the Management API: the same multipart call that
// `supabase functions deploy --use-api` makes, so no CLI, Docker or Deno is needed
// here. Supabase bundles server side.
//
//   node tools/deploy-fn.mjs <name> [<name> ...]   deploy, then probe without credentials
//   node tools/deploy-fn.mjs --list                 what is deployed now
//
// Every Dek function is deployed with verify_jwt false. This project signs tokens
// with ES256 keys and the legacy JWT secret is revoked, so the gateway cannot verify
// them: push-dispatch checks x-dek-internal, auth-email the hook signature, and the
// user-facing functions verify the caller's JWT themselves (auth.getUser/getClaims).
// The probe after each deploy is a credential-less POST; it must be refused by the
// function itself (proof that it is live and that verify_jwt really is off).
//
// Files: supabase/functions/<name>/** plus supabase/functions/_shared/** when that
// exists, uploaded with project-relative paths so '../_shared/x.ts' resolves. Test
// files and Markdown stay home. Prints names, sizes and versions, never a secret.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, mgmt, need } from './lib/env.mjs';

const { SUPABASE_PROJECT_REF: ref, SUPABASE_ACCESS_TOKEN: token } = need('SUPABASE_PROJECT_REF', 'SUPABASE_ACCESS_TOKEN');
const FN_DIR = join(ROOT, 'supabase', 'functions');
const SKIP = /(\.test\.[cm]?[jt]s|\.md|\.DS_Store)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!SKIP.test(name)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

async function probe(name) {
  const res = await fetch(`https://${ref}.supabase.co/functions/v1/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
  return `${res.status} ${text}`;
}

async function deploy(name) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`bad function name "${name}"`);
  const dir = join(FN_DIR, name);
  const entry = join(dir, 'index.ts');
  if (!existsSync(entry)) throw new Error(`${name}: ${rel(entry)} not found`);
  const files = walk(dir);
  const shared = join(FN_DIR, '_shared');
  if (existsSync(shared)) files.push(...walk(shared));

  const metadata = { entrypoint_path: rel(entry), name, verify_jwt: false };
  if (existsSync(join(dir, 'deno.json'))) metadata.import_map_path = rel(join(dir, 'deno.json'));
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  let bytes = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    bytes += buf.length;
    form.append('file', new Blob([buf]), rel(f));
  }
  // The slug must be in the query string: without it the API mints a UUID slug and
  // still answers 200 (it happened on the legacy project).
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: deploy failed, HTTP ${res.status}: ${text.slice(0, 600)}`);
  const fn = await mgmt('GET', `/v1/projects/${ref}/functions/${name}`);
  console.log(`deployed ${name}: version ${fn.version}, ${fn.status}, verify_jwt ${fn.verify_jwt}, ${files.length} files, ${bytes} bytes`);
  if (fn.verify_jwt !== false) throw new Error(`${name}: verify_jwt is ${fn.verify_jwt}, expected false`);
  console.log(`  probe without credentials: ${await probe(name)}`);
}

async function list() {
  const fns = await mgmt('GET', `/v1/projects/${ref}/functions`);
  for (const f of fns) {
    console.log(`${f.slug.padEnd(18)} v${String(f.version).padEnd(4)} ${f.status.padEnd(8)} verify_jwt=${f.verify_jwt} updated ${new Date(f.updated_at).toISOString()}`);
  }
  if (!fns.length) console.log('no functions deployed');
}

const args = process.argv.slice(2);
try {
  if (!args.length) throw new Error('usage: node tools/deploy-fn.mjs <name> [<name> ...] | --list');
  if (args[0] === '--list') await list();
  else for (const name of args) await deploy(name);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
