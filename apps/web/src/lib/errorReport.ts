// Crash reports (migration 0912, OPS18): render crashes from the ErrorBoundary and
// uncaught errors, so problems real people hit become visible. Technical facts only
// (build, route name, error name, a redacted message, a few stack lines, browser family);
// never message text, file names or tokens. At most 10 a page session, each once.
import { supabase } from '../api/client';
import { currentRoute } from '../app/router';
import { config } from '../config';

const MAX_PER_SESSION = 10;
const sent = new Set<string>();

export function redactForReport(s: string, max: number): string {
  return s
    .replace(/[^\s@]+@[^\s@]+/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<link>')
    .replace(/\d{6,}/g, '<number>')
    .replace(/"[^"]{20,}"/g, '"<text>"')
    .slice(0, max);
}

async function fingerprint(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

function agentFamily(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'other';
  return `${browser} ${os}`;
}

export function reportError(error: unknown): void {
  try {
    if (sent.size >= MAX_PER_SESSION) return;
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'non-Error thrown');
    const message = redactForReport(e.message ?? '', 300);
    // file:line only: the app's own origin is dropped from every frame
    const stack = redactForReport((e.stack ?? '').split('\n').slice(0, 8)
      .map((line) => line.replace(/https?:\/\/[^/\s)]+/g, '').trim()).join('\n'), 1500);
    const key = `${e.name}|${message}|${stack.split('\n')[1] ?? ''}`;
    if (sent.has(key)) return;
    sent.add(key);
    void fingerprint(`${config.buildId}|${key}`)
      .then((fp) => supabase().rpc('report_client_error', {
        p_report: { fingerprint: fp, build: config.buildId, route: currentRoute().name, name: e.name, message, stack, agent: agentFamily() },
      }))
      .catch(() => undefined);
  } catch {
    // reporting must never throw
  }
}

let installed = false;
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
}
