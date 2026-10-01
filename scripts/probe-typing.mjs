// Behavioral guard for the rank-21 typing-broadcast contract (11c15b0): starts
// are gated behind TYPING_GATE_MS of sustained composition, per-sentence traffic
// is coalesced to one start plus a 10s keepalive, sending itself broadcasts
// nothing (the message arriving IS the stop), explicit stops remain only where
// no echo will arrive (blur, hidden, delete-to-empty, 4s idle), switching
// channel kills a pending gate WITHOUT publishing onto the new topic, and every
// payload names the typer. Drives the REAL booted app: openChannel() through
// its exported symbol seeds a live 'typing' subscription, input events hit the
// shipped composer listeners, and the probe wraps the app's OWN channel object
// (sb.getSub('typing') - the same instance sendTyping() resolves) to count
// broadcasts without mocking anything.
//
//   LEG A quick-reply gate: "ok" typed and sent inside 800ms costs ZERO
//         broadcasts; sustained composition fires exactly one start; continued
//         typing within the keepalive window adds none; falling silent 4s adds
//         exactly one stop. Payload carries user_id + name.
//   LEG B explicit stops: blur stops, delete-to-empty stops, typing while the
//         tab is hidden can neither start nor continue (input-time guard), the
//         visibilitychange event stops a live indicator, and returning to
//         visible publishes normally again.
//   LEG C switch reset: a pending gate abandoned by openChannel(other) never
//         fires - not on the old topic, not on the new one - and the replaced
//         subscription is observed on the new channel's topic.
//
// Usage: node scripts/probe-typing.mjs [--root <dir>]
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
console.log(`probe-typing: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic Supabase: every REST call answered locally. send_message echoes the
// caller's body_text back as a full message row so upgradeMessageRow runs the
// real optimistic-id swap on the painted row.
await (async () => {})();
const browser = await chromium.launch();
async function bootAndOpen(page, channelId) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(await booted, `${channelId}: app never reached the features-loaded boot line within 45s`);
  await page.evaluate(async (cid) => {
    const { store } = await import("/js/store.js");
    store.me = { id: "u-me", name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.channels = [
      { id: "c1", name: "probe-one", position: 1000 },
      { id: "c2", name: "probe-two", position: 2000 },
    ];
    store.unread = new Map();
    store.notify = new Map();
    store.dms = [];
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === cid));
  }, channelId);
}

try {
  // ---------------------------------------------------------------- leg A
  {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await forceTransport(context, ROOT);
    await context.route("**/rest/v1/**", async (route) => {
      const u = new URL(route.request().url());
      const seg = u.pathname.split("/");
      if (seg[seg.length - 2] !== "rpc") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      const name = seg[seg.length - 1];
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch {}
      if (name === "get_channel_messages") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      if (name === "send_message") {
        const row = {
          id: "m-real-1", seq: 1, author_id: "u-me",
          body_text: body.p_body_text || "", attachments: [],
          created_at: new Date().toISOString(),
        };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(row) });
      }
      if (name === "save_draft" || name === "delete_draft" || name === "get_drafts") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    await bootAndOpen(page, "c1");

    // Observe the app's own typing channel. Poll because subscribeChannel runs
    // mid-open; wrap defensively against topic replacement (leg C relies on it).
    const wrapped = await page.evaluate(async () => {
      window.__typingLog = [];
      window.__topics = [];
      const { getSub } = await import("/js/sb.js");
      for (let i = 0; i < 60; i++) {
        const ch = getSub("typing");
        if (ch && !window.__topics.includes(ch.topic)) {
          const orig = ch.send.bind(ch);
          const topic = ch.topic;
          ch.send = (msg) => {
            if (msg && msg.event === "typing") {
              window.__typingLog.push({
                topic, state: msg.payload.state,
                user_id: msg.payload.user_id, name: msg.payload.name,
                at: Date.now(),
              });
            }
            return orig(msg);
          };
          window.__topics.push(topic);
        }
        if (window.__topics.length) return window.__topics;
        await new Promise((r) => setTimeout(r, 100));
      }
      return [];
    });
    ok(wrapped.length === 1 && wrapped[0].endsWith("typ:c1"),
      `legA: typing subscription must exist on typ:c1 after openChannel (got ${JSON.stringify(wrapped)})`);

    const counts = () => page.evaluate(() => ({
      starts: window.__typingLog.filter((e) => e.state === "start").length,
      stops: window.__typingLog.filter((e) => e.state === "stop").length,
      log: window.__typingLog,
    }));

    // --- quick reply: two keystrokes, send inside the 800ms gate.
    await page.evaluate(() => {
      const c = document.querySelector("#composer");
      c.focus();
      c.value = "o";
      c.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await sleep(150);
    await page.evaluate(() => {
      const c = document.querySelector("#composer");
      c.value = "ok";
      c.dispatchEvent(new InputEvent("input", { bubbles: true }));
      document.querySelector("#sendBtn").click();
    });
    await sleep(1100); // past where the gate would have fired had send not cancelled it
    let c0 = await counts();
    ok(c0.starts === 0 && c0.stops === 0,
      `legA: sub-second "ok"+send must broadcast NOTHING (got ${JSON.stringify(c0.log)})`);
    const sentRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#messages .msg")];
      return { n: rows.length, cleared: document.querySelector("#composer").value === "" };
    });
    ok(sentRow.n >= 1, "legA: the quick reply must still SEND (optimistic row painted)");
    ok(sentRow.cleared, "legA: composer must clear after send");

    // --- sustained composition: one start, coalesced, then the 4s idle stop.
    await page.evaluate(() => {
      const c = document.querySelector("#composer");
      c.value = "watch this";
      c.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await sleep(1050); // > TYPING_GATE_MS (800)
    let c1 = await counts();
    ok(c1.starts === 1, `legA: sustained composition must publish exactly ONE start (got ${c1.starts}: ${JSON.stringify(c1.log)})`);
    await page.evaluate(() => {
      const c = document.querySelector("#composer");
      c.value = "watch this still";
      c.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await sleep(300); // well inside the 10s keepalive: a second keystroke burst must NOT republish
    let c2 = await counts();
    ok(c2.starts === 1, `legA: keystrokes inside the keepalive window must not republish (got ${c2.starts})`);
    const first = c2.log[0] || {};
    // store.me rides the payload whole (sendTyping passes it as user_id) and
    // nameOf() renders the display name; assert the contract, not our seed.
    ok(first.user_id && first.user_id.id === "u-me" && typeof first.name === "string" && first.name
      && first.topic.endsWith("typ:c1"),
      `legA: start payload must name the typer and topic (got ${JSON.stringify(first)})`);
    await sleep(4300); // > TYPING_IDLE_MS (4000)
    let c3 = await counts();
    ok(c3.stops === 1, `legA: falling silent 4s must publish exactly ONE stop (got ${c3.stops}: ${JSON.stringify(c3.log)})`);
    ok(c3.starts === 1, `legA: idle window must not add starts (got ${c3.starts})`);
    ok(pageerrors.length === 0, `legA: pageerror(s): ${pageerrors.join(" | ")}`);
    await page.screenshot({ path: path.join(ROOT, "s", "probe-typing.png"), fullPage: false }).catch(() => {});
    await context.close();
  }

  // ---------------------------------------------------------------- leg B+C
  {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await forceTransport(context, ROOT);
    await context.route("**/rest/v1/**", async (route) => {
      const u = new URL(route.request().url());
      const seg = u.pathname.split("/");
      if (seg[seg.length - 2] !== "rpc") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      const name = seg[seg.length - 1];
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch {}
      if (name === "get_channel_messages") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      if (name === "send_message") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ id: "m-" + Math.random().toString(36).slice(2), seq: 1, author_id: "u-me", body_text: body.p_body_text || "", attachments: [], created_at: new Date().toISOString() }),
        });
      }
      if (["save_draft", "delete_draft", "get_drafts"].includes(name)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    await bootAndOpen(page, "c1");
    await page.evaluate(async () => {
      window.__typingLog = [];
      window.__topics = [];
      const { getSub } = await import("/js/sb.js");
      window.__wrapTyping = async () => {
        let got = false;
        for (let i = 0; i < 40; i++) {
          const ch = getSub("typing");
          if (ch && !window.__topics.includes(ch.topic)) {
            const orig = ch.send.bind(ch);
            const topic = ch.topic;
            ch.send = (msg) => {
              if (msg && msg.event === "typing") {
                window.__typingLog.push({ topic, state: msg.payload.state, user_id: msg.payload.user_id, name: msg.payload.name, at: Date.now() });
              }
              return orig(msg);
            };
            window.__topics.push(topic);
          }
          if (getSub("typing")) { got = true; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        return got;
      };
      await window.__wrapTyping();
    });
    const counts = () => page.evaluate(() => ({
      starts: window.__typingLog.filter((e) => e.state === "start").length,
      stops: window.__typingLog.filter((e) => e.state === "stop").length,
      topics: [...new Set(window.__typingLog.map((e) => e.topic))],
      log: window.__typingLog,
    }));
    const typeText = (text) => page.evaluate((t) => {
      const c = document.querySelector("#composer");
      c.value = t;
      c.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }, text);

    // --- blur stop
    await typeText("blur me");
    await sleep(950);
    await page.evaluate(() => {
      const c = document.querySelector("#composer");
      c.dispatchEvent(new FocusEvent("blur"));
    });
    await sleep(150);
    let b1 = await counts();
    ok(b1.starts === 1 && b1.stops === 1,
      `legB: blur after a live start must have published start+stop (got ${b1.starts}/${b1.stops}: ${JSON.stringify(b1.log)})`);

    // --- delete-to-empty stop
    await typeText("x");
    await sleep(950);
    await typeText("");
    await sleep(150);
    let b2 = await counts();
    ok(b2.starts === 2 && b2.stops === 2,
      `legB: deleting back to empty must retract the indicator (got ${b2.starts}/${b2.stops}: ${JSON.stringify(b2.log)})`);

    // --- hidden tab: input-time guard refuses to start...
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
    });
    await typeText("pocketed");
    await sleep(950);
    let b3 = await counts();
    ok(b3.starts === 2 && b3.stops === 2,
      `legB: a hidden tab must publish NOTHING while typing (got ${b3.starts}/${b3.stops}: ${JSON.stringify(b3.log)})`);

    // --- ...and the visibilitychange event stops an already-live indicator.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      delete document.visibilityState;
    });
    await typeText("back home");
    await sleep(950);
    let b4 = await counts();
    ok(b4.starts === 3, `legB: returning to visible must publish normally again (got ${b4.starts}: ${JSON.stringify(b4.log)})`);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(150);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      delete document.visibilityState;
    });
    let b5 = await counts();
    ok(b5.stops === 3, `legB: hiding the tab mid-sentence must stop the live indicator (got ${b5.stops}: ${JSON.stringify(b5.log)})`);

    // --- leg C: switching channel kills a PENDING gate without any publish.
    await typeText("switching soon");
    await sleep(80); // gate timer armed, nowhere near firing
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      await openChannel(store.channels.find((ch) => ch.id === "c2"));
    });
    await page.evaluate(() => window.__wrapTyping());
    await sleep(1100); // past where the abandoned gate would have fired
    let l1 = await counts();
    ok(l1.starts === 3 && l1.stops === 3,
      `legC: a gate abandoned by a channel switch must NEVER fire, old topic or new (got ${l1.starts}/${l1.stops}: ${JSON.stringify(l1.log)})`);
    const switched = await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { getSub } = await import("/js/sb.js");
      await window.__wrapTyping();
      return { cur: store.current && store.current.id, topic: getSub("typing") && getSub("typing").topic };
    });
    ok(switched.cur === "c2", `legC: must actually be on c2 (got ${switched.cur})`);
    ok(switched.topic.endsWith("typ:c2"), `legC: typing subscription must ride the new channel's topic (got ${switched.topic})`);
    ok(l1.topics.every((t) => t.endsWith("typ:c1")), `legC: no broadcast may leak onto the new topic (got ${JSON.stringify(l1.topics)})`);
    ok(pageerrors.length === 0, `legB/C: pageerror(s): ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (err) {
  problems.push(`harness: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN: typing proven (gate eats quick replies, one coalesced start + idle stop, send is silent, blur/delete/hidden stops, switch abandons gates silently)");
process.exit(0);
