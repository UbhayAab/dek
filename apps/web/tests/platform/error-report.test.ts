// Crash reports: redacted, once per kind, at most 10 a session.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn(async () => ({ data: { stored: true }, error: null }));
vi.mock('../../src/api/client', () => ({ supabase: () => ({ rpc }) }));
vi.mock('../../src/app/router', () => ({ currentRoute: () => ({ name: 'channel' }) }));

const { redactForReport, reportError } = await import('../../src/lib/errorReport');
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('crash reports', () => {
  beforeEach(() => { rpc.mockClear(); });

  it('redacts emails, links, long numbers and quoted text', () => {
    const s = redactForReport('failed for asha@jcf.org at https://x.test/a?b=c id 9876543210 body "this is a long private sentence"', 300);
    expect(s).not.toMatch(/asha@|https:|9876543210|private sentence/);
    expect(s).toContain('<email>');
    expect(s).toContain('<link>');
    expect(s).toContain('<number>');
    expect(s).toContain('"<text>"');
  });

  it('sends a technical report once per kind, with no message content', async () => {
    const e = new TypeError('Cannot read properties of undefined (reading "x")');
    reportError(e);
    reportError(e);
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, { p_report: Record<string, string> }];
    expect(fn).toBe('report_client_error');
    expect(args.p_report.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(args.p_report.route).toBe('channel');
    expect(args.p_report.name).toBe('TypeError');
    expect(Object.keys(args.p_report).sort()).toEqual(['agent', 'build', 'fingerprint', 'message', 'name', 'route', 'stack']);
  });

  it('stops after 10 reports in a session', async () => {
    for (let i = 0; i < 25; i += 1) reportError(new Error(`kind ${String.fromCharCode(97 + i)}`));
    await settle();
    // one was already sent by the test above; the cap is per page session
    expect(rpc.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('never throws, whatever it is given', () => {
    expect(() => reportError(undefined)).not.toThrow();
    expect(() => reportError({ weird: true })).not.toThrow();
  });
});
