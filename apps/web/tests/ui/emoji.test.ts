import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  EMOJI_GROUPS, EmojiPicker, QUICK_REACTIONS, emojiName, noteEmoji, recentEmoji, searchEmoji,
} from '../../src/features/conversation/emoji';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('emoji data', () => {
  const all = EMOJI_GROUPS.flatMap((g) => g.items);

  it('bundles about 300 named emoji with no duplicates', () => {
    expect(all.length).toBeGreaterThanOrEqual(250);
    expect(all.length).toBeLessThanOrEqual(400);
    expect(new Set(all.map((e) => e.ch)).size).toBe(all.length);
    for (const e of all) {
      expect(e.ch.length).toBeGreaterThan(0);
      expect(e.name).toMatch(/^[a-z0-9][a-z0-9 '.-]*$/);
      expect([0x2013, 0x2014].some((c) => e.name.includes(String.fromCharCode(c)))).toBe(false);
    }
  });

  it('has the expected groups, each with an icon', () => {
    expect(EMOJI_GROUPS.map((g) => g.id)).toEqual([
      'smileys', 'gestures', 'people', 'nature', 'food', 'activity', 'travel', 'objects', 'symbols',
    ]);
    for (const g of EMOJI_GROUPS) {
      expect(g.icon.length).toBeGreaterThan(0);
      expect(g.items.length).toBeGreaterThan(10);
    }
  });

  it('names every quick reaction', () => {
    for (const ch of QUICK_REACTIONS) expect(emojiName(ch)).not.toBeNull();
  });
});

describe('emojiName', () => {
  it('finds names with or without the presentation selector', () => {
    expect(emojiName('👍')).toBe('thumbs up');
    expect(emojiName('❤️')).toBe('red heart');
    expect(emojiName('❤')).toBe('red heart');
    expect(emojiName('🇮🇳')).toBe('flag india');
  });

  it('returns null for unknown input', () => {
    expect(emojiName('x')).toBeNull();
    expect(emojiName('')).toBeNull();
  });
});

describe('searchEmoji', () => {
  it('finds by name and keyword prefix', () => {
    expect(searchEmoji('thumb')[0]?.ch).toBe('👍');
    expect(searchEmoji('tada').map((e) => e.ch)).toContain('🎉');
    expect(searchEmoji('namaste').map((e) => e.ch)).toEqual(['🙏']);
    expect(searchEmoji('THUMBS').map((e) => e.ch)).toEqual(['👍', '👎']);
  });

  it('ranks prefix matches before substring matches', () => {
    const results = searchEmoji('art').map((e) => e.ch);
    expect(results).toContain('🎨');
    expect(results).toContain('❤️');
    expect(results.indexOf('🎨')).toBeLessThan(results.indexOf('❤️'));
  });

  it('respects the limit and handles empty or unknown queries', () => {
    expect(searchEmoji('heart', 3)).toHaveLength(3);
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('   ')).toEqual([]);
    expect(searchEmoji('zzqqxx')).toEqual([]);
    expect(searchEmoji('a', 0)).toEqual([]);
  });

  it('matches a pasted emoji', () => {
    expect(searchEmoji('🎉')[0]?.ch).toBe('🎉');
  });
});

describe('recent emoji', () => {
  it('records most recent first without duplicates', () => {
    noteEmoji('u1', '👍');
    noteEmoji('u1', '🎉');
    noteEmoji('u1', '👍');
    expect(recentEmoji('u1')).toEqual(['👍', '🎉']);
  });

  it('keeps at most 24', () => {
    const many = EMOJI_GROUPS.flatMap((g) => g.items).slice(0, 30).map((e) => e.ch);
    for (const ch of many) noteEmoji('u1', ch);
    const recent = recentEmoji('u1');
    expect(recent).toHaveLength(24);
    expect(recent[0]).toBe(many[29]);
  });

  it('keeps each person separate, with an anonymous bucket', () => {
    noteEmoji('u1', '👍');
    noteEmoji(null, '🎉');
    expect(recentEmoji('u2')).toEqual([]);
    expect(recentEmoji(null)).toEqual(['🎉']);
    expect(localStorage.getItem('dek.emoji.recent.u1')).toBe(JSON.stringify(['👍']));
  });

  it('survives corrupted or blocked storage', () => {
    localStorage.setItem('dek.emoji.recent.u1', '{not json');
    expect(recentEmoji('u1')).toEqual([]);
    localStorage.setItem('dek.emoji.recent.u1', JSON.stringify([1, '👍', null, '👍', '🎉']));
    expect(recentEmoji('u1')).toEqual(['👍', '🎉']);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(recentEmoji('u1')).toEqual([]);
    expect(() => noteEmoji('u1', '👍')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('EmojiPicker', () => {
  it('searches, picks and remembers the pick', () => {
    const onPick = vi.fn();
    render(createElement(EmojiPicker, { userId: 'picker', onPick }));
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'thumbs' } });
    fireEvent.click(screen.getByRole('button', { name: 'thumbs up' }));
    expect(onPick).toHaveBeenCalledWith('👍');
    expect(recentEmoji('picker')[0]).toBe('👍');
  });

  it('shows a Recent tab first when there are recents', () => {
    noteEmoji('recent-user', '🎉');
    render(createElement(EmojiPicker, { userId: 'recent-user', onPick: () => undefined }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]?.getAttribute('aria-label')).toBe('Recent');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'party popper' })).toBeTruthy();
  });

  it('switches categories and shows an empty state for no match', () => {
    render(createElement(EmojiPicker, { userId: 'cats', onPick: () => undefined }));
    fireEvent.click(screen.getByRole('tab', { name: 'Food and drink' }));
    expect(screen.getByRole('button', { name: 'pizza' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'zzqqxx' } });
    expect(screen.getByText('No emoji match')).toBeTruthy();
  });

  it('picks the first result with Enter in the search field', () => {
    const onPick = vi.fn();
    render(createElement(EmojiPicker, { userId: 'enter', onPick }));
    const input = screen.getByLabelText('Search emoji');
    fireEvent.change(input, { target: { value: 'pizza' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('🍕');
  });
});
