// Composer drafts (DEK09) and scroll memory (DEK04), persisted per person in
// localStorage so they survive a reload, a killed PWA and a failed send. Keys carry
// the user id (dek.drafts.<user>, dek.scroll.<user>) and are wiped at sign-out.
import { getState, setState } from '../store/state';
import type { ScrollMemory } from '../store/state';
import { readJson, readString, userKey, writeJson, writeString, removeKey } from '../lib/storage';
import { runtime } from './runtime';

const DRAFT_MAX = 10_000;
const SCROLL_KEEP = 200;
const SAVE_DELAY_MS = 400;

let draftTimer: ReturnType<typeof setTimeout> | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

export function loadLocal(userId: string): void {
  const drafts = readJson<Record<string, string>>(userKey('drafts', userId), {});
  const scroll = readJson<Record<string, ScrollMemory>>(userKey('scroll', userId), {});
  setState({
    drafts: typeof drafts === 'object' && drafts ? drafts : {},
    scroll: typeof scroll === 'object' && scroll ? scroll : {},
  });
}

function flushDrafts(): void {
  draftTimer = null;
  const uid = runtime()?.userId;
  if (!uid) return;
  writeJson(userKey('drafts', uid), getState().drafts);
}

function flushScroll(): void {
  scrollTimer = null;
  const uid = runtime()?.userId;
  if (!uid) return;
  // Keep the most recent entries only: a person who opened 2,000 channels does not
  // need 2,000 scroll positions in localStorage.
  const entries = Object.entries(getState().scroll);
  const kept = entries.length > SCROLL_KEEP ? Object.fromEntries(entries.slice(-SCROLL_KEEP)) : getState().scroll;
  writeJson(userKey('scroll', uid), kept);
}

export function setDraft(key: string, text: string): void {
  const value = text.length > DRAFT_MAX ? text.slice(0, DRAFT_MAX) : text;
  const drafts = { ...getState().drafts };
  if (value.trim().length === 0) delete drafts[key];
  else drafts[key] = value;
  setState({ drafts });
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDrafts, SAVE_DELAY_MS);
}

export function rememberScroll(channelId: string, anchorId: string | null, offset: number, atBottom: boolean): void {
  const prev = getState().scroll[channelId];
  if (prev && prev.anchorId === anchorId && prev.offset === offset && prev.atBottom === atBottom) return;
  const scroll = { ...getState().scroll };
  delete scroll[channelId];   // re-insert so it counts as most recent
  scroll[channelId] = { anchorId, offset: Number.isFinite(offset) ? Math.round(offset) : 0, atBottom };
  setState({ scroll });
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(flushScroll, SAVE_DELAY_MS);
}

// Write now (page hiding: Android may kill the PWA in the background).
export function flushLocal(): void {
  if (draftTimer) {
    clearTimeout(draftTimer);
    flushDrafts();
  }
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    flushScroll();
  }
}

export function cancelLocalWrites(): void {
  if (draftTimer) clearTimeout(draftTimer);
  if (scrollTimer) clearTimeout(scrollTimer);
  draftTimer = null;
  scrollTimer = null;
}

export function dropPersistedDrafts(userId: string, channelIds: ReadonlySet<string>): void {
  const key = userKey('drafts', userId);
  const drafts = readJson<Record<string, string>>(key, {});
  let changed = false;
  for (const k of Object.keys(drafts)) {
    if (channelIds.has(k.split(':')[0]!)) {
      delete drafts[k];
      changed = true;
    }
  }
  if (changed) writeJson(key, drafts);
}

// The organization picked last time, per person.
export function lastOrg(userId: string): string | null {
  return readString(userKey('lastOrg', userId));
}

export function rememberOrg(userId: string, orgId: string | null): void {
  if (orgId) writeString(userKey('lastOrg', userId), orgId);
  else removeKey(userKey('lastOrg', userId));
}
