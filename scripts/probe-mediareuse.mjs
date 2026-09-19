// Does an image survive a cold start, or is it downloaded again every time?
//
// Reported: "a lot of downloading happens every time I open the app - the image
// is kind of downloaded every time, after clearing it from RAM I can see it
// downloading." That is not a feeling. It is exactly what the code does, and
// sw.js says so in its own comment:
//
//     It is still not CACHED - lruPut is skipped above because an opaque
//     body has no readable length and would poison the LRU accounting.
//     Served, not stored.
//
// An <img src> to another origin is a no-cors request, so a signed storage URL
// always comes back OPAQUE - status 0, ok false, type 'opaque'. The service
// worker serves it and deliberately does not store it. So the storage cache,
// which exists and is 150MB, holds nothing an <img> ever asked for, and every
// avatar and every photo is re-fetched on every cold start forever.
//
// This measures it against the REAL Supabase storage origin, because the thing
// under test is how a real cross-origin no-cors response behaves - a mock cannot
// produce an opaque response and would prove nothing.
//
//   1. first load: the object comes off the network
//   2. a SECOND page load, same service worker, with a FRESHLY SIGNED url whose
//      token differs: does it come off the network again?
//   3. and the cache is asked directly whether it holds a readable body
//
// "Off the network" means a response the service worker did NOT serve. The
// page's own <img> request fires either way; only one of them costs egress.
//
// A signed URL is minted here with the project's secret key, so this probe needs
// dek-backend/.env.local. It is skipped, not failed, when that is not readable.
//
// Usage: node scripts/probe-mediareuse.mjs
// Exit 0 PROBE CLEAN or SKIPPED, 1 PROBE FAILED.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --root points at a directory holding a sw.js. Used to measure the SAME probe
// against an older worker, which is the only way a before/after claim about
// bandwidth is worth anything.
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0
  ? path.resolve(process.argv[rootArg + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = "C:/Users/abhay/Desktop/claude/dek-backend/.env.local";

function env() {
  try {
    return Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)
      .filter((l) => l.includes("=")).map((l) => [
        l.slice(0, l.indexOf("=")).replace(/^\uFEFF/, ""), l.slice(l.indexOf("=") + 1).trim()]));
  } catch { return null; }
}
const E = env();
if (!E?.SUPABASE_SECRET_KEY || !E?.VITE_SUPABASE_URL) {
  console.log("probe-mediareuse: SKIPPED (no dek-backend/.env.local, cannot mint a signed URL)");
  process.exit(0);
}

// A real object, minted fresh each time so the token differs between loads -
// which is the whole point: the cache key must survive a rotating query string.
async function sign(objectKey) {
  const r = await fetch(`${E.VITE_SUPABASE_URL}/storage/v1/object/sign/attachments/${objectKey}`, {
    method: "POST",
    headers: {
      apikey: E.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${E.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 900 }),
  });
  if (!r.ok) return null;
  return `${E.VITE_SUPABASE_URL}/storage/v1${(await r.json()).signedURL}`;
}

const OBJECT = process.env.PROBE_OBJECT
  || "ws/019f993c-604e-7274-bf5c-8d1efb669e14/01a0627a-cc6f-7600-9a9a-8ee62622e3de.jpg";

const first = await sign(OBJECT);
if (!first) {
  console.log("probe-mediareuse: SKIPPED (could not sign a test object)");
  process.exit(0);
}

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page that registers the REAL service worker and paints one image.
const PAGE = (src) => `<!doctype html><meta charset=utf-8><title>m</title>
<body>${src ? `<img id=i src="${src}" alt="">` : ''}<script>
navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready);
</script>`;

let imgSrc = null;
const MIME = { ".js": "text/javascript", ".html": "text/html; charset=utf-8" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE(imgSrc));
    return;
  }
  const p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
  res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-mediareuse: serving ${ROOT} on ${BASE}`);

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  // Counted at the NETWORK layer, which sits below the service worker: a request
  // the worker answers out of its cache never reaches here, and one it fetches
  // does. That is the definition of egress, and it is the thing being paid for.
  //
  // Not `context.on('request')` - that fires for the page's own <img> either
  // way. Not `response.fromServiceWorker()` either: a fetch made BY the worker
  // is not reliably surfaced on the context's response stream at all, which is
  // how the first version of this probe managed to report zero downloads for a
  // load that plainly downloaded something.
  const hits = [];
  await context.route("**/storage/v1/object/**", async (route) => {
    hits.push(route.request().url());
    await route.continue();
  });

  const page = await context.newPage();
  // imgSrc is null for both of these: installing the worker must not warm the
  // cache the measurement is about.
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The worker only controls the page after a reload; the first load is not
  // under test, it is what installs the thing being tested.
  await page.reload({ waitUntil: "load" });
  await page.evaluate(() => navigator.serviceWorker.controller
    ? true : new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r)));
  await sleep(600);

  hits.length = 0;
  // Load 1, under the worker.
  imgSrc = await sign(OBJECT);
  await page.goto(BASE + "/?a", { waitUntil: "load" });
  await sleep(2500);
  const firstHits = hits.length;
  ok(firstHits >= 1, "the first load did not fetch the object at all - the test proves nothing");

  // Load 2: a COLD START. A brand new page, a freshly signed url whose token is
  // different, the same service worker and the same caches. This is "I closed
  // the app and opened it again".
  hits.length = 0;
  imgSrc = await sign(OBJECT);
  ok(imgSrc !== first, "the two signed urls are identical - the token did not rotate");
  await page.goto(BASE + "/?b", { waitUntil: "load" });
  await sleep(2500);
  const secondHits = hits.length;

  // And ask the cache directly.
  const stored = await page.evaluate(async (u) => {
    const key = new URL(u).origin + new URL(u).pathname;
    for (const name of await caches.keys()) {
      if (!name.includes("storage")) continue;
      const hit = await (await caches.open(name)).match(key);
      if (hit) {
        const b = await hit.clone().blob().catch(() => null);
        return { cached: true, cache: name, bytes: b ? b.size : -1, type: hit.type };
      }
    }
    return { cached: false };
  }, imgSrc);

  console.log(`probe-mediareuse: first load ${firstHits} network hit(s), `
    + `cold restart ${secondHits} network hit(s), cache ${JSON.stringify(stored)}`);

  ok(stored.cached === true,
    "the service worker stored NOTHING for this object - every cold start re-downloads it. "
    + "An <img> to another origin is a no-cors request, so the response is opaque and lruPut skips it.");
  ok(stored.cached && stored.bytes > 0,
    `the cached body is not readable (${stored.bytes} bytes) - an opaque body cannot be measured or reused`);
  ok(secondHits === 0,
    `a cold restart went back to the network ${secondHits} time(s) for an image it already had`);

  ok(true, "");
} catch (e) {
  problems.push("probe threw: " + (e?.message || e));
} finally {
  await browser.close();
  server.close();
}

const real = problems.filter(Boolean);
if (real.length) {
  console.error("PROBE FAILED");
  for (const p of real) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN");
