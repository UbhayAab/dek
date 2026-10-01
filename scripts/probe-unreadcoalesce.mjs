// Behavioral guard for the rank-1 main.js half of 6e650fb: the user-topic
// subscription's mention/unread/dm handlers share ONE debounceLead(700)
// coalescedUnread instead of calling refreshUnread() per event, which the
// binding comment prices at three RPCs apiece ("a twenty-message burst ...
// was sixty requests"). 2a164b9 proved the workspace.js sibling; this closes
// the last unprobed debounceLead binding. The probe boots the real app into a
// signed-in-shaped state (a seeded future-dated auth-token session in
// localStorage drives the REAL enter() path far enough to run subscribeUser;
// no module is imported twice and no handler is re-implemented - the frames
// are delivered into the callbacks the real sb.subscribe installed, read off
// the live channel object's own bindings registry), blocks the realtime
// websocket so the topic never churns mid-window, seeds store.ws so
// refreshUnread's guard passes, and counts get_unread + get_dm_unread POSTs
// answered by context.route as the refresh instrument:
//
//   SETUP  the live 'user' channel really carries broadcast bindings named
//          mention/unread/dm (registration proven, not assumed).
//   LEG A  five same-tick unread frames cost exactly TWO full refreshes - one
//          leading edge inside 400ms (never behind the window), one trailing
//          catch-up landing only after ~650ms - then silence, with the DM tail
//          matching two-for-two.
//   LEG B  mention+unread+dm mixed inside one window cost ONE leading edge -
//          three private debounces would have fired three - and one catch-up.
//   LEG C  two quick bus 'unread:reload' emissions cost TWO immediate reads:
//          the explicit paths were deliberately left unwrapped, so capture
//          there would mean the coalescer leaked past its binding.
//   LEG D  twelve frames staggered across 600ms (a realistic burst) still cost
//          exactly two.
//
// Negative test (separate run): replant the pre-coalescing direct calls in
// main.js - legs A/B/D must fail on their exact-count shapes while C stays
// green, attributing the proof to the coalescer alone.
//
// Usage: node scripts/probe-unreadcoalesce.mjs [--root <dir>]
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
console.log(`probe-unreadcoalesce: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wire counters. get_unread fires once per refreshUnread() body; get_dm_unread
// once per its full tail's refreshDMList(); both empty so no member/profile
// follow-ups can blur the accounting.
const counts = new Map();
const bump = (name) => counts.set(name, (counts.get(name) || 0) + 1);
const nOf = (name) => counts.get(name) || 0;

// Seeded session: supabase-js v2 keeps it under sb-<ref>-auth-token; a future
// expires_at means getSession() answers from storage without touching the
// network and ensureFreshAuth's 30s timer never tries a refresh mid-run.
const REF = "ybddogqphinruyunnuwx";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u-seed", role: "authenticated" })}.sig`,
  refresh_token: "rt-probe",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "u-seed", email: "probe@example.com", aud: "authenticated",
    role: "authenticated", app_metadata: {}, user_metadata: {},
  },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await forceTransport(context, ROOT);
await context.route("**/rest/v1/**", async (route) => {
  const u = new URL(route.request().url());
  const seg = u.pathname.split("/");
  if (seg[seg.length - 2] === "rpc") {
    const name = seg[seg.length - 1];
    bump(name);
    let body = "null";
    if (name === "must_set_password") body = "false";
    else if (name.startsWith("get_")) body = "[]";
    return route.fulfill({ status: 200, contentType: "application/json", body });
  }
  if (u.pathname.includes("profiles")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "u-seed", display_name: "Probe One" }]),
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
});
// Accept the websocket and answer nothing: the topic stays JOINING forever,
// so no CHANNEL_ERROR reopen can replace d.ch between delivery and read.
await context.routeWebSocket("**/realtime/v1/websocket*", () => {});

const pageerrors = [];
const page = await context.newPage();
page.on("pageerror", (e) => pageerrors.push(String(e)));
page.on("console", (m) => { if (/features loaded/.test(m.text())) console.log("  [boot] " + m.text()); });

try {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [`sb-${REF}-auth-token`, JSON.stringify(SESSION)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "setup: app never reached the features-loaded boot line within 45s");

  if (booted) {
    // Wait until the real enter() reached subscribeUser and the topic exists,
    // then wait out the one-off install churn observed around features-load
    // time (the topic can flip once before settling) by requiring five
    // consecutive identical readings off the live registry.
    const reg = await page.evaluate(async () => {
      const sbm = await import("/js/sb.js");
      let stable = null, run = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const ch = sbm.getSub("user");
        const topic = ch ? ch.topic : null;
        if (topic && topic === stable) { run++; if (run >= 5) break; }
        else { stable = topic; run = 1; }
        await new Promise((r) => setTimeout(r, 100));
      }
      const ch = sbm.getSub("user");
      const events = ((ch?.bindings || {}).broadcast || [])
        .map((b) => b.filter && b.filter.event).filter(Boolean);
      return { topic: ch ? ch.topic : null, events };
    });
    ok(reg.topic === "realtime:user:u-seed", `setup: no stable realtime 'user' topic ever subscribed (last seen ${reg.topic}) - subscribeUser did not run`);

    if (reg.topic === "realtime:user:u-seed") {
      for (const ev of ["mention", "unread", "dm"]) {
        ok(reg.events.includes(ev), `setup: no ${ev} handler registered on the live user topic`);
      }

      // Seed the workspace so refreshUnread passes its guard, then let boot
      // noise (presence census, heartbeat, feature polls) drain before any
      // accounting.
      await page.evaluate(async () => {
        const { store } = await import("/js/store.js");
        store.ws = { id: "ws-p", name: "Probe Space" };
      });
      await sleep(1500);
      const baseU = nOf("get_unread");
      const baseD = nOf("get_dm_unread");

      // Deliver N broadcast frames into the callbacks the real subscription
      // installed, read off the channel's own bindings (this vendored build
      // exposes no trigger(); the bindings walk replicates its filter rule).
      const deliver = (frames) => page.evaluate((fs) => {
        return (async () => {
          const sbm = await import("/js/sb.js");
          const ch = sbm.getSub("user");
          const list = ((ch || {}).bindings || {}).broadcast || [];
          let hits = 0;
          for (const f of fs) {
            for (const b of list) {
              if (b.type === "broadcast" && b.filter && b.filter.event === f.ev) {
                b.callback({ payload: f.payload || {} });
                hits++;
              }
            }
            if (f.wait) await new Promise((r) => setTimeout(r, f.wait));
          }
          return hits;
        })();
      }, frames);

      // ---- LEG A: five same-tick unread frames ------------------------------
      const t0 = Date.now();
      const hitsA = await deliver([
        { ev: "unread" }, { ev: "unread" }, { ev: "unread" },
        { ev: "unread" }, { ev: "unread" },
      ]);
      ok(hitsA === 5, `A: expected to deliver 5 frames into real handlers, hit ${hitsA}`);
      await sleep(350);
      const leadA = nOf("get_unread") - baseU;
      const leadDt = Date.now() - t0;
      ok(leadA === 1, `A: leading edge should be exactly ONE immediate refresh inside the window, saw ${leadA} after ${leadDt}ms`);
      ok(leadDt < 400, `A: leading edge took ${leadDt}ms - it must never sit behind the 700ms window`);
      await sleep(1250); // window is 700ms; catch-up must have landed by now
      const totalA = nOf("get_unread") - baseU;
      ok(totalA === 2, `A: five frames must cost exactly two refreshes (lead + one catch-up), saw ${totalA}`);
      const dmA = nOf("get_dm_unread") - baseD;
      ok(dmA === 2, `A: the DM tail should ride both full refreshes (2), saw ${dmA}`);
      await sleep(900);
      const quietA = nOf("get_unread") - baseU;
      ok(quietA === 2, `A: silence after the catch-up expected, saw ${quietA} total`);

      // ---- LEG B: three event types share ONE coalescer ---------------------
      const baseUb = nOf("get_unread");
      const tB = Date.now();
      await deliver([{ ev: "mention" }, { ev: "unread", wait: 60 }, { ev: "dm", wait: 60 }]);
      await sleep(300);
      const leadB = nOf("get_unread") - baseUb;
      const dtB = Date.now() - tB;
      ok(leadB === 1, `B: mixed-event window must open ONE leading edge (shared coalescer), saw ${leadB} after ${dtB}ms - three private debounces would have fired three`);
      await sleep(1300);
      const totalB = nOf("get_unread") - baseUb;
      ok(totalB === 2, `B: mixed burst must cost exactly two refreshes, saw ${totalB}`);
      await sleep(800);
      ok(nOf("get_unread") - baseUb === 2, "B: silence after leg B's catch-up expected");

      // ---- LEG C: explicit paths stay uncoalesced ---------------------------
      const baseUc = nOf("get_unread");
      await page.evaluate(async () => {
        const { bus } = await import("/js/store.js");
        bus.emit("unread:reload");
        await new Promise((r) => setTimeout(r, 100));
        bus.emit("unread:reload");
      });
      await sleep(500);
      const cCount = nOf("get_unread") - baseUc;
      ok(cCount === 2, `C: two direct unread:reload emissions must cost two immediate reads (explicit paths stay unwrapped), saw ${cCount}`);

      // ---- LEG D: a realistic staggered burst still costs two ---------------
      const baseUd = nOf("get_unread");
      const framesD = [];
      for (let i = 0; i < 12; i++) framesD.push({ ev: i % 3 === 0 ? "mention" : "unread", wait: 50 });
      await deliver(framesD); // twelve frames across ~550ms, all inside the window
      await sleep(1500);
      const totalD = nOf("get_unread") - baseUd;
      ok(totalD === 2, `D: a twelve-frame staggered burst must still cost exactly two refreshes, saw ${totalD}`);
      await sleep(800);
      ok(nOf("get_unread") - baseUd === 2, "D: silence after leg D's catch-up expected");
    }
  }
} catch (e) {
  problems.push("harness: " + (e && e.message ? e.message : String(e)));
}

await browser.close();
server.close();

if (pageerrors.length) problems.push(`pageerror x${pageerrors.length}: ` + pageerrors[0]);
if (problems.length) {
  console.log("PROBE FAILED:");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN");
process.exit(0);
