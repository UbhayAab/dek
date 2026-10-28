// Device label from a browser user agent: browser and operating system only, no
// versions or device models (push_devices.label, push_devices.platform).

function os(ua) {
  if (/Android/i.test(ua)) return ['Android', 'android'];
  if (/iPhone|iPad|iPod/i.test(ua)) return ['iOS', 'ios'];
  if (/CrOS/i.test(ua)) return ['ChromeOS', 'chromeos'];
  if (/Windows/i.test(ua)) return ['Windows', 'windows'];
  if (/Macintosh|Mac OS X/i.test(ua)) return ['macOS', 'macos'];
  if (/Linux|X11/i.test(ua)) return ['Linux', 'linux'];
  return [null, null];
}

function browser(ua) {
  if (/EdgA?\/|EdgiOS\//.test(ua)) return 'Edge';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
  if (/Version\/[\d.]+.*Safari\//.test(ua) || /Safari\//.test(ua)) return 'Safari';
  return null;
}

// The push service host says which browser family registered when the UA is missing.
function browserFromEndpoint(endpoint) {
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { return null; }
  if (host.endsWith('push.apple.com')) return 'Safari';
  if (host.endsWith('mozilla.com')) return 'Firefox';
  if (host.endsWith('notify.windows.com')) return 'Edge';
  if (host.endsWith('googleapis.com')) return 'Chrome';
  return null;
}

export function deviceLabel(ua, endpoint) {
  const s = String(ua || '');
  const [osName, platform] = os(s);
  const b = browser(s) || browserFromEndpoint(endpoint) || 'Browser';
  const label = osName ? `${b} on ${osName}` : b;
  return { label: label.slice(0, 80), platform: platform ? platform.slice(0, 40) : null };
}
