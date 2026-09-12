// Leave, from the sidebar to the ledger.
//
// The correction that produced this feature was specific: "It has to be two
// way. Anyone who's applying leave has to apply from this dashboard only,
// because we need to maintain how many total number of leaves any specific
// person had raised during their tenure here." So the thing worth proving is
// not that names appear in a sidebar. It is that:
//
//   1. the section is there BEFORE anybody has booked anything, or nobody ever
//      books anything - the exact failure Later had
//   2. the form says what the person has left BEFORE they choose dates
//   3. applying calls apply_leave with this Space's ORG id, and p_user null
//      when it is for yourself
//   4. the two outcomes are said out loud and differently: approved, vs filed
//      and NOT yet time off
//   5. an ordinary member is not offered the who-to-file-for control, because
//      apply_leave refuses it
//   6. the ledger shows what was asked for by name: days left this month, days
//      waiting, and days taken across the whole tenure
//   7. an approver gets Approve and Refuse, and they call decide_leave
//   8. withdrawing calls cancel_leave, which keeps the row rather than deleting
//      it - a cancelled request is part of the record
//   9. a member gets no Approvals or Policy tab at all
//  10. the status popover's "On leave" files an application instead of typing a
//      sentence nobody can count
//  11. zero pageerror.
//
// Usage: node scripts/probe-leave.mjs [--root <dir>]
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
console.log(`probe-leave: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

// The server answers in Asia/Kolkata, so compute the same day the same way
// rather than trusting the runner's timezone.
const IST = (t = Date.now()) => new Date(t + 330 * 60000).toISOString().slice(0, 10);
const TODAY = IST();
const plus = (d, n) => IST(Date.parse(d + "T00:00:00Z") + n * 86400000 - 330 * 60000);

let away = null;              // who_is_away answer
let applyAnswer = null;       // apply_leave answer
let ledger = [];              // list_leave answer
let inbox = null;             // leave_inbox answer
const applies = [];
const decisions = [];
const cancels = [];
const policySaves = [];
let teamReads = 0;

const balance = (over = {}) => ({
  user_id: "u-me", month: TODAY.slice(0, 7), allowance: 2, used: 1, remaining: 1,
  max_stretch_days: 15, quota_kinds: ["leave", "sick", "holiday"],
  free_kinds: ["wfh", "travel"], approval_kinds: ["exam"], policy_note: null,
  pending_days: 3, pending_requests: 1, tenure_days: 11, tenure_requests: 6,
  flags: 1, by_kind: { leave: 9, wfh: 2 }, ...over,
});

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 940 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  // Catch-all FIRST: Playwright matches the most recently registered handler.
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/workspace_members**", (route) =>
    route.fulfill(json([{ user_id: "u-me", member_type: "admin", joined_at: TODAY },
      { user_id: "u-mehak", member_type: "member", joined_at: TODAY },
      { user_id: "u-sourabh", member_type: "member", joined_at: TODAY }])));
  await context.route("**/rest/v1/profiles**", (route) =>
    route.fulfill(json([{ id: "u-mehak", display_name: "Mehak" },
      { id: "u-sourabh", display_name: "Sourabh" }])));
  await context.route("**/rest/v1/rpc/who_is_away", (route) => route.fulfill(json(away)));
  await context.route("**/rest/v1/rpc/leave_balance", (route) => route.fulfill(json(balance())));
  await context.route("**/rest/v1/rpc/list_leave", (route) => route.fulfill(json(ledger)));
  await context.route("**/rest/v1/rpc/leave_inbox", (route) => route.fulfill(json(inbox)));
  // One read for the whole team, counted, so a regression back to one request
  // per person fails here rather than being noticed by an admin in a year.
  await context.route("**/rest/v1/rpc/leave_team", (route) => {
    teamReads++;
    return route.fulfill(json({
      month: TODAY.slice(0, 7), allowance: 2,
      people: [
        { user_id: "u-mehak", used: 2, tenure_days: 14, tenure_requests: 7,
          pending_days: 3, flags: 1, away_today: true },
        { user_id: "u-sourabh", used: 0, tenure_days: 2, tenure_requests: 1,
          pending_days: 0, flags: 0, away_today: false },
      ],
    }));
  });
  await context.route("**/rest/v1/rpc/get_leave_policy", (route) => route.fulfill(json({
    org_id: "o1", auto_approve_per_month: 2, max_stretch_days: 15,
    quota_kinds: ["leave", "sick", "holiday"], free_kinds: ["wfh", "travel"],
    approval_kinds: ["exam"], flag_kinds: ["emergency"], flag_backdated: true, note: null,
  })));
  await context.route("**/rest/v1/rpc/set_leave_policy", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    policySaves.push(b);
    return route.fulfill(json({ org_id: "o1", ...b }));
  });
  await context.route("**/rest/v1/rpc/apply_leave", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    applies.push(b);
    return route.fulfill(json(applyAnswer || {
      id: "a-new", status: "approved", auto_approved: true, flagged: false,
      flag_reason: null, days: 1, kind: b.p_kind, starts_on: b.p_from, ends_on: b.p_to,
      user_id: "u-me", balance: balance({ used: 2, remaining: 0 }),
    }));
  });
  await context.route("**/rest/v1/rpc/decide_leave", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    decisions.push(b);
    return route.fulfill(json({ id: b.p_id, status: b.p_approve ? "approved" : "rejected" }));
  });
  await context.route("**/rest/v1/rpc/cancel_leave", (route) => {
    let b = {}; try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    cancels.push(b);
    return route.fulfill(json({ id: b.p_id, status: "cancelled" }));
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
  console.log("probe-leave: app booted");

  const seed = (role) => page.evaluate(async (r) => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "W", org_id: "o1" };
    store.orgs = [{ org_id: "o1", name: "Jarurat Care", org_role: r }];
    store.profiles.set("u-me", { id: "u-me", display_name: "Abhay" });
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  }, role);

  const repaint = () => page.evaluate(async () => {
    window.__p.bus.emit("workspace", {});
    await new Promise((r) => setTimeout(r, 200));
    await window.__p.ui.ui.renderNavSections();
    await new Promise((r) => setTimeout(r, 600));
  });
  const navText = () => page.$eval("#navExtra", (n) => n.textContent).catch(() => "");
  const openTab = (t) => page.evaluate(async (x) => {
    await window.__p.ui.ui.openPanel("leave", { tab: x });
    await new Promise((r) => setTimeout(r, 800));
  }, t);
  const fields = () => page.$$eval(".modal-body .field .field-label", (ns) => ns.map((n) => n.textContent));
  const modalText = () => page.$eval(".modal", (n) => n.textContent).catch(() => "");
  const closeModal = () => page.evaluate(async () => {
    document.querySelector(".modal-foot button:last-child")?.click();
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------- 1. sidebar
  away = {
    day: TODAY, org_id: "o1", is_admin: true,
    away: [
      { id: "a1", user_id: "u-mehak", kind: "leave", note: null,
        starts_on: TODAY, ends_on: TODAY, back_on: plus(TODAY, 1) },
      { id: "a2", user_id: "u-sourabh", kind: "sick", note: "on WhatsApp",
        starts_on: plus(TODAY, -1), ends_on: plus(TODAY, 3), back_on: plus(TODAY, 4) },
    ],
    mine: [{ id: "m1", kind: "exam", status: "pending", starts_on: plus(TODAY, 30),
      ends_on: plus(TODAY, 32), days: 3, auto_approved: false, flagged: false }],
    balance: balance(), inbox: 3,
  };
  await seed("admin");
  await repaint();
  let txt = await navText();
  ok(/Time off/i.test(txt), `no Time off section: ${JSON.stringify(txt.slice(0, 200))}`);
  ok(/Mehak/.test(txt) && /Sourabh/.test(txt), `people away are not named: ${JSON.stringify(txt.slice(0, 300))}`);
  ok(/back tomorrow/i.test(txt), `somebody back the next day does not read "back tomorrow": ${JSON.stringify(txt.slice(0, 300))}`);
  ok(!/back \d{4}-\d{2}-\d{2}/.test(txt), "the sidebar is printing raw ISO dates at people");
  ok(/Leave to approve/i.test(txt) && /3/.test(txt),
    `an approver with three waiting has no inbox row: ${JSON.stringify(txt.slice(0, 400))}`);
  ok(/waiting/i.test(txt), `my own pending request is invisible in the sidebar: ${JSON.stringify(txt.slice(0, 400))}`);
  ok(/Apply for leave/i.test(txt), "there is no way to apply from the sidebar");

  // 2. an empty day keeps the section, which is the whole discoverability claim.
  away = { day: TODAY, org_id: "o1", is_admin: false, away: [], mine: [], balance: balance(), inbox: 0 };
  await seed("member");
  await repaint();
  txt = await navText();
  ok(/Time off/i.test(txt), "the section disappears when nobody is away, so nobody can ever find it");
  ok(/Everyone is in today/i.test(txt), `the empty state does not say so: ${JSON.stringify(txt.slice(0, 200))}`);
  ok(/Apply for leave/i.test(txt), "the apply row is missing on an empty day - the only way in");
  ok(!/Leave to approve/i.test(txt), "a member who approves nothing is offered an approvals row");

  // ------------------------------------------------------- 3,4,5. the form
  applies.length = 0;
  await openTab("apply");
  let f = await fields();
  ok(!f.some((x) => /who is applying/i.test(x)),
    `an ordinary member is offered a control apply_leave refuses: ${JSON.stringify(f)}`);
  ok(f.some((x) => /first day/i.test(x)) && f.some((x) => /last day/i.test(x)),
    `the form is missing its dates: ${JSON.stringify(f)}`);
  let mt = await modalText();
  ok(/1 of 2 automatic day/i.test(mt),
    `the form does not say what is left BEFORE the dates are chosen: ${JSON.stringify(mt.slice(0, 300))}`);
  ok(/longest single application here is 15 days/i.test(mt),
    `the form does not state the ceiling: ${JSON.stringify(mt.slice(0, 300))}`);
  // The kind list has to carry the policy, or the choice is blind.
  const kindText = await page.$eval(".modal-body select[name=kind]", (n) => n.textContent);
  ok(/always needs approval/i.test(kindText), `exams are not marked as always needing approval: ${JSON.stringify(kindText)}`);
  ok(/not a leave/i.test(kindText), `working from home is not marked as not-a-leave: ${JSON.stringify(kindText)}`);

  await page.evaluate(async (t) => {
    const form = document.querySelector(".modal-body form");
    form.elements.from.value = t.from;
    form.elements.to.value = t.to;
    form.elements.kind.value = "leave";
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 900));
  }, { from: plus(TODAY, 3), to: plus(TODAY, 3) });

  ok(applies.length === 1, `applying sent ${applies.length} apply_leave calls, want 1`);
  const a0 = applies[0] || {};
  ok(a0.p_org === "o1", `apply_leave got org ${JSON.stringify(a0.p_org)}, want the Space's org id o1`);
  ok(a0.p_from === plus(TODAY, 3) && a0.p_to === plus(TODAY, 3),
    `apply_leave got dates ${a0.p_from}..${a0.p_to}`);
  ok(a0.p_user === null || a0.p_user === undefined,
    `applying for MYSELF sent p_user ${JSON.stringify(a0.p_user)}; it must be null so the RPC defaults to auth.uid()`);

  // 4a. the approved verdict.
  mt = await modalText();
  ok(/approved/i.test(mt), `an approved application does not say so: ${JSON.stringify(mt.slice(0, 300))}`);
  await closeModal();

  // 4b. and the other outcome has to read DIFFERENTLY, or somebody believes
  //     they have leave they do not have.
  applyAnswer = {
    id: "a-pend", status: "pending", auto_approved: false, flagged: false, flag_reason: null,
    days: 3, kind: "exam", starts_on: plus(TODAY, 40), ends_on: plus(TODAY, 42),
    user_id: "u-me", balance: balance({ remaining: 0, used: 2 }),
  };
  await openTab("apply");
  await page.evaluate(async (t) => {
    const form = document.querySelector(".modal-body form");
    form.elements.from.value = t.from; form.elements.to.value = t.to;
    form.elements.kind.value = "exam";
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 900));
  }, { from: plus(TODAY, 40), to: plus(TODAY, 42) });
  mt = await modalText();
  ok(/not/i.test(mt) && /time off yet/i.test(mt),
    `a filed-but-undecided application does not say it is not time off yet: ${JSON.stringify(mt.slice(0, 400))}`);
  await closeModal();

  // ------------------------------------------------------------ 6. the ledger
  ledger = [
    { id: "l1", user_id: "u-me", kind: "leave", status: "approved", starts_on: plus(TODAY, -20),
      ends_on: plus(TODAY, -19), days: 2, note: "Diwali", flagged: false, flag_reason: null,
      auto_approved: true, decided_by: "u-me", decided_at: TODAY, decision_note: null,
      filed_by: "u-me", created_at: TODAY },
    { id: "l2", user_id: "u-me", kind: "emergency", status: "rejected", starts_on: plus(TODAY, -5),
      ends_on: plus(TODAY, -5), days: 1, note: null, flagged: true,
      flag_reason: "Logged as an emergency no-show", auto_approved: false,
      decided_by: "u-lead", decided_at: TODAY, decision_note: "Please tell us in advance",
      filed_by: "u-me", created_at: TODAY },
    { id: "l3", user_id: "u-me", kind: "exam", status: "pending", starts_on: plus(TODAY, 30),
      ends_on: plus(TODAY, 32), days: 3, note: "finals", flagged: false, flag_reason: null,
      auto_approved: false, decided_by: null, decided_at: null, decision_note: null,
      filed_by: "u-me", created_at: TODAY },
  ];
  await openTab("mine");
  const mine = await page.$eval("#panelContent", (n) => n.textContent);
  ok(/1.*of 2 automatic days left this month/is.test(mine) || /automatic days left this month/i.test(mine),
    `the ledger does not show what is left this month: ${JSON.stringify(mine.slice(0, 400))}`);
  ok(/11/.test(mine) && /days taken here in total/i.test(mine),
    `the tenure total - the number this whole feature was asked for - is missing: ${JSON.stringify(mine.slice(0, 500))}`);
  ok(/Approved/.test(mine) && /Refused/.test(mine) && /Waiting for approval/.test(mine),
    `the three outcomes are not all labelled: ${JSON.stringify(mine.slice(0, 600))}`);
  ok(/emergency no-show/i.test(mine), "a flagged row does not show why it was raised");
  ok(/Please tell us in advance/.test(mine), "the coordinator's note on a refusal is not shown");

  // 8. withdrawing keeps the row.
  cancels.length = 0;
  await page.evaluate(async () => {
    const btn = [...document.querySelectorAll("#panelContent .away-ledger button")]
      .find((b) => /withdraw/i.test(b.textContent));
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 700));
  });
  ok(cancels.length === 1 && cancels[0].p_id === "l3",
    `withdrawing sent ${JSON.stringify(cancels)}, want cancel_leave on l3`);

  // 9. a member has no approvals and no policy tab.
  const memberTabs = await page.$$eval("#panelContent .away-tab", (ns) => ns.map((n) => n.textContent));
  ok(!memberTabs.some((t) => /approval/i.test(t)), `a member is shown an Approvals tab: ${JSON.stringify(memberTabs)}`);
  ok(!memberTabs.some((t) => /policy/i.test(t)), `a member is shown a Policy tab: ${JSON.stringify(memberTabs)}`);

  // ------------------------------------------------------- 7. the approver
  away = { day: TODAY, org_id: "o1", is_admin: true, away: [], mine: [], balance: balance(), inbox: 2 };
  inbox = {
    pending: [
      { id: "p1", user_id: "u-mehak", kind: "leave", starts_on: plus(TODAY, 4), ends_on: plus(TODAY, 6),
        days: 3, note: "cousin's wedding", flagged: false, flag_reason: null, created_at: TODAY, filed_by: "u-mehak" },
      { id: "p2", user_id: "u-sourabh", kind: "exam", starts_on: plus(TODAY, 10), ends_on: plus(TODAY, 20),
        days: 11, note: "semester", flagged: false, flag_reason: null, created_at: TODAY, filed_by: "u-sourabh" },
    ],
    flagged: [
      { id: "f1", user_id: "u-mehak", kind: "emergency", status: "pending", starts_on: TODAY,
        ends_on: TODAY, days: 1, flag_reason: "Logged as an emergency no-show", note: null, created_at: TODAY },
    ],
    month_used: { "u-mehak": 2, "u-sourabh": 0 },
  };
  await seed("admin");
  await repaint();
  await openTab("approvals");
  const app = await page.$eval("#panelContent", (n) => n.textContent);
  ok(/Waiting on you \(2\)/.test(app), `the approver inbox does not count what is waiting: ${JSON.stringify(app.slice(0, 300))}`);
  ok(/Mehak/.test(app) && /Sourabh/.test(app), "the requests do not name who they are from");
  ok(/2 days already taken this month/.test(app),
    `a decision is being asked for without showing what they have already spent: ${JSON.stringify(app.slice(0, 600))}`);
  ok(/Raised \(1\)/.test(app), `flagged absences are not surfaced to the approver: ${JSON.stringify(app.slice(0, 600))}`);

  decisions.length = 0;
  await page.evaluate(async () => {
    const btn = [...document.querySelectorAll("#panelContent button")].find((b) => /^Approve$/i.test(b.textContent.trim()));
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 800));
  });
  ok(decisions.length === 1 && decisions[0].p_approve === true,
    `Approve sent ${JSON.stringify(decisions)}, want decide_leave with p_approve true`);
  ok(decisions[0]?.p_id === "p1", `Approve decided ${JSON.stringify(decisions[0]?.p_id)}, want p1`);

  // ------------------------------------------------------------- the team tab
  teamReads = 0;
  await openTab("team");
  const team = await page.$eval("#panelContent", (n) => n.textContent);
  ok(teamReads === 1,
    `the Team tab made ${teamReads} server reads; it must be exactly one for the whole team`);
  ok(/Mehak/.test(team) && /Sourabh/.test(team), `the team tab names nobody: ${JSON.stringify(team.slice(0, 300))}`);
  ok(/14 days in total/.test(team),
    `a person's tenure total is missing from the team tab: ${JSON.stringify(team.slice(0, 400))}`);
  ok(/out today/.test(team), "the team tab does not say who is actually out today");

  // ------------------------------------------------------------ policy
  policySaves.length = 0;
  await openTab("policy");
  const pol = await page.$eval("#panelContent", (n) => n.textContent);
  ok(/2/.test(pol) && /approved automatically/i.test(pol),
    `the policy page does not state the allowance: ${JSON.stringify(pol.slice(0, 400))}`);
  await page.evaluate(async () => {
    [...document.querySelectorAll("#panelContent button")]
      .find((b) => /change the policy/i.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 600));
    document.querySelector(".modal-body form").elements.auto.value = "4";
    document.querySelector(".modal-foot button:last-child").click();
    await new Promise((r) => setTimeout(r, 800));
  });
  ok(policySaves.length === 1 && policySaves[0].p_auto_per_month === 4,
    `saving the policy sent ${JSON.stringify(policySaves)}, want auto_per_month 4`);

  // -------------------------------------------- 10. status is an application
  const fired = await page.evaluate(async () => {
    const { bus } = window.__p;
    let got = null;
    bus.on("leave:apply", (p) => { got = p || {}; });
    const sf = document.querySelector(".hstatus-chip, #hb-status, [id^=hb-status]")
      || [...document.querySelectorAll("#headerActions button")].find((b) => /status/i.test(b.title || ""));
    if (!sf) return "no status control on screen";
    sf.click();
    await new Promise((r) => setTimeout(r, 500));
    const row = [...document.querySelectorAll(".hstatus-preset")]
      .find((b) => /on leave/i.test(b.textContent));
    if (!row) return "no On leave row in the status popover";
    row.click();
    await new Promise((r) => setTimeout(r, 300));
    return got ? "fired" : "clicked but nothing was emitted";
  });
  ok(fired === "fired",
    `"On leave" in the status popover does not file an application: ${fired}`);

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
