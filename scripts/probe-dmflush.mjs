// Behavioral guard for EFFICIENCY rank 22 remainder (1b9d0e5), whose two flush
// paths shipped with only a boot screenshot. The claims: a coalesced DM read
// PENDING on its 1200ms timer is sent IMMEDIATELY when the reader leaves the
// conversation (openDM's first act, before any await) and when the tab is
// pocketed or closed (hidden tabs never fire setTimeout, so without the
// visibilitychange flush the last burst in a DM would stay unread everywhere
// but this device). The probe boots the real app, seeds the store, opens REAL
// conversations through the exported openDM and seeds the module-private
// pending state through the only path that creates it - incoming broadcast
// frames delivered into the handler registration the real subscribe() path
// installed on the wrapped channel factory (probe-guideupdate precedent,
// capture-not-mock). Every mark_dm_read is counted and timestamped on the WIRE
// via context.route, with an optional hold as the arrival-time instrument:
//
//   LEG A pre-switch flush: frame lands in conv-a, openDM('conv-b') is called
//     at once - the held write must arrive carrying mark_dm_read(conv-a,seq 1)
//     well inside the coalescing window (not at timer expiry), and waiting out
//     the window must produce no second write (timer disarmed).
//   LEG B hidden flush: frame lands in conv-b, a real visibilitychange event
//     with visibilityState hidden dispatches - the write must arrive promptly
//     (hidden timers never fire) and stay alone through the window.
//   LEG C coalescing shape: two frames (seq 2, seq 3) inside one window cost
//     exactly ONE write at timer expiry carrying the HIGHEST seq, never one
//     write per message - the payload legs A/B flush is proven honest here.
//   LEG D receipts debounce: three rapid 'dm:receipts' emits for the open
//     conversation cost exactly ONE get_dm_receipts post past the 1000ms
//     debounce; emits for a conversation NOT on screen cost zero.
//
// Usage: node scripts/probe-dmflush.mjs [--root <dir>]
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
console.log(`probe-dmflush: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const GUIDE = {
  channel_id: "", channel_name: "", purpose: "", body: "", topic: "",
  seen: true, pins: [], open_asks: [], can_edit: false, member_count: 1,
  updated_at: null, updated_by: null,
};

// Hermetic Supabase. mark_dm_read is logged with an arrival TIMESTAMP (the
// timing instrument - the whole contract is "before the timer, not at it") and
// optionally HELD on the wire; get_dm_receipts is counted for the debounce leg.
function wireSupabase(context, wire) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    if (name === "mark_dm_read") {
      wire.dmLog.push({ body, at: Date.now() });
      if (wire.hold) await wire.hold;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (name === "get_dm_receipts") {
      wire.receipts++;
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (name === "get_channel_guide") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...GUIDE, channel_id: String(body.p_channel || "") }) });
    }
    if (name === "heartbeat") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

// Empty pages everywhere on purpose: openDM only writes on lastSeq > 0, so the
// open itself stays silent and EVERY observed write is attributable to the
// flush/coalescing paths under test, never to the open's own acknowledgment.
function wireDmPages(context, wire) {
  return context.route("**/rest/v1/dm_messages**", (route) => {
    const raw = new URL(route.request().url()).searchParams.get("conversation_id") || "";
    const conv = raw.replace(/^eq\./, "");
    const rows = wire.pages.get(conv) || [];
    return route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(rows),
    });
  });
}

const browser = await chromium.launch();

try {
  const wire = {
    dmLog: [], receipts: 0, hold: null,
    pages: new Map([["conv-a", []], ["conv-b", []]]),
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceTransport(context, ROOT);
  await wireSupabase(context, wire);
  await wireDmPages(context, wire);

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "app never reached the features-loaded boot line within 45s");

  // Capture, NOT mock: the channel objects are created by the real subscribe()
  // path inside openDM; we only record the 'msg' broadcast registrations
  // verbatim so frames can be delivered into exactly what shipped. Modules are
  // stashed once so leg evaluates stay synchronous around the timing-critical
  // deliver-then-switch pair.
  await page.evaluate(async () => {
    const sbm = await import("/js/sb.js");
    const dms = await import("/js/core/dms.js");
    const storeM = await import("/js/store.js");
    window.__dmProbe = { handlers: new Map(), openDM: dms.openDM, store: storeM.store };
    const orig = sbm.sb.channel.bind(sbm.sb);
    sbm.sb.channel = (...a) => {
      const ch = orig(...a);
      if (/^dm:/.test(String(a[0]))) {
        const origOn = ch.on.bind(ch);
        ch.on = (type, filter, cb) => {
          if (type === "broadcast" && filter && filter.event === "msg") {
            window.__dmProbe.handlers.set(a[0], cb);
          }
          return origOn(type, filter, cb);
        };
      }
      return ch;
    };
  });

  await page.evaluate(() => {
    const { store } = window.__dmProbe;
    store.me = { id: "u-me", display_name: "Me" };
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.profiles.set("u-alice", { id: "u-alice", display_name: "Alice" });
    store.dms = [
      { conversation_id: "conv-a", other_user_ids: ["u-alice"], last_message_at: new Date(Date.now() - 60e3).toISOString(), unread: 0 },
      { conversation_id: "conv-b", other_user_ids: ["u-alice"], last_message_at: new Date(Date.now() - 90e3).toISOString(), unread: 0 },
    ];
    store.channels = [];
  });

  // Open conv-a through the REAL export; empty page means no open-path write.
  await page.evaluate(async () => { await window.__dmProbe.openDM("conv-a"); });
  await sleep(400);
  ok(wire.dmLog.length === 0 && wire.receipts <= 2,
    `boot-noise baseline must show zero mark_dm_read writes, got ${JSON.stringify(wire.dmLog)}`);
  ok(wire.dmLog.length === 0, `baseline: no mark_dm_read before any frame (${wire.dmLog.length})`);

  const deliver = (topic, frame) => page.evaluate(([t, f]) => {
    const cb = window.__dmProbe.handlers.get(t);
    if (!cb) return false;
    cb({ payload: f });
    return true;
  }, [topic, frame]);

  const frame = (id, seq, conv) => ({
    id, seq, conversation_id: conv, author_id: "u-alice",
    body_text: "burst line " + seq, created_at: iso(NOW), deleted_at: null,
  });

  const waitWrites = async (n, ms) => {
    const deadline = Date.now() + ms;
    while (wire.dmLog.length < n && Date.now() < deadline) await sleep(20);
    return wire.dmLog.length;
  };

  // ---------------------------------------------------- LEG A: pre-switch
  {
    // Seed the pending read through the REAL incoming-frame path, then switch
    // conversations immediately - inside the same evaluate, so nothing can
    // interleave between arming the timer and leaving.
    const tSeed = Date.now();
    const switched = await page.evaluate(() => {
      const cb = window.__dmProbe.handlers.get("dm:conv-a");
      if (!cb) return false;
      cb({ payload: { id: "dA1", seq: 1, conversation_id: "conv-a", author_id: "u-alice", body_text: "first", created_at: new Date().toISOString(), deleted_at: null } });
      window.__dmProbe.openDM("conv-b");
      return true;
    });
    ok(switched, "LEG A: no msg handler was bound onto dm:conv-a - cannot drive the real path");

    // HOLD the write so its arrival instant is exactly observable, then require
    // it to show up well inside the coalescing window. Keep-in-sync: the
    // window is dms.js DM_READ_MS = 1200 (module-private const).
    wire.hold = new Promise(() => {});
    const got = await waitWrites(1, 3000);
    const elapsed = got >= 1 ? wire.dmLog[0].at - tSeed : Infinity;
    ok(got === 1, `LEG A: the left conversation's pending read must go out on the switch, saw ${got}`);
    ok(elapsed < 1000, `LEG A: flush must beat the 1200ms timer, took ${elapsed}ms`);
    ok(wire.dmLog[0]?.body?.p_conversation === "conv-a" && wire.dmLog[0]?.body?.p_up_to_seq === 1,
      `LEG A: flushed write must carry mark_dm_read(conv-a, seq 1), got ${JSON.stringify(wire.dmLog[0]?.body)}`);

    wire.hold = null;
    // Wait out the full coalescing window: the disarmed timer must produce no
    // second write for conv-a (or anything else).
    await sleep(1500);
    ok(wire.dmLog.length === 1,
      `LEG A: after the flush the window must stay silent (timer disarmed), got ${wire.dmLog.length} writes`);
  }

  // ----------------------------------------------------- LEG B: hidden tab
  {
    ok(await deliver("dm:conv-b", frame("dB1", 1, "conv-b")),
      "LEG B: no msg handler was bound onto dm:conv-b - cannot drive the real path");
    const tHide = Date.now();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const base = wire.dmLog.length;
    const got = await waitWrites(base + 1, 3000);
    const elapsed = got >= base + 1 ? wire.dmLog[base].at - tHide : Infinity;
    ok(got === base + 1, `LEG B: hiding the tab must flush the pending read at once, saw ${got - base}`);
    ok(elapsed < 800, `LEG B: hidden-tab flush must not wait for any timer (hidden timers never fire), took ${elapsed}ms`);
    ok(wire.dmLog[base]?.body?.p_conversation === "conv-b" && wire.dmLog[base]?.body?.p_up_to_seq === 1,
      `LEG B: flushed write must carry mark_dm_read(conv-b, seq 1), got ${JSON.stringify(wire.dmLog[base]?.body)}`);

    // Truth restored (no synthetic visible event needed - the assertion is the
    // ABSENCE of further writes, and silence is what really happens next).
    await page.evaluate(() => { delete document.visibilityState; });
    await sleep(1500);
    ok(wire.dmLog.length === base + 1,
      `LEG B: the flushed window must stay silent afterwards, got ${wire.dmLog.length - base} extra writes`);
  }

  // ------------------------------------------- LEG C: coalescing, high seq
  {
    // Two frames inside one window: highest seq wins, ONE write at expiry -
    // this is the payload shape legs A and B flush early.
    await deliver("dm:conv-b", frame("dB2", 2, "conv-b"));
    await deliver("dm:conv-b", frame("dB3", 3, "conv-b"));
    const base = wire.dmLog.length;
    await sleep(1700);
    ok(wire.dmLog.length === base + 1,
      `LEG C: a two-message burst inside one window must cost ONE write, got ${wire.dmLog.length - base}`);
    ok(wire.dmLog[base]?.body?.p_conversation === "conv-b" && wire.dmLog[base]?.body?.p_up_to_seq === 3,
      `LEG C: the coalesced write must carry the highest seq (3), got ${JSON.stringify(wire.dmLog[base]?.body)}`);
    ok(!wire.dmLog.slice(base).some((w) => w.body?.p_up_to_seq === 2),
      "LEG C: no intermediate write may carry the lower seq");
  }

  // ------------------------------------------------ LEG D: receipts dedup
  {
    const rBase = wire.receipts;
    await page.evaluate(async () => {
      const { bus } = await import("/js/store.js");
      window.__emitReceipts = (id) => bus.emit("dm:receipts", { conversationId: id });
    });
    await page.evaluate(() => {
      window.__emitReceipts("conv-b");
      window.__emitReceipts("conv-b");
      window.__emitReceipts("conv-b");
      window.__emitReceipts("conv-z");
    });
    await sleep(1600);
    ok(wire.receipts === rBase + 1,
      `LEG D: three bursted read broadcasts must cost ONE receipts fetch and a foreign id must cost zero, got +${wire.receipts - rBase}`);
  }

  ok(pageerrors.length === 0, `pageerrors: ${pageerrors.join(" | ")}`);
  await page.screenshot({ path: path.join(ROOT, "s", "probe-dmflush.png"), fullPage: false }).catch(() => {});
  await context.close();
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-dmflush");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-dmflush");
process.exit(0);
