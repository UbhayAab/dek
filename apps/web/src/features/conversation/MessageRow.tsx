// One message: avatar and name (unless grouped), body, edited marker,
// attachments, reactions, thread summary, actions. Plus the pending and failed
// rows of the outbox and the in-place editor.
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Channel, Message, OrgSettings } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Button } from '../../ui/kit';
import { Markdown, toPlainText, type MdContext } from '../../ui/markdown';
import { MessageAttachments } from '../media';
import { useCoarsePointer } from '../shell/layout';
import { decodeForEditing, encodeForSending } from './composer-text';
import { stopEditing, useEditing } from './editing';
import { useMdContext } from './md';
import { MessageActions } from './MessageActions';
import { channelTitle, personName } from './names';
import { canMentionAll, canReact, postState, type Who } from './permissions';
import { Reactions } from './Reactions';
import { fire, run } from './safe';
import { fullTimeLabel, relativeLong, timeLabel } from './time';
import {useRowGestures,type ContextRequest} from '../../ui/useRowGestures';

export interface RowContext {
  orgId: string;
  channel: Channel;
  who: Who;
  settings: OrgSettings | null;
  inThread: boolean;
  onOpenThread: (rootId: string) => void;
  // One markdown context for the whole list; it resolves names lazily, and each
  // row re-renders only when the names it shows change.
  md: MdContext;
}

interface MessageRowProps {
  id: string;
  grouped: boolean;
  highlighted: boolean;
  ctx: RowContext;
  isThreadRoot?: boolean;
}

export const MessageRow = memo(function MessageRow({ id, grouped, highlighted, ctx, isThreadRoot }: MessageRowProps) {
  const m = useDek((s) => s.messages[id]);
  const author = useDek((s) => { const a = s.messages[id]?.author_id; return a ? s.profiles[a] : undefined; });
  // A primitive signature of the mentioned people's names: the row (and its
  // markdown) re-renders when one of them loads or changes, and not otherwise.
  const namesSig = useDek((s) => (s.messages[id]?.mentions ?? []).map((u) => s.profiles[u]?.display_name ?? '').join('|'));
  const editing = useEditing((s) => s.id === id);
  const md = useMemo<MdContext>(() => ({ ...ctx.md }), [ctx.md, namesSig]);
  const [contextRequest,setContextRequest]=useState<ContextRequest|null>(null);
  const gestureIdentity=[ctx.orgId,ctx.who.meId,id,m?.deleted_at,ctx.channel.member,ctx.channel.my_role,ctx.channel.posting_policy,ctx.channel.archived,ctx.channel.allow_reactions,ctx.channel.allow_replies,ctx.who.orgRole,ctx.who.server?.my_role,ctx.who.server?.archived,editing].join(':');
  const gestures=useRowGestures({identity:gestureIdentity,disabled:editing||!m,onMenu:setContextRequest});
  useEffect(()=>setContextRequest(null),[gestureIdentity]);
  useEffect(()=>{if(editing&&m&&!postState(ctx.channel,ctx.who,m.thread_root_id!==null).ok)stopEditing();},[editing,m,ctx.channel,ctx.who]);

  useEffect(() => {
    if (!m) return;
    const known = useDek.getState().profiles;
    const ids = [m.author_id, ...m.mentions, ...m.reply_user_ids.slice(0, 3)].filter((x): x is string => !!x && !known[x]);
    if (ids.length) fire(() => actions.ensureProfiles(ids));
  }, [m]);

  if (!m) return null;
  const name = m.author_id ? (author?.display_name || author?.handle || 'Someone') : 'Dek';
  const mine = !!ctx.who.meId && m.author_id === ctx.who.meId;
  const deleted = !!m.deleted_at;
  const label = `${m.kind === 'system' ? 'Dek' : name}, ${relativeLong(m.created_at)}`;

  if (m.kind === 'system') {
    return (
      <article {...gestures.handlers} tabIndex={0} aria-haspopup="menu" className={`dk-msg dk-msg--system${highlighted ? ' is-highlighted' : ''}`} aria-label={label} data-message-id={m.id}>
        <Icon name="info" size={16} />
        <div className="dk-msg__sysbody"><Markdown body={m.body} ctx={md} /></div>
        <time className="dk-msg__systime" dateTime={m.created_at} title={fullTimeLabel(m.created_at)}>{timeLabel(m.created_at)}</time>
        <MessageActions message={m} channel={ctx.channel} orgId={ctx.orgId} who={ctx.who} settings={ctx.settings} inThread={ctx.inThread} onOpenThread={()=>undefined} contextRequest={contextRequest} onDismissContext={()=>setContextRequest(null)}/>
      </article>
    );
  }

  const showThread = !ctx.inThread && m.reply_count > 0 && !m.thread_root_id;
  const root = m.also_in_channel && m.thread_root_id && !ctx.inThread ? m.thread_root_id : null;

  return (
    <article
      {...gestures.handlers} tabIndex={editing?-1:0} aria-haspopup="menu" aria-expanded={!!contextRequest}
      className={['dk-msg', grouped && 'is-grouped', mine && 'is-mine', highlighted && 'is-highlighted', deleted && 'is-deleted', editing && 'is-editing', isThreadRoot && 'is-root']
        .filter(Boolean).join(' ')}
      aria-label={label}
      data-message-id={m.id}
    >
      <div className="dk-msg__gutter">
        {grouped ? (
          <time className="dk-msg__hovertime" dateTime={m.created_at} title={fullTimeLabel(m.created_at)}>{timeLabel(m.created_at)}</time>
        ) : (
          <Avatar name={name} path={author?.avatar_path} seed={m.author_id ?? m.id} size={36} />
        )}
      </div>
      <div className="dk-msg__main">
        {!grouped ? (
          <header className="dk-msg__head">
            <span className="dk-msg__author" dir="auto">{name}</span>
            {author?.status_emoji ? <span className="dk-msg__status" title={author.status_text ?? undefined} aria-hidden="true">{author.status_emoji}</span> : null}
            <time className="dk-msg__time" dateTime={m.created_at} title={fullTimeLabel(m.created_at)}>{timeLabel(m.created_at)}</time>
            {m.pinned ? <span className="dk-msg__pinned"><Icon name="pin" size={12} />Pinned</span> : null}
          </header>
        ) : m.pinned ? <span className="dk-msg__pinned"><Icon name="pin" size={12} />Pinned</span> : null}
        {root ? <ThreadContext rootId={root} orgId={ctx.orgId} onOpen={() => ctx.onOpenThread(root)} /> : null}
        {deleted ? (
          <p className="dk-msg__tombstone">This message was deleted.</p>
        ) : editing ? (
          <InlineEditor message={m} ctx={ctx} />
        ) : (
          <div className="dk-msg__body">
            <Markdown body={m.body} ctx={md} />
            {m.edited_at ? <span className="dk-msg__edited" title={`Edited ${fullTimeLabel(m.edited_at)}`}>(edited)</span> : null}
          </div>
        )}
        {!deleted && m.attachments.length ? <MessageAttachments message={m} attachments={m.attachments} /> : null}
        {!deleted ? <Reactions message={m} meId={ctx.who.meId} canReact={canReact(ctx.channel)&&!ctx.who.server?.archived} /> : null}
        {showThread ? <ThreadSummary message={m} onOpen={() => ctx.onOpenThread(m.id)} /> : null}
        {!ctx.inThread && !m.thread_root_id && !m.reply_count && !deleted && postState(ctx.channel,ctx.who,true).ok ?
          <button type="button" className="dk-threadstart" onClick={() => ctx.onOpenThread(m.id)}><Icon name="thread" size={16} />Start thread</button> : null}
      </div>
      {!editing ? (
        <MessageActions message={m} channel={ctx.channel} orgId={ctx.orgId} who={ctx.who} settings={ctx.settings}
          inThread={ctx.inThread} onOpenThread={() => ctx.onOpenThread(m.thread_root_id??m.id)} contextRequest={contextRequest} onDismissContext={()=>setContextRequest(null)} />
      ) : null}
    </article>
  );
});

function ThreadContext({ rootId, orgId, onOpen }: { rootId: string; orgId: string; onOpen: () => void }) {
  const root = useDek((s) => s.messages[rootId]);
  const profiles = useDek((s) => s.profiles);
  const md = useMdContext(orgId);
  const snippet = root ? toPlainText(root.body, md).slice(0, 80) : null;
  return (
    <button type="button" className="dk-msg__ctx" onClick={onOpen}>
      <Icon name="reply" size={14} />
      <span className="dk-msg__ctxtext">
        {root ? `Replied to ${personName(profiles, root.author_id)}: ${snippet || 'a message'}` : 'Replied to a thread'}
      </span>
    </button>
  );
}

function ThreadSummary({ message: m, onOpen }: { message: Message; onOpen: () => void }) {
  const profiles = useDek((s) => s.profiles);
  const people = m.reply_user_ids.slice(0, 3);
  return (
    <button type="button" className="dk-threadsum" onClick={onOpen}
      aria-label={`${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}${m.last_reply_at ? `, last ${relativeLong(m.last_reply_at)}` : ''}. Open thread`}>
      <span className="dk-threadsum__avatars" aria-hidden="true">
        {people.map((u) => <Avatar key={u} name={personName(profiles, u)} path={profiles[u]?.avatar_path} seed={u} size={22} />)}
      </span>
      <span className="dk-threadsum__count">{`${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'} - Reply in thread`}</span>
      {m.last_reply_at ? <span className="dk-threadsum__last">{`Last reply ${relativeLong(m.last_reply_at)}`}</span> : null}
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

function InlineEditor({ message: m, ctx }: { message: Message; ctx: RowContext }) {
  const profiles = useDek((s) => s.profiles);
  const channels = useDek((s) => s.channels);
  const coarse = useCoarsePointer();
  const initial = useMemo(() => decodeForEditing(m.body, {
    user: (id) => profiles[id]?.display_name ?? null,
    channel: (id) => { const c = channels[id]; return c ? (c.name ?? channelTitle(c, profiles)) : null; },
    channelPeers:Object.values(channels).filter(c=>c.org_id===ctx.orgId&&!c.archived).map(c=>({id:c.id,name:c.name??channelTitle(c,profiles)})),
    channelScope:id=>{const st=useDek.getState(),sid=channels[id]?.server_id;return sid?st.servers[sid]?.name??null:null;},
  }), [m.body]);
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
  }, [text]);

  const save = async () => {
    const body = encodeForSending(text, initial.refs, { allowAll: canMentionAll(ctx.channel, ctx.who) }).trim();
    if (!body && !m.attachments.length) {
      setError('A message cannot be empty. Delete it instead.');
      return;
    }
    if (body.length > 8000) {
      setError('A message can be at most 8000 characters.');
      return;
    }
    if (body === m.body) {
      stopEditing();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(() => actions.editMessage(m.id, body));
      stopEditing();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopEditing();
    } else if (e.key === 'Enter' && !e.shiftKey && !coarse) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="dk-edit">
      <label className="sr-only" htmlFor={`edit-${m.id}`}>Edit message</label>
      <textarea id={`edit-${m.id}`} ref={ref} className="dk-edit__input" dir="auto" value={text} disabled={busy}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={1} />
      {error ? <p className="dk-edit__error" role="alert">{error}</p> : null}
      <div className="dk-edit__actions">
        <span className="dk-edit__hint">{coarse ? '' : 'Enter to save, Escape to cancel'}</span>
        <Button variant="ghost" onClick={stopEditing} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} loading={busy}>Save</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pending row

const SHOW_PENDING_AFTER_MS = 900;

export const PendingRow = memo(function PendingRow({ clientId, grouped, orgId }: { clientId: string; grouped: boolean; orgId: string }) {
  const p = useDek((s) => s.pending[clientId]);
  const me = useDek((s) => s.me?.profile ?? null);
  const meId = useDek((s) => s.session.userId);
  const md = useMdContext(orgId);
  const [late, setLate] = useState(() => (p ? Date.now() - p.createdAt >= SHOW_PENDING_AFTER_MS : false));

  useEffect(() => {
    if (!p || late) return undefined;
    const t = setTimeout(() => setLate(true), Math.max(0, SHOW_PENDING_AFTER_MS - (Date.now() - p.createdAt)));
    return () => clearTimeout(t);
  }, [p, late]);

  if (!p) return null;
  const failed = p.status === 'failed';
  // The outbox decides when delivery state is worth showing (after 900 ms, or at
  // once for a failure); the local timer is the fallback.
  const showState = failed || p.statusVisible || late;
  const name = me?.display_name ?? 'You';
  return (
    <article className={['dk-msg', 'is-mine', 'is-pending', grouped && 'is-grouped', showState && 'is-late', failed && 'is-failed'].filter(Boolean).join(' ')}
      aria-label={`${name}, ${failed ? 'not sent' : 'sending'}`}>
      <div className="dk-msg__gutter">
        {grouped ? null : <Avatar name={name} path={me?.avatar_path} seed={meId ?? name} size={36} />}
      </div>
      <div className="dk-msg__main">
        {!grouped ? (
          <header className="dk-msg__head">
            <span className="dk-msg__author">{name}</span>
          </header>
        ) : null}
        <div className="dk-msg__body"><Markdown body={p.body} ctx={md} /></div>
        {p.attachmentIds.length ? <p className="dk-msg__pendingfiles">{`${p.attachmentIds.length} attachment${p.attachmentIds.length === 1 ? '' : 's'}`}</p> : null}
        {failed ? (
          <div className="dk-msg__failed" role="alert">
            <Icon name="alert" size={16} />
            <span className="dk-msg__failtext">{`Not sent. ${p.error?.hint ?? 'Something went wrong.'}`}</span>
            <span className="dk-msg__failactions">
              <Button size="md" variant="secondary" icon="refresh" onClick={() => fire(() => actions.retrySend(p.clientId))}>Retry</Button>
              <Button size="md" variant="ghost" icon="trash" onClick={() => fire(() => actions.discardPending(p.clientId))}>Delete</Button>
            </span>
          </div>
        ) : showState ? (
          <p className="dk-msg__sending" role="status">
            <Icon name="clock" size={14} />
            {p.status === 'retrying' ? `Retrying${p.attempts > 1 ? ` (attempt ${p.attempts})` : ''}. It will send when the connection allows.` : 'Sending'}
          </p>
        ) : null}
      </div>
    </article>
  );
});
