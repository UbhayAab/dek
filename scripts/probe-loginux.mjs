// The three ways somebody gets stuck on the way in.
//
// All three were reported from real use, and all three are about a person who
// is signed in but cannot get where they need to be:
//
//   A  Signed in with the wrong email, landed on "you are not part of a team
//      yet", and there is no way to sign out. That screen adds body.no-team,
//      which hides #navToggle, which is the only route to the sidebar, which is
//      the only place Sign out has existed since it left the top bar.
//
//   B  Created an account with a code and was never asked to choose a password,
//      so every future sign-in needs another code. The set-password screen and
//      the must_set_password latch that drives it both already existed; nothing
//      ever set the latch for an account born this way.
//
//   C  The invite row that hands somebody a link and a QR code was reachable
//      only by long-pressing an org tile. It is now a labelled sidebar row.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sql = (q) => JSON.parse(execFileSync('node', ['scripts/db-query.mjs', q], { encoding: 'utf8' }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (err, body) => {
    if (err) { try { res.writeHead(404).end('nope'); } catch {} return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.PROBE_BASE || `http://127.0.0.1:${server.address().port}`;
console.log(`probe-loginux: serving ${ROOT} on ${BASE}`);

// The demo account's latch is restored in the finally block whatever happens,
// because leaving it set would lock the account every other probe signs in with.
const [demo] = sql(`select p.id, p.must_set_password latched from public.profiles p
                    join auth.users u on u.id = p.id where u.email = '${EMAIL}';`);
const restoreLatch = () => sql(
  `update public.profiles set must_set_password = ${demo.latched} where id = '${demo.id}'; select 1;`);

const browser = await chromium.launch();
const signIn = async (page) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(6000);
  for (let i = 0; i < 4; i++) {
    const d = page.locator('.modal,[role="dialog"]').last();
    if (await d.count() && await d.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    } else break;
  }
};

try {
  // ---- A: the no-team screen has a way out ------------------------------
  // Driven on a PHONE viewport, because that is where the trap is total: the
  // nav toggle is hidden, so on 390px there is genuinely nothing else to press.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await signIn(page);
    await page.evaluate(() => import('./js/main.js').then((m) => m.showNoTeam()));
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('noteamOut')
      ?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);

    const seen = await page.evaluate(() => {
      const b = document.getElementById('noteamOut');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      // Hit-test the middle of the button: "in the DOM" is not the same claim as
      // "a thumb can press it", and this whole screen is a lesson in that.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        present: true,
        visible: r.width > 0 && r.height > 0,
        onScreen: r.top >= 0 && r.bottom <= innerHeight,
        hitsButton: !!(hit && (hit === b || b.contains(hit))),
        label: b.textContent.trim(),
        who: document.querySelector('.noteam-who')?.textContent.replace(/\s+/g, ' ').trim() || '',
        // The real trap, measured rather than assumed. Not "is a CSS rule
        // winning" but "can this person reach the only other Sign out there
        // is": the user menu hangs off #meName in the sidebar.
        userMenuReachable: (() => {
          const n = document.getElementById('meName');
          if (!n) return false;
          const q = n.getBoundingClientRect();
          return q.width > 0 && q.height > 0 && getComputedStyle(n).visibility !== 'hidden';
        })(),
      };
    });

    // Measured on a phone: the sidebar's user menu is NOT reachable here, which
    // is why this screen needed its own way out. On a desktop it IS reachable,
    // so the trap was mobile-only - which matches where it was reported from.
    check('no-team: on a phone the user menu really is unreachable (the trap is real)',
      seen.userMenuReachable === false);
    check('no-team: a Sign out control exists', seen.present === true);
    check('no-team: it is visible and on screen', !!seen.visible && !!seen.onScreen);
    check('no-team: a thumb actually lands on it', seen.hitsButton === true);
    check('no-team: the screen names the account you are signed into',
      /Signed in as/.test(seen.who) && seen.who.includes('@'), seen.who);

    // Press it for real and require the session to be gone.
    if (seen.hitsButton) {
      await page.click('#noteamOut');
      await page.waitForTimeout(4000);
      const out = await page.evaluate(async () => {
        const { sb } = await import('./js/sb.js');
        const { data } = await sb.auth.getSession();
        return { session: !!data.session, onAuth: !!document.querySelector('#email') };
      });
      check('no-team: pressing it clears the session', out.session === false);
      check('no-team: and lands back on the sign-in screen', out.onAuth === true);
    }
    check('no-team: no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.close();
  }

  // ---- B: a latched account is made to choose a password ----------------
  {
    sql(`update public.profiles set must_set_password = true where id = '${demo.id}'; select 1;`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('button:has-text("Sign in")');
    await page.waitForTimeout(7000);

    const at = await page.evaluate(() => {
      const vis = (id) => {
        const n = document.getElementById(id);
        return !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0;
      };
      return { setPw: vis('setPwStep'), chat: vis('chat'), newPwField: !!document.getElementById('newPw') };
    });
    check('otp/latch: signing in with a latched account shows the password screen', at.setPw === true);
    check('otp/latch: it does NOT drop them into the app first', at.chat === false);
    check('otp/latch: the new-password field is there to type into', at.newPwField === true);
    await page.close();
    restoreLatch();
  }

  // ---- C: sharing is on the sidebar, not behind a long-press ------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    const row = await page.evaluate(() => {
      const n = document.querySelector('[data-anav="invitelink"]');
      if (!n) return { present: false };
      const r = n.getBoundingClientRect();
      return { present: true, label: n.textContent.trim(), visible: r.width > 0 && r.height > 0 };
    });
    check('share: an "Invite with a link" row is in the sidebar', row.present === true, row.label || '');
    check('share: it is visible', !!row.visible);
    if (row.present && row.visible) {
      await page.click('[data-anav="invitelink"]');
      await page.waitForTimeout(3500);
      const sheet = await page.evaluate(() => ({
        open: !!document.querySelector('.oshare-url'),
        link: document.querySelector('.oshare-url')?.value || '',
        qr: !!document.querySelector('.oshare-qr'),
      }));
      check('share: it opens the sheet with a link already minted',
        sheet.open && /#\/join-org\/[0-9a-f]{32}$/.test(sheet.link), sheet.link || 'no link');
      check('share: with a QR beside it', sheet.qr === true);
    }
    await page.close();
  }

  // ---- E: the sign-in card asks for what it needs and nothing else ------
  // Reported as "it shows email, the name, the password, and then enter a name.
  // What does enter a name even mean?" - and it did: an orphan field labelled
  // "Your name", placeholder "Only needed for the options below", sitting under
  // the Sign in button, above a code button, under six lines of consent text.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(900);
    const card = await page.evaluate(() => {
      const shown = (n) => !!n && n.offsetParent !== null;
      const order = [...document.querySelectorAll('#auth input, #auth button')]
        .filter(shown).map((n) => n.id);
      const notice = document.getElementById('dpdpNotice');
      const email = document.getElementById('email');
      return {
        order,
        nameOnCard: shown(document.getElementById('displayName')),
        noticeShown: shown(notice),
        // Is anything above the email field except the brand and the tagline?
        aboveEmail: [...document.querySelectorAll('.authcard > *')]
          .filter((n) => shown(n) && n.getBoundingClientRect().bottom
                        <= email.getBoundingClientRect().top)
          .map((n) => n.id || n.className.split(' ')[0]),
        separator: shown(document.querySelector('.author-sep')),
        help: document.getElementById('authHelp')?.textContent.replace(/\s+/g, ' ').trim() || '',
      };
    });
    check('login: no "Your name" box on the sign-in card', card.nameOnCard === false);
    check('login: the consent wall is not the first thing above the email field',
      card.noticeShown === false, card.aboveEmail.join(', '));
    check('login: the controls read email, password, sign in, forgot, then code',
      JSON.stringify(card.order)
        === JSON.stringify(['email', 'password', 'pwSignIn', 'pwForgot', 'otpSend']),
      card.order.join(' > '));
    check('login: the two ways in are visibly separated', card.separator === true);
    check('login: the help text does not contradict the button above it',
      /No password yet/.test(card.help), card.help);
    await page.close();
  }

  // ---- F: the name is asked for where it means something ----------------
  {
    sql(`update public.profiles set must_set_password = true where id = '${demo.id}'; select 1;`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('button:has-text("Sign in")');
    await page.waitForTimeout(7000);
    const step = await page.evaluate(() => {
      const n = document.getElementById('displayName');
      const shown = (x) => !!x && x.offsetParent !== null;
      return {
        nameHere: shown(n),
        prefilled: n?.value || '',
        placeholder: n?.placeholder || '',
        noticeHere: shown(document.getElementById('dpdpNotice')),
      };
    });
    check('setup: the name is asked for on the set-password screen', step.nameHere === true);
    check('setup: it arrives prefilled rather than blank', step.prefilled.length > 0, step.prefilled);
    check('setup: its placeholder says what it is for',
      /colleagues will see/.test(step.placeholder), step.placeholder);
    check('setup: the consent notice is shown where data is collected', step.noticeHere === true);
    await page.close();
    restoreLatch();
  }

  // ---- G: the rest of the organisation is findable ----------------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    // THE ROW MOVED AND WAS RENAMED, ON PURPOSE.
    //
    // This used to look for [data-anav="browse"], a "Browse servers" row that
    // sat under the sidebar heading "Run this Space" and opened a per-org modal.
    // Finding the other servers is not an operator's job - it was the single
    // most common complaint from ordinary members - so it is now "Find a server"
    // at the end of the Servers group, where the list of servers you are already
    // in runs out, and it opens features/servers.js: every organisation at once,
    // with a search box.
    const row = await page.evaluate(() => {
      const n = document.querySelector('[data-findserver]');
      return {
        present: !!n,
        label: n?.textContent.trim() || '',
        // It must not have gone back under an admin heading.
        underAdmin: !!n?.closest('.anav-group'),
      };
    });
    check('org: a "Find a server" row is in the sidebar', row.present === true, row.label);
    check('org: and it is not buried under the admin group', row.underAdmin === false);
    if (row.present) {
      await page.click('[data-findserver]');
      await page.waitForTimeout(3500);
      const dir = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#panelContent .srvd-row')];
        return {
          open: rows.length > 0,
          count: rows.length,
          orgs: [...document.querySelectorAll('#panelContent .srvd-orgname')].length,
          searchable: !!document.querySelector('#panelContent .srvd-search'),
          // Every row resolves to exactly one state: Open it, join it, ask, or
          // a plain "invite only" label once asking has been refused.
          acted: rows.filter((r) => r.querySelector('.srvd-act button, .srvd-locked')).length,
        };
      });
      check(`org: it lists the organisation's servers`, dir.open === true, `${dir.count} rows`);
      check('org: grouped by organisation', dir.orgs >= 1, `${dir.orgs} groups`);
      check('org: with a search box, which the old modal never had', dir.searchable === true);
      check('org: every row offers Open, Join, Ask, or says it is invite only',
        dir.count > 0 && dir.acted === dir.count,
        `${dir.acted} of ${dir.count} rows carry an action`);
    }
    await page.close();
  }

  // ---- H: an admin can decide which servers a link lands people in ------
  // The half of "my invite only added me to one server" that is a DECISION
  // rather than a bug: redeem_org_invite joins every OPEN server, and
  // join_policy defaulted to 'invite' before 0109, so most servers here are
  // closed. Which ones open is the admin's call - "HR" being invite-only is
  // very plausibly deliberate - so the fix is a control, not a data migration.
  {
    const [ws] = sql(`select w.id, w.name, w.join_policy, w.org_id
                        from public.workspaces w
                        join public.org_members om on om.org_id = w.org_id
                        join auth.users u on u.id = om.user_id
                       where u.email = '${EMAIL}' and om.org_role = 'admin'
                         and w.archived_at is null limit 1;`);
    if (!ws) {
      check('policy: found a server the demo account can administer', false);
    } else {
      const restorePolicy = () => sql(
        `update public.workspaces set join_policy = '${ws.join_policy}' where id = '${ws.id}'; select 1;`);
      try {
        sql(`update public.workspaces set join_policy = 'invite' where id = '${ws.id}'; select 1;`);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await signIn(page);
        await page.evaluate(async (orgId) => {
          const { bus } = await import('./js/store.js');
          bus.emit('orgadmin:open', { orgId });
          await new Promise((r) => setTimeout(r, 2500));
          document.querySelector('[data-sec="servers"]')?.click();
          await new Promise((r) => setTimeout(r, 2500));
        }, ws.org_id);

        const before = await page.evaluate((id) => {
          const row = document.querySelector(`.ap-server-row[data-ws="${id}"]`);
          return {
            chip: row?.querySelector('.ap-chip')?.textContent.trim() || '',
            button: row?.querySelector('[data-a="policy"]')?.textContent.trim() || '',
            warnShown: !!document.getElementById('apOpenFirst'),
          };
        }, ws.id);
        check('policy: a closed server says so on its row', before.chip === 'invite only', before.chip);
        check('policy: and offers a control to change it', before.button === 'Let anyone in', before.button);

        // Press it for real, confirm the dialog, and read the DATABASE back -
        // a green toast is not the claim, "an invite link now lands here" is.
        await page.click(`.ap-server-row[data-ws="${ws.id}"] [data-a="policy"]`);
        await page.waitForTimeout(700);
        await page.click('.modal button:has-text("Let them in")');
        await page.waitForTimeout(3000);

        const [after] = sql(`select join_policy p from public.workspaces where id = '${ws.id}';`);
        check('policy: pressing it actually opens the server', after.p === 'open', after.p);

        const back = await page.evaluate((id) => {
          const row = document.querySelector(`.ap-server-row[data-ws="${id}"]`);
          return {
            chip: row?.querySelector('.ap-chip')?.textContent.trim() || '',
            button: row?.querySelector('[data-a="policy"]')?.textContent.trim() || '',
          };
        }, ws.id);
        check('policy: the row repaints to the new state',
          back.chip === 'anyone with the link' && back.button === 'Make invite only',
          `${back.chip} / ${back.button}`);

        // And the thing that actually matters: the org invite now has somewhere
        // to put people. list_org_spaces is what the directory and the share
        // sheet both read.
        const [openNow] = sql(`select count(*) n from public.workspaces
                                where org_id = '${ws.org_id}' and archived_at is null
                                  and join_policy = 'open';`);
        check('policy: the organisation now has a server an invite can land in',
          Number(openNow.n) > 0, `${openNow.n} open`);
        await page.close();
      } finally { restorePolicy(); }
    }
  }

  // ---- I: forgot-password is a door you can walk through yourself -------
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(800);
    const has = await page.evaluate(() => {
      const b = document.getElementById('pwForgot');
      return { present: !!b, visible: !!b && b.offsetParent !== null, label: b?.textContent.trim() };
    });
    check('reset: the sign-in form offers a way out when the password is lost',
      has.present && has.visible, has.label || 'missing');

    // Pressing it with an empty email must teach rather than fail silently.
    const empty = await page.evaluate(() => {
      document.getElementById('email').value = '';
      document.getElementById('pwForgot').click();
      const e = document.getElementById('authErr');
      return { msg: e.textContent.trim(), shown: !e.classList.contains('hidden') };
    });
    check('reset: pressing it with no email says what to do',
      empty.shown && /email address first/i.test(empty.msg), empty.msg);

    // With an email, it goes to the code step and says WHY, so the screen does
    // not look identical to an ordinary code sign-in.
    const sent = await page.evaluate(async () => {
      const realFetch = window.fetch;
      window.fetch = async (u, o) => (String(u).includes('/mail-otp')
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : realFetch(u, o));
      document.getElementById('email').value = 'reset.probe@dek.app';
      document.getElementById('pwForgot').click();
      await new Promise((r) => setTimeout(r, 1200));
      window.fetch = realFetch;
      const lead = document.getElementById('otpLead');
      return {
        onCodeStep: !document.getElementById('otpStep').classList.contains('hidden'),
        lead: lead && !lead.classList.contains('hidden') ? lead.textContent.trim() : '',
        cta: document.getElementById('otpVerifyBtn').textContent.trim(),
      };
    });
    check('reset: it reaches the code step', sent.onCodeStep === true);
    check('reset: the code step says it is a reset, not a sign-in',
      /reset your password/i.test(sent.lead), sent.lead || '(no lead line)');
    check('reset: and the button says where it goes',
      /choose a new password/i.test(sent.cta), sent.cta);
    await page.close();
  }

  // ---- J: your name is findable, and you are told it needs setting ------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    const nav = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-pnav]')];
      return {
        ids: rows.map((r) => r.dataset.pnav),
        labels: rows.map((r) => r.querySelector('.ch-name')?.textContent.trim()),
        visible: rows.every((r) => r.getBoundingClientRect().height > 0),
      };
    });
    check('profile: the sidebar has a "You" group with profile and password',
      JSON.stringify(nav.ids) === JSON.stringify(['profile', 'password']), nav.ids.join(', '));
    check('profile: both rows are visible', nav.visible === true, nav.labels.join(' / '));

    if (nav.ids.includes('profile')) {
      await page.click('[data-pnav="profile"]');
      await page.waitForTimeout(2500);
      const editor = await page.evaluate(() => {
        const dlg = document.querySelector('.modal');
        return {
          open: !!dlg,
          hasName: !!dlg?.querySelector('input[name="display_name"], #pfName, input'),
          title: dlg?.querySelector('.modal-head strong')?.textContent.trim() || '',
        };
      });
      check('profile: the row opens the editor', editor.open === true, editor.title);
      check('profile: with somewhere to type a name', editor.hasName === true);
      await page.keyboard.press('Escape');
    }

    // The nudge only fires for a name that is still the guessed one. Force that
    // state, reload, and require it - then put the name back.
    const [me] = sql(`select p.display_name d from public.profiles p
                      join auth.users u on u.id = p.id where u.email = '${EMAIL}';`);
    const local = EMAIL.split('@')[0];
    try {
      sql(`update public.profiles set display_name = '${local}' where id = '${demo.id}'; select 1;`);
      const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await signIn(p2);
      await p2.waitForTimeout(7000);
      const nudge = await p2.evaluate(() => {
        const t = [...document.querySelectorAll('.toast, [class*="toast"]')]
          .map((n) => n.textContent).join(' | ');
        return { text: t, hasButton: !!document.querySelector('.toast button, [class*="toast"] button') };
      });
      check('profile: a guessed name gets told so, once',
        /showing as/i.test(nudge.text), nudge.text.slice(0, 90) || '(no nudge)');
      check('profile: with a button that opens the editor', nudge.hasButton === true);
      await p2.close();
    } finally {
      sql(`update public.profiles set display_name = '${String(me.d).replace(/'/g, "''")}'
           where id = '${demo.id}'; select 1;`);
    }
    await page.close();
  }

  // ---- K: joining a server joins the organisation -----------------------
  {
    const [row] = sql(`select count(*) n from public.workspace_members wm
                        join public.workspaces w on w.id = wm.workspace_id
                       where w.org_id is not null
                         and not exists (select 1 from public.org_members m
                                          where m.org_id = w.org_id and m.user_id = wm.user_id);`);
    check('org: nobody is in a server without being in its organisation',
      Number(row.n) === 0, `${row.n} stranded`);
  }

  // ---- D: nobody is left unable to choose a password --------------------
  {
    // The precise population, not the loose one. "password_set_at is null" also
    // catches accounts with a working password set out of band - latching those
    // locks out a person whose sign-in works fine, which is what happened to
    // demo@dek.app on the first attempt at this.
    const [row] = sql(`select count(*) n from public.profiles p join auth.users u on u.id = p.id
                        where not p.is_app and u.banned_until is null
                          and not p.must_set_password and p.password_set_at is null
                          and u.raw_user_meta_data ? 'display_name'
                          and not (u.raw_user_meta_data ? 'sub')
                          and u.raw_user_meta_data->>'display_name' = split_part(u.email,'@',1)
                          and (u.raw_user_meta_data->>'email_verified')::boolean is true;`);
    check('backfill: every OTP account has been asked to choose a password',
      Number(row.n) === 0, `${row.n} still stranded`);

    // And the other half of that lesson: an account with a working password must
    // NOT have been swept up. demo signs the whole probe suite in.
    const [d] = sql(`select p.must_set_password l from public.profiles p
                     join auth.users u on u.id = p.id where u.email = '${EMAIL}';`);
    check('backfill: an account with a working password was left alone', d.l === false);
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  restoreLatch();
  await browser.close();
  server.close();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
