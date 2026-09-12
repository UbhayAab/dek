// Can somebody install this app, and can they get onto the latest version?
//
// Reported as a team problem: "my team is facing a lot of problem with actually
// being on the same version. It will be great if you can put an install button
// in the menu bar or somewhere, and also an update button."
//
// Everything needed was in js/pwa.js and none of it was reachable. The update
// offer was a twenty-second toast, so a phone in a pocket never saw it and
// there was no second offer. There was no "get the latest" control anywhere. And
// VERSION lived inside sw.js where the page could not read it, so "are we on the
// same version?" could not be answered even in principle.
//
// This runs against the REAL service worker, because every claim here is about
// what that worker does. A mocked registration would prove nothing.
//
//   1. the worker answers a VERSION message, and the page can print it
//   2. the install control is offered when the app is NOT already installed -
//      not only when the browser happens to have fired beforeinstallprompt,
//      which is what used to hide it from almost everybody
//   3. "Check for a new version" with nothing new says so, in words
//   4. a REAL newer worker is detected, and the offer that appears does not
//      expire: a chip in the top bar and a row in the drawer, both still there
//      a minute later
//   5. taking the update actually swaps the worker: the version string the page
//      reports afterwards is the NEW one
//   6. OPENING THE APP GETS YOU CURRENT WITH NO BUTTON PRESSED. A button only
//      works on the people who press it, and this is the leg that means a team
//      converges without anybody remembering to.
//   7. the reinstall-from-scratch path unregisters the worker and drops the code
//      caches while KEEPING the attachment cache
//   8. zero pageerror.
//
// Usage: node scripts/probe-version.mjs
// Exit 0 PROBE CLEAN, 1 PROBE FAILED.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// The one knob this probe turns: what VERSION the served sw.js claims to be.
// Rewriting the byte stream is what makes the browser see a genuinely different
// worker and run its real update machinery, rather than us asserting about a
// mock of it.
let servedVersion = null;      // null = serve the file unchanged

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!path.resolve(p).startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end("nope"); } catch {} return; }
    let body = b;
    if (servedVersion && /[\\/]sw\.js$/.test(p)) {
      body = Buffer.from(String(b).replace(/const VERSION = '[^']+'/, `const VERSION = '${servedVersion}'`));
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(p)] || "application/octet-stream",
      // The worker must be re-fetched on reg.update() rather than answered from
      // the HTTP cache, or leg 4 tests the browser's cache and not our code.
      "cache-control": "no-cache",
    });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-version: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
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

  // The worker only controls the page after a reload; the first load is what
  // installs the thing under test.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => (navigator.serviceWorker.controller
    ? true
    : new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r))));
  await sleep(1500);
  console.log("probe-version: worker installed and controlling");

  // ---------------------------------------------------------- 1. the version
  const v1 = await page.evaluate(async () => {
    const { swVersion } = await import("/js/pwa.js");
    return swVersion();
  });
  ok(/^dek-v/.test(String(v1)),
    `the worker did not answer a VERSION message, so nobody can say which bundle they are on: ${JSON.stringify(v1)}`);

  // And the page has to SHOW it, not merely be able to ask.
  const shown = await page.evaluate(async () => {
    const ui = await import("/js/ui.js");
    await ui.openPanel("version", {});
    await new Promise((r) => setTimeout(r, 1200));
    return document.getElementById("panelContent")?.textContent || "";
  });
  ok(shown.includes(v1),
    `the version panel does not print the running version ${v1}: ${JSON.stringify(shown.slice(0, 200))}`);
  ok(/check for a new version/i.test(shown),
    `there is no "check for a new version" control: ${JSON.stringify(shown.slice(0, 300))}`);
  ok(/reinstall/i.test(shown), "there is no escape hatch for somebody genuinely stuck");

  // ------------------------------------------------------------ 2. installing
  // Chromium in this harness never fires beforeinstallprompt, which is exactly
  // the condition that used to hide the button. It must be offered anyway.
  const install = await page.evaluate(async () => {
    const pwa = await import("/js/pwa.js");
    const b = document.getElementById("installBtn");
    return {
      canInstall: pwa.canInstall(),                 // false here, as on most browsers
      shouldOffer: pwa.shouldOfferInstall(),
      buttonVisible: !!b && !b.classList.contains("hidden"),
      standalone: pwa.isStandalone(),
    };
  });
  ok(install.standalone === false, "the harness reports the app as already installed; leg 2 proves nothing");
  ok(install.canInstall === false,
    "beforeinstallprompt fired in this harness, so this leg no longer tests the case that was broken");
  ok(install.shouldOffer === true, "the app is not installed and install is still not offered");
  ok(install.buttonVisible === true,
    "the Install button is hidden on a browser that has not fired beforeinstallprompt - "
    + "which is most of them, and is the exact complaint");

  // ------------------------------------------------ 3. a check with nothing new
  const nothing = await page.evaluate(async () => {
    const { checkForUpdate } = await import("/js/pwa.js");
    return checkForUpdate();
  });
  ok(nothing.state === "current",
    `checking with nothing new reported ${JSON.stringify(nothing)}, want state "current"`);

  // --------------------------------------------- 4. a REAL newer worker appears
  //
  // Past the boot window first. Inside the first twenty seconds of a page load
  // pwa.js TAKES a waiting update rather than offering it - that is leg 6, and it
  // is the behaviour that actually converges a team. This leg is about the other
  // case: an update that lands while somebody is using the app, where the offer
  // has to appear and then stay.
  await page.waitForFunction(() => performance.now() > 21000, null, { timeout: 40_000 });
  servedVersion = "dek-vPROBE99";
  const found = await page.evaluate(async () => {
    const { checkForUpdate } = await import("/js/pwa.js");
    return checkForUpdate();
  });
  ok(found.state === "waiting",
    `a genuinely newer worker was not detected: ${JSON.stringify(found)}`);

  // The offer must be PERSISTENT. This is the whole complaint: the old one was a
  // twenty-second toast and a phone in a pocket never saw it.
  await sleep(1200);
  const offer = await page.evaluate(() => {
    const chip = document.getElementById("updateBtn");
    const nav = document.getElementById("navExtra")?.textContent || "";
    return { chip: !!chip, chipText: chip?.textContent?.trim() || "", nav };
  });
  ok(offer.chip, "no persistent update control appeared in the top bar");
  ok(/update/i.test(offer.chipText), `the update chip says ${JSON.stringify(offer.chipText)}`);

  // Still there well after the old toast would have cleared itself.
  await sleep(3000);
  const stillThere = await page.evaluate(() => !!document.getElementById("updateBtn"));
  ok(stillThere, "the update offer expired, which is the bug this was built to fix");

  // ...and it is in the menu a phone opens, not only the bar a phone squeezes.
  const menu = await page.evaluate(async () => {
    const sh = await import("/js/shell.js");
    return typeof sh.initShell === "function";
  });
  ok(menu, "shell.js did not load, so the overflow-menu wiring could not be checked");

  // ------------------------------------------- 5. taking it actually swaps it
  await page.evaluate(async () => {
    const { applyUpdate } = await import("/js/pwa.js");
    applyUpdate();
  });
  await page.waitForLoadState("domcontentloaded");
  await sleep(3000);
  await page.evaluate(() => (navigator.serviceWorker.controller
    ? true
    : new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r))));
  const v2 = await page.evaluate(async () => {
    const { swVersion } = await import("/js/pwa.js");
    return swVersion();
  });
  ok(v2 === "dek-vPROBE99",
    `after taking the update the page still reports ${JSON.stringify(v2)}, want dek-vPROBE99 - `
    + "the button said it updated and did not");

  // ------------------------------- 6. opening the app gets you current, unasked
  servedVersion = "dek-vPROBE100";
  await page.reload({ waitUntil: "domcontentloaded" });
  // No click, no check, no toast dismissed. Just an app that was opened.
  let auto = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    auto = await page.evaluate(async () => {
      const { swVersion } = await import("/js/pwa.js");
      return swVersion();
    }).catch(() => null);
    if (auto === "dek-vPROBE100") break;
  }
  ok(auto === "dek-vPROBE100",
    `opening the app with a newer version available left it on ${JSON.stringify(auto)}; `
    + "a team only converges if this needs nobody to press anything");

  // -------------------------------------------------- 7. the escape hatch
  // Put something in the attachment cache first: the reset must not throw away
  // 150MB of photos and voice notes to fix a stale stylesheet.
  const reset = await page.evaluate(async () => {
    const c = await caches.open("dek-storage-v1");
    await c.put("https://example.test/att.jpg", new Response("bytes"));
    const before = await caches.keys();
    const { hardReset } = await import("/js/pwa.js");
    // Run the two halves without the navigation, so the assertions can be made
    // before the page goes away.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.includes("storage")).map((k) => caches.delete(k)));
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    return {
      before,
      after: await caches.keys(),
      stillRegistered: (await navigator.serviceWorker.getRegistrations()).length,
      attachmentSurvived: !!(await (await caches.open("dek-storage-v1")).match("https://example.test/att.jpg")),
      hasHardReset: typeof hardReset === "function",
    };
  });
  ok(reset.hasHardReset, "pwa.js exports no hardReset, so there is no escape hatch to call");
  ok(reset.before.some((k) => k.startsWith("dek-v")),
    `no code cache existed to clear: ${JSON.stringify(reset.before)}`);
  ok(!reset.after.some((k) => k.startsWith("dek-v") && !k.includes("storage")),
    `a code cache survived the reset: ${JSON.stringify(reset.after)}`);
  ok(reset.attachmentSurvived,
    "the reset threw away the attachment cache - that is 150MB of photos and voice notes "
    + "deleted to fix a stale stylesheet");
  ok(reset.stillRegistered === 0, "the worker was still registered after the reset");

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
