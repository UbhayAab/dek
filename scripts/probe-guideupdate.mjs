// Behavioral guard for the rank-14 realtime half (e6d4b34): orientation.js
// binds a guide_update handler onto whatever channel object core currently
// holds under key 'chan' (bindChannel/getSub) and deletes the cache entry the
// payload names, so an edit made elsewhere heals your NEXT open instead of
// serving yesterday's guide forever. d146ff8 named exactly this as its
// accepted gap: no socket existed in the harness, so the broadcast half rode
// on faith. This probe closes it the way the socket itself does - the REAL
// booted subscription is created by the real openChannel() -> subscribe()
// path, the probe wraps js/sb.js's public sb.channel export to capture the
// callback that registration actually installed on the live channel object,
// and delivers one broadcast frame into it. Nothing about orientation.js is
// mocked or imported twice; the counts come off counted get_channel_guide
// POSTs answered by context.route.
//
//   LEG A init bind: first open of cA costs one fetch, paints the welcome
//        banner, and a guide_update handler is really bound onto the live
//        'ch:cA' object (captured through the wrapped registration).
//   LEG B warm cache baseline: reopening cA costs nothing - the invalidation
//        assertions below mean something only against this.
//   LEG C targeting: a broadcast naming an UNKNOWN channel clears nothing -
//        reopening cA stays at one fetch (payload-targeted delete, not a
//        blanket clear).
//   LEG D heal: the broadcast naming cA fires through the real handler; the
//        next open costs exactly one more fetch and paints the FRESH answer
//        (v2 carries an open ask) - proof the refetch result, not the old
//        entry, is what the cache now serves.
//   LEG E rebind across switches: opening cB replaces the 'chan' object;
//        orientation must rebind onto the NEW one, and a frame delivered
//        through THAT object still deletes cA's entry (attempts 2 -> 3 on the
//        next cA open).
//
// Accepted gap, named: message rows are not seeded (get_channel_messages
// answers null), so #messages shows the channel-born empty card; the ask card
// paint runs through the real whenListReady against that settled list, which
// is all the contract needs.
//
// Usage: node scripts/probe-guideupdate.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forceTransport } from "./probe-transport.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { out.root = argv[++i]; }
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
console.log(`probe-guideupdate: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

// Hermetic Supabase. get_channel_guide is counted per p_channel and served
// from mutable per-channel answer maps, so legs can rewrite the truth mid-run
// exactly the way a colleague editing the guide would.
const state = {
  attempts: new Map(), lastArgs: new Map(),
  purpose: new Map(), asks: new Map(), names: new Map(),
};
function wireGuideRoute(context) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    if (name === "get_channel_guide") {
      const ch = String(body.p_channel || "?");
      state.attempts.set(ch, (state.attempts.get(ch) || 0) + 1);
      state.lastArgs.set(ch, body);
      const payload = {
        channel_id: ch,
        channel_name: state.names.get(ch) || ch,
        purpose: state.purpose.get(ch) ?? ("Purpose of " + ch),
        body: "",
        topic: "",
        seen: false,
        pins: [],
        open_asks: state.asks.get(ch) || [],
        can_edit: false,
        member_count: 3,
        updated_at: null,
        updated_by: null,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    }
    if (name === "get_drafts" || name === "save_draft" || name === "delete_draft"
      || name === "mark_guide_seen" || name === "get_channel_messages") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

const ATTACHED = { state: "attached", timeout: 15_000 };
async function waitGuideBound(page, topic, label) {
  const got = await page.waitForFunction(
    (t) => !!window.__guideProbe?.handlers.get(t),
    topic,
    { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  ok(got, `${label}: no guide_update handler was ever bound onto ${topic}`);
  return got;
}
// Deliver one broadcast frame into the callback registration really installed.
async function fireGuideUpdate(page, topic, channelId) {
  return page.evaluate(([t, cid]) => {
    const cb = window.__guideProbe.handlers.get(t);
    if (!cb) return false;
    cb({ payload: { channel_id: cid } });
    return true;
  }, [topic, channelId]);
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceTransport(context, ROOT);
  await wireGuideRoute(context);
  state.names.set("cA", "alpha").set("cB", "beta");
  const chans = [
    { id: "cA", name: "alpha", position: 1000 },
    { id: "cB", name: "beta", position: 2000 },
  ];

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "app never reached the features-loaded boot line within 45s");

  // Capture, NOT mock: every channel object below is created by the real
  // subscribe() path; we only record what registers onto it, verbatim.
  await page.evaluate(async () => {
    const sbm = await import("/js/sb.js");
    window.__guideProbe = { handlers: new Map() };
    const orig = sbm.sb.channel.bind(sbm.sb);
    sbm.sb.channel = (...a) => {
      const ch = orig(...a);
      if (/^ch:/.test(String(a[0]))) {
        const origOn = ch.on.bind(ch);
        ch.on = (type, filter, cb) => {
          if (type === "broadcast" && filter && filter.event === "guide_update") {
            window.__guideProbe.handlers.set(a[0], cb);
          }
          return origOn(type, filter, cb);
        };
      }
      return ch;
    };
  });

  // ---- LEG A: init bind -------------------------------------------------
  await page.evaluate(async (cs) => {
    const { store } = await import("/js/store.js");
    store.me = { id: "u-me", name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.channels = cs;
    store.unread = new Map();
    store.notify = new Map();
    store.dms = [];
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cA"));
  }, chans);

  await page.waitForSelector(".ori-banner", ATTACHED)
    .catch(() => problems.push("A: first open of cA never painted the welcome banner"));
  ok(state.attempts.get("cA") === 1,
    `A: first open should cost exactly 1 guide fetch, got ${state.attempts.get("cA")}`);
  ok(state.lastArgs.get("cA")?.p_channel === "cA",
    `A: outbound guide POST did not carry p_channel:cA (${JSON.stringify(state.lastArgs.get("cA"))})`);
  const bannerText = await page.$eval(".ori-banner", (n) => n.textContent).catch(() => "");
  ok(/alpha/.test(bannerText), `A: banner does not name the channel (${JSON.stringify(bannerText)})`);
  await waitGuideBound(page, "ch:cA", "A");

  // ---- LEG B: warm cache baseline ---------------------------------------
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cA"));
  });
  await sleep(900);
  ok(state.attempts.get("cA") === 1,
    `B: warm reopen refetched (${state.attempts.get("cA")} - cache-first lost, D/E mean nothing)`);

  // ---- LEG C: targeting --------------------------------------------------
  let fired = await fireGuideUpdate(page, "ch:cA", "cZZ");
  ok(fired, "C: could not deliver the foreign-channel frame into the real handler");
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cA"));
  });
  await sleep(900);
  ok(state.attempts.get("cA") === 1,
    `C: a broadcast naming cZZ cleared cA's entry (${state.attempts.get("cA")} fetches, want 1)`);

  // ---- LEG D: the heal ----------------------------------------------------
  state.purpose.set("cA", "Fresh purpose v2");
  state.asks.set("cA", [{ message_id: "m-ask-1", body_text: "Confirm the safety note" }]);
  fired = await fireGuideUpdate(page, "ch:cA", "cA");
  ok(fired, "D: could not deliver the cA frame into the real handler");
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cA"));
  });
  await page.waitForSelector(".ori-card", ATTACHED)
    .catch(() => problems.push("D: invalidated reopen never painted the fresh ask card"));
  ok(state.attempts.get("cA") === 2,
    `D: post-broadcast open must cost exactly 1 more fetch, total ${state.attempts.get("cA")} (want 2)`);
  const cardText = await page.$eval(".ori-card", (n) => n.textContent).catch(() => "");
  ok(cardText.includes("Confirm the safety note"),
    `D: card does not carry the fresh ask (${JSON.stringify(cardText.slice(0, 160))})`);
  ok(cardText.includes("Fresh purpose v2"),
    `D: card is not built from the refetched answer (${JSON.stringify(cardText.slice(0, 160))})`);

  // ---- LEG E: rebind across the switch -----------------------------------
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cB"));
  });
  await sleep(600); // cold fetch of cB settles
  ok(state.attempts.get("cB") === 1,
    `E: first open of cB should cost 1 fetch, got ${state.attempts.get("cB")}`);
  if (await waitGuideBound(page, "ch:cB", "E")) {
    fired = await fireGuideUpdate(page, "ch:cB", "cA");
    ok(fired, "E: could not deliver cA's frame through the cB-era binding");
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      await openChannel(store.channels.find((c) => c.id === "cA"));
    });
    await sleep(900);
    ok(state.attempts.get("cA") === 3,
      `E: invalidation did not follow the switched channel object (cA total ${state.attempts.get("cA")}, want 3)`);
  }

  ok(pageerrors.length === 0, `pageerrors: ${pageerrors.join(" | ")}`);
  await context.close();
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-guideupdate");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-guideupdate");
process.exit(0);
