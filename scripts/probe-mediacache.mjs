// Behavioral guard for the signed-URL cache + batched mint-download,
// js/core/media.js. mediaUrl/mediaUrls shipped with only a node --check and a
// boot screenshot, so the claims that N attachment keys cost exactly ONE
// edge-function POST carrying every missing key, that an immediate repeat is
// free off the in-memory map, that IndexedDB (dak.media) answers after a full
// reload so only never-answered keys go back to the wire, that an expired stored
// row is never served but refreshed, that the answer's REAL expiry is
// persisted verbatim where a missing one falls back to the soft TTL, that the
// single-key path posts {object_key} and dedupes, and that opening the store
// drops the legacy dek-backend.media database once were all unproven. Every claim
// here is deterministic, so the asserts are EXACT VALUES, not shapes:
//
//   PAGE 1 (the very instance the booted app shares):
//   LEG G   a hand-built dek-backend.media database existing before the first
//           media call is deleted by the first urlDb() open (poll
//           indexedDB.databases() until it is gone).
//   LEG A   mediaUrls([k1,k2,k3]) costs exactly ONE POST whose body carries
//           object_keys exactly [k1,k2,k3]; the answer holding k1/k2 only
//           returns [u1,u2,null] aligned to input order; raw dak.media rows
//           carry the answer's exp VERBATIM (fixed far-future constant).
//   LEG B   an immediate repeat costs ZERO further POSTs and returns the same
//           aligned array off the memory map, including the known-missing k3
//           stored as null.
//   LEG E   mediaUrl('solo') costs one POST whose body is exactly
//           {object_key:'solo'}, returns the answer url, dedupes the second
//           call at zero POSTs, and persists exp verbatim.
//   PAGE 1 after a FULL RELOAD (fresh module instance, cold L1):
//   LEG C   mediaUrls([k1,k2,k3]) pays exactly ONE NARROW POST naming ONLY
//           the never-answered k3; u1/u2 are served from IndexedDB and the
//           aligned array still comes back.
//   LEG D   a seeded EXPIRED row (exp in the past) is never served: exactly
//           ONE POST carries kx, the fresh url comes back, and the rewritten
//           row's exp sits inside the soft-TTL window (answer carried no exp).
//
// FOUND AND FIXED by this probe's first run: mediaUrls' L2 reads were
// fire-and-forget, so missing[] was computed before any onsuccess ran and the
// read side of the cache could never answer; every batch call refetched ALL
// keys even straight after a reload, contradicting the module header ("so
// scrolling back after a RELOAD reuses the still-valid signed URL instead of
// paying a fresh edge-function invocation"). The fix consults the memory map
// first and awaits each remaining get; this probe pins the fixed contract.
//
// Negative test (separate run): cache READS disabled in mediaUrls (the L1
// consult forced false and the db forced null) - exactly legs B and C must
// fail on their wire shapes while every write-side, expired-refetch and
// single-path assert stays green.
//
// Usage: node scripts/probe-mediacache.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { out.root = argv[++i]; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");
const TARGET = path.join(ROOT, "js", "core", "media.js");

function shaOf(file) {
  const raw = fs.readFileSync(file);
  const norm = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return {
    raw: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8),
    norm: crypto.createHash("sha256").update(norm).digest("hex").slice(0, 8),
  };
}
const SHA_BEFORE = shaOf(TARGET);
console.log(`probe-mediacache: media.js normalized sha ${SHA_BEFORE.norm} (raw ${SHA_BEFORE.raw})`);

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
console.log(`probe-mediacache: serving ${ROOT} on ${BASE}`);

const problems = [];
const errors = [];

// Mutable per-leg canned answers for the mint-download edge function.
const ANSWER = {
  batch: {},
  batchExp: undefined,
  single: { url: "https://cdn.test/warm", exp: 4102444800000 },
};
const posts = [];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

await context.route("**/functions/v1/mint-download*", async (route) => {
  const req = route.request();
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch {}
  posts.push({
    keys: Array.isArray(body.object_keys) ? body.object_keys : null,
    single: typeof body.object_key === "string" ? body.object_key : null,
    at: Date.now(),
  });
  let payload;
  if (Array.isArray(body.object_keys)) {
    const urls = {};
    for (const k of body.object_keys) {
      if (ANSWER.batch[k] != null) urls[k] = ANSWER.batch[k];
    }
    payload = { urls };
    if (ANSWER.batchExp !== undefined) payload.exp = ANSWER.batchExp;
  } else {
    payload = ANSWER.single || {};
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
});

async function newPage() {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`p${errors.length}: ${e.message}`));
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return page;
}

try {
  // ---------------------------------------------------------------- PAGE 1
  let page = await newPage();
  if (posts.length !== 0) {
    problems.push(`[baseline] boot fired ${posts.length} mint-download POSTs, expected 0`);
  }

  // ---- LEG G: legacy dek-backend.media dropped by the first store open
  const gRes = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    if (typeof indexedDB.databases !== "function") {
      bad.push("G-SKIP indexedDB.databases() unavailable in this engine");
      return { bad, skipped: true };
    }
    // Build the pre-migration database exactly like the old product left it.
    await new Promise((res, rej) => {
      const rq = indexedDB.open("dek-backend.media", 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains("urls")) rq.result.createObjectStore("urls");
      };
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction("urls", "readwrite");
        tx.objectStore("urls").put({ url: "old-signed-url", exp: 1 }, "ancient");
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      rq.onerror = () => rej(rq.error);
    });
    const namesNow = async () => (await indexedDB.databases()).map((d) => d.name);
    eq((await namesNow()).includes("dek-backend.media"), true, "G dek-backend.media standing before first media call");
    const M = await import("/js/core/media.js");
    // First media call on this page load opens dak.media, which fires the
    // one-shot legacy drop. Answer arrives from the route.
    const u = await M.mediaUrl("legacy-warmup");
    eq(u, "https://cdn.test/warm", "G warm-up mediaUrl answered off the wire");
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 100));
      gone = !(await namesNow()).includes("dek-backend.media");
    }
    eq(gone, true, "G dek-backend.media deleted after first store open");
    return { bad };
  });
  problems.push(...gRes.bad.map((s) => `[page1] ${s}`));

  // ---- LEG A + LEG B + LEG E on the same live page
  const FAR_EXP = 4102444800000; // 2100-01-01, exact-equality target
  ANSWER.batch = { k1: "https://cdn.test/u1", k2: "https://cdn.test/u2" };
  ANSWER.batchExp = FAR_EXP;
  ANSWER.single = { url: "https://cdn.test/u-solo", exp: FAR_EXP };

  const aRes = await page.evaluate(async ({ FAR_EXP }) => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const M = await import("/js/core/media.js");

    // ---- LEG A: one batched POST, aligned answer, verbatim persisted exp
    const urls = await M.mediaUrls(["k1", "k2", "k3"]);
    eq(urls, ["https://cdn.test/u1", "https://cdn.test/u2", null], "A aligned answer, missing key null");
    const rawRow = async (key) =>
      new Promise((res, rej) => {
        const rq = indexedDB.open("dak.media", 1);
        rq.onerror = () => rej(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const g = db.transaction("urls").objectStore("urls").get(key);
          g.onsuccess = () => { db.close(); res(g.result); };
          g.onerror = () => rej(g.error);
        };
      });
    const r1 = await rawRow("k1");
    eq(r1 && { url: r1.url, exp: r1.exp }, { url: "https://cdn.test/u1", exp: FAR_EXP }, "A k1 row on disk with verbatim exp");
    const r2 = await rawRow("k2");
    eq(r2 && { url: r2.url, exp: r2.exp }, { url: "https://cdn.test/u2", exp: FAR_EXP }, "A k2 row on disk with verbatim exp");

    // ---- LEG B: immediate repeat is free off the memory map
    const again = await M.mediaUrls(["k1", "k2", "k3"]);
    eq(again, ["https://cdn.test/u1", "https://cdn.test/u2", null], "B repeat returns the same aligned array");

    // ---- LEG E: single-key path
    const solo = await M.mediaUrl("solo");
    eq(solo, "https://cdn.test/u-solo", "E single url returned");
    const soloAgain = await M.mediaUrl("solo");
    eq(soloAgain, "https://cdn.test/u-solo", "E single repeat returned");
    const rs = await rawRow("solo");
    eq(rs && { url: rs.url, exp: rs.exp }, { url: "https://cdn.test/u-solo", exp: FAR_EXP }, "E solo row on disk with verbatim exp");
    return { bad };
  }, { FAR_EXP });
  problems.push(...aRes.bad.map((s) => `[page1] ${s}`));

  // Wire accounting done Node-side where the route lives. Page 1 must have
  // fired EXACTLY three POSTs: G warm-up single, A full batch, E single. Leg
  // B must have added nothing (the repeat rides the memory map, including the
  // known-missing k3 stored as null).
  if (posts.length !== 3) {
    problems.push(`[wire] expected exactly 3 POSTs on page 1 (B must add ZERO), got ${posts.length}: ${JSON.stringify(posts)}`);
  } else {
    if (JSON.stringify(posts[0].single) !== JSON.stringify("legacy-warmup")) {
      problems.push(`[wire] G warm-up POST body object_key mismatch: ${JSON.stringify(posts[0])}`);
    }
    if (JSON.stringify(posts[1].keys) !== JSON.stringify(["k1", "k2", "k3"])) {
      problems.push(`[wire] A batch POST object_keys mismatch: ${JSON.stringify(posts[1])}`);
    }
    if (JSON.stringify(posts[2].single) !== JSON.stringify("solo")) {
      problems.push(`[wire] E single POST body object_key mismatch: ${JSON.stringify(posts[2])}`);
    }
  }

  // ------------------------------------------------- PAGE 1 after full reload
  // Fresh module instance: the in-memory map starts empty, so any hit below
  // comes from the IndexedDB layer alone.
  page = await newPage();

  // Leg D's canned answer is configured Node-side because the route handler
  // lives here; NO exp field so the write-back must fall back to the soft TTL.
  ANSWER.batch = { kx: "https://cdn.test/fresh-x" };
  delete ANSWER.batchExp;
  const T0 = Date.now();

  const cRes = await page.evaluate(async ({ T0 }) => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const M = await import("/js/core/media.js");

    // ---- LEG C: the reload pays exactly ONE narrow POST for the one key
    // the original answer never supplied; k1/k2 come from IndexedDB.
    const urls = await M.mediaUrls(["k1", "k2", "k3"]);
    eq(urls, ["https://cdn.test/u1", "https://cdn.test/u2", null], "C reload served aligned array");

    // ---- LEG D: an expired row is never served, it is refreshed
    await new Promise((res, rej) => {
      const rq = indexedDB.open("dak.media", 1);
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction("urls", "readwrite");
        tx.objectStore("urls").put({ url: "https://cdn.test/stale-x", exp: Date.now() - 1000 }, "kx");
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
    });
    const rx = await M.mediaUrls(["kx"]);
    eq(rx, ["https://cdn.test/fresh-x"], "D expired row refreshed off the wire");
    const rk = await new Promise((res, rej) => {
      const rq = indexedDB.open("dak.media", 1);
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const g = db.transaction("urls").objectStore("urls").get("kx");
        g.onsuccess = () => { db.close(); res(g.result); };
        g.onerror = () => rej(g.error);
      };
    });
    const SOFT_MS = 230000; // keep in sync with URL_TTL_MS in js/core/media.js
    const softOk = rk && rk.url === "https://cdn.test/fresh-x"
      && typeof rk.exp === "number"
      && rk.exp > T0 + SOFT_MS - 6000
      && rk.exp < T0 + SOFT_MS + 6000;
    eq(softOk, true, "D rewritten row carries soft-TTL expiry");
    return { bad };
  }, { T0 }).catch((e) => ({ bad: [`[harness] page1-reload evaluate threw: ${e.message}`] }));
  problems.push(...cRes.bad.map((s) => `[page1-reload] ${s}`));

  // Wire accounting for C/D (C adds exactly ONE post naming only k3, so D
  // lands at index 4):
  if (posts.length !== 5) {
    problems.push(`[wire] expected exactly 5 POSTs total after C/D (leg C must add exactly the narrow k3 read), got ${posts.length}: ${JSON.stringify(posts)}`);
  } else {
    if (JSON.stringify(posts[3].keys) !== JSON.stringify(["k3"])) {
      problems.push(`[wire] C reload POST must name ONLY the never-answered k3: ${JSON.stringify(posts[3])}`);
    }
    if (JSON.stringify(posts[4].keys) !== JSON.stringify(["kx"])) {
      problems.push(`[wire] D refresh POST object_keys mismatch: ${JSON.stringify(posts[4])}`);
    }
  }

  await page.close();
} catch (e) {
  console.error("SETUP FAILURE:", e.message);
  process.exitCode = 2;
} finally {
  if (errors.length) problems.push(`pageerrors: ${errors.length} (${errors[0]})`);
  await browser.close();
  server.close();
}

if (process.exitCode !== 2) {
  console.log("legs: G legacy-db drop | A one batched POST + aligned + verbatim exp | B repeat free | E single path | C reload zero-cost | D expired refreshed + soft TTL");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
