// OWNER: native builder. Keeps the composer visible above the on-screen keyboard.
//
// The shells already shrink the web view above the keyboard (iOS: Keyboard
// resize "native"; Android: Capacitor 8 SystemBars pads the view by the keyboard
// height). On top of that this exposes the state to CSS and scrolls the focused
// field into view once the keyboard has settled:
//   html[data-keyboard="open"]   while the keyboard is up
//   --kb-native                  the keyboard height in CSS px (0 when hidden)
import { listenNative } from './bridge';

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function setOpen(height: number): void {
  const root = document.documentElement;
  if (height > 0) {
    root.dataset.keyboard = 'open';
    root.style.setProperty('--kb-native', `${Math.round(height)}px`);
  } else {
    delete root.dataset.keyboard;
    root.style.setProperty('--kb-native', '0px');
  }
}

export function revealFocused(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.matches(EDITABLE)) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export function installKeyboard(): () => void {
  setOpen(0);
  const offs = [
    listenNative<{ keyboardHeight: number }>('Keyboard', 'keyboardWillShow', (e) => setOpen(e?.keyboardHeight ?? 0)),
    listenNative<{ keyboardHeight: number }>('Keyboard', 'keyboardDidShow', (e) => {
      setOpen(e?.keyboardHeight ?? 0);
      revealFocused();
    }),
    listenNative('Keyboard', 'keyboardWillHide', () => setOpen(0)),
    listenNative('Keyboard', 'keyboardDidHide', () => setOpen(0)),
  ];
  return () => offs.forEach((off) => off());
}
