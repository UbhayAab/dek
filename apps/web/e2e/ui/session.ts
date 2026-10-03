// Signs a QA person in without the UI (the auth screen belongs to another
// builder): password from .env.local via tools/lib/env.mjs, never printed. The
// session goes into localStorage under the app's storage key before the page
// loads, exactly where supabase-js keeps it.
import { createClient, type Session } from '@supabase/supabase-js';
import type { BrowserContext } from '@playwright/test';
// @ts-expect-error plain ESM helper shared by the repo's tools
import { env } from '../../../../tools/lib/env.mjs';

export type QaPerson = 'owner' | 'admin' | 'alice' | 'bob' | 'carol' | 'guest' | 'eve';

const STORAGE_KEY = 'dek.auth';
const cache = new Map<QaPerson, Session>();

function settings(): { url: string; key: string; password: string } {
  const e = env() as Record<string, string | undefined>;
  const url = e.SUPABASE_URL ?? 'https://nxljuctnauhgzekvmftp.supabase.co';
  const key = e.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_3nEbaDSWo0j3kFCl52-vhg_aRQZTndH';
  const password = e.DEK_QA_PASSWORD;
  if (!password) throw new Error('DEK_QA_PASSWORD is missing from .env.local (run node tools/seed-qa.mjs)');
  return { url, key, password };
}

export async function qaSession(who: QaPerson): Promise<Session> {
  const hit = cache.get(who);
  if (hit && (hit.expires_at ?? 0) * 1000 > Date.now() + 5 * 60_000) return hit;
  const { url, key, password } = settings();
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email: `qa-${who}@dek-test.invalid`, password });
  if (error || !data.session) throw new Error(`QA sign-in failed for ${who}: ${error?.message ?? 'no session'}`);
  cache.set(who, data.session);
  return data.session;
}

export async function signIn(context: BrowserContext, who: QaPerson): Promise<Session> {
  const session = await qaSession(who);
  await context.addInitScript(({ k, v }) => {
    try {
      if (!window.localStorage.getItem(k)) window.localStorage.setItem(k, v);
    } catch {
      // storage unavailable: the test will fail visibly at the sign-in screen
    }
  }, { k: STORAGE_KEY, v: JSON.stringify(session) });
  return session;
}

// Read-only API calls as a QA person (to find ids for deep links).
export async function qaRpc<T>(who: QaPerson, fn: string, args: Record<string, unknown>): Promise<T> {
  const session = await qaSession(who);
  const { url, key } = settings();
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'api',
      'Accept-Profile': 'api',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}
