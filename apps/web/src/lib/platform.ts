// Browser and device detection for push, install and troubleshooting copy. Pure
// functions over a snapshot so tests can feed any user agent (LESSONS "iPhone and
// phones": iPadOS reports MacIntel with touch points; iOS Safari excludes CriOS,
// FxiOS, EdgiOS and OPiOS, which cannot install or receive web push).
export type Engine = 'chromium' | 'webkit' | 'gecko' | 'other';
export type Os = 'android' | 'ios' | 'ipados' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other';
export type BrowserName = 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Samsung Internet' | 'Opera' | 'Browser';

export interface EnvSnapshot {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  navigatorStandalone: boolean;
  displayModeStandalone: boolean;
}

export interface PlatformInfo {
  os: Os;
  browser: BrowserName;
  engine: Engine;
  isIOS: boolean;              // iPhone, iPod or iPad (any browser: all are WebKit there)
  isIOSSafari: boolean;        // the browser that can add to Home Screen with push
  iosVersion: number | null;   // 16.4 => 16.4
  isAndroid: boolean;
  isStandalone: boolean;       // running as an installed app
  isMobile: boolean;
}

export function snapshot(): EnvSnapshot {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  let dm = false;
  try {
    dm = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    dm = false;
  }
  return {
    ua: nav?.userAgent ?? '',
    platform: (nav as (Navigator & { platform?: string }) | null)?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    navigatorStandalone: (nav as (Navigator & { standalone?: boolean }) | null)?.standalone === true,
    displayModeStandalone: dm,
  };
}

export function detect(env: EnvSnapshot = snapshot()): PlatformInfo {
  const ua = env.ua;
  const iPadOS = env.platform === 'MacIntel' && env.maxTouchPoints > 1;
  const iPhone = /iPhone|iPod/.test(ua);
  const iPad = /iPad/.test(ua) || iPadOS;
  const isIOS = iPhone || iPad;
  const isAndroid = /Android/i.test(ua);

  let os: Os = 'other';
  if (iPhone) os = 'ios';
  else if (iPad) os = 'ipados';
  else if (isAndroid) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macos';
  else if (/Linux|X11/.test(ua)) os = 'linux';

  let browser: BrowserName = 'Browser';
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|OPiOS|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome\/|Chromium\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) || isIOS) browser = 'Safari';

  let engine: Engine = 'other';
  if (isIOS) engine = 'webkit';
  else if (/Firefox\//.test(ua)) engine = 'gecko';
  else if (/Chrome\/|Chromium\/|Edg\//.test(ua)) engine = 'chromium';
  else if (/AppleWebKit/.test(ua)) engine = 'webkit';

  const m = /OS (\d+)[_.](\d+)/.exec(ua) ?? (iPadOS ? /Version\/(\d+)\.(\d+)/.exec(ua) : null);
  const iosVersion = isIOS && m ? Number(`${m[1]}.${m[2]}`) : null;
  const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\//.test(ua);

  return {
    os,
    browser,
    engine,
    isIOS,
    isIOSSafari,
    iosVersion,
    isAndroid,
    isStandalone: env.displayModeStandalone || env.navigatorStandalone,
    isMobile: isIOS || isAndroid || /Mobile/.test(ua),
  };
}

const OS_LABEL: Record<Os, string> = {
  android: 'Android', ios: 'iPhone', ipados: 'iPad', windows: 'Windows', macos: 'Mac', linux: 'Linux', chromeos: 'ChromeOS', other: 'this device',
};

// "Chrome on Android", "Safari on iPhone (Home Screen)": the device row label.
export function deviceLabel(p: PlatformInfo = detect()): string {
  const base = `${p.browser} on ${OS_LABEL[p.os]}`;
  return p.isStandalone ? `${base} (installed)` : base;
}

export function platformCode(p: PlatformInfo = detect()): string {
  return p.os === 'ipados' ? 'ios' : p.os;
}

// Web push from an iPhone or iPad needs iOS 16.4 or later AND the Home Screen app.
export function iosPushNeedsInstall(p: PlatformInfo = detect()): boolean {
  return p.isIOS && !p.isStandalone;
}

export function iosTooOldForPush(p: PlatformInfo = detect()): boolean {
  return p.isIOS && p.iosVersion !== null && p.iosVersion < 16.4;
}
