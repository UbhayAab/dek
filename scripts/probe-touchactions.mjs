// On a phone, can you reach a message action at all?
//
// messages.css hides every button in the hover bar except the emoji picker and
// the last one, so on touch the row offers exactly two controls: React and ⋯.
// And the ⋯ menu core builds is a FIXED list - Forward, Copy link, Save for
// later, Pin, Edit, Delete - which has never contained a single action a feature
// registered. uxfix.js's foldActionBar, the thing that puts registered actions
// into that menu, opened with `if (isTouch()) return`.
//
// So on a phone, "Make this a task", "Label this message", "Turn into a form"
// and every other registered action existed only behind a long press: a gesture
// nobody is taught, that iOS Safari does not reliably deliver, and that this
// app's own CSS comment calls "the native idiom on this form factor" without
// anything else backing it up. Everyone using Dek is on a phone.
//
//   1. under (hover: none) the row really does show only two buttons
//   2. the ⋯ menu contains the core fixed entries AND the registered ones
//   3. Label this message and Make this a task are both in it by name
//   4. picking one from the menu actually runs that action
//   5. a pointer device is unchanged: the first registered actions stay in the
//      bar and only the overflow folds
//   6. zero pageerror.
//
// Usage: node scripts/probe-touchactions.mjs [--root <dir>]
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
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-touchactions: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const browser = await chromium.launch();
let pageerrors = [];

// One signed-in-looking page with one real message row, on whatever form factor
// the caller asks for.
async function boot(opts) {
  const context = await browser.newContext(opts);
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(e.message));
  let ready;
  const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  const booted = Promise.race([line.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (!(await booted)) throw new Error("app never reached the features-loaded boot line within 45s");

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const msgs = await import("/js/core/messages.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, msgs, ui, ran: [] };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "W", org_id: "o1" };
    store.profiles.set("u-lead", { id: "u-lead", display_name: "Priyanka" });
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    store.current = store.channels[0];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");

    // A probe-owned action, so leg 4 proves the menu RUNS the thing rather than
    // only listing it, without firing anything that opens a dialog.
    ui.ui.addMessageAction({
      id: "probe-canary", label: "<span>C</span>", title: "Probe canary", order: 500,
      onClick: () => { window.__p.ran.push("canary"); },
    });

    const host = document.getElementById("messages");
    host.innerHTML = "";
    const m = { id: "m-1", channel_id: "ch-1", workspace_id: "w1", seq: 1, author_id: "u-lead",
      body_text: "Ambulance paperwork is due Friday", body: {}, attachments: [],
      created_at: new Date().toISOString(), mention_user_ids: [] };
    store.msgCache.set(m.id, m);
    host.appendChild(msgs.buildMessage(m, { context: "channel" }));
  });
  await sleep(700);
  return { context, page };
}

const shown = (page) => page.$$eval(".msg[data-id='m-1'] .actions button",
  (ns) => ns.filter((n) => getComputedStyle(n).display !== "none").map((n) => n.title || "?"));

const openMore = async (page) => page.evaluate(async () => {
  const bar = document.querySelector(".msg[data-id='m-1'] .actions");
  const more = [...bar.children].at(-1);
  more.click();
  await new Promise((r) => setTimeout(r, 250));
  return [...document.querySelectorAll(".ctxmenu .ctx-item")].map((n) => n.textContent.trim());
});

try {
  // ---------------------------------------------------------------- touch
  const t = await boot({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const coarse = await t.page.evaluate(() => window.matchMedia("(hover: none)").matches);
  ok(coarse, "the emulated phone does not report (hover: none) - this leg would prove nothing");

  const bar = await shown(t.page);
  ok(bar.length <= 2,
    `a phone row shows ${bar.length} action buttons, so the premise has changed: ${JSON.stringify(bar)}`);

  const menu = await openMore(t.page);
  ok(menu.length > 0, "the ⋯ menu on a phone is empty");
  ok(menu.some((x) => /forward to a channel/i.test(x)),
    `core's own fixed entries are missing from the ⋯ menu: ${JSON.stringify(menu)}`);
  ok(menu.some((x) => /label this message/i.test(x)),
    `"Label this message" is unreachable on a phone except by long-press: ${JSON.stringify(menu)}`);
  ok(menu.some((x) => /make this a task/i.test(x)),
    `"Make this a task" is unreachable on a phone except by long-press: ${JSON.stringify(menu)}`);

  // 4. and picking one runs it.
  const ran = await t.page.evaluate(async () => {
    const hit = [...document.querySelectorAll(".ctxmenu .ctx-item")]
      .find((n) => /probe canary/i.test(n.textContent));
    if (!hit) return "canary missing from the menu";
    hit.click();
    await new Promise((r) => setTimeout(r, 200));
    return window.__p.ran.join(",");
  });
  ok(ran === "canary", `picking an action from the phone ⋯ menu did not run it: ${JSON.stringify(ran)}`);
  await t.context.close();

  // ---------------------------------------------------------------- pointer
  // The desktop behaviour must be exactly what it was: the first couple of
  // registered actions stay in the bar, the rest fold.
  const d = await boot({ viewport: { width: 1200, height: 900 } });
  const fine = await d.page.evaluate(() => window.matchMedia("(hover: hover)").matches);
  ok(fine, "the desktop context does not report (hover: hover)");
  const dbar = await shown(d.page);
  ok(dbar.length > 3,
    `a pointer device folded the whole bar away, which is a regression: ${JSON.stringify(dbar)}`);
  const dmenu = await openMore(d.page);
  ok(dmenu.some((x) => /label this message/i.test(x)) || dbar.some((x) => /label this message/i.test(x)),
    `the label action is neither in the desktop bar nor its ⋯ menu: bar=${JSON.stringify(dbar)} menu=${JSON.stringify(dmenu)}`);
  await d.context.close();

  ok(pageerrors.length === 0, `pageerror: ${pageerrors.join(" | ")}`);
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
