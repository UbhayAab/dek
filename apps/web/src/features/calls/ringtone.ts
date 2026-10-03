// A short, quiet two-note chime for an incoming call, made with WebAudio (no file
// to download, works offline). It never plays under automation (tests are
// silent), and never when the page is not allowed to play audio: a context that
// will not start without a gesture is closed again instead of waiting to blare
// later. Always returns a stop function; stopping closes the AudioContext.

const REPEAT_MS = 3000;
const MAX_RING_MS = 45_000;
const GAIN = 0.12;

type AutoplayNavigator = Navigator & { getAutoplayPolicy?: (type: 'audiocontext' | 'mediaelement') => string };

export function ringtoneAllowed(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (navigator.webdriver) return false;
  if (import.meta.env?.MODE === 'test') return false;
  const policy = (navigator as AutoplayNavigator).getAutoplayPolicy?.('audiocontext');
  if (policy === 'disallowed') return false;
  try {
    if (window.localStorage.getItem('dek.calls.ringtone') === 'off') return false;
  } catch {
    // storage unavailable: ring
  }
  return typeof window.AudioContext === 'function';
}

function note(ctx: AudioContext, freq: number, at: number, length: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(GAIN, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

export function startRingtone(): () => void {
  if (!ringtoneAllowed()) return () => undefined;
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => undefined;
  }
  let stopped = false;
  let repeat: ReturnType<typeof setInterval> | null = null;
  const chime = () => {
    if (stopped || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    note(ctx, 659.25, t, 0.22);
    note(ctx, 880, t + 0.25, 0.35);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(begin);
    clearTimeout(limit);
    if (repeat) clearInterval(repeat);
    void ctx.close().catch(() => undefined);
  };
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  // Not running a moment later means no permission to play: give up quietly.
  const begin = setTimeout(() => {
    if (stopped) return;
    if (ctx.state !== 'running') {
      stop();
      return;
    }
    chime();
    repeat = setInterval(chime, REPEAT_MS);
  }, 250);
  const limit = setTimeout(stop, MAX_RING_MS);
  return stop;
}
