// Service worker pure helpers: url to tag, the focused-window decision (Chromium
// only), click routing, same-origin targets, the media cache key and its LRU.
import { describe, expect, it } from 'vitest';
import {
  MEDIA_MAX_BYTES, conversationOf, isChromiumUA, isMediaUrl, isStale, matchesPrefix, mediaCacheKey, mediaObjectPath,
  parsePushData, pickWindow, planEviction, safeTargetUrl, sameConversation, suppressFor, tagFor,
} from '../../src/sw/helpers';

const O = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const C2 = '33333333-3333-4333-8333-333333333333';
const T = '44444444-4444-4444-8444-444444444444';
const M = '55555555-5555-4555-8555-555555555555';
const K = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://dek-7o4.pages.dev';

const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

describe('conversation and tag from a url', () => {
  it('reads org, channel and thread from deep links', () => {
    expect(conversationOf(`/o/${O}/c/${C}/m/${M}`)).toEqual({ orgId: O, channelId: C, threadId: null });
    expect(conversationOf(`/o/${O}/c/${C}/t/${T}/m/${M}`)).toEqual({ orgId: O, channelId: C, threadId: T });
    expect(conversationOf(`/c/${C}`)).toEqual({ orgId: null, channelId: C, threadId: null });
    expect(conversationOf(`/o/${O}/mentions`)).toBeNull();
    expect(conversationOf('not a url ::')).toBeNull();
  });

  it('uses the server tag, else one tag per conversation', () => {
    expect(tagFor({ tag: `c:${C}`, url: '/' })).toBe(`c:${C}`);
    expect(tagFor({ url: `/o/${O}/c/${C}/m/${M}` })).toBe(`c:${C}`);
    expect(tagFor({ url: `/o/${O}/c/${C}/t/${T}/m/${M}` })).toBe(`t:${T}`);
    expect(tagFor({ url: `/o/${O}/call/${K}` })).toBe(`call:${K}`);
    expect(tagFor({})).toBe('dek');
  });

  it('a channel message matches a window on that channel; a reply only its open thread', () => {
    expect(sameConversation(`/o/${O}/c/${C}/m/${M}`, `${ORIGIN}/o/${O}/c/${C}`, ORIGIN)).toBe(true);
    expect(sameConversation(`/o/${O}/c/${C}/m/${M}`, `${ORIGIN}/o/${O}/c/${C}/t/${T}`, ORIGIN)).toBe(false);
    expect(sameConversation(`/o/${O}/c/${C}/m/${M}`, `${ORIGIN}/o/${O}/c/${C2}`, ORIGIN)).toBe(false);
    expect(sameConversation(`/o/${O}/c/${C}/t/${T}/m/${M}`, `${ORIGIN}/o/${O}/c/${C}`, ORIGIN)).toBe(false);
    expect(sameConversation(`/o/${O}/c/${C}/t/${T}/m/${M}`, `${ORIGIN}/o/${O}/c/${C}/t/${T}`, ORIGIN)).toBe(true);
    expect(sameConversation(`/o/${O}/c/${C}`, `${ORIGIN}/o/${O}/mentions`, ORIGIN)).toBe(false);
  });
});

describe('focused-window decision', () => {
  const url = `/o/${O}/c/${C}/m/${M}`;
  const focusedHere = { url: `${ORIGIN}/o/${O}/c/${C}`, focused: true, visibilityState: 'visible' };
  const focusedElsewhere = { url: `${ORIGIN}/o/${O}/c/${C2}`, focused: true, visibilityState: 'visible' };
  const backgroundHere = { url: `${ORIGIN}/o/${O}/c/${C}`, focused: false, visibilityState: 'hidden' };
  it('keeps main alerts while a phone thread hides the channel, but respects a visible desktop main pane', () => {
    const thread = { ...focusedHere, url: `${ORIGIN}/o/${O}/c/${C}/t/${T}`, channelVisible: false };
    expect(suppressFor({ url }, [thread], true, ORIGIN)).toBeNull();
    const desktop = { ...thread, channelVisible: true };
    expect(suppressFor({ url }, [desktop], true, ORIGIN)).toBe(desktop);
  });

  it('Chromium: skips the OS notification only for a focused visible window on that conversation', () => {
    expect(suppressFor({ url }, [focusedHere], true, ORIGIN)).toBe(focusedHere);
    expect(suppressFor({ url }, [focusedElsewhere], true, ORIGIN)).toBeNull();
    expect(suppressFor({ url }, [backgroundHere], true, ORIGIN)).toBeNull();
    expect(suppressFor({ url }, [], true, ORIGIN)).toBeNull();
  });
  it('honors explicit hidden context while old pages retain exact-URL fallback',()=>{
    expect(suppressFor({url},[{...focusedHere,channelVisible:false}],true,ORIGIN)).toBeNull();
    expect(suppressFor({url},[focusedHere],true,ORIGIN)).toBe(focusedHere);
    const thread={...focusedHere,url:`${ORIGIN}/o/${O}/c/${C}/t/${T}`,channelVisible:false,threadVisible:true};
    expect(suppressFor({url:`/o/${O}/c/${C}/t/${T}/m/${M}`},[thread],true,ORIGIN)).toBe(thread);
    expect(suppressFor({url:`/o/${O}/c/${C}/t/${T}/m/${M}`},[{...thread,threadVisible:false}],true,ORIGIN)).toBeNull();
  });

  it('WebKit and Firefox: ALWAYS show it', () => {
    expect(suppressFor({ url }, [focusedHere], false, ORIGIN)).toBeNull();
  });

  it('calls and test notifications always show', () => {
    expect(suppressFor({ url, kind: 'call' }, [focusedHere], true, ORIGIN)).toBeNull();
    expect(suppressFor({ url, kind: 'test' }, [focusedHere], true, ORIGIN)).toBeNull();
  });

  it('knows which engines are Chromium', () => {
    expect(isChromiumUA(CHROME)).toBe(true);
    expect(isChromiumUA(EDGE)).toBe(true);
    expect(isChromiumUA(SAFARI_MAC)).toBe(false);
    expect(isChromiumUA(IOS_CHROME)).toBe(false);   // WebKit underneath
    expect(isChromiumUA(FIREFOX)).toBe(false);
  });
});

describe('notification taps', () => {
  it('opens only same-origin paths', () => {
    expect(safeTargetUrl(`/o/${O}/c/${C}?x=1#y`, ORIGIN)).toBe(`/o/${O}/c/${C}?x=1#y`);
    expect(safeTargetUrl('https://evil.example/phish', ORIGIN)).toBe('/');
    expect(safeTargetUrl('//evil.example/x', ORIGIN)).toBe('/');
    expect(safeTargetUrl('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(safeTargetUrl(null, ORIGIN)).toBe('/');
  });

  it('prefers the window already in that conversation, then the focused one', () => {
    const a = { url: `${ORIGIN}/o/${O}/c/${C2}`, focused: true, visibilityState: 'visible', id: 'a' };
    const b = { url: `${ORIGIN}/o/${O}/c/${C}`, focused: false, visibilityState: 'hidden', id: 'b' };
    expect(pickWindow([a, b], `/o/${O}/c/${C}`, ORIGIN)?.id).toBe('b');
    expect(pickWindow([a, b], `/o/${O}/mentions`, ORIGIN)?.id).toBe('a');
    expect(pickWindow([], '/', ORIGIN)).toBeNull();
  });

  it('parses push payloads defensively and dates them', () => {
    expect(parsePushData('{"title":"Asha","body":"hi","url":"/x","tag":"c:1","kind":"message","ts":5}')).toMatchObject({ title: 'Asha', body: 'hi', ts: 5 });
    expect(parsePushData('plain text')).toEqual({ body: 'plain text' });
    expect(parsePushData(null)).toEqual({});
    expect(parsePushData('{"title":42}').title).toBeUndefined();
    expect(isStale({ ts: 0 }, 60 * 60 * 1000 + 1)).toBe(true);
    expect(isStale({ ts: 0 }, 1000)).toBe(false);
    expect(isStale({}, 1e13)).toBe(false);
  });
});

describe('media cache', () => {
  const signed = `https://nxljuctnauhgzekvmftp.supabase.co/storage/v1/object/sign/media/${O}/${C}/${M}/photo%201.jpg?token=abc.def`;

  it('keys by object path without the token', () => {
    expect(isMediaUrl(signed)).toBe(true);
    expect(isMediaUrl('https://nxljuctnauhgzekvmftp.supabase.co/rest/v1/rpc/send_message')).toBe(false);
    expect(isMediaUrl('https://nxljuctnauhgzekvmftp.supabase.co/storage/v1/object/public/avatars/a.webp')).toBe(false);
    const key = mediaCacheKey(signed);
    expect(key).toBe(`https://nxljuctnauhgzekvmftp.supabase.co/storage/v1/object/sign/media/${O}/${C}/${M}/photo%201.jpg`);
    expect(mediaCacheKey(signed.replace('abc.def', 'fresh.token'))).toBe(key);
    expect(mediaObjectPath(key)).toBe(`${O}/${C}/${M}/photo 1.jpg`);
  });

  it('purges by organization or channel prefix', () => {
    const key = mediaCacheKey(signed);
    expect(matchesPrefix(key, [`${O}/${C}/`])).toBe(true);
    expect(matchesPrefix(key, [`${O}/`])).toBe(true);
    expect(matchesPrefix(key, [`${O}/${C2}/`])).toBe(false);
    expect(matchesPrefix(key, [''])).toBe(false);
  });

  it('evicts least recently used first until under 150 MB and 500 entries', () => {
    const mb = 1024 * 1024;
    const idx: Record<string, { size: number; at: number }> = {
      old: { size: 60 * mb, at: 1 }, mid: { size: 60 * mb, at: 2 }, new: { size: 60 * mb, at: 3 },
    };
    expect(planEviction(idx)).toEqual(['old']);                      // 180 MB -> 120 MB
    expect(planEviction({ a: { size: 1, at: 1 } })).toEqual([]);
    const many: Record<string, { size: number; at: number }> = {};
    for (let i = 0; i < 503; i += 1) many[`k${i}`] = { size: 10, at: i };
    expect(planEviction(many)).toEqual(['k0', 'k1', 'k2']);
    expect(planEviction({ big: { size: MEDIA_MAX_BYTES + 1, at: 9 } })).toEqual(['big']);
  });
});
