// The composer (DEK09): autosizing, Enter sends on desktop and makes a newline on
// phones, never sends mid-composition (IME), @ # : autocomplete, attachments
// through the media builder's extension points, per-conversation drafts, a
// length counter, and clear reasons whenever posting is not possible.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { api } from '../../api/rpc';
import type { Channel, Profile } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions, draftKey, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Banner, Button, toast } from '../../ui/kit';
import { navigate } from '../../app/router';
import { AttachmentButton, PendingUploads, useUploads } from '../media';
import { useCoarsePointer } from '../shell/layout';
import { myBlocks } from './blocks';
import { applyCompletion, decodeForEditing, encodeForSending, findTrigger, insertAt, type MentionRef, type Trigger } from './composer-text';
import { startEditing } from './editing';
import { searchEmoji } from './emoji';
import { EmojiPopover } from './EmojiPopover';
import { channelIcon, channelTitle } from './names';
import { canMentionAll, canModerate, editState, postState, type Who } from './permissions';
import { fire, run } from './safe';
import { isActive } from './time';

const MAX_LEN = 8000;
const WARN_AT = 7000;
const DRAFT_DEBOUNCE_MS = 400;
const SUGGEST_DEBOUNCE_MS = 150;

type Suggestion =
  | { kind: 'user'; key: string; id: string; label: string; sub: string | null; profile: Profile }
  | { kind: 'special'; key: string; id: 'channel' | 'here'; label: string; sub: string }
  | { kind: 'channel'; key: string; id: string; label: string; sub: string | null; channel: Channel }
  | { kind: 'emoji'; key: string; ch: string; label: string };

interface Props {
  orgId: string;
  channel: Channel;
  who: Who;
  threadRootId: string | null;
  placeholder: string;
  onSent?: () => void;
  autoFocus?: boolean;
  // Narrow places (the thread pane) skip the keyboard tip; warnings still show.
  compact?: boolean;
}

function useBlockedDm(channel: Channel): boolean {
  const [blocked, setBlocked] = useState(false);
  const other = channel.kind === 'dm' ? channel.dm_user_ids?.[0] ?? null : null;
  useEffect(() => {
    if (!other) return undefined;
    let live = true;
    void myBlocks().then((set) => { if (live) setBlocked(set.has(other)); });
    return () => { live = false; };
  }, [other]);
  return blocked;
}

export function Composer({ orgId, channel, who, threadRootId, placeholder, onSent, autoFocus, compact }: Props) {
  const key = draftKey(channel.id, threadRootId);
  const coarse = useCoarsePointer();
  const uploads = useUploads(key);
  const allowAll = canMentionAll(channel, who);
  const post = postState(channel, who, threadRootId !== null);
  const blockedByMe = useBlockedDm(channel);
  const failures = useDek((s) => s.pending);

  const [{ text, refs }, setDoc] = useState(() => {
    const st = useDek.getState();
    const draft = st.drafts[key] ?? '';
    return decodeForEditing(draft, {
      user: (id) => st.profiles[id]?.display_name ?? null,
      channel: (id) => { const c = st.channels[id]; return c ? (c.name ?? channelTitle(c, st.profiles)) : null; },
    });
  });
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const caretAfter = useRef<number | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ text, refs });
  latest.current = { text, refs };

  const body = useMemo(() => encodeForSending(text, refs, { allowAll }), [text, refs, allowAll]);
  const length = body.trim().length;

  // A send that failed for a reason that will not go away by retrying.
  const hardFailure = useMemo(() => {
    for (const p of Object.values(failures)) {
      if (p.channelId !== channel.id || p.status !== 'failed' || !p.error) continue;
      if (p.error.code === 'blocked' || p.error.code === 'suspended') return p.error.hint;
    }
    return null;
  }, [failures, channel.id]);

  const disabledReason = !post.ok ? post.reason
    : blockedByMe ? 'You blocked this person. Unblock them in Settings to send messages.'
      : hardFailure;

  // ---------------------------------------------------------------- drafts
  const flushDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const cur = latest.current;
    fire(() => actions.setDraft(key, encodeForSending(cur.text, cur.refs, { allowAll })));
  }, [key, allowAll]);

  useEffect(() => () => flushDraft(), [flushDraft]);

  const scheduleDraft = () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
  };

  // ---------------------------------------------------------------- autosize, caret
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = Math.max(120, Math.round(window.innerHeight * 0.4));
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
    if (caretAfter.current !== null) {
      ta.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (autoFocus && !coarse && !disabledReason) taRef.current?.focus({ preventScroll: true });
  }, [autoFocus, coarse, disabledReason]);

  // ---------------------------------------------------------------- autocomplete
  const updateTrigger = (value: string, caret: number) => {
    const t = findTrigger(value, caret);
    if (t && dismissed === t.start) return setTrigger(null);
    setTrigger(t);
    if (!t) setDismissed(null);
  };

  useEffect(() => {
    if (!trigger) {
      setSuggestions([]);
      return undefined;
    }
    const q = trigger.query.trim().toLowerCase();
    setActive(0);
    if (trigger.char === ':') {
      setSuggestions(searchEmoji(q, 8).map((e) => ({ kind: 'emoji', key: `e:${e.ch}`, ch: e.ch, label: e.name })));
      return undefined;
    }
    if (trigger.char === '#') {
      const st = useDek.getState();
      const list = Object.values(st.channels)
        .filter((c) => c.org_id === orgId && (c.kind === 'text' || c.kind === 'audio') && !c.archived && (c.name ?? '').toLowerCase().includes(q))
        .sort((a, b) => Number(!(a.name ?? '').toLowerCase().startsWith(q)) - Number(!(b.name ?? '').toLowerCase().startsWith(q)) || (a.name ?? '').localeCompare(b.name ?? ''))
        .slice(0, 8)
        .map<Suggestion>((c) => ({ kind: 'channel', key: `c:${c.id}`, id: c.id, label: c.name ?? '', sub: c.topic, channel: c }));
      setSuggestions(list);
      return undefined;
    }
    const specials: Suggestion[] = allowAll && channel.kind !== 'dm'
      ? (['channel', 'here'] as const)
        .filter((s) => s.startsWith(q))
        .map((s) => ({ kind: 'special', key: `s:${s}`, id: s, label: s, sub: s === 'channel' ? 'Notify everyone in this conversation' : 'Notify everyone active now' }))
      : [];
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.all([
        api.listChannelMembers(channel.id, q || null, 20).catch(() => ({ items: [] as { profile: Profile }[] })),
        api.listOrgMembers(orgId, q || null, null, 20).catch(() => ({ items: [] as { profile: Profile }[] })),
      ]).then(([inChannel, inOrg]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const people: Suggestion[] = [];
        for (const item of [...inChannel.items, ...inOrg.items]) {
          const p = item.profile;
          if (!p || p.deleted || seen.has(p.id)) continue;
          seen.add(p.id);
          people.push({ kind: 'user', key: `u:${p.id}`, id: p.id, label: p.display_name, sub: p.title ?? (p.handle ? `@${p.handle}` : null), profile: p });
        }
        setSuggestions([...people.slice(0, 8), ...specials]);
      });
    }, SUGGEST_DEBOUNCE_MS);
    setSuggestions(specials);
    return () => { cancelled = true; clearTimeout(t); };
  }, [trigger, orgId, channel.id, channel.kind, allowAll]);

  const choose = (s: Suggestion) => {
    const ta = taRef.current;
    if (!trigger || !ta) return;
    const caret = ta.selectionStart ?? text.length;
    let insert: string;
    let ref: MentionRef | null = null;
    if (s.kind === 'user') { insert = `@${s.label}`; ref = { kind: 'user', id: s.id, display: insert }; }
    else if (s.kind === 'special') { insert = `@${s.id}`; ref = { kind: 'special', id: s.id, display: insert }; }
    else if (s.kind === 'channel') { insert = `#${s.label}`; ref = { kind: 'channel', id: s.id, display: insert }; }
    else insert = s.ch;
    const next = applyCompletion(text, trigger, caret, insert);
    caretAfter.current = next.caret;
    setDoc({ text: next.text, refs: ref ? [...refs.filter((r) => r.display !== ref!.display), ref] : refs });
    setTrigger(null);
    setSuggestions([]);
    scheduleDraft();
    ta.focus();
  };

  // ---------------------------------------------------------------- send
  const send = () => {
    if (disabledReason) return;
    const trimmed = body.trim();
    if (!trimmed && uploads.readyIds.length === 0) return;
    if (uploads.busy) {
      setNotice('Wait for the attachments to finish uploading, then send.');
      return;
    }
    if (trimmed.length > MAX_LEN) {
      setNotice(`Messages can be at most ${MAX_LEN} characters. Shorten it or split it in two.`);
      return;
    }
    try {
      actions.sendMessage({
        channelId: channel.id,
        body: trimmed,
        threadRootId,
        attachmentIds: uploads.readyIds,
        alsoInChannel: threadRootId ? alsoInChannel && !(channel.posting_policy === 'admins' && !canModerate(channel, who)) : false,
      });
    } catch (e) {
      // Nothing was queued: keep every character where it is.
      setNotice(`Not sent: ${humanError(e)}`);
      return;
    }
    // The outbox has persisted the text; the box clears at once (DEK06).
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setDoc({ text: '', refs: [] });
    setTrigger(null);
    setNotice(null);
    setAlsoInChannel(false);
    fire(() => actions.setDraft(key, ''));
    uploads.clear();
    onSent?.();
  };

  const editLast = (): boolean => {
    const st = useDek.getState();
    const ids = threadRootId ? st.threads[threadRootId]?.replyIds ?? [] : st.timelines[channel.id]?.ids ?? [];
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const m = st.messages[ids[i]!];
      if (!m || m.author_id !== who.meId || m.deleted_at || m.kind !== 'user') continue;
      if (!threadRootId && m.thread_root_id) continue;
      if (editState(m, who.meId, st.org?.settings).ok) {
        startEditing(m.id);
        return true;
      }
      return false;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (suggestions.length && trigger) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !composing) { e.preventDefault(); const s = suggestions[active]; if (s) choose(s); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(trigger.start); setTrigger(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !coarse) {
      if (composing) return;
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'ArrowUp' && !text && !composing) {
      if (editLast()) e.preventDefault();
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDoc({ text: value, refs: refs.filter((r) => value.includes(r.display)) });
    setNotice(null);
    updateTrigger(value, e.target.selectionStart ?? value.length);
    scheduleDraft();
    if (value.trim()) fire(() => actions.notifyTyping(channel.id, threadRootId));
  };

  const onSelect = () => {
    const ta = taRef.current;
    if (ta) updateTrigger(ta.value, ta.selectionStart ?? ta.value.length);
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (disabledReason) {
      toast({ kind: 'error', title: 'Cannot attach here', body: disabledReason });
      return;
    }
    uploads.add(files);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const insertEmoji = (ch: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const next = insertAt(text, start, end, ch);
    caretAfter.current = next.caret;
    setDoc({ text: next.text, refs });
    scheduleDraft();
    ta?.focus();
  };

  const join = async () => {
    setJoining(true);
    try {
      await run(() => actions.joinChannel(channel.id));
      toast({ kind: 'success', title: `You joined #${channel.name ?? 'the channel'}` });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not join', body: humanError(e) });
    } finally {
      setJoining(false);
    }
  };

  // ---------------------------------------------------------------- render
  if (disabledReason) {
    return (
      <div className="dk-composer dk-composer--off" role="status">
        <Icon name={!post.ok && post.action === 'join' ? 'hash' : 'lock'} size={18} />
        <p className="dk-composer__reason">{disabledReason}</p>
        {!post.ok && post.action === 'join' ? <Button variant="primary" loading={joining} onClick={() => void join()}>Join channel</Button> : null}
        {blockedByMe ? <Button variant="secondary" onClick={() => navigate({ name: 'settings', section: 'blocked' })}>Blocked people</Button> : null}
      </div>
    );
  }

  const listId = `ac-${key}`;
  const activeSuggestion = suggestions[active];
  const over = length - MAX_LEN;
  const canSend = (length > 0 || uploads.readyIds.length > 0) && !uploads.busy && over <= 0;
  // The server refuses "also send to channel" in announcement channels unless you moderate it.
  const alsoBlocked = channel.posting_policy === 'admins' && !canModerate(channel, who);

  return (
    <div className={`dk-composer${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}>
      {suggestions.length && trigger ? (
        <ul id={listId} className="dk-ac" role="listbox" aria-label={trigger.char === '#' ? 'Channels' : trigger.char === ':' ? 'Emoji' : 'People'}>
          {suggestions.map((s, i) => (
            <li key={s.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={`dk-ac__item${i === active ? ' is-active' : ''}`}
              onPointerDown={(e) => { e.preventDefault(); choose(s); }}
              onPointerEnter={() => setActive(i)}>
              {s.kind === 'user' ? <Avatar name={s.label} path={s.profile.avatar_path} seed={s.id} size={24} active={isActive(s.profile.last_active_at)} />
                : s.kind === 'channel' ? <Icon name={channelIcon(s.channel)} size={18} />
                  : s.kind === 'emoji' ? <span className="dk-ac__emoji" aria-hidden="true">{s.ch}</span>
                    : <Icon name="megaphone" size={18} />}
              <span className="dk-ac__label">{s.kind === 'user' || s.kind === 'special' ? `@${s.label}` : s.kind === 'channel' ? `#${s.label}` : `:${s.label}:`}</span>
              {'sub' in s && s.sub ? <span className="dk-ac__sub">{s.sub}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <PendingUploads uploadKey={key} />
      {notice ? <Banner tone="warning" onClose={() => setNotice(null)}>{notice}</Banner> : null}
      <div className="dk-composer__box">
        <AttachmentButton uploadKey={key} channelId={channel.id} />
        <textarea
          ref={taRef}
          className="dk-composer__input"
          dir="auto"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-describedby={`${listId}-meta`}
          aria-autocomplete="list"
          aria-controls={suggestions.length ? listId : undefined}
          aria-expanded={suggestions.length > 0 && !!trigger}
          aria-activedescendant={suggestions.length && trigger && activeSuggestion ? `${listId}-${active}` : undefined}
          enterKeyHint={coarse ? 'enter' : 'send'}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onPaste={onPaste}
          onBlur={() => { flushDraft(); setTimeout(() => setTrigger(null), 120); }}
        />
        <button ref={emojiBtn} type="button" className="dk-composer__tool" aria-label="Insert emoji" title="Insert emoji"
          onClick={() => setEmojiOpen((o) => !o)} aria-expanded={emojiOpen}>
          <Icon name="smile" size={20} />
        </button>
        <button type="button" className="dk-composer__send" aria-label="Send message" title={coarse ? 'Send' : 'Send (Enter)'}
          disabled={!canSend} onClick={send}>
          <Icon name="send" size={18} />
        </button>
      </div>
      <div className="dk-composer__meta" id={`${listId}-meta`}>
        {threadRootId ? (
          <label className={`dk-composer__also${alsoBlocked ? ' is-disabled' : ''}`} title={alsoBlocked ? 'Only admins can post to this channel' : undefined}>
            <input type="checkbox" checked={alsoInChannel && !alsoBlocked} disabled={alsoBlocked}
              onChange={(e) => setAlsoInChannel(e.target.checked)} />
            <span>{`Also send to ${channel.kind === 'text' || channel.kind === 'audio' ? `#${channel.name ?? 'channel'}` : 'the conversation'}`}</span>
          </label>
        ) : null}
        <span className="dk-composer__hint">
          {uploads.busy ? 'Uploading. You can send when it finishes.'
            : length > WARN_AT ? (over > 0 ? `${over} characters over the limit` : `${MAX_LEN - length} characters left`)
              : coarse || compact ? '' : 'Enter to send, Shift+Enter for a new line'}
        </span>
      </div>
      <EmojiPopover open={emojiOpen} onClose={() => setEmojiOpen(false)} anchor={emojiBtn.current} onPick={insertEmoji} title="Insert emoji" />
    </div>
  );
}
