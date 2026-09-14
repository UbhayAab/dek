// Screenshots of the three surfaces this change touches, so somebody can LOOK at
// them. A probe proves an element exists and is positioned where the maths says;
// it cannot tell you the organisation heading reads as a stray character, or
// that a row is clipped, or that a dropdown lands on top of the text it is
// completing. Those have all shipped from this repo before.
//
// Writes into shots/, which the deploy withholds.
//
// Usage: node scripts/shot-servers.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "shots");
fs.mkdirSync(OUT, { recursive: true });

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
const CORS = { "access-control-allow-origin": "*" };

const SPACES = {
  "org-jc": [
    { id: "w1", name: "Jarurat Care", slug: "jc", join_policy: "invite", created_by_name: "Ubhay", member_count: 64, is_member: true },
    { id: "w2", name: "HR Psy-Connect", slug: "psy", join_policy: "open", created_by_name: "Ubhay", member_count: 14, is_member: false },
    { id: "w3", name: "HR", slug: "hr", join_policy: "invite", created_by_name: "Ubhay", member_count: 4, is_member: false },
  ],
  "org-ss": [
    { id: "w4", name: "Safalta Setu", slug: "ss", join_policy: "open", created_by_name: "Ubhay", member_count: 50, is_member: true },
    { id: "w5", name: "Design", slug: "design", join_policy: "open", created_by_name: "Neha", member_count: 17, is_member: false },
    { id: "w6", name: "HR", slug: "sshr", join_policy: "open", created_by_name: "Neha", member_count: 19, is_member: false },
  ],
};

const browser = await chromium.launch();
const shots = [];

async function shoot(name, { width, height, theme, after }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/my_orgs", (route) => route.fulfill(json([
    { org_id: "org-jc", name: "Jarurat Care", org_role: "admin", spaces: 3, my_spaces: 1 },
    { org_id: "org-ss", name: "Safalta Setu", org_role: "member", spaces: 3, my_spaces: 1 },
  ])));
  await context.route("**/rest/v1/rpc/list_org_spaces", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    return route.fulfill(json(SPACES[b.p_org] || []));
  });
  const page = await context.newPage();
  let ready; const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await Promise.race([line, new Promise((r) => setTimeout(r, 30000))]);

  await page.evaluate(async (t) => {
    const { store, bus } = await import("/js/store.js");
    window.__p = { store, bus, ui: await import("/js/ui.js") };
    if (t) document.documentElement.setAttribute("data-theme", t);
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Ubhay", username: "ubhay" };
    store.ws = { id: "w1", name: "Jarurat Care", org_id: "org-jc" };
    store.orgs = [
      { org_id: "org-jc", name: "Jarurat Care", org_role: "admin" },
      { org_id: "org-ss", name: "Safalta Setu", org_role: "member" },
    ];
    store.spaces = [
      { id: "w1", name: "Jarurat Care", org_id: "org-jc" },
      { id: "w4", name: "Safalta Setu", org_id: "org-ss" },
    ];
    store.profiles.set("u-me", { id: "u-me", display_name: "Ubhay", username: "ubhay" });
    store.profiles.set("u-mehak", { id: "u-mehak", display_name: "Mehak", username: "mehak_k1" });
    store.profiles.set("u-sourabh", { id: "u-sourabh", display_name: "Sourabh", username: "sourabh_r2" });
    store.categories = [{ id: "c1", name: "General", position: 1 }];
    store.channels = [
      { id: "ch-1", name: "founders-office", kind: "text", category_id: "c1", position: 1 },
      { id: "ch-2", name: "announcements", kind: "text", category_id: "c1", position: 2 },
    ];
    store.current = store.channels[0];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    const ch = await import("/js/core/channels.js");
    await ch.renderChannels();
    await window.__p.ui.renderNavSections();
    bus.emit("channel:open", { channel: store.current });
    await new Promise((r) => setTimeout(r, 700));
  }, theme);

  if (after) await after(page);
  await new Promise((r) => setTimeout(r, 500));
  const file = path.join(OUT, name + ".png");
  await page.screenshot({ path: file });
  shots.push(`${name}.png  ${width}x${height}`);
  await context.close();
}

// 1. the drawer on a laptop, with no rail and the organisation headings.
await shoot("srv-desktop-drawer", { width: 1280, height: 900 });

// 2. the directory, which is the answer to "we can't see the other servers".
await shoot("srv-desktop-directory", { width: 1280, height: 900, after: async (page) => {
  await page.evaluate(async () => {
    await window.__p.ui.openPanel("servers", {});
    await new Promise((r) => setTimeout(r, 1200));
  });
} });

// 3. the same on a phone, where the drawer has to be opened first.
await shoot("srv-phone-drawer", { width: 390, height: 844, after: async (page) => {
  await page.evaluate(() => document.body.classList.add("nav-open"));
} });
await shoot("srv-phone-directory", { width: 390, height: 844, after: async (page) => {
  await page.evaluate(async () => {
    await window.__p.ui.openPanel("servers", {});
    await new Promise((r) => setTimeout(r, 1200));
  });
} });

// 4. the mention picker inside a reply thread - the thing that could not be
//    done at all, and the thing most likely to be in the wrong place.
await shoot("srv-thread-mention", { width: 1280, height: 900, after: async (page) => {
  await page.evaluate(async () => {
    const { openThread } = await import("/js/core/threads.js");
    const { store } = window.__p;
    const root = { id: "m-root", channel_id: "ch-1", workspace_id: "w1", seq: 1,
      author_id: "u-mehak", body_text: "who is covering the camp on Sunday?", body: {},
      attachments: [], created_at: new Date().toISOString(), mention_user_ids: [] };
    store.msgCache.set(root.id, root);
    store.rootThreads.set(root.id, { threadId: "th-1", count: 1, last_message_at: new Date().toISOString() });
    await openThread(root);
    await new Promise((r) => setTimeout(r, 900));
  });
  await page.focus("#threadComposer");
  await page.type("#threadComposer", "can you take it @me", { delay: 30 });
  await new Promise((r) => setTimeout(r, 400));
} });

// 5. the organisation menu, which is the rail's only irreplaceable job.
await shoot("srv-orgmenu", { width: 1280, height: 900, after: async (page) => {
  await page.evaluate(async () => {
    document.querySelector("#channels .nav-orgmenu")?.click();
    await new Promise((r) => setTimeout(r, 400));
  });
} });

await browser.close();
server.close();
console.log("shot-servers wrote:");
for (const s of shots) console.log("  " + s);
