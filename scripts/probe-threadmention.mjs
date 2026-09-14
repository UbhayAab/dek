// Can you tag somebody from inside a reply thread?
//
// Reported by the owner, verbatim: "I am not able to tag people when I am within
// a reply thread."
//
// It was not a broken binding. It was a binding that was never made. The
// autocomplete engine in js/core/composer.js read one hardcoded `$('composer')`
// and painted into one hardcoded `$('acPop')`, and initComposer() wired it once
// at boot. The thread reply box is a different element, #threadComposer, rebuilt
// from scratch every time a thread opens, and nothing ever told the picker it
// existed. Typing @ there produced no dropdown at all.
//
// The trap this probe exists to catch: #acPop is positioned absolutely inside
// #composerBar. Pointing the old engine at the thread box without giving it its
// own popup would have drawn the dropdown pinned above the CHANNEL composer at
// the bottom of the screen while you typed in the panel on the right - which
// looks like it works in code review and is useless in a browser. Leg 3 measures
// the geometry rather than trusting it.
//
//   1. typing @ in a thread reply opens a picker at all
//   2. it offers real people from the roster
//   3. the popup is INSIDE the thread panel, not over the channel composer
//   4. Enter completes the name instead of sending a half-typed one
//   5. the reply that goes out carries resolved mention ids
//   6. ...and carries mention_scope, so @channel in a thread is not silently
//      downgraded to nothing, which is what it used to be
//   7. the channel composer still has its own working picker (no regression)
//   8. zero pageerror.
//
// Usage: node scripts/probe-threadmention.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--root") args.root = process.argv[++i];
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!path.resolve(p).startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-threadmention: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const sends = [];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  // Catch-all FIRST: Playwright matches the most recently registered handler.
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/send_message", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    sends.push(b);
    return route.fulfill(json({ id: "m-new", seq: 99, created_at: new Date().toISOString() }));
  });

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(e.message));
  let ready;
  const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  const booted = Promise.race([line.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (problems.length) throw new Error(problems.join("; "));
  console.log("probe-threadmention: app booted");

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay", username: "abhay" };
    store.ws = { id: "w1", name: "W", org_id: "o1" };
    store.profiles.set("u-me", { id: "u-me", display_name: "Abhay", username: "abhay" });
    store.profiles.set("u-mehak", { id: "u-mehak", display_name: "Mehak", username: "mehak_k1" });
    store.profiles.set("u-sourabh", { id: "u-sourabh", display_name: "Sourabh", username: "sourabh_r2" });
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    store.current = store.channels[0];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  // Open a real thread panel, the way the app does.
  const opened = await page.evaluate(async () => {
    const { openThread } = await import("/js/core/threads.js");
    const { store } = window.__p;
    const root = { id: "m-root", channel_id: "ch-1", workspace_id: "w1", seq: 1,
      author_id: "u-mehak", body_text: "who is covering the camp on Sunday?", body: {},
      attachments: [], created_at: new Date().toISOString(), mention_user_ids: [] };
    store.msgCache.set(root.id, root);
    store.rootThreads.set(root.id, { threadId: "th-1", count: 1, last_message_at: new Date().toISOString() });
    await openThread(root);
    await new Promise((r) => setTimeout(r, 900));
    return !!document.getElementById("threadComposer");
  });
  ok(opened, "the thread panel did not produce a #threadComposer, so nothing below can be tested");
  if (!opened) throw new Error("no thread composer");

  // ---------------------------------------------------------- 1 + 2. the picker
  await page.focus("#threadComposer");
  await page.type("#threadComposer", "can you take this @me", { delay: 25 });
  await sleep(350);
  const picker = await page.evaluate(() => {
    const pops = [...document.querySelectorAll(".acpop")]
      .filter((n) => !n.classList.contains("hidden"));
    return {
      open: pops.length,
      id: pops[0]?.id || "",
      rows: [...(pops[0]?.querySelectorAll(".ac-row") || [])].map((n) => n.textContent.trim()),
    };
  });
  ok(picker.open === 1,
    `typing @ in a thread reply opened ${picker.open} pickers, want exactly 1 - this is the reported bug`);
  ok(picker.id === "threadAcPop",
    `the open picker is #${picker.id}; the thread box must use its own popup, not the channel's #acPop`);
  ok(picker.rows.some((t) => /Mehak/.test(t)),
    `the picker offers no real people: ${JSON.stringify(picker.rows)}`);

  // ------------------------------------------------- 3. it is in the right place
  // The trap. #acPop lives inside #composerBar at the bottom of the channel
  // column; a popup that escapes to that containing block renders far away from
  // the thread box somebody is typing in.
  const geo = await page.evaluate(() => {
    const pop = document.getElementById("threadAcPop");
    const panel = document.getElementById("panel");
    const ta = document.getElementById("threadComposer");
    const bar = document.getElementById("composerBar");
    const r = (n) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { pop: r(pop), panel: r(panel), ta: r(ta), bar: r(bar),
      inThreadBox: !!pop.closest(".thread-composer") };
  });
  ok(geo.inThreadBox, "the thread picker is not inside .thread-composer");
  ok(geo.pop.x >= geo.panel.x - 2 && geo.pop.x + geo.pop.w <= geo.panel.x + geo.panel.w + 2,
    `the picker is horizontally outside the thread panel: pop ${JSON.stringify(geo.pop)} panel ${JSON.stringify(geo.panel)}`);
  // Directly above the box it serves, not down at the channel composer.
  ok(Math.abs((geo.pop.y + geo.pop.h) - geo.ta.y) < 40,
    `the picker is not sitting above the thread box: pop bottom ${Math.round(geo.pop.y + geo.pop.h)}, box top ${Math.round(geo.ta.y)}`);
  ok(Math.abs(geo.pop.x - geo.bar.x) > 20,
    `the picker is drawn over the CHANNEL composer bar - the exact failure this probe exists for: pop x ${Math.round(geo.pop.x)}, bar x ${Math.round(geo.bar.x)}`);
  console.log(`probe-threadmention: picker at x=${Math.round(geo.pop.x)} w=${Math.round(geo.pop.w)}, `
    + `panel x=${Math.round(geo.panel.x)} w=${Math.round(geo.panel.w)}, channel bar x=${Math.round(geo.bar.x)}`);

  // ------------------------------------------------------ 4. Enter completes
  sends.length = 0;
  await page.keyboard.press("Enter");
  await sleep(250);
  const afterEnter = await page.$eval("#threadComposer", (n) => n.value);
  ok(sends.length === 0,
    "Enter while the picker was open SENT the message instead of completing the name");
  ok(/@mehak_k1\s?$/.test(afterEnter),
    `Enter did not complete the handle: ${JSON.stringify(afterEnter)}`);

  // ---------------------------------------------- 5 + 6. what the reply carries
  await page.evaluate(() => {
    const ta = document.getElementById("threadComposer");
    ta.value = "@mehak_k1 can you take Sunday, @channel please note";
  });
  await page.evaluate(async () => {
    document.getElementById("threadSend").click();
    await new Promise((r) => setTimeout(r, 700));
  });
  ok(sends.length === 1, `sending the reply produced ${sends.length} send_message calls, want 1`);
  const s0 = sends[0] || {};
  ok(Array.isArray(s0.p_mentions) && s0.p_mentions.includes("u-mehak"),
    `the thread reply carried no resolved mention: ${JSON.stringify(s0.p_mentions)}`);
  ok(s0.p_thread === "th-1", `the reply was not sent into the thread: ${JSON.stringify(s0.p_thread)}`);
  ok(s0.p_mention_scope === "channel",
    `@channel in a thread reply was sent with scope ${JSON.stringify(s0.p_mention_scope)}; `
    + "it used to default to 'none', which is a notification nobody receives");

  // ------------------------------------------ 7. the channel box still works
  //
  // initComposer() starts the channel box DISABLED and only enables it on
  // channel:open. Without emitting that, page.type silently fails to focus it
  // and the keystrokes land in whatever had focus before - the thread box - so
  // this leg would test nothing and report a phantom regression.
  await page.evaluate(async () => {
    const { store, ui } = window.__p;
    const { bus } = await import("/js/store.js");
    bus.emit("channel:open", { channel: store.current });
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById("composer").value = "";
    document.getElementById("threadComposer").value = "";
  });
  const enabled = await page.$eval("#composer", (n) => !n.disabled);
  ok(enabled, "the channel composer is still disabled, so leg 7 would prove nothing");
  await page.focus("#composer");
  await page.type("#composer", "hello @sou", { delay: 25 });
  await sleep(350);
  const chan = await page.evaluate(() => {
    const open = [...document.querySelectorAll(".acpop")].filter((n) => !n.classList.contains("hidden"));
    return { count: open.length, id: open[0]?.id || "",
      rows: [...(open[0]?.querySelectorAll(".ac-row") || [])].map((n) => n.textContent.trim()) };
  });
  ok(chan.count === 1 && chan.id === "acPop",
    `the channel composer's own picker regressed: ${JSON.stringify(chan)}`);
  ok(chan.rows.some((t) => /Sourabh/.test(t)),
    `the channel picker stopped finding people: ${JSON.stringify(chan.rows)}`);

  ok(pageerrors.length === 0, `pageerror: ${pageerrors.join(" | ")}`);
} catch (e) {
  problems.push("probe threw: " + (e?.message || e));
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN");
