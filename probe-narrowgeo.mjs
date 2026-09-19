import { chromium } from "playwright";

const base = "http://127.0.0.1:4177";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`[console.error] ${m.text()}`); });

await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1800);

// --- NARROW (390px viewport): CSS geometry + 10-minute grouping window ---
const narrow = await page.evaluate(async () => {
  const out = {};
  const mod = await import("/js/core/messages.js");

  // Stand-in host INSIDE #app so @container dek measures the real box.
  const host = document.createElement("section");
  host.className = "msgs";
  host.innerHTML = '<div id="probe-list"></div>';
  document.getElementById("app").appendChild(host);
  const list = host.querySelector("#probe-list");

  // CSS geometry through stand-in rows.
  list.innerHTML = `
    <div class="msg"><div class="gutter"><div class="avatar" style="width:36px;height:36px">A</div></div>
      <div class="mbody"><div class="mhead"><span class="who">A</span><span class="t">05:57 PM</span></div>
      <div class="body">hello</div></div></div>`;
  const row = list.querySelector(".msg");
  const cs = getComputedStyle(row);
  out.appWidth = Math.round(document.getElementById("app").getBoundingClientRect().width);
  out.gutter = getComputedStyle(row.querySelector(".gutter")).width;
  out.avatarW = getComputedStyle(row.querySelector(".avatar")).width;
  out.padTopGroupedless = cs.paddingTop;
  out.padInline = cs.paddingRight;
  out.gap = cs.columnGap;
  out.tMargin = getComputedStyle(row.querySelector(".mhead .t")).marginInlineStart;
  out.bodyWrap = getComputedStyle(row.querySelector(".body")).textWrap;
  const msgs = document.getElementById("messages");
  out.sbGutter = msgs ? getComputedStyle(msgs).scrollbarGutter : "absent";

  // Behaviour: two rows by one author 6 minutes apart must GROUP under the
  // narrow window (10min) where desktop (5min) would split them.
  const t0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const a = { id: "p1", author_id: "u1", created_at: iso(t0 - 12 * 60000), body_text: "one" };
  const b = { id: "p2", author_id: "u1", created_at: iso(t0 - 6 * 60000), body_text: "two" };
  mod.appendMessage(list, a, "channel");
  const r2 = mod.appendMessage(list, b, "channel");
  out.narrowGroups6min = r2.classList.contains("grouped");

  host.remove();
  return out;
});

// --- WIDE (1280px viewport): same pair must NOT group (5-minute window) ---
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(400); // ResizeObserver callback + style recalc
const wide = await page.evaluate(async () => {
  const mod = await import("/js/core/messages.js");
  const host = document.createElement("section");
  host.className = "msgs";
  host.innerHTML = '<div id="probe-list-w"></div>';
  document.getElementById("app").appendChild(host);
  const list = host.querySelector("#probe-list-w");
  const t0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const a = { id: "q1", author_id: "u1", created_at: iso(t0 - 12 * 60000), body_text: "one" };
  const b = { id: "q2", author_id: "u1", created_at: iso(t0 - 6 * 60000), body_text: "two" };
  mod.appendMessage(list, a, "channel");
  const r2 = mod.appendMessage(list, b, "channel");
  const row = list.querySelector(".msg");
  const out = {
    appWidth: Math.round(document.getElementById("app").getBoundingClientRect().width),
    wideGroups6min: r2.classList.contains("grouped"),
    gutterWide: getComputedStyle(row.querySelector(".gutter")).width,
    padTopWide: getComputedStyle(row).paddingTop,
  };
  host.remove();
  return out;
});

console.log("narrow:", JSON.stringify(narrow, null, 2));
console.log("wide:", JSON.stringify(wide, null, 2));

if (!(narrow.appWidth <= 440)) problems.push(`narrow appWidth=${narrow.appWidth}, test invalid`);
if (narrow.gutter !== "28px") problems.push(`gutter=${narrow.gutter} want 28px`);
if (narrow.avatarW !== "24px") problems.push(`avatar=${narrow.avatarW} want 24px`);
if (narrow.padTopGroupedless !== "6px") problems.push(`padTop=${narrow.padTopGroupedless} want 6px`);
if (narrow.padInline !== "10px") problems.push(`padInline=${narrow.padInline} want 10px`);
if (narrow.gap !== "8px") problems.push(`gap=${narrow.gap} want 8px`);
if (narrow.tMargin === "0px") problems.push(`tMargin=${narrow.tMargin}, timestamp not pushed to line end`);
if (narrow.bodyWrap !== "pretty") problems.push(`text-wrap=${narrow.bodyWrap} want pretty`);
if (narrow.sbGutter !== "stable") problems.push(`scrollbar-gutter=${narrow.sbGutter} want stable`);
if (!narrow.narrowGroups6min) problems.push("narrow: 6-min gap should GROUP (10min window)");
if (!(wide.appWidth > 440)) problems.push(`wide appWidth=${wide.appWidth}, test invalid`);
if (wide.wideGroups6min) problems.push("wide: 6-min gap should NOT group (5min window)");
// Desktop truth is shell.css's hard 38px, not the --gutter token's 44.
if (wide.gutterWide !== "38px") problems.push(`wide gutter=${wide.gutterWide} want 38px`);

// Boot screenshot at phone size for the record.
await ctx.close();
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await ctx2.newPage();
const errs = [];
p2.on("pageerror", (e) => errs.push(e.message));
await p2.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await p2.waitForTimeout(1800);
await p2.screenshot({ path: "shots/burst-narrowgeo.png" });
console.log("boot pageerrors:", errs.length);

console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "PROBE CLEAN");
await browser.close();
process.exit(problems.length || errs.length ? 1 : 0);
