// Every action on a message. Desktop: a hover toolbar (quick reactions, picker,
// reply, more). Everywhere: a visible "more" button opening the kit Menu, which
// is an action sheet on touch (long press is unreliable on iOS).
import { useRef, useState } from 'react';
import type { Channel, Message, OrgSettings } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { ConfirmDialog, Menu, toast, type MenuItem } from '../../ui/kit';
import { markSaved, useUi } from '../shell/ui-store';
import { useCoarsePointer } from '../shell/layout';
import { decodeForEditing } from './composer-text';
import { startEditing } from './editing';
import { QUICK_REACTIONS } from './emoji';
import { EmojiPopover } from './EmojiPopover';
import { messageUrl } from './jump';
import { channelTitle } from './names';
import { canDelete, canModerate, canPin, canReact, canReply, editState, type Who } from './permissions';
import { react } from './Reactions';
import { ReportDialog } from './ReportDialog';
import { copyText, run } from './safe';

interface Props {
  message: Message;
  channel: Channel;
  orgId: string;
  who: Who;
  settings: OrgSettings | null;
  inThread: boolean;
  onOpenThread: () => void;
}

export function MessageActions({ message: m, channel, orgId, who, settings, inThread, onOpenThread }: Props) {
  const coarse = useCoarsePointer();
  const authorName = useDek((s) => (m.author_id ? s.profiles[m.author_id]?.display_name ?? null : null));
  const saved = useUi((s) => !!s.saved[m.id]);
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [up, setUp] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  // Menus open upward in the lower half of the screen so the list cannot clip them.
  const aim = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setUp(r.top > window.innerHeight * 0.5);
  };

  const mine = !!who.meId && m.author_id === who.meId;
  const moderator = canModerate(channel, who);
  const reactOk = canReact(channel);
  const replyOk = !inThread && !m.thread_root_id && canReply(channel) && !m.deleted_at;
  const edit = editState(m, who.meId, settings);
  const author = authorName ?? 'Someone';

  const copy = async (what: 'text' | 'link') => {
    try {
      if (what === 'text') {
        const st = useDek.getState();
        const { text } = decodeForEditing(m.body, {
          user: (id) => st.profiles[id]?.display_name ?? null,
          channel: (id) => { const c = st.channels[id]; return c ? (c.name ?? channelTitle(c, st.profiles)) : null; },
        });
        await copyText(text);
      } else {
        await copyText(messageUrl(orgId, m));
      }
      toast({ kind: 'success', title: what === 'text' ? 'Text copied' : 'Link copied' });
    } catch {
      toast({ kind: 'error', title: 'Could not copy', body: 'Your browser blocked the clipboard. Select the text and copy it instead.' });
    }
  };

  const pin = () => {
    run(() => actions.pinMessage(m.id, !m.pinned))
      .then(() => toast({ kind: 'success', title: m.pinned ? 'Unpinned' : 'Pinned to this conversation' }))
      .catch((e: unknown) => toast({ kind: 'error', title: m.pinned ? 'Not unpinned' : 'Not pinned', body: humanError(e) }));
  };

  const save = () => {
    const next = !saved;
    run(() => actions.saveMessage(m.id, next))
      .then(() => {
        markSaved([m.id], next);
        toast({ kind: 'success', title: next ? 'Saved' : 'Removed from saved', body: next ? 'Find it under Saved.' : undefined });
      })
      .catch((e: unknown) => toast({ kind: 'error', title: next ? 'Not saved' : 'Still saved', body: humanError(e) }));
  };

  const markUnread = () => {
    run(() => actions.markUnread(m.channel_id, m.seq))
      .then(() => toast({ kind: 'success', title: 'Marked unread from here' }))
      .catch((e: unknown) => toast({ kind: 'error', title: 'Not marked unread', body: humanError(e) }));
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await run(() => actions.deleteMessage(m.id));
      setConfirmDelete(false);
      toast({ kind: 'success', title: 'Message deleted' });
    } catch (e) {
      toast({ kind: 'error', title: 'Message not deleted', body: humanError(e) });
    } finally {
      setDeleting(false);
    }
  };

  const items: MenuItem[] = [];
  if (reactOk && !m.deleted_at) items.push({ label: 'Add reaction', icon: 'smile', onSelect: () => setPicker(true) });
  if (replyOk) items.push({ label: 'Reply in thread', icon: 'thread', onSelect: onOpenThread });
  if (!m.deleted_at) items.push({ label: 'Copy text', icon: 'copy', onSelect: () => void copy('text') });
  items.push({ label: 'Copy link', icon: 'share', onSelect: () => void copy('link') });
  if (mine && !m.deleted_at) {
    items.push(edit.ok
      ? { label: 'Edit message', icon: 'edit', onSelect: () => startEditing(m.id) }
      : { label: 'Edit (time limit passed)', icon: 'edit', disabled: true, onSelect: () => undefined });
  }
  if (canPin(channel, who) && !m.deleted_at && m.kind === 'user') {
    items.push({ label: m.pinned ? 'Unpin' : 'Pin to conversation', icon: 'pin', onSelect: pin });
  }
  if (!m.deleted_at) items.push({ label: saved ? 'Remove from saved' : 'Save for later', icon: 'bookmark', onSelect: save });
  if (!inThread && !m.thread_root_id && channel.member) items.push({ label: 'Mark unread from here', icon: 'inbox', onSelect: markUnread });
  if (canDelete(m, who.meId, moderator)) items.push({ label: 'Delete message', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) });
  if (!mine && m.kind === 'user' && !m.deleted_at && m.author_id) items.push({ label: 'Report message', icon: 'flag', danger: true, onSelect: () => setReporting(true) });

  return (
    <div className={`dk-msgactions${coarse ? ' is-touch' : ''}${up ? ' is-up' : ''}`} ref={anchorRef} onPointerEnter={aim} onFocus={aim}>
      {!coarse && reactOk && !m.deleted_at ? (
        <div className="dk-msgactions__bar" role="toolbar" aria-label="Message actions">
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} type="button" tabIndex={-1} className="dk-msgactions__btn" aria-label={`React with ${e}`} title={`React with ${e}`} onClick={() => react(m.id, e)}>
              <span aria-hidden="true">{e}</span>
            </button>
          ))}
          <button type="button" tabIndex={-1} className="dk-msgactions__btn" aria-label="Add reaction" title="Add reaction" onClick={() => setPicker(true)}>
            <Icon name="smile" size={18} />
          </button>
          {replyOk ? (
            <button type="button" tabIndex={-1} className="dk-msgactions__btn" aria-label="Reply in thread" title="Reply in thread" onClick={onOpenThread}>
              <Icon name="thread" size={18} />
            </button>
          ) : null}
          <Menu label="More message actions" items={items} />
        </div>
      ) : (
        <div className="dk-msgactions__more">
          <Menu label="Message actions" items={items} />
        </div>
      )}
      <EmojiPopover open={picker} onClose={() => setPicker(false)} anchor={anchorRef.current} onPick={(ch) => react(m.id, ch)} />
      {confirmDelete ? (
        <ConfirmDialog
          open
          title="Delete this message?"
          body={mine
            ? 'It is removed for everyone in this conversation. This cannot be undone.'
            : `You are deleting a message from ${author} as a moderator. It is removed for everyone and kept in the audit log for review.`}
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={() => void remove()}
          onCancel={() => { if (!deleting) setConfirmDelete(false); }}
        />
      ) : null}
      {reporting ? <ReportDialog open orgId={orgId} messageId={m.id} authorName={author} onClose={() => setReporting(false)} /> : null}
    </div>
  );
}
