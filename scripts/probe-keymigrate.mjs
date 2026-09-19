// Behavioral guard for the storage-key unification: every persisted key still
// on the first product name moves to its dak.* name at boot (util.js
// migrateLegacyKeys, called at the top of main()), and the loader console
// prefix is [dak] now. Owned by no other probe; asserts the move end to end
// against the REAL boot, including the no-clobber rule and the old key's
// removal.
//
// Self-serves the tree on an ephemeral port (no PID cleanup dance).
import { chromium, devices } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    if (err) { res.writeHead(404).end("nope"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

const browser = await chromium.launch();
const boot = async (seed) => {
  const ctx = await browser.newContext({ ...devices["iPhone 13 Pro"] });
  if (seed) {
    await ctx.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, seed);
  }
  const page = await ctx.newPage();
  const seen = { featureLines: [], errors: [] };
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (/features loaded:/.test(text)) {
      seen.featureLines.push(text);
      if (msg.type() === "error") seen.errors.push(text);
    }
  });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  return { ctx, page, seen };
};

// ---- Case A: legacy-only seeds move to dak.* twins, originals removed ----
{
  const { page } = await boot({
    "dek-backend.emoji.recent": '["thumbsup","fire"]',
    "dek-backend.cat.design": "0",
    "dek-backend.report.quiet": "14",
    "dek-backend.later.sec.work": "1",
    "dek-backend.quicktask.off": "1",
    "dek-backend.tasks.tab": "all",
    "dek-backend.task.reminded": "[9]",
    "dek-backend.ux.recentSearch": '["roster"]',
    "Dek.lastChannel": JSON.stringify({ id: "ch1", name: "General", uid: "u1" }),
  });
  const st = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^(dak|dek-backend|Dek)\./.test(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  });
  ok(st["dak.emoji.recent"] === '["thumbsup","fire"]', `A emoji recents moved (got ${st["dak.emoji.recent"]})`);
  ok(st["dak.cat.design"] === "0", "A collapsed category moved");
  ok(st["dak.report.quiet"] === "14", "A quiet days moved");
  ok(st["dak.later.sec.work"] === "1", "A Later section state (prefix key) moved");
  ok(st["dak.quicktask.off"] === "1", "A quicktask off moved");
  ok(st["dak.tasks.tab"] === "all", "A tasks tab moved");
  ok(st["dak.task.reminded"] === "[9]", "A reminded marker moved");
  ok(st["dak.ux.recentSearch"] === '["roster"]', "A recent search moved");
  ok(st["dak.lastChannel"] !== undefined && st["dak.lastChannel"].includes("ch1"), "A Dek.lastChannel moved");
  ok(!Object.keys(st).some((k) => k.startsWith("dek-backend.")), `A zero dek-backend.* keys remain (${Object.keys(st).filter((k) => k.startsWith("dek-backend.")).join(",") || "none"})`);
  ok(!Object.keys(st).some((k) => k.startsWith("Dek.")), "A zero Dek.* keys remain");
  await page.context().close();
}

// ---- Case B: existing dak.* wins, legacy twin still removed ----
{
  const { page } = await boot({
    "dek-backend.tasks.tab": "mine",
    "dak.tasks.tab": "all",
  });
  const st = await page.evaluate(() => ({
    dak: localStorage.getItem("dak.tasks.tab"),
    legacy: localStorage.getItem("dek-backend.tasks.tab"),
  }));
  ok(st.dak === "all", `B dak.* kept authoritative (got ${st.dak})`);
  ok(st.legacy === null, "B legacy twin removed even when newer-looking");
  await page.context().close();
}

// ---- Case C: loader announces under [dak], never [dek-backend] ----
{
  const { seen } = await boot(null);
  ok(seen.featureLines.length >= 1, "C features-loaded line seen");
  ok(seen.featureLines.every((l) => l.startsWith("[dak]")), `C line carries [dak] prefix (${seen.featureLines[0] || "none"})`);
  ok(!seen.featureLines.some((l) => l.startsWith("[dek-backend]")), "C no [dek-backend] line anywhere");
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`PROBE FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("PROBE CLEAN - storage keys unified under dak.*, loader prefix [dak]");
process.exit(0);
