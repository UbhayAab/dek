// Can somebody find the other servers, and get into them?
//
// The most heard complaint, verbatim: "people are not able to see or find all
// servers... we can't see the other servers. People need to be very easily able
// to join all servers - search, or by group."
//
// The measured shape of it, from the live database: Safalta Setu's servers are
// already join_policy='open' and hold 19, 17 and 17 of its 51 people. They are
// open and unfindable. So this is not a permissions feature, it is a finding
// feature, and these legs are about finding.
//
//   1. every server in EVERY organisation is listed, not one org at a time
//   2. grouped by organisation - "HR" is the name of a server in both of them,
//      so a flat list would be two identical rows
//   3. search matches the server name AND the organisation name
//   4. the three states read differently: in it, joinable, invite only
//   5. Join calls join_team_space with that server's id
//   6. ONE button joins everything open, and does NOT touch the invite-only one
//   7. an org admin gets "Let everyone in" and it sets join_policy open;
//      an ordinary member does not get that button at all
//   8. Ctrl+K finds a server by name, which it never could before - the quick
//      switcher only ever searched channels and people in the Space you were
//      already standing in
//   9. zero pageerror.
//
// Usage: node scripts/probe-serverdir.mjs [--root <dir>]
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
console.log(`probe-serverdir: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const joins = [];
const policySets = [];
// Joining calls loadSpaces(), which re-reads my_orgs and OVERWRITES store.orgs.
// Without this mock the second render found zero organisations and painted the
// empty state, which looked exactly like a broken directory. The real app has
// this RPC; the fixture has to have it too.
let orgRole = "member";

// Shaped exactly like the live data, including two servers called HR.
const SPACES = {
  "org-jc": [
    { id: "ws-jc1", name: "Jarurat Care", slug: "jc", join_policy: "invite",
      created_by_name: "Ubhay", member_count: 64, is_member: true },
    { id: "ws-jc2", name: "HR Psy-Connect", slug: "psy", join_policy: "open",
      created_by_name: "Ubhay", member_count: 14, is_member: false },
    { id: "ws-jc3", name: "HR", slug: "hr", join_policy: "invite",
      created_by_name: "Ubhay", member_count: 4, is_member: false },
  ],
  "org-ss": [
    { id: "ws-ss1", name: "Safalta Setu", slug: "ss", join_policy: "open",
      created_by_name: "Ubhay", member_count: 50, is_member: false },
    { id: "ws-ss2", name: "Design", slug: "design", join_policy: "open",
      created_by_name: "Neha", member_count: 17, is_member: false },
    { id: "ws-ss3", name: "HR", slug: "ss-hr", join_policy: "open",
      created_by_name: "Neha", member_count: 19, is_member: false },
  ],
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/my_orgs", (route) => route.fulfill(json([
    { org_id: "org-jc", name: "Jarurat Care", slug: "jc", org_role: orgRole, spaces: 3, my_spaces: 1 },
    { org_id: "org-ss", name: "Safalta Setu", slug: "ss", org_role: "member", spaces: 3, my_spaces: 0 },
  ])));
  await context.route("**/rest/v1/rpc/get_space_summary", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/list_org_spaces", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    return route.fulfill(json(SPACES[b.p_org] || []));
  });
  await context.route("**/rest/v1/rpc/join_team_space", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    joins.push(b.p_workspace);
    for (const list of Object.values(SPACES)) {
      const hit = list.find((s) => s.id === b.p_workspace);
      if (hit) { hit.is_member = true; hit.member_count++; }
    }
    return route.fulfill(json({ id: b.p_workspace }));
  });
  await context.route("**/rest/v1/rpc/set_workspace_join_policy", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    policySets.push(b);
    for (const list of Object.values(SPACES)) {
      const hit = list.find((s) => s.id === b.p_workspace);
      if (hit) hit.join_policy = b.p_policy;
    }
    return route.fulfill(json(null));
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
  console.log("probe-serverdir: app booted");

  const seed = async (role) => {
    orgRole = role;
    return page.evaluate(async (r) => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "ws-jc1", name: "Jarurat Care", org_id: "org-jc" };
    store.spaces = [{ id: "ws-jc1", name: "Jarurat Care", org_id: "org-jc" }];
    store.orgs = [
      { org_id: "org-jc", name: "Jarurat Care", org_role: r },
      { org_id: "org-ss", name: "Safalta Setu", org_role: "member" },
    ];
    store.channels = [{ id: "ch-1", name: "general", kind: "text", position: 1 }];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    bus.emit("workspace", {});
    await new Promise((x) => setTimeout(x, 400));
    }, role);
  };

  const open = (ctx = {}) => page.evaluate(async (c) => {
    await window.__p.ui.openPanel("servers", c);
    await new Promise((r) => setTimeout(r, 900));
  }, ctx);

  const shown = () => page.evaluate(() => ({
    orgs: [...document.querySelectorAll("#panelContent .srvd-orgname")].map((n) => n.textContent.trim()),
    names: [...document.querySelectorAll("#panelContent .srvd-name")].map((n) => n.textContent.trim()),
    buttons: [...document.querySelectorAll("#panelContent .srvd-act button")].map((n) => n.textContent.trim()),
    all: [...document.querySelectorAll("#panelContent .srvd-all")].map((n) => n.textContent.trim()),
  }));

  // ------------------------------------------------- 1 + 2. everything, grouped
  await seed("member");
  await open();
  let v = await shown();
  ok(v.orgs.length === 2, `the directory shows ${v.orgs.length} organisations, want both: ${JSON.stringify(v.orgs)}`);
  ok(v.orgs.includes("Jarurat Care") && v.orgs.includes("Safalta Setu"),
    `both organisations must be named: ${JSON.stringify(v.orgs)}`);
  ok(v.names.length === 6, `${v.names.length} servers listed, want all 6 across both orgs`);
  ok(v.names.filter((n) => n.startsWith("HR")).length === 3,
    `the two servers called HR and the HR Psy-Connect one must all appear: ${JSON.stringify(v.names)}`);

  // ------------------------------------------------------------- 4. the states
  ok(v.buttons.includes("Open"), `a server I am in has no Open button: ${JSON.stringify(v.buttons)}`);
  ok(v.buttons.filter((b) => b === "Join").length === 4,
    `want 4 joinable servers for a plain member, got ${JSON.stringify(v.buttons)}`);
  ok(v.buttons.includes("Ask to join"),
    `the invite-only server offers no way to ask: ${JSON.stringify(v.buttons)}`);
  ok(!v.buttons.includes("Let everyone in"),
    `an ordinary member is offered an admin control: ${JSON.stringify(v.buttons)}`);

  // --------------------------------------------------------------- 3. search
  await page.evaluate(async () => {
    const s = document.querySelector("#panelContent .srvd-search");
    s.value = "design"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  v = await shown();
  ok(v.names.length === 1 && /Design/.test(v.names[0]),
    `searching a server name left ${JSON.stringify(v.names)}`);

  await page.evaluate(async () => {
    const s = document.querySelector("#panelContent .srvd-search");
    s.value = "safalta"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  v = await shown();
  ok(v.names.length === 3 && v.orgs.length === 1 && v.orgs[0] === "Safalta Setu",
    `searching an ORGANISATION name must show its servers: orgs=${JSON.stringify(v.orgs)} names=${JSON.stringify(v.names)}`);

  await page.evaluate(async () => {
    const s = document.querySelector("#panelContent .srvd-search");
    s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });

  // ------------------------------------------------------------ 5. one join
  joins.length = 0;
  await page.evaluate(async () => {
    const rows = [...document.querySelectorAll("#panelContent .srvd-row")];
    const row = rows.find((r) => /HR Psy-Connect/.test(r.querySelector(".srvd-name")?.textContent || ""));
    [...row.querySelectorAll("button")].find((b) => /^Join$/.test(b.textContent.trim())).click();
    await new Promise((r) => setTimeout(r, 900));
  });
  ok(joins.length === 1 && joins[0] === "ws-jc2",
    `Join sent ${JSON.stringify(joins)}, want exactly ws-jc2`);

  // ------------------------------------------- 6. join everything open, once
  joins.length = 0;
  v = await shown();
  ok(v.all.some((t) => /Join all 3 servers/.test(t)),
    `Safalta Setu should offer to join all 3 at once: ${JSON.stringify(v.all)}`);
  await page.evaluate(async () => {
    const btn = [...document.querySelectorAll("#panelContent .srvd-all")]
      .find((b) => /Join all 3/.test(b.textContent));
    btn.click();
    await new Promise((r) => setTimeout(r, 2200));
  });
  ok(joins.length === 3, `"join all" sent ${joins.length} joins, want 3: ${JSON.stringify(joins)}`);
  ok(joins.every((id) => id.startsWith("ws-ss")),
    `"join all" reached into the wrong organisation: ${JSON.stringify(joins)}`);
  ok(!joins.includes("ws-jc3"),
    "\"join all\" joined the invite-only HR server, which it must never do");

  // ---------------------------------------------------- 7. the admin control
  await seed("admin");
  await page.evaluate(() => { window.__p.ui.closePanel?.(); });
  await open();
  v = await shown();
  ok(v.buttons.includes("Let everyone in"),
    `an org admin is not offered the one control that fixes this for everybody: ${JSON.stringify(v.buttons)}`);
  policySets.length = 0;
  await page.evaluate(async () => {
    const rows = [...document.querySelectorAll("#panelContent .srvd-row")];
    const row = rows.find((r) => (r.querySelector(".srvd-name")?.textContent || "").trim().startsWith("HR")
      && !/Psy/.test(r.querySelector(".srvd-name").textContent));
    [...row.querySelectorAll("button")].find((b) => /Let everyone in/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 1000));
  });
  ok(policySets.length === 1 && policySets[0].p_policy === "open",
    `"Let everyone in" sent ${JSON.stringify(policySets)}, want p_policy open`);
  ok(policySets[0]?.p_workspace === "ws-jc3",
    `it opened the wrong server: ${JSON.stringify(policySets[0])}`);

  // ------------------------------------------------------- 8. the quick switcher
  await page.evaluate(() => { window.__p.ui.closePanel?.(); });
  await sleep(300);
  const sw = await page.evaluate(async () => {
    const ui = window.__p.ui;
    const found = ui.getSwitcherSources().find((s) => s.id === "servers");
    if (!found) return { error: "no servers source registered with the quick switcher" };
    const hits = found.search("design") || [];
    return { labels: hits.map((h) => h.label), hints: hits.map((h) => h.hint), runnable: hits.every((h) => typeof h.run === "function") };
  });
  ok(!sw.error, sw.error || "");
  ok((sw.labels || []).includes("Design"),
    `Ctrl+K cannot find a server by name: ${JSON.stringify(sw.labels)}`);
  ok(sw.runnable === true,
    "the switcher entries have no run() - js/main.js calls items[idx].run(), so they would do nothing");
  ok((sw.hints || []).some((h) => /Safalta Setu/.test(h)),
    `the switcher does not say which organisation a server belongs to: ${JSON.stringify(sw.hints)}`);

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
