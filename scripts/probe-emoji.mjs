// Behavioral guard for js/core/emoji.js.
// The module shipped with its header betting "one cached list_custom_emoji read
// per Space per minute" and a self-loading Custom tab, but nothing ever ran the
// search/recent/registry machinery headless. Every claim below is deterministic:
//
//   LEG A  searchEmoji: empty/whitespace -> [], case-insensitive trim (GRIN
//          finds the grin cell), keyword-alias lookup (lol -> laugh cell),
//          startswith-before-contains ordering (the startswith "love" cells
//          precede the contains-only "heart eyes|love" one), and the 80-row
//          cap when a query like "a" matches most of the table.
//   LEG B  recents: fresh empty, noteEmoji dedupes to the front, capped at 36.
//   LEG C  registry cache (wire-counted list_custom_emoji): the first
//          refreshCustomEmoji with a seeded workspace costs exactly ONE read
//          carrying p_workspace and populates the keys map lowercased plus one
//          customEmoji:changed emit; a second call inside the 60s window costs
//          ZERO reads; a forced call costs exactly one more and re-emits.
//   LEG D  hydrateCustomEmoji: fills signed URLs onto <img class="cemoji"> and
//          a dead URL degrades back to the literal :name: text, never a broken
//          <img>.
//
// Negative test (separate run): widen emoji.js's registry TTL from 60000 to
// 1e9 - exactly leg C's no-reread assert must fail while A/B/D stay green,
// attributing the proof to the per-minute gate alone.
//
// Usage: node scripts/probe-emoji.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (err) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-emoji: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Wire counters for the registry read.
let customPosts = [];
let customBodies = [];

try {
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // ---- LEG A + B: pure search + recents, no network.
  const pure = await page.evaluate(async () => {
    const E = await import("/js/core/emoji.js");
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const chars = (arr) => arr.map((e) => e.ch);

    eq(E.searchEmoji(""), [], "A empty query");
    eq(E.searchEmoji("   "), [], "A whitespace query");
    eq(chars(E.searchEmoji("GRIN")), ["😀"], "A case-insensitive grin (trim + lower)");
    eq(chars(E.searchEmoji("smile")), ["😃", "😀"], "A smile startswith order");
    eq(chars(E.searchEmoji("100")), ["💯"], "A keyword-alias 100");
    eq(chars(E.searchEmoji("lol")), ["😆", "🍭", "😂"], "A keyword alias lol order");
    const love = chars(E.searchEmoji("love"));
    eq(love.slice(0, 3), ["🥰", "🤟", "😍"], "A love startswith before contains-only ordering");
    if (love.length !== 6) bad.push(`A love result count, got ${love.length}`);
    const a = E.searchEmoji("a");
    if (a.length !== 80) bad.push(`A 80-row cap, got ${a.length}`);
    eq(chars(a.slice(-1)), [a[a.length - 1].ch], "A cap array shape stays emoji cells");

    // ---- LEG B: recents
    E.noteEmoji("😀");
    E.noteEmoji("👍");
    E.noteEmoji("😀"); // duplicate -> moves to front, no second copy
    eq(E.recentEmoji(), ["😀", "👍"], "B recents dedupe to front");
    for (let i = 0; i < 40; i++) E.noteEmoji("x" + i);
    const r = E.recentEmoji();
    eq(r.length, 36, "B recents cap at 36");
    eq(r[0], "x39", "B newest lands front after cap");

    return { bad };
  });
  problems.push(...pure.bad);

  // ---- LEG C + D: registry over the wire.
  const cpost = (route) => {
    const req = route.request();
    const body = req.postDataJSON ? req.postDataJSON() : {};
    customPosts.push(req.postData());
    customBodies.push(body);
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify([
      { name: "PartyParrot", image_key: "k-parrot" },
      { name: "blob_fire", image_key: "k-fire" },
    ]) });
  };
  await context.route("**/rest/v1/rpc/list_custom_emoji", cpost);
  // The real function takes BOTH shapes - {object_key} and {object_keys: []},
  // see supabase/functions/mint-download/index.ts. This stub only spoke the
  // singular one, so it started failing the moment hydrateCustomEmoji was
  // changed to batch its mint the way hydrateMedia already did. The stub was
  // the stale half, not the app: a probe implementing half a contract fails
  // any caller that uses the other half. k-missing stays absent from the batch
  // reply so the dead-key degrade path is still exercised.
  await context.route("**/functions/v1/mint-download", (route) => {
    const body = route.request().postDataJSON ? route.request().postDataJSON() : {};
    if (Array.isArray(body.object_keys)) {
      const urls = {};
      for (const k of body.object_keys) {
        if (k !== "k-missing") urls[k] = "https://cdn.example/img.png";
      }
      route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ urls, exp: 9999999999 }),
      });
      return;
    }
    const missing = body.object_key === "k-missing";
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(missing ? {} : { url: "https://cdn.example/img.png", exp: 9999999999 }) });
  });

  const wire = await page.evaluate(async () => {
    const E = await import("/js/core/emoji.js");
    const { store } = await import("/js/store.js");
    const { bus } = await import("/js/store.js");
    store.ws = { id: "ws-emo", name: "Emo" };
    const bad = [];
    const emits = [];
    bus.on("customEmoji:changed", () => emits.push(1));

    await E.refreshCustomEmoji();
    let keys = [...E.customEmojiKeys().keys()];
    bad.push(JSON.stringify(keys) !== '["partyparrot","blob_fire"]'
      ? `C keys lowercased ${JSON.stringify(keys)}, want [partyparrot,blob_fire]` : null);

    await E.refreshCustomEmoji(); // inside window -> no re-read
    await E.refreshCustomEmoji();
    bad.push(emits.length !== 1 ? `C one emit after the no-force window, got ${emits.length}` : null);

    await E.refreshCustomEmoji(true); // forced
    bad.push(emits.length !== 2 ? `C forced re-emits, got ${emits.length}` : null);

    // ---- LEG D
    const host = document.createElement("div");
    host.innerHTML = `<img class="cemoji" data-key="k-parrot" alt=":partyparrot:"><img class="cemoji" data-key="k-missing" alt=":missing:">`;
    document.body.appendChild(host);
    await E.hydrateCustomEmoji(host);
    const src0 = host.querySelectorAll("img.cemoji")[0] && host.querySelectorAll("img.cemoji")[0].getAttribute("src");
    const replaced = host.querySelectorAll("img.cemoji")[1] ? null : "gone";
    bad.push(!src0 ? `D live key filled a src, got ${src0}` : null);
    bad.push(replaced !== "gone" ? `D dead key degraded, got ${host.innerHTML}` : null);

    return { bad: bad.filter(Boolean) };
  });
  problems.push(...wire.bad);

  const pws = customBodies.map((b) => b.p_workspace).filter((x) => x);
  ok(customPosts.length === 2, `C exactly two list_custom_emoji reads total, got ${customPosts.length}`);
  ok(pws.length === 2 && pws.every((w) => w === "ws-emo"), `C every read carries the seeded workspace, got ${JSON.stringify(pws)}`);

  // attribution detail: both reads = the first call and the forced call;
  // the two within-window calls must not have re-read.
} catch (e) {
  console.error("SETUP FAILURE:", e.message);
  process.exitCode = 2;
} finally {
  if (errors.length) problems.push(`pageerrors: ${errors.length} (${errors[0]})`);
  await browser.close();
  server.close();
}

if (process.exitCode !== 2) {
  console.log("legs: A search | B recents | C registry cache | D hydrate");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
