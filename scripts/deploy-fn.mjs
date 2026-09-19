// Deploy an edge function to Supabase via the Management API (no CLI needed).
// Usage: node scripts/deploy-fn.mjs <function-name>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name) { console.error('usage: node scripts/deploy-fn.mjs <fn-name>'); process.exit(1); }

const env = Object.fromEntries(
  readFileSync('C:/Users/abhay/Desktop/claude/dek-backend/.env.local', 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const REF = env.SUPABASE_PROJECT_REF, TOKEN = env.SUPABASE_ACCESS_TOKEN;

const dir = `supabase/functions/${name}`;
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (!f.endsWith('.md')) files.push(p);
  }
};
walk(dir);

// What is deployed right now, so a redeploy cannot quietly change a setting it
// was never asked to change.
const existing = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then((r) => (r.ok ? r.json() : [])).then((all) => all.find((f) => f.slug === name) || null)
  .catch(() => null);
if (existing) console.log(`existing ${name}: verify_jwt=${existing.verify_jwt} (preserved)`);

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({
  entrypoint_path: 'index.ts',
  name,
  // Never decided by a list in this file alone. A redeploy that silently flips a
  // public function to verify_jwt:true takes it off the internet, and the deploy
  // still answers 200 - which is exactly what happened to mail-otp, the sign-in
  // endpoint, when it was redeployed for an unrelated one-line change.
  //
  // So: an existing function KEEPS whatever it already has, and the list below
  // only decides the value for a function being created for the first time.
  //   soop-handoff - embed handoff, called before there is a session
  //   dek-app      - a cron job on a factory PC has no Supabase JWT; the
  //                  function is its own boundary via private.app_ctx
  //   mail-otp     - the sign-in door itself; requiring a JWT to get one is a
  //                  deadlock
  verify_jwt: existing ? existing.verify_jwt
    : !['soop-handoff', 'dek-app', 'mail-otp'].includes(name),
})], { type: 'application/json' }), 'metadata.json');
for (const p of files) {
  form.append('file', new Blob([readFileSync(p)]), p.replaceAll('\\', '/').split(`functions/${name}/`)[1]);
}

// The slug MUST be in the query string. Without it the API mints a UUID slug and
// still answers 200, so the deploy "succeeds" and the function is unreachable at
// the name you deployed it under. That had already happened to an earlier deploy
// here, which is why a function with a UUID for a name is sitting in the project.
const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(name)}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
const text = await r.text();
console.log(r.ok ? `DEPLOYED ${name}` : `FAILED ${r.status}: ${text.slice(0, 400)}`);
