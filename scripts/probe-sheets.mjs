// Sheet access: pinning a sheet to a channel and opening it without leaving Dek.
//
// The ask was "allow relevant sheets to be attached or accessed directly within
// Dek", and the honest answer has two halves that a probe has to keep apart. A
// PUBLISHED sheet (File > Share > Publish to web) is frameable and opens in a
// panel here. An ordinary /edit URL is NOT - Google refuses the frame with
// X-Frame-Options and no flag on our side changes that - so it opens a tab.
// The failure this guards against is the tempting one: quietly iframing an edit
// URL, shipping it, and finding out from a volunteer that the panel is blank.
//
// Legs:
//   1. the classifier answers a table of real-shaped URLs, including the ones
//      people actually paste - a /u/0/ account prefix, a trailing #gid=0,
//      ?usp=sharing, plain http, and a scheme-less paste
//   2. the bar groups pinned sheets FIRST, with an icon, ahead of plain links,
//      and the "Add a sheet" affordance is ON SCREEN at 390px rather than off
//      the right edge of a scroller whose scrollbar is hidden
//   3. tapping a published sheet opens the in-app viewer with an iframe whose
//      src is the sheet, and an "Open in Google Sheets" escape hatch
//   4. tapping a NON-embeddable sheet opens no iframe at all, opens a tab, and
//      shows the publish note exactly once
//   5. the add flow classifies while you type, auto-fills the label, and calls
//      add_bookmark with (p_channel, p_label, p_url) as the RPC declares them
//   6. the viewer fits inside a 390px phone with no horizontal overflow, and
//      the CSP this repo actually deploys (read from _headers) does not refuse
//      the frame
//   7. /sheet lands in the same dialog with the link already classified, and
//      someone without Manage channels gets no add affordance
//   8. zero pageerror.
//
// Usage: node scripts/probe-sheets.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--root") args.root = process.argv[++i];
}
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png",
};
// THE REAL CSP, read off the file Cloudflare Pages serves, not a guess.
// Nothing here can frame docs.google.com if a frame-src or a default-src turns
// up in _headers, and the failure mode is silent: no exception, no network
// entry, just an empty box where the roster was. So this probe serves the
// deployed policy and leg 3 then proves the frame survived it.
const headersSrc = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
const CSP = (headersSrc.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1]?.trim() || "";
console.log(`probe-sheets: serving with the deployed CSP: ${CSP || "(none found in _headers)"}`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (err) { try { res.writeHead(404).end("nope"); } catch {} return; }
    const head = { "content-type": MIME[path.extname(p)] || "application/octet-stream" };
    if (CSP) head["content-security-policy"] = CSP;
    res.writeHead(200, head);
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-sheets: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = { "access-control-allow-origin": "*" };

// The two links the whole feature turns on. Shaped like the real thing: the
// published id space is /d/e/2PACX-... and is NOT the same id as the edit URL's.
const PUB = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRfakePublishedId9/pubhtml?gid=0&single=true";
const EDIT = "https://docs.google.com/spreadsheets/d/1FakeEditSheetId_abc-123/edit#gid=0";

const BOOKMARKS = [
  { id: "bm-1", channel_id: "ch-1", label: "Runbook", url: "https://example.org/runbook",
    position: 1, created_at: new Date().toISOString() },
  { id: "bm-2", channel_id: "ch-1", label: "Volunteer roster", url: PUB,
    position: 2, created_at: new Date().toISOString() },
  { id: "bm-3", channel_id: "ch-1", label: "Patient call list", url: EDIT,
    position: 3, created_at: new Date().toISOString() },
];

let addBookmarkBody = null;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });

  // CATCH-ALL FIRST. Playwright matches the most recently registered route, so
  // a trailing "**/rest/v1/**" would swallow every specific handler below it.
  await context.route("**/rest/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
  await context.route("**/rest/v1/rpc/list_bookmarks", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify(BOOKMARKS) }));
  await context.route("**/rest/v1/rpc/add_bookmark", (route) => {
    try { addBookmarkBody = JSON.parse(route.request().postData() || "{}"); } catch { addBookmarkBody = null; }
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify({ id: "bm-new", channel_id: "ch-1",
        label: addBookmarkBody?.p_label, url: addBookmarkBody?.p_url,
        position: 9, created_at: new Date().toISOString() }) });
  });
  // The frame must never actually reach Google from a probe. Fulfilling it
  // locally also makes leg 3 assert the real src we would have sent.
  await context.route("https://docs.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>stub</title><body>published sheet stub</body>" }));

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (err) => pageerrors.push(err.message));

  // A CSP refusal is a console message and nothing else - no throw, no failed
  // request. Without collecting these, a policy that blocks the frame looks
  // exactly like a frame that loaded.
  const refusals = [];
  page.on("console", (m) => {
    if (/refused to (frame|display)|content security policy/i.test(m.text())) refusals.push(m.text());
  });

  // Popups: an edit URL is supposed to open one. Catching them is how leg 4
  // proves the tab opened instead of a frame being drawn.
  const popups = [];
  context.on("page", (p) => popups.push(p));

  let featuresLoaded;
  const bootedLine = new Promise((r) => { featuresLoaded = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
  const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (problems.length) throw new Error(problems.join("; "));
  console.log("probe-sheets: app booted");

  // ---------------------------------------------------------------- 1. classifier
  // The table is the specification. Every row here is a shape somebody has
  // pasted into a chat at some point, and the two columns that matter are the
  // kind and whether it may be framed.
  const table = await page.evaluate(async () => {
    const m = await import("/js/lib/sheeturl.js");
    const cases = [
      ["https://docs.google.com/spreadsheets/d/1Abc_dEf-9/edit", "gsheet", false, true],
      ["https://docs.google.com/spreadsheets/d/1Abc_dEf-9/edit#gid=0", "gsheet", false, true],
      ["https://docs.google.com/spreadsheets/d/1Abc_dEf-9/edit?usp=sharing", "gsheet", false, true],
      ["http://docs.google.com/spreadsheets/u/0/d/1Abc_dEf-9/edit#gid=87654321", "gsheet", false, true],
      ["docs.google.com/spreadsheets/d/1Abc_dEf-9/edit", "gsheet", false, true],
      ["https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9/pubhtml", "gsheet-pub", true, false],
      ["https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9/pubhtml?gid=12&single=true", "gsheet-pub", true, false],
      ["https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9/pub?output=csv", "gsheet-pub", true, false],
      ["https://docs.google.com/spreadsheets/d/1Abc/pubhtml", "gsheet-pub", true, false],
      ["https://docs.google.com/document/d/1Doc9/edit", "gdoc", false, true],
      ["https://docs.google.com/document/d/e/2PACX-1vD/pub", "gdoc-pub", true, false],
      ["https://docs.google.com/presentation/d/1Sl/edit#slide=id.p1", "gslides", false, true],
      ["https://docs.google.com/presentation/d/1Sl/embed?start=false", "gslides-pub", true, false],
      ["https://docs.google.com/forms/d/e/1FAIpQ/viewform", "gform", true, false],
      ["https://docs.google.com/forms/d/1FAIpQ/edit", "gform", false, true],
      ["https://drive.google.com/file/d/1FILE/preview", "gdrive", true, false],
      ["https://drive.google.com/file/d/1FILE/view?usp=drive_link", "gdrive", false, false],
      ["https://onedrive.live.com/edit.aspx?resid=ABC", "excel", false, false],
      ["https://jaruratcare-my.sharepoint.com/:x:/g/personal/x/EabC", "excel", false, false],
      ["https://1drv.ms/x/s!Abc", "excel", false, false],
      ["https://example.org/roster_march.csv", "excel", false, false],
      ["https://example.com/some/page", "link", false, false],
      ["not a url", "link", false, false],
      ["javascript:alert(1)", "link", false, false],
      ["", "link", false, false],
    ];
    const bad = [];
    for (const [url, kind, emb, pub] of cases) {
      const i = m.classifySheetUrl(url);
      if (i.kind !== kind) bad.push(`${url || "(empty)"} -> kind ${i.kind}, want ${kind}`);
      if (!!i.embeddable !== emb) bad.push(`${url || "(empty)"} -> embeddable ${!!i.embeddable}, want ${emb}`);
      if (!!i.publishable !== pub) bad.push(`${url || "(empty)"} -> publishable ${!!i.publishable}, want ${pub}`);
    }
    // A javascript: URL must never come back as something the UI would frame or
    // hand to window.open.
    const evil = m.classifySheetUrl("javascript:alert(1)");
    if (evil.valid || evil.embeddable) bad.push("javascript: URL was accepted as a valid link");

    // Embed URLs: Google's own embed params on a pubhtml, output=html instead of
    // a download on a /pub, embedded=true on a form, and nothing at all for an
    // edit URL - offering one would be the exact lie this feature must not tell.
    const emb = (u) => m.sheetEmbedUrl(m.classifySheetUrl(u));
    const pubhtml = emb("https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9/pubhtml");
    if (!/widget=true/.test(pubhtml || "") || !/headers=false/.test(pubhtml || "")) {
      bad.push(`pubhtml embed url lost Google's widget params: ${pubhtml}`);
    }
    const csv = emb("https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9/pub?output=csv");
    if (!/output=html/.test(csv || "")) bad.push(`/pub?output=csv would have framed a download: ${csv}`);
    const form = emb("https://docs.google.com/forms/d/e/1FAIpQ/viewform");
    if (!/embedded=true/.test(form || "")) bad.push(`form embed url missing embedded=true: ${form}`);
    if (emb("https://docs.google.com/spreadsheets/d/1Abc/edit") !== null) {
      bad.push("an /edit URL was handed an embed URL");
    }

    // The label the add dialog pre-fills.
    const label = (u) => m.sheetLabelFrom(m.classifySheetUrl(u));
    if (label("https://docs.google.com/spreadsheets/d/1Abc/edit") !== "Sheet") {
      bad.push(`a sheet URL auto-labelled "${label("https://docs.google.com/spreadsheets/d/1Abc/edit")}"`);
    }
    if (label("https://example.org/roster_march.csv") !== "Roster march") {
      bad.push(`a .csv URL auto-labelled "${label("https://example.org/roster_march.csv")}"`);
    }
    if (label("https://onedrive.live.com/edit.aspx?resid=ABC") !== "Spreadsheet") {
      bad.push(`a OneDrive URL auto-labelled "${label("https://onedrive.live.com/edit.aspx?resid=ABC")}"`);
    }
    return bad;
  });
  for (const b of table) problems.push("classifier: " + b);
  console.log(`probe-sheets: classifier table ${table.length ? "FAILED" : "clean"}`);

  // ------------------------------------------------------------------ boot state
  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-1", name: "Jarurat Care" };
    store.isAdmin = true;                       // Manage channels, the existing gate
    store.channels = [{ id: "ch-1", name: "nutrition", kind: "text", position: 1 }];
    store.current = store.channels[0];
    localStorage.removeItem("dak.sheets.pubtip");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    bus.emit("channel:open", { channel: store.current });
  });
  await page.waitForSelector("#bmkBar .bmk-pill", { state: "attached", timeout: 8000 });
  await sleep(250);

  // ----------------------------------------------------------------- 2. grouping
  const bar = await page.evaluate(() => {
    const pills = [...document.querySelectorAll("#bmkBar .bmk-pill")];
    return pills.map((p) => ({
      text: p.textContent.trim(),
      doc: p.classList.contains("bmk-doc"),
      add: p.classList.contains("bmk-add"),
      icon: !!p.querySelector("svg.ico"),
    }));
  });
  const pinned = bar.filter((p) => !p.add);
  ok(pinned.length === 3, `bar drew ${pinned.length} pinned pills, want 3`);
  ok(pinned[0]?.text === "Volunteer roster" && pinned[1]?.text === "Patient call list",
    `sheets are not first in the bar: ${JSON.stringify(pinned.map((p) => p.text))}`);
  ok(pinned[2]?.text === "Runbook", `the plain link is not last: ${pinned[2]?.text}`);
  ok(pinned[0]?.doc && pinned[1]?.doc && !pinned[2]?.doc,
    "the sheet pills are not marked .bmk-doc while the plain link is");
  ok(pinned[0]?.icon && pinned[1]?.icon,
    "a pinned sheet has no icon, so it looks like every other bookmark");
  ok(bar.some((p) => p.add && /add a sheet/i.test(p.text)),
    `no spelled-out "Add a sheet" affordance in the bar: ${JSON.stringify(bar.map((p) => p.text))}`);

  // ON SCREEN, not merely in the DOM. The strip is a sideways scroller with a
  // hidden scrollbar (css/features.css says why), so an add pill appended after
  // three pins sat entirely off the right edge of a 390px phone. It is stuck to
  // the scrollport edge now, and this is the measurement that says so.
  const addGeo = await page.evaluate(() => {
    const strip = document.getElementById("bmkBar");
    const pill = [...strip.querySelectorAll(".bmk-pill.bmk-add")]
      .find((n) => /add a sheet/i.test(n.textContent));
    if (!strip || !pill) return null;
    const s = strip.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    return { stripL: Math.round(s.left), stripR: Math.round(s.right),
      pillL: Math.round(p.left), pillR: Math.round(p.right),
      overflows: strip.scrollWidth > strip.clientWidth + 1 };
  });
  ok(!!addGeo, "could not measure the Add a sheet pill against the strip");
  ok(!addGeo?.overflows || (addGeo.pillR <= addGeo.stripR + 1 && addGeo.pillL >= addGeo.stripL - 1),
    `"Add a sheet" sits at ${addGeo?.pillL}-${addGeo?.pillR}px outside a strip that ends at ${addGeo?.stripR}px`);
  if (addGeo) {
    console.log(`probe-sheets: strip ${addGeo.stripL}-${addGeo.stripR}px, `
      + `Add a sheet at ${addGeo.pillL}-${addGeo.pillR}px, overflowing=${addGeo.overflows}`);
  }

  // -------------------------------------------------------- 3. published -> frame
  await page.evaluate(() => {
    [...document.querySelectorAll("#bmkBar .bmk-pill")]
      .find((p) => p.textContent.trim() === "Volunteer roster").click();
  });
  await page.waitForSelector(".sht-modal iframe.sht-frame", { state: "attached", timeout: 6000 })
    .catch(() => problems.push("tapping a published sheet did not open the in-app viewer"));
  const view = await page.evaluate(() => {
    const f = document.querySelector(".sht-modal iframe.sht-frame");
    const foot = document.querySelector(".sht-modal .modal-foot");
    return {
      src: f?.getAttribute("src") || "",
      sandbox: f?.getAttribute("sandbox") || "",
      title: document.querySelector(".sht-modal .modal-head strong")?.textContent.trim() || "",
      escape: [...(foot?.querySelectorAll("button") || [])].map((b) => b.textContent.trim()),
      frames: document.querySelectorAll("iframe").length,
    };
  });
  ok(/docs\.google\.com\/spreadsheets\/d\/e\/2PACX/.test(view.src),
    `the viewer frames the wrong URL: ${view.src}`);
  ok(/widget=true/.test(view.src), `the frame src lost Google's embed params: ${view.src}`);
  ok(/allow-scripts/.test(view.sandbox), `the frame is not sandboxed: "${view.sandbox}"`);
  ok(view.title === "Volunteer roster", `the viewer is titled "${view.title}"`);
  ok(view.escape.some((t) => /open in google sheets/i.test(t)),
    `no escape hatch out of the viewer: ${JSON.stringify(view.escape)}`);

  // The frame really navigated under the deployed CSP. A blocked frame stays at
  // about:blank and is otherwise indistinguishable from a working one.
  await page.waitForFunction(
    () => [...document.querySelectorAll("iframe")].length > 0, null, { timeout: 4000 },
  ).catch(() => {});
  await sleep(600);
  const framed = page.frames().some((f) => /docs\.google\.com/.test(f.url()));
  ok(framed, `the sheet iframe never navigated; frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`);
  ok(refusals.length === 0, `the deployed CSP refused the frame: ${refusals.join(" | ")}`);
  console.log(`probe-sheets: viewer framed ${view.src.slice(0, 72)}`);

  // ---------------------------------------------------------- 6. 390px geometry
  // A viewer that overflows a phone is a viewer nobody uses: the ask names the
  // volunteers on phones first.
  await page.evaluate(() => Promise.all(
    document.querySelectorAll(".modal-back")
      ? [...document.getElementById("chat").getAnimations({ subtree: true })].map((a) => a.finished.catch(() => {}))
      : [],
  ));
  await sleep(300);
  const geo = await page.evaluate(() => {
    const box = document.querySelector(".sht-modal");
    const f = document.querySelector(".sht-modal iframe.sht-frame");
    if (!box || !f) return null;
    const b = box.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return {
      boxW: Math.round(b.width), boxH: Math.round(b.height),
      frameH: Math.round(fr.height),
      vw: window.innerWidth, vh: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
    };
  });
  ok(!!geo, "could not measure the viewer at 390px");
  ok(!geo || geo.boxW <= geo.vw, `the viewer is ${geo?.boxW}px wide inside a ${geo?.vw}px phone`);
  ok(!geo || geo.scrollW <= geo.vw, `the page scrolls sideways at 390px (${geo?.scrollW} > ${geo?.vw})`);
  ok(!geo || geo.frameH > 260, `the sheet frame is only ${geo?.frameH}px tall on a phone`);
  if (geo) console.log(`probe-sheets: 390px viewer ${geo.boxW}x${geo.boxH}, frame ${geo.frameH}px tall`);

  await page.evaluate(() => document.querySelector(".sht-modal .modal-head button.icon")?.click());
  await sleep(250);
  ok(!(await page.$(".sht-modal")), "the viewer did not close");

  // ------------------------------------------------------ 4. edit URL -> new tab
  const before = popups.length;
  await page.evaluate(() => {
    [...document.querySelectorAll("#bmkBar .bmk-pill")]
      .find((p) => p.textContent.trim() === "Patient call list").click();
  });
  await sleep(600);
  ok(!(await page.$("iframe.sht-frame")),
    "an ordinary /edit URL was put in an iframe - Google refuses that frame and the panel would be blank");
  ok(popups.length > before, "tapping a non-embeddable sheet did not open a new tab");
  const opened = popups[popups.length - 1];
  ok(!opened || /spreadsheets\/d\/1FakeEditSheetId/.test(opened.url()),
    `the new tab went to ${opened?.url()}`);
  const tip = await page.evaluate(() => {
    const t = document.querySelector("#bmkBar .sht-tip");
    return { shown: !!t, text: t?.textContent || "", lines: t ? t.textContent.split("\n").length : 0 };
  });
  ok(tip.shown, "no note explaining that publishing the sheet makes it open inside Dek");
  ok(/publish to web/i.test(tip.text), `the note does not name Publish to web: "${tip.text}"`);
  ok(/✕/.test(tip.text), "the note cannot be dismissed");
  // Readable, not merely present. Dropped into the strip as an ordinary flex
  // item the note became a two-word column 500px tall, off the side of a
  // scroller with no scrollbar - which is how the pre-existing .bmk-note bug
  // presented too.
  const tipGeo = await page.evaluate(() => {
    const strip = document.getElementById("bmkBar");
    const t = strip?.querySelector(".sht-tip");
    if (!strip || !t) return null;
    const s = strip.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
      stripW: Math.round(s.width), inside: r.right <= s.right + 1 };
  });
  ok(!!tipGeo, "could not measure the publish note");
  ok(!tipGeo || tipGeo.w > tipGeo.stripW * 0.7,
    `the publish note is ${tipGeo?.w}px wide in a ${tipGeo?.stripW}px strip`);
  ok(!tipGeo || tipGeo.h < 120, `the publish note is ${tipGeo?.h}px tall, so it is not one line`);
  ok(!tipGeo || tipGeo.inside, "the publish note runs off the side of the strip");
  if (tipGeo) console.log(`probe-sheets: publish note ${tipGeo.w}x${tipGeo.h} in a ${tipGeo.stripW}px strip`);

  // ONCE. A hint that returns on every tap is a hint people learn to ignore.
  await page.evaluate(() => document.querySelector("#bmkBar .sht-tip button")?.click());
  await page.evaluate(() => {
    [...document.querySelectorAll("#bmkBar .bmk-pill")]
      .find((p) => p.textContent.trim() === "Patient call list").click();
  });
  await sleep(400);
  ok(!(await page.$("#bmkBar .sht-tip")), "the publish note came back a second time");

  // --------------------------------------------------------------- 5. add flow
  await page.evaluate(() => {
    [...document.querySelectorAll("#bmkBar .bmk-pill.bmk-add")]
      .find((p) => /add a sheet/i.test(p.textContent)).click();
  });
  await page.waitForSelector(".sht-form .sht-url", { state: "attached", timeout: 5000 })
    .catch(() => problems.push("the Add a sheet affordance opened no dialog"));

  const typed = async (v) => {
    await page.$eval(".sht-form .sht-url", (n, x) => {
      n.value = x; n.dispatchEvent(new Event("input", { bubbles: true }));
    }, v);
    await sleep(260);                                // past the 120ms debounce
    return page.evaluate(() => ({
      verdict: document.querySelector(".sht-form .sht-verdict")?.textContent.trim() || "",
      cls: document.querySelector(".sht-form .sht-verdict")?.className || "",
      label: document.querySelector(".sht-form .sht-label")?.value || "",
    }));
  };

  const bad = await typed("banana");
  ok(/sht-bad/.test(bad.cls), `a junk URL was not called out: "${bad.verdict}"`);

  const editSaid = await typed(EDIT);
  ok(/publish to web/i.test(editSaid.verdict),
    `pasting an edit URL does not say how to make it open here: "${editSaid.verdict}"`);
  ok(editSaid.label === "Sheet", `the label did not auto-fill from the URL: "${editSaid.label}"`);

  const pubSaid = await typed(PUB);
  ok(/sht-yes/.test(pubSaid.cls) && /inside dek/i.test(pubSaid.verdict),
    `pasting a published URL does not say it opens here: "${pubSaid.verdict}"`);

  await page.$eval(".sht-form .sht-label", (n) => {
    n.value = "March roster"; n.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => {
    [...document.querySelectorAll(".modal-foot button")]
      .find((b) => b.textContent.trim() === "Add").click();
  });
  await sleep(700);
  ok(!!addBookmarkBody, "submitting the Add a sheet dialog did not call add_bookmark");
  ok(addBookmarkBody?.p_channel === "ch-1", `add_bookmark got p_channel ${addBookmarkBody?.p_channel}`);
  ok(addBookmarkBody?.p_label === "March roster", `add_bookmark got p_label ${addBookmarkBody?.p_label}`);
  ok(addBookmarkBody?.p_url === PUB, `add_bookmark got p_url ${addBookmarkBody?.p_url}`);
  // Forcing 0 would stack every new pin at the front of the bar; the server
  // default is "after everything else".
  ok(addBookmarkBody && "p_position" in addBookmarkBody && addBookmarkBody.p_position === null,
    `add_bookmark should leave p_position null, got ${JSON.stringify(addBookmarkBody?.p_position)}`);
  const added = await page.$$eval("#bmkBar .bmk-pill", (ns) => ns.map((n) => n.textContent.trim()));
  ok(added.includes("March roster"), `the new sheet did not appear in the bar: ${JSON.stringify(added)}`);
  console.log("probe-sheets: add_bookmark " + JSON.stringify(addBookmarkBody));

  // -------------------------------------------------------- 5b. slash command
  // /sheet is the route for somebody who is already typing, and it has to land
  // in the SAME dialog with the pasted link already classified - otherwise it is
  // a second half-implementation of the add flow.
  const slash = await page.evaluate(async (u) => {
    const ui = await import("/js/ui.js");
    const handled = await ui.runSlash("/sheet " + u);
    await new Promise((r) => setTimeout(r, 400));
    return {
      handled,
      title: document.querySelector(".modal .modal-head strong")?.textContent.trim() || "",
      url: document.querySelector(".sht-form .sht-url")?.value || "",
      verdict: document.querySelector(".sht-form .sht-verdict")?.textContent.trim() || "",
      label: document.querySelector(".sht-form .sht-label")?.value || "",
    };
  }, EDIT);
  ok(slash.handled, "/sheet is not registered as a slash command");
  ok(/add a sheet/i.test(slash.title), `/sheet opened "${slash.title}" instead of the add dialog`);
  ok(slash.url === EDIT, `/sheet did not carry the pasted link through: "${slash.url}"`);
  ok(/publish to web/i.test(slash.verdict), `/sheet did not classify the link: "${slash.verdict}"`);
  ok(slash.label === "Sheet", `/sheet did not auto-fill the label: "${slash.label}"`);
  await page.evaluate(() => document.querySelector(".modal .modal-head button.icon")?.click());
  await sleep(250);

  // ------------------------------------------------------------- 7. permission
  // Same gate the bookmark bar already used, not a new one: no Manage channels,
  // no add affordance anywhere in the bar.
  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    store.isAdmin = false;
    store.perms = 0n;
    bus.emit("channel:open", { channel: store.current });
  });
  await sleep(600);
  const adds = await page.$$eval("#bmkBar .bmk-pill.bmk-add", (ns) => ns.length);
  ok(adds === 0, `${adds} add affordance(s) shown to somebody without Manage channels`);
  const stillPinned = await page.$$eval("#bmkBar .bmk-pill", (ns) => ns.length);
  ok(stillPinned >= 3, `the pinned sheets vanished along with the add button (${stillPinned} pills)`);

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
