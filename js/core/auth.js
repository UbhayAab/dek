// Auth: email one-time-code as the real path, guest as the zero-friction path.
// The OTP screen is a state machine (idle -> sent -> verifying) with a resend
// cooldown, because a code screen that silently does nothing is the fastest way
// to lose someone at the door.
import { sb, session, markIntentionalSignOut } from '../sb.js';
import { CODE_SIGNIN, GUEST_SIGNIN, NOTICE_AT_SIGNUP, MAIL_OTP, SUPABASE_URL } from '../config.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast } from '../ui.js';

const RESEND_SECONDS = 60;
let resendTimer = null;

const show = (id) => { $(id).classList.remove('hidden'); };
const hide = (id) => { $(id).classList.add('hidden'); };

function authError(msg, causes) {
  const e = $('authErr');
  e.textContent = msg || '';
  if (msg && causes?.length) {
    const ul = el('ul');
    for (const c of causes) ul.appendChild(el('li', '', esc(c)));
    e.appendChild(ul);
  }
  e.classList.toggle('hidden', !msg);
}

// Whether the person actually typed into the password box, as opposed to the
// browser filling it. Autofill selects a value without a keystroke or a paste,
// so "no key was ever pressed in this field" is a good enough read on it - and
// it is the case that needs a different answer when sign-in fails.
let pwWasTyped = false;

function busy(btn, on, label) {
  btn.disabled = on;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = on ? '…' : (label || btn.dataset.label);
}

// Supabase decides between a sign-in LINK and a numeric CODE purely from the
// email template, and template editing is locked until a custom SMTP provider is
// configured. So on the default mailer people receive a link, not a code, and a
// screen that only offers a code box looks broken. Support both: the link signs
// them in on return (detectSessionInUrl), and the code box stays for when the
// template is switched to {{ .Token }}.
export function readAuthCallback() {
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(location.search || '');
  const err = h.get('error_description') || h.get('error') || q.get('error_description');
  const hasToken = !!(h.get('access_token') || q.get('code'));
  if (err) {
    // Clear it so a refresh does not resurrect a dead error.
    history.replaceState(null, '', location.pathname + location.search);
    return { error: decodeURIComponent(err.replace(/\+/g, ' ')) };
  }
  return { hasToken };
}

// The sign-in screen is the one surface where a thrown error locks EVERYBODY
// out: no session, no app, no way to reach a menu that could fix it. So nothing
// here reaches into the DOM without checking.
//
// This is not hypothetical. Adding "Forgot your password?" put
//   $('pwForgot').onclick = ...
// in initAuth, and a phone that had the previous index.html in its service
// worker cache while fetching the new auth.js over the network threw
// "Cannot set properties of null" on that line, aborted initAuth, and showed a
// dead login page. The shell and the code are separate requests and can always
// skew for one load; the code has to survive it.
const missingIds = [];
function bind(id, ev, fn) {
  const n = $(id);
  if (!n) { missingIds.push(id); return null; }
  if (ev === 'click') n.onclick = fn;
  else n.addEventListener(ev, fn);
  return n;
}

// What a usable sign-in screen cannot do without. If any of these are absent the
// page being rendered is older than the code rendering it, and no amount of
// defensive binding makes that page work - it has no password field to type in.
const SHELL_REQUIRED = ['email', 'password', 'emailStep', 'pwSignIn'];

export function initAuth(onSignedIn) {
  // Someone clicked an expired or already-used sign-in link. Without this they
  // land on a blank sign-in screen with no idea why nothing happened.
  // The DPDP s.6(1) notice is filled in here but stays hidden until the screen
  // where personal data is actually collected. It used to be the first thing on
  // the sign-in card: six lines of consent language above the email field, read
  // by everybody who ever opened the app, including the person signing in for
  // the four hundredth time. Notice at the point of collection is both what the
  // section asks for and the only version anybody reads.
  const notice = $('dpdpNotice');
  if (notice) notice.textContent = NOTICE_AT_SIGNUP;
  const cb = readAuthCallback();
  if (cb.error) {
    authError(/expired|invalid/i.test(cb.error)
      ? 'That sign-in link has expired or was already used. Request a new one below.'
      : cb.error);
  }

  // A forced sign-out (revoked token, another tab leaving) stashes this before
  // reloading, so the card can say why it appeared instead of the person finding
  // chat gone with no explanation.
  try {
    if (sessionStorage.getItem('dekKicked')) {
      sessionStorage.removeItem('dekKicked');
      authError('Your session ended on this device. Sign in again to continue.');
    }
  } catch { /* storage unavailable */ }

  // ---- guest ----
  bind('guestBtn', 'click', async () => {
    const name = 'Guest ' + Math.floor(1000 + Math.random() * 9000);
    const btn = $('guestBtn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      await api.setProfile({ display_name: name });
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not start a guest session');
      busy(btn, false);
    }
  });
  // Both ship hidden; these two lines are what put them back, so the flags in
  // config.js are the only thing to change on the client.
  $('guestBtn').classList.toggle('hidden', !GUEST_SIGNIN);
  // The "or" rule belongs to whatever is under it. With nothing under it, it is
  // a divider between a form and empty space.
  document.querySelector('.author-sep')?.classList.toggle('hidden', !(GUEST_SIGNIN || CODE_SIGNIN));
  const help = $('authHelp');
  if (help) {
    help.textContent = CODE_SIGNIN
      ? 'No password yet? Get a code, and you can choose a password once you are in.'
      : "Accounts here are created by your organisation and handed to you with a password. "
        + "If you do not have one, ask whoever runs your team's Space.";
  }

  // ---- password sign-in ----
  // The interim path while the organisations finish their own mailer: accounts
  // are provisioned in bulk with a temporary password, and the first sign-in
  // forces a real one.
  const passwordSignIn = async () => {
    const email = $('email').value.trim();
    const typed = $('password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    if (!typed) return authError('Enter your password');
    const btn = $('pwSignIn');
    busy(btn, true);
    authError('');
    try {
      // A password is whatever bytes were chosen, so it is never silently
      // rewritten - but a temporary password handed out over WhatsApp is copied,
      // and a long-press copy on Android takes the trailing space with it.
      // gotrue rejects that as a wrong password with no way to tell the
      // difference. So: try exactly what was entered, and only if that is
      // refused, try it again without the surrounding whitespace.
      let { error } = await sb.auth.signInWithPassword({ email, password: typed });
      const trimmed = typed.trim();
      if (error && /invalid login/i.test(error.message || '') && trimmed && trimmed !== typed) {
        ({ error } = await sb.auth.signInWithPassword({ email, password: trimmed }));
      }
      if (error) throw error;
      if (await needsPasswordSetup()) { showSetPassword(email); return; }
      await onSignedIn();
    } catch (e) {
      if (/invalid login/i.test(e.message || '')) {
        // "Check with whoever set up your account" was the whole message, and it
        // is the one thing that does not help: it is not the operator's mistake
        // in either of the two cases that actually happen. Name them instead.
        const causes = [];
        if (!pwWasTyped) {
          causes.push('Your browser filled the password in for you, and it may still be holding the '
            + 'temporary one from your first sign-in. Clear the box and type the password you chose.');
        }
        causes.push('Your account may be under a different email address - most people were added '
          + 'with a personal address, not a work one. Try the other one.');
        causes.push('If neither works, ask the person who set this up to reset you. Nobody can see '
          + 'your password, so it can only be replaced, never looked up.');
        authError('That email and password do not match.', causes);
      } else {
        authError(e.message);
      }
      busy(btn, false);
    }
  };
  bind('emailStep', 'submit', (e) => { e.preventDefault(); passwordSignIn(); });
  // keydown, not input: autofill writes a value without either, and telling the
  // two apart is what lets the failure message name the right cause.
  bind('password', 'keydown', () => { pwWasTyped = true; });
  bind('password', 'paste', () => { pwWasTyped = true; });

  // ---- forced password change ----
  const savePassword = async () => {
    // Trimmed on the way IN, which is the half that matters. A stray space
    // pasted here is stored as part of the password forever, and the person then
    // types the password they think they chose and is told it is wrong - with no
    // way for anyone to work out why, because nobody can read the password back.
    const a = $('newPw').value.trim();
    const b = $('newPw2').value.trim();
    if (a.length < 8) return authError('Use at least 8 characters');
    if (a !== b) return authError('Those two passwords do not match');
    const btn = $('pwSave');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.updateUser({ password: a, data: {
        password_setup_complete: true, otp_password_setup_required: false,
      } });
      if (error) throw error;
      // Only drop the latch once GoTrue has actually accepted the new password.
      await api.completePasswordSetup();
      // The name is part of setting the account up, not a separate errand. A
      // failure here must not strand somebody on this screen with a password
      // that has already been changed - they are in, and they can rename
      // themselves from their profile.
      const chosen = ($('displayName')?.value || '').trim();
      if (chosen && chosen !== store.myProfile?.display_name) {
        try { await api.setProfile({ display_name: chosen }); }
        catch (err) { console.warn('could not save the display name', err.message); }
      }
      // The password manager saved the temporary password on the way in. Leave
      // the new one where it can find it and let the form's submit be what it
      // reads, rather than being asked to guess from a SPA that never navigates.
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not set that password');
      busy(btn, false);
    }
  };
  bind('setPwStep', 'submit', (e) => { e.preventDefault(); savePassword(); });
  bind('newPw', 'input', () => paintStrength($('newPw')?.value || ''));

  // "Forgot my password", "email me a code" and "create an account" are all the
  // same machine: prove you hold the mailbox, then land somewhere. The only
  // difference is where they land and what the screen calls itself, so it is
  // two flags rather than three flows.
  let resetMode = false;
  let signupMode = false;

  // Which email box is live depends on the tab. Reading $('email')
  // unconditionally is how the Create account tab would have silently sent a
  // code to whatever was left sitting in the sign-in box.
  const activeEmailField = () => (signupMode ? $('signupEmail') : $('email'));

  // ---- the two doors ----
  const setMode = (mode) => {
    signupMode = mode === 'signup';
    resetMode = false;
    $('tabSignin')?.classList.toggle('on', !signupMode);
    $('tabSignup')?.classList.toggle('on', signupMode);
    $('tabSignin')?.setAttribute('aria-selected', String(!signupMode));
    $('tabSignup')?.setAttribute('aria-selected', String(signupMode));
    $('emailStep')?.classList.toggle('hidden', signupMode);
    $('signupStep')?.classList.toggle('hidden', !signupMode);
    // The secondary "code instead of a password" route is a sign-IN affordance.
    // On the Create account tab it does the same thing as the primary button,
    // which reads as two buttons competing for one job.
    $('otpSend')?.classList.toggle('hidden', signupMode || !CODE_SIGNIN);
    document.querySelector('.authalt .author-sep')?.classList.toggle('hidden', signupMode);
    $('authHelp')?.classList.toggle('hidden', signupMode);
    authError('');
    // Carry a typed address across the switch rather than making somebody type
    // it twice because they picked the wrong tab first.
    const from = signupMode ? $('email') : $('signupEmail');
    const to = signupMode ? $('signupEmail') : $('email');
    if (from && to && from.value.trim() && !to.value.trim()) to.value = from.value.trim();
    setTimeout(() => to?.focus(), 30);
  };
  bind('tabSignin', 'click', () => setMode('signin'));
  bind('tabSignup', 'click', () => setMode('signup'));

  // ---- request a code ----
  const sendCode = async () => {
    const field = activeEmailField();
    const email = (field?.value || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      authError('Enter a valid email address');
      field?.focus();
      return;
    }
    // The signup tab has its own submit button; the code button is the one on
    // the sign-in tab. Whichever fired is the one that should show busy.
    const btn = signupMode ? $('signupGo') : $('otpSend');
    if (!btn || btn.disabled) return;
    busy(btn, true);
    authError('');
    try {
      if (MAIL_OTP) {
        // Own mailer: unlimited-ish transactional sends through JCF-Mailer,
        // branded template, no project-wide hourly cap. Sign up and sign in
        // are the same door - the verify step creates the account if needed.
        const r = await fetch(SUPABASE_URL + '/functions/v1/mail-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send', email }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || 'Could not send the code');
      } else {
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: {
            // Email verification establishes identity; Space access is checked separately.
            shouldCreateUser: true,
            data: { otp_password_setup_required: true },
            // The link has to come back to THIS page, including when the mail app
            // opens it in a fresh tab.
            emailRedirectTo: location.origin + location.pathname,
          },
        });
        if (error) throw error;
      }
      $('code').value = '';
      $('otpTarget').textContent = email;
      // Three arrivals at one screen, so it says which one this is. An
      // unlabelled code box after "Create account" is the moment people check
      // whether they have accidentally triggered a password reset.
      const lead = resetMode
        ? 'To reset your password we first need to know it is you.'
        : signupMode
          ? 'Almost there. Confirm the address and you can pick a password.'
          : '';
      $('otpLead').textContent = lead;
      $('otpLead').classList.toggle('hidden', !lead);
      $('otpVerifyBtn').textContent = resetMode ? 'Verify and choose a new password'
        : signupMode ? 'Verify and create my account'
          : 'Verify and sign in';
      show('otpStep');
      hide('emailStep');
      hide('signupStep');
      // The tabs are meaningless once a code is out: this screen is now one job.
      document.querySelector('.authtabs')?.classList.add('hidden');
      document.querySelector('.authalt')?.classList.add('hidden');
      // Requesting a code is what CREATES the account, so this screen is a point
      // of collection and the notice belongs on it.
      $('dpdpNotice')?.classList.remove('hidden');
      $('code').focus();
      startCooldown();
    } catch (e) {
      const msg = /rate|limit|seconds|minute/i.test(e.message || '')
        ? 'Too many codes requested. Wait a minute and try again.'
        : e.message;
      authError(msg);
    } finally { busy(btn, false); }
  };
  // Enter in the email box submits the sign-in form now, which is the path
  // almost everyone here is on. Requesting a code is an explicit button press.
  bind('otpSend', 'click', () => { resetMode = false; signupMode = false; sendCode(); });
  // The Create account tab's primary action. It is a real form submit so the
  // password manager sees a signup rather than a stray click, and so Enter in
  // the email box works the way it does on the sign-in form next to it.
  bind('signupStep', 'submit', (e) => {
    e.preventDefault();
    resetMode = false;
    signupMode = true;
    sendCode();
  });
  bind('pwForgot', 'click', () => {
    if (!/^\S+@\S+\.\S+$/.test($('email').value.trim())) {
      authError('Type your email address first, then press this again.');
      $('email').focus();
      return;
    }
    resetMode = true;
    signupMode = false;
    sendCode();
  });
  // The button ships hidden; this is what puts it back, so the flag is the only
  // thing to change when the mailer exists.
  $('otpSend').classList.toggle('hidden', !CODE_SIGNIN);

  // ---- verify ----
  const verify = async () => {
    // The address the code was sent to, which on the Create account tab is NOT
    // the one in the sign-in box. Reading $('email') here would have verified a
    // code against a different address than the one it was mailed to.
    const email = ($('otpTarget')?.textContent || activeEmailField()?.value || '').trim();
    const token = $('code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(token)) return authError('Enter the 6-digit code from your email');
    const btn = $('otpVerifyBtn');
    if (btn.disabled) return;
    busy(btn, true);
    authError('');
    let wasNew = null;
    try {
      if (MAIL_OTP) {
        const r = await fetch(SUPABASE_URL + '/functions/v1/mail-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'verify', email, code: token }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || 'That code is wrong or expired.');
        wasNew = j.isNew === true;
        const { error } = await sb.auth.setSession({
          access_token: j.access_token, refresh_token: j.refresh_token,
        });
        if (error) throw error;
      } else {
        const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
        if (error) throw error;
      }
      if (resetMode) {
        // Latch first, so a reset that is interrupted here - tab closed, phone
        // dies - resumes on the next sign-in instead of quietly leaving the old
        // password in place while the person believes they changed it.
        await api.rpc('start_password_reset', {});
        resetMode = false;
        showSetPassword(email, 'reset');
        return;
      }
      // mail-otp has always returned isNew and nothing has ever read it, so a
      // person who just created an account and a colleague who has been here a
      // year got the same words. It only changes copy - the latch, not this
      // flag, still decides whether the screen is shown at all.
      const madeAccount = signupMode || wasNew === true;
      if (await needsPasswordSetup()) {
        showSetPassword(email, madeAccount ? 'signup' : 'setup');
        signupMode = false;
        return;
      }
      // The name is asked for on the set-password screen now, which every
      // account created this way is sent to. mail-otp seeds it from the email
      // in the meantime so nobody is ever nameless.
      await onSignedIn();
    } catch (e) {
      authError(/expired|invalid|wrong/i.test(e.message || '')
        ? 'That code is wrong or expired. Request a new one.'
        : e.message);
    } finally { busy(btn, false); }
  };
  bind('otpVerifyBtn', 'click', verify);
  bind('code', 'keydown', (e) => { if (e.key === 'Enter') verify(); });
  bind('code', 'input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) verify();
  });

  bind('otpBack', 'click', () => {
    hide('otpStep');
    $('dpdpNotice')?.classList.add('hidden');
    // Back to the tab they came from, with the tabs visible again. Restoring
    // the sign-in form unconditionally is how somebody halfway through
    // creating an account would land on a password box for an account that
    // does not exist yet.
    document.querySelector('.authtabs')?.classList.remove('hidden');
    document.querySelector('.authalt')?.classList.remove('hidden');
    setMode(signupMode ? 'signup' : 'signin');
    stopCooldown();
  });
  bind('otpResend', 'click', () => { if (!$('otpResend')?.disabled) sendCode(); });

  // ---- sign out ----
  // Sign out lives in the user menu (js/shell.js) and on the no-team screen.
  // Bind here too if some surface still offers a top-level button.
  const so = $('signout');
  if (so) so.onclick = signOutEverywhere;

  reportShellSkew();
}

// A control that is merely NEW being absent is survivable - bind() skipped it and
// everything else still works. A control the screen cannot function without being
// absent means the HTML in front of the person is older than the JavaScript
// running on it, which happens when a navigation falls back to the service
// worker's cached shell while the module requests reach the network. One load,
// one device, and until now a dead login page with no way out.
//
// So: throw the stale shell away and reload, once. sessionStorage rather than
// localStorage, and a single attempt, because a reload loop on the sign-in
// screen would be worse than the bug it is fixing.
const SKEW_KEY = 'dak.shellSkew';
function reportShellSkew() {
  const absent = SHELL_REQUIRED.filter((id) => !$(id));
  if (missingIds.length) console.warn('auth: shell is missing', missingIds.join(', '));
  if (!absent.length) return;

  console.warn('auth: the page is older than the code', absent.join(', '));
  // Offline, this is the WRONG move: the stale shell is the only shell there is,
  // and deleting the caches to reload would leave nothing to come back to. Say
  // so and stop; the next online load fixes itself.
  if (navigator.onLine === false) return;
  let tried = null;
  try { tried = sessionStorage.getItem(SKEW_KEY); } catch { /* private mode */ }
  if (tried) return;                       // already tried; do not loop
  try { sessionStorage.setItem(SKEW_KEY, '1'); } catch { /* ignore */ }

  (async () => {
    try {
      // Drop every cache this app owns, not just the shell: if the HTML was
      // stale there is no reason to trust the rest of that generation either.
      if (window.caches) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      const reg = await navigator.serviceWorker?.getRegistration?.();
      await reg?.update?.().catch(() => {});
    } catch { /* a reload without the cache clear is still worth trying */ }
    location.reload();
  })();
}

// The one teardown, in one place. It used to be written out twice - here and in
// js/shell.js - and the screen that needed it most had neither: somebody who
// signs in with the wrong email lands on "you are not part of a team yet", which
// hides the nav toggle, which is the only route to the user menu, which is the
// only place Sign out existed. They were locked into the wrong account with no
// way out but clearing site data.
export async function signOutEverywhere() {
  // The local-first caches keep this person's conversations on the device so the
  // app can paint before the network. On a shared phone - which is most of them
  // here - signing out has to take them with it.
  await Promise.all([
    import('../lib/pagecache.js').then((m) => m.wipe()),
    import('../lib/readcache.js').then((m) => m.wipe()),
    // 'dek-storage-v1' must match STORAGE in sw.js.
    window.caches ? caches.delete('dek-storage-v1') : Promise.resolve(),
  ]).catch(() => { /* signing out must not be blocked by storage */ });
  markIntentionalSignOut();
  await sb.auth.signOut();
  location.hash = '';
  location.reload();
}

function startCooldown() {
  let n = RESEND_SECONDS;
  const b = $('otpResend');
  b.disabled = true;
  const tick = () => {
    b.textContent = n > 0 ? `Resend in ${n}s` : 'Resend code';
    b.disabled = n > 0;
    if (n-- > 0) resendTimer = setTimeout(tick, 1000);
  };
  stopCooldown();
  tick();
}
function stopCooldown() { if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; } }

// A failed password-state check must not silently skip first-time setup.
export async function needsPasswordSetup() {
  const s = await session();
  const metadata = s?.user?.user_metadata || {};
  const flagged = await api.mustSetPassword();
  if (flagged === true) return true;
  if (metadata.otp_password_setup_required === true && metadata.password_setup_complete !== true) {
    await api.rpc('start_password_reset', {});
    return true;
  }
  return false;
}

// `kind` names which of the three journeys landed here, because the screen is
// identical for all three and the copy is the only thing that tells somebody
// whether they just made an account, reset a password, or were handed one.
export function showSetPassword(email, kind = 'setup') {
  stopCooldown();
  $('newPw').value = '';
  $('newPw2').value = '';
  hide('emailStep');
  hide('signupStep');
  hide('otpStep');
  document.querySelector('.authtabs')?.classList.add('hidden');
  document.querySelector('.authalt')?.classList.add('hidden');
  show('setPwStep');
  const heading = $('pwHeading');
  const lead = $('pwLead');
  if (heading) {
    heading.textContent = kind === 'reset' ? 'Choose a new password'
      : kind === 'signup' ? 'Your account is ready'
        : 'Set a new password';
  }
  if (lead) {
    lead.innerHTML = kind === 'reset'
      ? 'Pick something you have not used here before. You will be signed in straight after.'
      : kind === 'signup'
        ? 'Pick a password and the name your colleagues will see. That is the last step.'
        : 'Welcome<span id="pwWho"></span>. Choose a password so you can sign in '
          + 'without waiting for a code next time.';
  }
  if ($('pwWho')) $('pwWho').textContent = email ? `, ${email}` : '';
  $('pwSave').textContent = kind === 'reset' ? 'Save and sign in' : 'Save and continue';
  // The password manager needs a username on this form or it has nothing to file
  // the new password against - see the comment on #pwUser in index.html.
  $('pwUser').value = email || '';
  // Prefilled from whatever the account already has - which for an account made
  // from a code is the email's local part, seeded by mail-otp. A prefilled field
  // is a correction, and people correct things; an empty one labelled "Your
  // name" on a sign-in card is a question nobody knows why they are being asked.
  const nameField = $('displayName');
  if (nameField) {
    nameField.value = store.myProfile?.display_name
      || (email ? email.split('@')[0] : '');
  }
  // Personal data is collected on THIS screen, so the notice belongs on it.
  $('dpdpNotice')?.classList.remove('hidden');
  authError('');
  setTimeout(() => $('newPw').focus(), 40);
}

// A calm strength hint rather than a scolding validator: length is what actually
// matters, with a nudge for variety.
const STRENGTH_WORDS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

function paintStrength(v) {
  const meter = $('pwMeter');
  if (!meter) return;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
  if (/\d/.test(v) || /[^\w\s]/.test(v)) score++;
  meter.dataset.score = String(score);
  meter.querySelector('i').style.width = `${(score / 4) * 100}%`;
  // A bar with no word is a colour somebody has to interpret. The word is also
  // what a screen reader gets, since the bar itself carries no text.
  const word = $('pwMeterWord');
  if (word) {
    const label = v ? STRENGTH_WORDS[score] : '';
    word.textContent = label;
    word.dataset.score = String(score);
    meter.setAttribute('aria-label', label ? `Password strength: ${label}` : 'Password strength');
  }
}

export async function currentUser() {
  const s = await session();
  return s?.user || null;
}

export function showAuth() {
  $('auth').classList.remove('hidden');
  $('chat').classList.add('hidden');
}
export function showChat() {
  $('auth').classList.add('hidden');
  $('chat').classList.remove('hidden');
}
