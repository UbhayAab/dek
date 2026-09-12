// Install, update, and knowing which version you are actually on.
//
// Two very different platforms for the install half:
//   Chromium (Android, desktop) fires beforeinstallprompt, so we stash it and
//   call prompt() from a real click - the only thing the browser accepts.
//   iOS Safari has no such API at all: the honest answer is a sheet that shows
//   the exact Share -> Add to Home Screen steps. Pretending otherwise would just
//   produce a button that does nothing.
//
// And the update half, which was reported as a team problem rather than a bug:
// "my team is facing a lot of problem with actually being on the same version."
//
// Everything needed to fix that half-existed and none of it was reachable:
//
//   - the update offer was a toast that cleared itself after twenty seconds, so
//     on a phone in a pocket it was simply never seen;
//   - there was no button anywhere meaning "get the latest", so somebody who
//     missed that toast had no move at all;
//   - and nobody, including the person asking, could say which bundle they were
//     on, because VERSION lived only inside sw.js. "Are we the same?" was
//     unanswerable even in principle.
//
// This module now owns that state and publishes it on the bus. features/
// version.js paints it. The state lives here rather than there because the
// registration lives here, and a second module calling register() would be a
// second opinion about the same worker.
import { $, el, esc } from './util.js';
import { modal, toast } from './ui.js';
import { icon } from './icons.js';
import { bus } from './store.js';

let deferredPrompt = null;

let registration = null;
let waitingReg = null;          // the registration whose worker is ready to take over
let runningVersion = null;      // what the controlling worker says it is
let lastCheckedAt = 0;
let checking = false;

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

// ------------------------------------------------------------------ version state
export const updateState = () => ({
  version: runningVersion,
  waiting: !!waitingReg,
  lastCheckedAt,
  checking,
  standalone: isStandalone(),
  canInstall: shouldOfferInstall(),
});

const publish = () => bus.emit('version:state', updateState());

// Ask the controlling worker what it is. Answers null when nothing controls the
// page yet, which is the honest answer on a first load rather than a guess.
export function swVersion(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => finish(e.data?.version || null);
      sw.postMessage({ type: 'VERSION' }, [ch.port2]);
    } catch { finish(null); }
    // A worker from a deploy older than this change has no VERSION handler and
    // will never answer, so this has to give up rather than hang the button.
    setTimeout(() => finish(null), timeoutMs);
  });
}

// Returns what actually happened, so the caller can say it out loud instead of
// showing a spinner and leaving the person to guess.
export async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return { state: 'unsupported' };
  checking = true; publish();
  try {
    const reg = registration || await navigator.serviceWorker.getRegistration();
    if (!reg) return { state: 'unsupported' };
    registration = reg;
    await reg.update();
    // reg.update() resolves as soon as the fetch is done; the new worker may
    // still be installing. Wait for it to reach `waiting` before deciding there
    // is nothing new, or a check on a slow phone reports "up to date" about the
    // very update it has just downloaded.
    for (let i = 0; i < 20 && !reg.waiting; i++) {
      if (!reg.installing) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    lastCheckedAt = Date.now();
    if (reg.waiting) { waitingReg = reg; publish(); return { state: 'waiting' }; }
    return { state: 'current', version: runningVersion };
  } catch (e) {
    return { state: 'failed', error: e?.message || 'could not reach the server' };
  } finally { checking = false; publish(); }
}

// Take the waiting bundle. The reload is the point: skipWaiting alone swaps the
// worker and leaves the page running the old modules it has already imported.
export async function applyUpdate() {
  const reg = waitingReg || registration || await navigator.serviceWorker?.getRegistration();
  if (reg?.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    await new Promise((r) => setTimeout(r, 300));
  }
  location.reload();
}

// TAKING IT WITHOUT BEING ASKED, WHEN THAT IS SAFE.
//
// A button only works on the people who press it, and "everybody on the same
// version" is not a thing a team achieves by everybody remembering. So an update
// that is sitting there is taken automatically at the two moments when a reload
// costs nothing and interrupts nobody:
//
//   - opening the app, where the page has just loaded anyway;
//   - coming back to it after it has been in the background for five minutes,
//     which is somebody picking the phone up again, not somebody mid-sentence.
//
// Never while there is half-typed text in the composer, never over an open
// dialog, and at most twice in a session so a worker that refuses to activate
// can never turn into a reload loop.
const AUTO_KEY = 'dak.autoUpdates';
const AUTO_MAX = 2;

function autoCount() {
  try { return +(sessionStorage.getItem(AUTO_KEY) || 0); } catch { return AUTO_MAX; }
}
function noteAuto() {
  try { sessionStorage.setItem(AUTO_KEY, String(autoCount() + 1)); } catch { /* private mode */ }
}

function safeToReload() {
  if (document.querySelector('.modal-back')) return false;
  const c = document.getElementById('composer');
  if (c && String(c.value || '').trim()) return false;
  // Mid-recording is the one that would actually lose something the person
  // cannot get back by retyping.
  if (document.querySelector('.vn-recording, [data-recording="1"]')) return false;
  return true;
}

export function maybeAutoUpdate(reason) {
  if (!waitingReg?.waiting) return false;
  if (autoCount() >= AUTO_MAX) return false;
  if (!safeToReload()) return false;
  noteAuto();
  console.info('[dak] taking the waiting update automatically:', reason);
  applyUpdate();
  return true;
}

// THE ONE THAT ALWAYS WORKS. A worker that failed to install, a cache holding a
// half-written entry, a bundle older than the VERSION handler above - none of
// those can be fixed by asking the worker nicely, and somebody stuck on an old
// screen needs a move that does not depend on the thing that is broken.
//
// The attachment cache is deliberately spared: it is up to 150MB of photos and
// voice notes that are expensive to fetch again and are never the thing that is
// stale. Only the code caches go.
export async function hardReset() {
  try {
    const keys = (await caches.keys()) || [];
    await Promise.all(keys.filter((k) => !k.includes('storage')).map((k) => caches.delete(k)));
  } catch { /* storage blocked; the unregister below still helps */ }
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* nothing registered */ }
  // A cache-busting query on the reload, so the HTML itself cannot come back
  // from the HTTP cache that the worker is no longer standing in front of.
  const u = new URL(location.href);
  u.searchParams.set('fresh', String(Date.now()));
  location.replace(u.toString());
}

// ------------------------------------------------------------------ boot
export function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(async (reg) => {
        registration = reg;
        // A worker can already be waiting the moment the page loads: somebody
        // opened the app, the new bundle downloaded, and they closed the tab
        // before the toast appeared. That state used to be invisible forever.
        if (reg.waiting && navigator.serviceWorker.controller) waitingReg = reg;
        runningVersion = await swVersion();
        publish();
        // Left over from a previous session: the page has only just loaded, so
        // take it now and be current before anybody has typed anything.
        if (waitingReg) setTimeout(() => maybeAutoUpdate('boot'), 1200);

        // Never swap the running bundle mid-conversation. Offer it instead.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              waitingReg = reg;
              publish();
              // An update that lands within the first twenty seconds of a page
              // load is one that arrived because somebody OPENED the app. Nobody
              // is mid-anything yet, so take it rather than offering it: this is
              // the behaviour that actually converges a team onto one version,
              // because it needs nobody to remember anything.
              if (performance.now() < 20_000 && maybeAutoUpdate('arrived during boot')) return;
              showUpdateToast(reg);
            }
          });
        });

        // ASK. updatefound only fires if something actually re-fetches sw.js,
        // and nothing here ever did - the browser's own check happens on a hard
        // navigation and then roughly daily. So an installed app that somebody
        // leaves open, which is every phone on a shift, could sit on a bundle
        // for a day with no way to know a newer one existed and no reload
        // offered. Reported exactly that way: "it's still stuck on the old UI
        // and there's no option to refresh".
        //
        // Two triggers, both cheap: coming back to the tab, and a slow timer for
        // a screen that is simply left on. Throttled together so a person
        // flicking between apps does not fire a request per flick; sw.js is a
        // conditional GET, so a check with nothing new costs a 304.
        const CHECK_EVERY = 15 * 60 * 1000;
        const AWAY_ENOUGH = 5 * 60 * 1000;
        let lastCheck = Date.now();
        let hiddenAt = 0;
        const check = () => {
          if (Date.now() - lastCheck < CHECK_EVERY) return;
          lastCheck = Date.now();
          reg.update().catch(() => { /* offline, or the check simply failed */ });
        };
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
          check();
          // Back after a real absence: if something is already waiting, take it
          // rather than asking somebody who has just picked their phone up.
          if (hiddenAt && Date.now() - hiddenAt >= AWAY_ENOUGH) {
            setTimeout(() => maybeAutoUpdate('returned after '
              + Math.round((Date.now() - hiddenAt) / 60000) + 'm away'), 400);
          }
          hiddenAt = 0;
        });
        setInterval(check, CHECK_EVERY);
      })
      .catch((e) => console.warn('sw register failed', e));

    // The worker changing under a live page means somebody else's tab took the
    // update, or ours just did. Either way this page is now running modules from
    // a bundle the worker no longer serves.
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      runningVersion = await swVersion();
      publish();
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    paintInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    paintInstallButton();
    toast('Dek installed. Look for it with your other apps.');
  });

  paintInstallButton();

  // Persistent storage keeps the offline cache and the session from being evicted.
  navigator.storage?.persist?.().catch(() => {});
}

// ------------------------------------------------------------------ install
// "Can I raise the native sheet." On Chromium this is false until
// beforeinstallprompt fires, which needs the install criteria met, does not fire
// again once dismissed in a session, and never fires at all in some browsers.
export function canInstall() {
  if (isStandalone()) return false;
  return !!deferredPrompt || isIOSSafari;
}

// WHAT THE BUTTON SHOULD ACTUALLY TEST, which is not the same thing.
//
// Gating the button on canInstall() hid it from most of the people who most
// needed it, and the ask was literally "put an install button in the menu bar or
// somewhere". promptInstall() already has an honest answer for every case: the
// native sheet where one exists, the exact Share -> Add to Home Screen steps on
// iOS, and the browser-menu instructions otherwise. So the button can simply be
// there until the app IS installed, at which point isStandalone() retires it.
export const shouldOfferInstall = () => !isStandalone();

export function paintInstallButton() {
  const b = $('installBtn');
  if (!b) return;
  b.classList.toggle('hidden', !shouldOfferInstall());
  b.onclick = promptInstall;
  publish();
}

export async function promptInstall() {
  if (isStandalone()) { toast('Already installed'); return; }
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') toast('Installing…');
    deferredPrompt = null;
    paintInstallButton();
    return;
  }
  if (isIOS) return iosSheet();
  modal({
    title: 'Install Dek',
    body: `<p>Your browser has not offered an install prompt yet. Use the browser menu and choose
      <b>Install app</b> or <b>Add to Home screen</b>.</p>
      <p class="muted">On Chrome or Edge desktop the install icon also appears at the right edge of the address bar.</p>
      <p class="muted">Installing matters for more than the icon: an installed app checks for a new
      version every time you open it, which is how everybody ends up on the same one.</p>`,
  });
}

function iosSheet() {
  modal({
    title: 'Add Dek to your Home Screen',
    body: `
      <ol class="ios-steps">
        <!-- The last emoji in the chrome, and the one with the best excuse: it
             depicts a button in Safari's own interface rather than one of ours.
             It is still an emoji, still rendered by the operating system, and
             still the wrong shape on any device that is not an iPhone - which is
             every device where this sentence is a lie anyway. The drawn glyph
             matches the real control closely enough and matches the rest of the
             product exactly. -->
        <li>Tap the <b>Share</b> button <span class="ios-ico">${icon('shareIos')}</span> at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. Dek opens full screen, like an app.</li>
      </ol>
      ${isIOSSafari ? '' :
        '<p class="muted">You are not in Safari. On iPhone only Safari can add an app to the Home Screen - open this page in Safari first.</p>'}`,
  });
}

// Still a toast, because an interruption is right at the moment it happens. It
// is no longer the ONLY offer: features/version.js keeps a chip in the top bar
// and a row in the drawer for as long as the update is waiting, so missing this
// one - which is what a phone in a pocket does - now costs nothing.
function showUpdateToast() {
  const t = toast('A new version of Dek is ready.', 'info', 20000);
  const b = el('button', 'sm', 'Update now');
  b.onclick = () => applyUpdate();
  t.appendChild(b);
}
