// Sheet access at 390px, in both schemes: the channel bar with its pinned
// sheets, the in-app viewer, and the add dialog mid-paste.
//
// This one is for looking at. The probe measures that the frame is tall enough
// and that nothing scrolls sideways; it cannot tell whether a pill row with two
// sheets, a link and two add affordances reads as one strip or as clutter.
//
// Usage: node scripts/shot-sheets.mjs [--out shots]
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--out") args.out = process.argv[++i];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, args.out || "shots");
fs.mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end(); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const PUB = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRfakePublishedId9/pubhtml?gid=0&single=true";
const EDIT = "https://docs.google.com/spreadsheets/d/1FakeEditSheetId_abc-123/edit#gid=0";
const iso = () => new Date().toISOString();
const BOOKMARKS = [
  { id: "bm-1", channel_id: "ch-1", label: "Camp runbook", url: "https://example.org/runbook", position: 1, created_at: iso() },
  { id: "bm-2", channel_id: "ch-1", label: "Volunteer roster", url: PUB, position: 2, created_at: iso() },
  { id: "bm-3", channel_id: "ch-1", label: "Patient call list", url: EDIT, position: 3, created_at: iso() },
];

// A stub that looks like a published sheet, so the frame in the screenshot
// shows the shape a volunteer would actually see rather than a blank box.
const SHEET_STUB = `<!doctype html><meta charset="utf-8"><title>stub</title>
<style>body{margin:0;font:13px/1.4 Arial,sans-serif;color:#202124}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #dadce0;padding:6px 8px;text-align:left;white-space:nowrap}
th{background:#f1f3f4;font-weight:600}</style>
<table><tr><th>Name</th><th>Ward</th><th>Called</th></tr>
<tr><td>Sunita D.</td><td>B-2</td><td>Yes</td></tr>
<tr><td>Ramesh K.</td><td>B-2</td><td>Yes</td></tr>
<tr><td>Farida S.</td><td>C-1</td><td>No</td></tr>
<tr><td>Anil M.</td><td>C-1</td><td>No</td></tr>
<tr><td>Kavita R.</td><td>A-4</td><td>Yes</td></tr>
<tr><td>Imran Q.</td><td>A-4</td><td>No</td></tr></table>`;

const browser = await chromium.launch();
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await ctx.route("**/rest/v1/**", (r) => r.fulfill(json([])));
  await ctx.route("**/rest/v1/rpc/list_bookmarks", (r) => r.fulfill(json(BOOKMARKS)));
  await ctx.route("https://docs.google.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SHEET_STUB }));

  const page = await ctx.newPage();
  let ready; const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await Promise.race([line, sleep(45_000)]);

  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "ws-1", name: "Jarurat Care" };
    store.isAdmin = true;
    store.channels = [{ id: "ch-1", name: "nutrition", kind: "text", position: 1 }];
    store.current = store.channels[0];
    localStorage.removeItem("dak.sheets.pubtip");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    bus.emit("channel:open", { channel: store.current });
  });
  await page.waitForSelector("#bmkBar .bmk-pill", { state: "attached", timeout: 8000 });

  for (const scheme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-mode", t);
      document.documentElement.setAttribute("data-scheme", t);
    }, scheme);
    await sleep(250);

    const barShot = path.join(OUT, `sheets-${scheme}-bar.png`);
    await page.locator("#bmkBar").screenshot({ path: barShot });
    shots.push(barShot);

    // The viewer, framing the stub.
    await page.evaluate(() => {
      [...document.querySelectorAll("#bmkBar .bmk-pill")]
        .find((p) => p.textContent.trim() === "Volunteer roster").click();
    });
    await page.waitForSelector(".sht-modal iframe.sht-frame", { state: "attached", timeout: 6000 });
    await sleep(700);
    const viewShot = path.join(OUT, `sheets-${scheme}-viewer.png`);
    await page.screenshot({ path: viewShot });
    shots.push(viewShot);
    await page.evaluate(() => document.querySelector(".sht-modal .modal-head button.icon")?.click());
    await sleep(300);

    // The add dialog, with a pasted edit URL so the line that teaches publishing
    // is in the picture.
    await page.evaluate(() => {
      [...document.querySelectorAll("#bmkBar .bmk-pill.bmk-add")]
        .find((p) => /add a sheet/i.test(p.textContent)).click();
    });
    await page.waitForSelector(".sht-form .sht-url", { state: "attached", timeout: 5000 });
    await page.$eval(".sht-form .sht-url", (n, v) => {
      n.value = v; n.dispatchEvent(new Event("input", { bubbles: true }));
    }, EDIT);
    await sleep(500);
    const addShot = path.join(OUT, `sheets-${scheme}-add.png`);
    await page.screenshot({ path: addShot });
    shots.push(addShot);
    await page.evaluate(() => document.querySelector(".modal .modal-head button.icon")?.click());
    await sleep(300);
  }

  // The one-time publish note, in the bar, after an edit URL opens a tab.
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-mode", t);
    document.documentElement.setAttribute("data-scheme", t);
  }, "light");
  await page.evaluate(() => {
    localStorage.removeItem("dak.sheets.pubtip");
    [...document.querySelectorAll("#bmkBar .bmk-pill")]
      .find((p) => p.textContent.trim() === "Patient call list").click();
  });
  await sleep(600);
  const tipShot = path.join(OUT, "sheets-light-tip.png");
  await page.locator("#bmkBar").screenshot({ path: tipShot });
  shots.push(tipShot);

  // And the laptop width, because the viewer has to be worth opening there too.
  const wide = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  await wide.route("**/rest/v1/**", (r) => r.fulfill(json([])));
  await wide.route("**/rest/v1/rpc/list_bookmarks", (r) => r.fulfill(json(BOOKMARKS)));
  await wide.route("https://docs.google.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SHEET_STUB }));
  const wp = await wide.newPage();
  let ready2; const line2 = new Promise((r) => { ready2 = r; });
  wp.on("console", (m) => { if (/features loaded/.test(m.text())) ready2(); });
  await wp.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await Promise.race([line2, sleep(45_000)]);
  await wp.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "ws-1", name: "Jarurat Care" };
    store.isAdmin = true;
    store.channels = [{ id: "ch-1", name: "nutrition", kind: "text", position: 1 }];
    store.current = store.channels[0];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    bus.emit("channel:open", { channel: store.current });
  });
  await wp.waitForSelector("#bmkBar .bmk-pill", { state: "attached", timeout: 8000 });
  console.log("desktop pills:", JSON.stringify(
    await wp.$$eval("#bmkBar .bmk-pill", (ns) => ns.map((n) => n.textContent.trim()))));
  await wp.evaluate(() => {
    [...document.querySelectorAll("#bmkBar .bmk-pill")]
      .find((p) => p.textContent.trim() === "Volunteer roster")?.click();
  });
  await wp.waitForSelector(".sht-modal iframe.sht-frame", { state: "attached", timeout: 6000 });
  await sleep(800);
  const deskShot = path.join(OUT, "sheets-desktop-viewer.png");
  await wp.screenshot({ path: deskShot });
  shots.push(deskShot);
} finally {
  await browser.close();
  server.close();
}
for (const s of shots) console.log("wrote", path.relative(ROOT, s));
