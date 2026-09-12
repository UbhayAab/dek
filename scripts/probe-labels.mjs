// Message labels, end to end in a real browser.
//
// Asked for as "Add labels such as Important, High Priority, Pending, and Task."
// The thing worth proving is not that a pill can be drawn - it is that the four
// labels round-trip through toggle_message_label and that TASK IS NOT ONE OF
// THEM. Task in that menu routes to the existing create-a-task dialog, because
// this app already has tasks with an assignee, a due date and a place in Later,
// and a label spelled "task" would be a second, weaker task system that silently
// never appears there.
//
//   1. the tag action is offered on a channel message
//   2. ...and NOT on a direct message, where toggle_message_label would refuse
//   3. the menu holds all five labels AND a Task row that is not a label
//   4. picking one calls toggle_message_label(p_message, p_label) and paints a pill
//   5. picking it again calls the same RPC and the pill goes
//   6. a `label` broadcast from somebody else paints a pill with no RPC at all
//   7. the panel lists what list_labelled returns, and a filter chip passes p_label
//   8. zero pageerror.
//
// Usage: node scripts/probe-labels.mjs [--root <dir>]
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
console.log(`probe-labels: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const toggles = [];          // every toggle_message_label body
const listed = [];           // every list_labelled body
let labelRows = [];          // what the message_labels table read answers

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 860 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  // The catch-all is registered FIRST on purpose: Playwright matches the
  // MOST RECENTLY registered handler, so a catch-all added last swallows every
  // specific route below it and the probe measures nothing.
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/message_labels**", (route) => route.fulfill(json(labelRows)));
  await context.route("**/rest/v1/rpc/toggle_message_label", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    toggles.push(b);
    // Answer the way the function does: true when it added, false when it removed.
    const on = labelRows.some((r) => r.message_id === b.p_message && r.label === b.p_label);
    return route.fulfill(json(!on));
  });
  await context.route("**/rest/v1/rpc/list_labelled", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    listed.push(b);
    const all = [{
      message_id: "m-1", label: "important", channel_id: "ch-1", channel_name: "founders-office",
      author_id: "u-lead", body_text: "Ambulance paperwork is due Friday",
      created_at: new Date().toISOString(), set_by: "u-me", set_at: new Date().toISOString(),
    }, {
      message_id: "m-2", label: "pending", channel_id: "ch-1", channel_name: "founders-office",
      author_id: "u-lead", body_text: "Waiting on the hospital to confirm",
      created_at: new Date().toISOString(), set_by: "u-me", set_at: new Date().toISOString(),
    }];
    return route.fulfill(json(b.p_label ? all.filter((r) => r.label === b.p_label) : all));
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
  console.log("probe-labels: app booted");

  const loaded = await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    const msgs = await import("/js/core/messages.js");
    window.__p = { store, bus, ui, msgs };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "W", org_id: "o1" };
    store.profiles.set("u-me", { id: "u-me", display_name: "Abhay" });
    store.profiles.set("u-lead", { id: "u-lead", display_name: "Priyanka" });
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    store.current = store.channels[0];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    return !!ui.ui.getMessageActions;
  });
  ok(loaded, "the ui kit did not expose getMessageActions");

  // 1 + 2. offered on a channel message, withheld from a direct message.
  const offered = await page.evaluate(() => {
    const { ui } = window.__p;
    const has = (m) => ui.ui.getMessageActions(m).some((a) => a.id === "label");
    return {
      channel: has({ id: "m-1", author_id: "u-lead", _context: "channel" }),
      dm: has({ id: "d-1", author_id: "u-lead", conversation_id: "cv-1", _context: "dm" }),
    };
  });
  ok(offered.channel, "no label action on a channel message - the feature has no way in");
  ok(!offered.dm, "the label action is offered on a DIRECT message, where toggle_message_label refuses it");

  // Paint a real row through the real builder, so the pill lands where core puts
  // the reactions and not somewhere a hand-built fixture happened to allow.
  await page.evaluate(() => {
    const { msgs, store } = window.__p;
    const host = document.getElementById("messages");
    host.innerHTML = "";
    const m = { id: "m-1", channel_id: "ch-1", workspace_id: "w1", seq: 1, author_id: "u-lead",
      body_text: "Ambulance paperwork is due Friday", body: {}, attachments: [],
      created_at: new Date().toISOString(), mention_user_ids: [] };
    store.msgCache.set(m.id, m);
    host.appendChild(msgs.buildMessage(m, { context: "channel" }));
  });
  await sleep(400);

  // 3. the menu: five labels, and a Task row that is not one of them.
  const menu = await page.evaluate(async () => {
    const row = document.querySelector('.msg[data-id="m-1"]');
    const btn = [...row.querySelectorAll(".actions button")]
      .find((b) => /label this message/i.test(b.title || ""));
    if (!btn) return { error: "no tag button on the row" };
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    return { items: [...document.querySelectorAll(".ctxmenu .ctx-item")].map((n) => n.textContent) };
  });
  ok(!menu.error, menu.error || "");
  const items = menu.items || [];
  for (const want of ["Important", "High priority", "Pending", "Blocked", "FYI"]) {
    ok(items.some((t) => t.includes(want)), `the label menu is missing ${want}: ${JSON.stringify(items)}`);
  }
  ok(items.some((t) => /task/i.test(t)),
    `the menu offers no Task row at all - it was asked for by name: ${JSON.stringify(items)}`);
  // And Task must NOT be one of the five labels: nothing may be sent to
  // toggle_message_label under that name, because the check constraint refuses it.
  ok(!items.some((t) => /^\s*[✓ ]\s*[★▲◷■●]\s+Task\b/.test(t)),
    "Task is being offered as a label, which the database check constraint refuses");

  // 4. pick Important.
  toggles.length = 0;
  await page.evaluate(async () => {
    const hit = [...document.querySelectorAll(".ctxmenu .ctx-item")]
      .find((n) => n.textContent.includes("Important"));
    hit.click();
    await new Promise((r) => setTimeout(r, 400));
  });
  ok(toggles.length === 1 && toggles[0].p_message === "m-1" && toggles[0].p_label === "important",
    `picking Important sent ${JSON.stringify(toggles)}, want one toggle of m-1/important`);
  let pills = await page.$$eval(".msg[data-id='m-1'] .lbl-pill", (ns) => ns.map((n) => n.textContent));
  ok(pills.some((t) => /important/i.test(t)),
    `no Important pill on the row after labelling it: ${JSON.stringify(pills)}`);
  // It must sit inside the message body, above the reactions, or a grouped row
  // (which has no name line) would have nowhere to put it.
  const placed = await page.evaluate(() => {
    const strip = document.querySelector(".msg[data-id='m-1'] .lbl-strip");
    const rx = document.querySelector(".msg[data-id='m-1'] .rxns");
    if (!strip || !rx) return false;
    return strip.parentElement.classList.contains("mbody")
      && (strip.compareDocumentPosition(rx) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  ok(placed, "the label strip is not inside .mbody above the reactions");

  // 5. pick it again: same RPC, pill gone.
  labelRows = [{ message_id: "m-1", label: "important", workspace_id: "w1" }];
  toggles.length = 0;
  await page.evaluate(async () => {
    const row = document.querySelector('.msg[data-id="m-1"]');
    [...row.querySelectorAll(".actions button")]
      .find((b) => /label this message/i.test(b.title || "")).click();
    await new Promise((r) => setTimeout(r, 120));
    [...document.querySelectorAll(".ctxmenu .ctx-item")]
      .find((n) => n.textContent.includes("Important")).click();
    await new Promise((r) => setTimeout(r, 400));
  });
  ok(toggles.length === 1 && toggles[0].p_label === "important",
    `taking a label off sent ${JSON.stringify(toggles)}`);
  pills = await page.$$eval(".msg[data-id='m-1'] .lbl-pill", (ns) => ns.map((n) => n.textContent));
  ok(!pills.some((t) => /important/i.test(t)),
    `the Important pill survived being toggled off: ${JSON.stringify(pills)}`);

  // 6. somebody ELSE labels it: the broadcast paints, with no RPC of our own.
  //
  // There is no realtime server here, so stand up the same 'chan' descriptor
  // core stands up and push a frame through the channel object itself. That is
  // the real binding under test - labels.js attaches to whatever getSub('chan')
  // returns and has to survive core replacing it on every switch - and the leg
  // is worth nothing if it quietly skips when the socket never joins.
  toggles.length = 0;
  const fed = await page.evaluate(async () => {
    const { subscribe, getSub } = await import("/js/sb.js");
    const { bus } = window.__p;
    subscribe("chan", "ch:ch-1", { msg: () => {} });
    // scheduleBind gives up after twenty tries; channel:open re-arms it, which
    // is exactly what core emits at this point in a real open.
    bus.emit("channel:open", { channel: { id: "ch-1" } });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ch = getSub("chan");
      // The feature's binding is the proof it attached.
      const bound = (ch?.bindings?.broadcast || [])
        .some((b) => b?.filter?.event === "label");
      if (bound) return true;
    }
    return false;
  });
  ok(fed, "labels.js never bound its 'label' handler onto the channel core owns");
  if (fed) {
    await page.evaluate(async () => {
      const { getSub } = await import("/js/sb.js");
      getSub("chan")._trigger("broadcast", { event: "label",
        payload: { message_id: "m-1", label: "pending", added: true, by: "u-lead" } });
      await new Promise((r) => setTimeout(r, 250));
    });
    pills = await page.$$eval(".msg[data-id='m-1'] .lbl-pill", (ns) => ns.map((n) => n.textContent));
    ok(pills.some((t) => /pending/i.test(t)),
      `a label broadcast from somebody else painted nothing: ${JSON.stringify(pills)}`);
    ok(toggles.length === 0, "receiving a broadcast wrote back to the server");

    // ...and taking one off over the wire removes the pill rather than adding a
    // second one. The added:false branch is the half that is easy to get wrong.
    await page.evaluate(async () => {
      const { getSub } = await import("/js/sb.js");
      getSub("chan")._trigger("broadcast", { event: "label",
        payload: { message_id: "m-1", label: "pending", added: false, by: "u-lead" } });
      await new Promise((r) => setTimeout(r, 250));
    });
    pills = await page.$$eval(".msg[data-id='m-1'] .lbl-pill", (ns) => ns.map((n) => n.textContent));
    ok(!pills.some((t) => /pending/i.test(t)),
      `an added:false broadcast left the pill on the row: ${JSON.stringify(pills)}`);
  }

  // 7. the panel, and the filter.
  listed.length = 0;
  await page.evaluate(async () => {
    const { ui } = window.__p;
    await ui.ui.openPanel("labels", {});
    await new Promise((r) => setTimeout(r, 500));
  });
  const cards = await page.$$eval("#panelContent .lbl-card .lbl-text", (ns) => ns.map((n) => n.textContent.trim()));
  ok(cards.length === 2, `the Labelled panel painted ${cards.length} cards, want 2`);
  ok(listed.length >= 1 && listed[0].p_workspace === "w1" && listed[0].p_label === null,
    `the panel asked list_labelled with ${JSON.stringify(listed[0])}, want w1 and no filter`);

  listed.length = 0;
  await page.evaluate(async () => {
    const chip = [...document.querySelectorAll("#panelContent .lbl-chip")]
      .find((b) => /pending/i.test(b.textContent));
    chip.click();
    await new Promise((r) => setTimeout(r, 500));
  });
  ok(listed.some((b) => b.p_label === "pending"),
    `the Pending chip did not filter: ${JSON.stringify(listed)}`);
  const filtered = await page.$$eval("#panelContent .lbl-card", (ns) => ns.length);
  ok(filtered === 1, `filtering to Pending left ${filtered} cards, want 1`);

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
