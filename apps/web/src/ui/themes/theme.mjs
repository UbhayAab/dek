/* ============================================================================
   Theme choice: which theme is on, switching it, remembering it, and keeping
   the browser bar colour in step. The picker's look belongs to each product;
   this module only knows the names. Pair it with theme-boot.js in <head>.

     initTheme()                    once at start; the storage key is the
                                    data-theme-key on the theme-boot.js tag
     setTheme('classic')            from the picker
     window 'themechange' event     { detail: { theme } } after every change
   ========================================================================= */

export const THEMES = Object.freeze([
  { id: 'auto', label: 'Auto', hint: 'Follows your device: light, or dark when the device is dark' },
  { id: 'light', label: 'Light', hint: 'Neutral greys and white, indigo accent' },
  { id: 'dark', label: 'Dark', hint: 'Deep grey, easy on the eyes at night' },
  { id: 'classic', label: 'Classic', hint: 'Warm paper with a petrol teal accent' },
  { id: 'contrast', label: 'High contrast', hint: 'Black on white with strong lines' },
]);
const IDS = THEMES.map((t) => t.id);
const DEVICE_DARK = '(prefers-color-scheme: dark)';

let storageKey = 'theme';

export function initTheme(key) {
  storageKey = key || document.querySelector('script[data-theme-key]')?.getAttribute('data-theme-key') || storageKey;
  syncChrome();
  // On Auto, the device switching to dark changes the theme under us.
  window.matchMedia?.(DEVICE_DARK).addEventListener?.('change', () => {
    if (currentTheme() !== 'auto') return;
    syncChrome();
    announce('auto');
  });
}

export function currentTheme() {
  const id = document.documentElement.getAttribute('data-theme');
  return IDS.includes(id) ? id : 'auto';
}

export function setTheme(id) {
  const next = IDS.includes(id) ? id : 'auto';
  const root = document.documentElement;
  if (next === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
  try {
    if (next === 'auto') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, next);
  } catch { /* storage blocked: the choice lasts for this visit */ }
  dropAddressTheme();
  syncChrome();
  announce(next);
}

/* A ?theme= link applies once. A choice made in the picker replaces it, so the
   address must stop naming a theme, or the next reload would undo the choice. */
function dropAddressTheme() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('theme')) return;
    url.searchParams.delete('theme');
    window.history.replaceState(window.history.state, '', url);
  } catch { /* an address the URL parser refuses: leave it */ }
}

/* The browser bar and an installed app's title bar take --theme-chrome. */
function syncChrome() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--theme-chrome').trim();
  if (!color) return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', color);
}

function announce(theme) {
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}
