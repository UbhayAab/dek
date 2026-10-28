// Microphone and camera, asked for only when a call needs them (DEK24), and what
// to tell a person when the browser says no. A refusal never touches chat: it is
// a dialog that explains how to allow access in this browser, and closing it
// leaves everything else exactly as it was.

export type Device = 'microphone' | 'camera';
export type ProblemKind = 'denied' | 'missing' | 'busy' | 'insecure' | 'unknown';

export interface MediaProblem {
  kind: ProblemKind;
  device: Device;
  title: string;
  body: string;
  steps: string[];
}

export class MediaAccessError extends Error {
  readonly problem: MediaProblem;

  constructor(problem: MediaProblem) {
    super(problem.title);
    this.name = 'MediaAccessError';
    this.problem = problem;
  }
}

interface Platform {
  ios: boolean;
  android: boolean;
  standalone: boolean;
  firefox: boolean;
  safari: boolean;
  mac: boolean;
  windows: boolean;
}

export function platform(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): Platform {
  const ua = nav?.userAgent ?? '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (nav?.platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1);
  const standalone = typeof window !== 'undefined'
    && (window.matchMedia?.('(display-mode: standalone)').matches || (nav as Navigator & { standalone?: boolean } | undefined)?.standalone === true);
  return {
    ios,
    android: /Android/i.test(ua),
    standalone: !!standalone,
    firefox: /Firefox\//.test(ua) && !/Seamonkey/i.test(ua),
    safari: /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(ua),
    mac: /Macintosh/.test(ua) && !ios,
    windows: /Windows/.test(ua),
  };
}

// How to undo a refusal in this browser. requestPermission cannot re-prompt once
// the person said no, so these are the only way back.
export function permissionSteps(device: Device, p: Platform = platform()): string[] {
  const Dev = device === 'microphone' ? 'Microphone' : 'Camera';
  const steps: string[] = [];
  if (p.ios) {
    if (p.standalone) steps.push(`Open the Settings app, scroll to Safari, tap ${Dev}, and choose Allow. Then come back to Dek and try again.`);
    else steps.push(`Tap the aA button in the address bar, then Website Settings, and set ${Dev} to Allow. Then try again.`);
    steps.push(`If that does not help: Settings, Safari, ${Dev}, Allow.`);
    return steps;
  }
  if (p.android) {
    if (p.standalone) steps.push(`Touch and hold the Dek icon, tap App info, then Permissions, then ${Dev}, and choose Allow.`);
    else steps.push(`Tap the icon at the left of the address bar, then Permissions, and turn on ${Dev}. Then try again.`);
    return steps;
  }
  if (p.firefox) steps.push(`Click the crossed-out ${device} icon in the address bar and remove the block (or choose Allow). Then try again.`);
  else if (p.safari) steps.push(`Open Safari, then Settings, then Websites, choose ${Dev} on the left, and set this site to Allow. Then try again.`);
  else steps.push(`Click the icon at the left of the address bar (a lock, or a ${device} with a red cross), set ${Dev} to Allow, and reload if asked. Then try again.`);
  if (p.windows) steps.push(`If it is already allowed there, open Windows Settings, Privacy and security, ${Dev}, and let your browser use it.`);
  if (p.mac) steps.push(`If it is already allowed there, open System Settings, Privacy and Security, ${Dev}, and turn your browser on.`);
  return steps;
}

export function describeMediaError(e: unknown, device: Device, p: Platform = platform()): MediaProblem {
  if (e instanceof MediaAccessError) return e.problem;
  const name = (e as { name?: string } | null)?.name ?? '';
  const Dev = device === 'microphone' ? 'microphone' : 'camera';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      kind: 'denied', device,
      title: `Dek is not allowed to use your ${Dev}`,
      body: `Your browser blocked the ${Dev} for Dek. Chat keeps working; to talk in calls, allow it:`,
      steps: permissionSteps(device, p),
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      kind: 'missing', device,
      title: `No ${Dev} found`,
      body: `Dek could not find a ${Dev}. Plug one in or turn it on, check your system sound settings, then try again.`,
      steps: [],
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      kind: 'busy', device,
      title: `Your ${Dev} is busy`,
      body: `Another app or tab is using the ${Dev}, or it could not start. Close the other app, then try again.`,
      steps: [],
    };
  }
  if (name === 'TypeError' || (typeof navigator !== 'undefined' && !navigator.mediaDevices)) {
    return {
      kind: 'insecure', device,
      title: 'Calls need a secure connection',
      body: 'This page cannot use a microphone or camera. Open Dek from its https address and try again.',
      steps: [],
    };
  }
  return {
    kind: 'unknown', device,
    title: `The ${Dev} did not start`,
    body: `Something stopped the ${Dev} from starting. Try again, or restart the browser.`,
    steps: [],
  };
}

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};

export interface OpenRequest {
  audio: boolean;
  video: boolean;
  audioDevice?: string | null;
  videoDevice?: string | null;
}

export interface Opened {
  stream: MediaStream;
  cameraProblem: MediaProblem | null;
}

export type GetUserMedia = (c: MediaStreamConstraints) => Promise<MediaStream>;

const gum: GetUserMedia = (c) => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new TypeError('getUserMedia is not available'));
  }
  return navigator.mediaDevices.getUserMedia(c);
};

export function audioConstraints(deviceId?: string | null): MediaTrackConstraints {
  return deviceId ? { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } : AUDIO_CONSTRAINTS;
}

export function videoConstraints(deviceId?: string | null): MediaTrackConstraints {
  return deviceId ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } : VIDEO_CONSTRAINTS;
}

// The microphone (and the camera for a video call). A camera that fails does not
// stop the call: it goes ahead with audio and says why there is no picture. A
// microphone that fails throws MediaAccessError with the explanation.
export async function openMedia(req: OpenRequest, get: GetUserMedia = gum): Promise<Opened> {
  if (req.video) {
    try {
      const stream = await get({ audio: audioConstraints(req.audioDevice), video: videoConstraints(req.videoDevice) });
      return { stream, cameraProblem: null };
    } catch (e) {
      try {
        const stream = await get({ audio: audioConstraints(req.audioDevice), video: false });
        return { stream, cameraProblem: describeMediaError(e, 'camera') };
      } catch (e2) {
        throw new MediaAccessError(describeMediaError(e2, 'microphone'));
      }
    }
  }
  try {
    const stream = await get({ audio: audioConstraints(req.audioDevice), video: false });
    return { stream, cameraProblem: null };
  } catch (e) {
    throw new MediaAccessError(describeMediaError(e, 'microphone'));
  }
}

export interface DeviceLists {
  audioinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
}

export async function listDevices(): Promise<DeviceLists> {
  const out: DeviceLists = { audioinput: [], audiooutput: [], videoinput: [] };
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return out;
  try {
    for (const d of await navigator.mediaDevices.enumerateDevices()) {
      if (d.kind in out && d.deviceId) out[d.kind as keyof DeviceLists].push(d);
    }
  } catch {
    // no list: the selectors simply stay hidden
  }
  return out;
}

// Choosing the speaker works where HTMLMediaElement.setSinkId exists (Chromium,
// Firefox 116+, Safari 18.4+); elsewhere the system decides.
export function sinkSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export async function applySink(el: HTMLMediaElement, deviceId: string | null): Promise<void> {
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!withSink.setSinkId) return;
  try {
    await withSink.setSinkId(deviceId ?? '');
  } catch {
    // the device went away: the default output carries on
  }
}

// Screen sharing needs getDisplayMedia: desktop Chrome, Edge, Firefox and Safari.
// Missing on iOS and in the Android and iOS app WebViews, where the button is
// hidden rather than offered and refused.
export function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}
