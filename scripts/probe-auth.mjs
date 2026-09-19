// Behavioral guard for the sign-in card: js/core/auth.js plus its index.html
// markup. The screen every new hire lands on was redesigned ground-up
// (442f875 split-screen) and carries hard-won contracts documented only in
// comments - the real <form> for password managers, autocomplete tokens,
// the DPDP signup notice, the kicked-session message, the trailing-space
// retry, the autofill-vs-typed failure split, the forced-password-change
// step and the OTP state machine - none of which any probe, guard or test
// exercised. Owned by no other check; driven signed-out so nothing here
// needs an account (network legs ride intercepted routes, never the live
// Supabase project).
//
// Self-serves the tree on an ephemeral port; embed leg omitted: embed boots
// this same initAuth and scripts/smoke.mjs already covers embed boot.
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
  ".woff2": "font/woff2",
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
const phone = { ...devices["iPhone 13 Pro"] };

const boot = async (ctxOpts = {}, initScript = null) => {
  const ctx = await browser.newContext({ ...phone, ...ctxOpts });
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return { ctx, page };
};

// Gotrue-shaped refusal so auth.js's own error paths run without touching
// the live project. supabase-js surfaces error_description as the message,
// which is exactly what /invalid login/i keys on.
const denyToken = async (page) => {
  const calls = [];
  await page.route("**/auth/v1/token**", (route) => {
    calls.push(route.request().postData() || "");
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }),
    });
  });
  return calls;
};
const fakeMailer = async (page) => {
  const calls = [];
  await page.route("**/functions/v1/mail-otp**", (route) => {
    let action = "";
    try { action = JSON.parse(route.request().postData() || "{}").action; } catch {}
    calls.push(action);
    const okSend = action === "send";
    return route.fulfill({
      status: okSend ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify(okSend
        ? { ok: true }
        : { ok: false, error: "That code is wrong or stale" }),
    });
  });
  return calls;
};

const errText = (page) =>
  page.evaluate(() => {
    const e = document.getElementById("authErr");
    return { hidden: e.classList.contains("hidden"), text: e.textContent };
  });

// ---- Leg 1: boot posture, markup contracts, notice parity, flag wiring ----
{
  const { ctx, page } = await boot();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  const posture = await page.evaluate(() => ({
    authVisible: !document.getElementById("auth").classList.contains("hidden"),
    chatHidden: document.getElementById("chat").classList.contains("hidden"),
    emailStepIsForm: document.getElementById("emailStep")?.tagName === "FORM",
    autocompletes: {
      email: document.getElementById("email")?.getAttribute("autocomplete"),
      password: document.getElementById("password")?.getAttribute("autocomplete"),
      newUser: document.getElementById("pwUser")?.getAttribute("autocomplete"),
      newPw: document.getElementById("newPw")?.getAttribute("autocomplete"),
      code: document.getElementById("code")?.getAttribute("autocomplete"),
    },
    codeInput: {
      mode: document.getElementById("code")?.getAttribute("inputmode"),
      max: document.getElementById("code")?.getAttribute("maxlength"),
    },
    stepsStartHidden: ["setPwStep", "otpStep"].map((id) => document.getElementById(id).classList.contains("hidden")),
    errStartHidden: document.getElementById("authErr").classList.contains("hidden"),
  }));
  ok(posture.authVisible, "signed-out boot did not show #auth");
  ok(posture.chatHidden, "signed-out boot left #chat visible");
  ok(posture.emailStepIsForm, "#emailStep is not a real <form> - the password-manager contract is gone");
  ok(posture.autocompletes.email === "email", "email input lost autocomplete=email");
  ok(posture.autocompletes.password === "current-password", "password input lost autocomplete=current-password");
  ok(posture.autocompletes.newUser === "username", "set-password account field lost autocomplete=username");
  ok(posture.autocompletes.newPw === "new-password", "new password lost autocomplete=new-password");
  ok(posture.autocompletes.code === "one-time-code", "code input lost autocomplete=one-time-code");
  ok(posture.codeInput.mode === "numeric" && posture.codeInput.max === "6", "code input lost inputmode/maxlength contract");
  ok(posture.stepsStartHidden.every(Boolean), "setPw/otp step visible before any flow ran");
  ok(posture.errStartHidden, "#authErr visible on a clean boot");

  const parity = await page.evaluate(async () => {
    const cfg = await import("/js/config.js");
    const vis = (id) => {
      const elx = document.getElementById(id);
      const fieldHidden = elx.closest(".field")?.classList.contains("hidden");
      return !fieldHidden && !elx.classList.contains("hidden");
    };
    return {
      noticeWant: cfg.NOTICE_AT_SIGNUP,
      noticeGot: document.getElementById("dpdpNotice").textContent,
      noticeShown: !document.getElementById("dpdpNotice").classList.contains("hidden"),
      otpSend: vis("otpSend"),
      guestBtn: vis("guestBtn"),
      // The name field moved to the set-password step, where it is part of
      // setting an account up. On the sign-in card it was an orphan labelled
      // "Only needed for the options below".
      nameOnCard: !!document.getElementById("displayName")?.closest("#setPwStep")
        ? false
        : vis("displayName"),
      codeSignin: cfg.CODE_SIGNIN,
      guestSignin: cfg.GUEST_SIGNIN,
    };
  });
  // The notice is NOT wallpaper on the sign-in form any more. It is shown on the
  // two screens where personal data is actually collected - requesting a code,
  // which creates the account from an email, and the setup screen, which asks
  // for a name. Notice at the point of collection is what s.6(1) asks for, and
  // it is the only version anybody reads; above the email field it was six lines
  // every returning user scrolled past forever.
  ok(!parity.noticeShown, "DPDP notice is wallpaper on the sign-in form again");
  ok(parity.noticeGot === parity.noticeWant, "dpdpNotice text does not match NOTICE_AT_SIGNUP");
  ok(parity.otpSend === parity.codeSignin, `otpSend visibility (${parity.otpSend}) disagrees with CODE_SIGNIN=${parity.codeSignin}`);
  ok(parity.guestBtn === parity.guestSignin, `guestBtn visibility (${parity.guestBtn}) disagrees with GUEST_SIGNIN=${parity.guestSignin}`);
  ok(!parity.nameOnCard, "the sign-in card grew a name field again");

  // And it must actually appear where it now claims to. A notice that moved off
  // the first screen and onto no screen would be a compliance regression, not a
  // tidy-up, so prove the code step shows it.
  const onCode = await page.evaluate(async () => {
    const shown = () => !document.getElementById("dpdpNotice").classList.contains("hidden");
    const before = shown();
    // Stub the send so no real email goes out, then press the real button and
    // let the real handler decide. Un-hiding the element by hand and asserting
    // it is un-hidden would prove nothing at all.
    const realFetch = window.fetch;
    window.fetch = async (u, o) => (String(u).includes("/mail-otp")
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : realFetch(u, o));
    document.getElementById("email").value = "notice.probe@dek.app";
    document.getElementById("otpSend").click();
    await new Promise((r) => setTimeout(r, 1200));
    window.fetch = realFetch;
    return {
      before,
      after: shown(),
      onCodeStep: !document.getElementById("otpStep").classList.contains("hidden"),
    };
  });
  ok(onCode.onCodeStep, "pressing the code button did not reach the code step");
  ok(onCode.before === false && onCode.after === true,
    "the notice does not appear on the code step");
  await ctx.close();
}

// ---- Leg 2: forced-signout message ----
{
  const { ctx, page } = await boot({}, () => sessionStorage.setItem("dekKicked", "1"));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  const kicked = await errText(page);
  ok(!kicked.hidden && /session ended/i.test(kicked.text), `kicked latch did not paint its message ('${kicked.text.trim()}')`);
  const latched = await page.evaluate(() => sessionStorage.getItem("dekKicked"));
  ok(latched === null, "dekKicked latch survived the reload - message would repeat forever");
  await ctx.close();
}

// ---- Leg 3: client-side gates fire before any network call ----
{
  const { ctx, page } = await boot();
  const calls = await denyToken(page);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);

  await page.click("#pwSignIn");
  let e = await errText(page);
  ok(!e.hidden && /valid email/i.test(e.text), `empty submit said '${e.text.trim()}', want the email gate`);

  await page.fill("#email", "notanemail");
  await page.fill("#password", "whatever1");
  await page.click("#pwSignIn");
  e = await errText(page);
  ok(!e.hidden && /valid email/i.test(e.text), `bad email said '${e.text.trim()}', want the email gate`);

  await page.fill("#email", "misho@example.com");
  await page.fill("#password", "");
  await page.click("#pwSignIn");
  e = await errText(page);
  ok(!e.hidden && /enter your password/i.test(e.text), `empty password said '${e.text.trim()}', want the password gate`);
  ok(calls.length === 0, `validation gates leaked ${calls.length} network call(s)`);
  await ctx.close();
}

// ---- Leg 4: invalid-login help - autofill vs typed, trailing-space retry ----
{
  // 4a: value present but never keyed into (the autofill shape).
  const { ctx, page } = await boot();
  const calls = await denyToken(page);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.getElementById("email").value = "misho@example.com";
    document.getElementById("password").value = "temp-pass-1";
  });
  await page.click("#pwSignIn");
  await page.waitForTimeout(600);
  const autofill = await errText(page);
  ok(/do not match/i.test(autofill.text), `invalid login said '${autofill.text.trim()}', want the mismatch headline`);
  ok(/filled the password in/i.test(autofill.text), "untyped password failure did not name the autofill cause");
  ok(autofill.text.indexOf("filled the password in") < autofill.text.indexOf("different email"),
    "autofill cause not listed first in the untyped case");
  ok(calls.length === 1, `untyped retry made ${calls.length} token call(s), want exactly 1 (no space, no retry)`);
  await ctx.close();

  // 4b: really typed, with a copied trailing space - the WhatsApp-paste shape.
  const { ctx: ctx2, page: page2 } = await boot();
  const calls2 = await denyToken(page2);
  await page2.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page2.waitForTimeout(1200);
  await page2.evaluate(() => {
    document.getElementById("email").value = "misho@example.com";
    document.getElementById("password").focus();
  });
  await page2.keyboard.press("a"); // the keystroke is what flips pwWasTyped
  await page2.evaluate(() => { document.getElementById("password").value = "temp-pass-1 "; });
  await page2.click("#pwSignIn");
  await page2.waitForTimeout(800);
  const typed = await errText(page2);
  ok(!/filled the password in/i.test(typed.text), "typed password failure blamed autofill");
  ok(/different email/i.test(typed.text), "typed failure did not offer the other likely cause");
  ok(calls2.length === 2, `trailing-space retry made ${calls2.length} token call(s), want 2 (verbatim, then trimmed)`);
  const posted = calls2.map((c) => { try { return JSON.parse(c).password; } catch { return "?"; } });
  ok(posted[0] === "temp-pass-1 " && posted[1] === "temp-pass-1",
    `retry order wrong: posted ${JSON.stringify(posted)}, want verbatim first then trimmed`);
  await ctx2.close();
}

// ---- Leg 5: forced password change - swap, meters, gates ----
{
  const { ctx, page } = await boot();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const m = await import("/js/core/auth.js");
    m.showSetPassword("provisioned@example.com");
  });
  await page.waitForTimeout(150);
  const swapped = await page.evaluate(() => ({
    emailHidden: document.getElementById("emailStep").classList.contains("hidden"),
    setShown: !document.getElementById("setPwStep").classList.contains("hidden"),
    who: document.getElementById("pwWho").textContent,
    userVal: document.getElementById("pwUser").value,
    readonly: document.getElementById("pwUser").hasAttribute("readonly"),
  }));
  ok(swapped.emailHidden && swapped.setShown, "showSetPassword did not swap the cards");
  ok(swapped.who === ", provisioned@example.com", `pwWho '${swapped.who}' missing the address`);
  ok(swapped.userVal === "provisioned@example.com" && swapped.readonly,
    "readonly username field not prefilled - the password manager files under nothing");

  await page.fill("#newPw", "short");
  await page.fill("#newPw2", "short");
  await page.click("#pwSave");
  let se = await errText(page);
  ok(!se.hidden && /at least 8/i.test(se.text), `short password said '${se.text.trim()}'`);

  await page.fill("#newPw", "long-enough-passphrase");
  await page.fill("#newPw2", "different-long-enough");
  await page.click("#pwSave");
  se = await errText(page);
  ok(!se.hidden && /do not match/i.test(se.text), `mismatch said '${se.text.trim()}'`);

  await page.fill("#newPw", "");
  await page.type("#newPw", "Passw0rdLong");
  const meter = await page.evaluate(() => ({
    score: document.getElementById("pwMeter").dataset.score,
    width: document.querySelector("#pwMeter i").style.width,
  }));
  ok(meter.score === "4" && meter.width === "100%", `strength meter read ${JSON.stringify(meter)}, want score 4 at 100%`);
  await ctx.close();
}

// ---- Leg 6: OTP machine - send swaps screens + cooldown, code sanitizes +
// auto-verifies at six, wrong code lands the friendly line, back restores ----
{
  const { ctx, page } = await boot();
  const mailer = await fakeMailer(page);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);

  await page.fill("#email", "misho@example.com");
  await page.click("#otpSend");
  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => ({
    target: document.getElementById("otpTarget").textContent,
    otpShown: !document.getElementById("otpStep").classList.contains("hidden"),
    emailHidden: document.getElementById("emailStep").classList.contains("hidden"),
    resendDisabled: document.getElementById("otpResend").disabled,
    resendLabel: document.getElementById("otpResend").textContent,
  }));
  ok(sent.target === "misho@example.com", `otpTarget '${sent.target}' not the address`);
  ok(sent.otpShown && sent.emailHidden, "send did not swap onto the code step");
  ok(sent.resendDisabled && /Resend in \d+s/.test(sent.resendLabel),
    `resend not cooling down ('${sent.resendLabel}', disabled=${sent.resendDisabled})`);

  await page.type("#code", "ab12cd34ef");
  const mid = await page.evaluate(() => document.getElementById("code").value);
  ok(mid === "1234", `sanitizer left '${mid}', want digits-only '1234'`);
  ok(mailer.filter((a) => a === "verify").length === 0, "verify fired before six digits");

  await page.type("#code", "56");
  await page.waitForTimeout(500);
  const wrong = await errText(page);
  ok(mailer.filter((a) => a === "verify").length === 1, `auto-verify fired ${mailer.filter((a) => a === "verify").length} times at six digits, want 1`);
  ok(!wrong.hidden && /wrong or expired/i.test(wrong.text), `bad code said '${wrong.text.trim()}', want the friendly line`);
  ok(mailer[0] === "send" && mailer.includes("verify"), `mailer calls ${JSON.stringify(mailer)} in wrong order`);

  await page.click("#otpBack");
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({
    emailShown: !document.getElementById("emailStep").classList.contains("hidden"),
    otpHidden: document.getElementById("otpStep").classList.contains("hidden"),
    errHidden: document.getElementById("authErr").classList.contains("hidden"),
  }));
  ok(back.emailShown && back.otpHidden && back.errHidden, "'Use a different email' did not restore the start state cleanly");
  await ctx.close();
}

// ---- Leg 7: dead sign-in link paints its reason and cleans the hash ----
{
  const { ctx, page } = await boot();
  await page.goto(BASE + "/#error_description=" + encodeURIComponent("Email link is invalid or has expired"),
    { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  const cb = await errText(page);
  ok(!cb.hidden && /expired|already used/i.test(cb.text), `expired link said '${cb.text.trim()}', want the expiry explainer`);
  const clean = await page.evaluate(() => location.search + location.hash);
  ok(!/error/.test(clean), `callback error survived the cleanup: '${clean}'`);
  await ctx.close();
}

// First OTP sign-in and recovery must both stop at password setup. Exercise
// real UI handlers with local Auth/RPC doubles; no email or account is created.
for (const recovery of [false, true]) {
  const {ctx, page} = await boot();
  await page.route('**/js/main.js', route => route.fulfill({contentType:'text/javascript', body: `
    import {sb} from './sb.js';
    import {initAuth,showAuth} from './core/auth.js';
    window.authTest={updates:[],latch:false,entered:false,failSave:true,resets:0};
    const state=window.authTest;
    let metadata=${JSON.stringify(recovery ? {password_setup_complete:true} : {otp_password_setup_required:true})};
    sb.auth.setSession=async()=>({error:null});
    sb.auth.getSession=async()=>({data:{session:{user:{email:'new@example.org',user_metadata:metadata}}}});
    sb.auth.updateUser=async body=>{
      state.updates.push(body);
      if(state.failSave)return {error:{message:'Password save unavailable'}};
      metadata={...metadata,...body.data}; return {error:null};
    };
    sb.rpc=async name=>{
      if(name==='must_set_password')return {data:state.latch,error:null};
      if(name==='start_password_reset'){state.latch=true;state.resets++;}
      if(name==='complete_password_setup')state.latch=false;
      return {data:null,error:null};
    };
    initAuth(async()=>{state.entered=true;});showAuth();
  `}));
  await page.route('**/functions/v1/mail-otp', route => route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,isNew:!recovery,access_token:'mock',refresh_token:'mock'})}));
  await page.goto(BASE + '/');
  await page.fill('#email','new@example.org');
  await page.click(recovery ? '#pwForgot' : '#otpSend');
  await page.fill('#code','123456');
  await page.waitForFunction(()=>!document.getElementById('setPwStep').classList.contains('hidden'));
  let state=await page.evaluate(()=>window.authTest);
  ok(!state.entered && state.resets===1, `${recovery ? 'recovery' : 'first OTP'} skipped the password gate`);
  await page.fill('#newPw','New-password-123');
  await page.fill('#newPw2','Different-password-123');
  await page.click('#pwSave');
  ok((await page.evaluate(()=>window.authTest.updates.length))===0,'mismatched passwords reached Auth');
  await page.fill('#newPw2','New-password-123');
  await page.click('#pwSave');
  await page.waitForFunction(()=>document.getElementById('authErr').textContent.includes('Password save unavailable'));
  ok(!(await page.evaluate(()=>window.authTest.entered)),'failed password save entered app');
  await page.evaluate(()=>{window.authTest.failSave=false;});
  await page.click('#pwSave');
  await page.waitForFunction(()=>window.authTest.entered);
  state=await page.evaluate(()=>window.authTest);
  ok(!state.latch && state.updates.at(-1).data.password_setup_complete===true,'successful save did not finish setup');
  await ctx.close();
}

await browser.close();
await new Promise((r) => server.close(r));
console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
