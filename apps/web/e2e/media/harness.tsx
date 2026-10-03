// A small test page for the media and calls components, used by the end-to-end
// tests while the full app shell is still being assembled. It boots exactly the
// way the app does where it matters to media and calls: the real API wrappers,
// the real realtime hub (platform builder) with the bootstrap topics, store.calls
// filled from call.ring and call.upd, and the real components (AttachmentButton,
// PendingUploads, MessageAttachments, CallButton, CallLayer, AudioRoomPanel).
// Served by Vite at /e2e/media/harness.html. Never part of a build.
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/tokens.css';
import '../../src/ui/base.css';
import { supabase } from '../../src/api/client';
import { api } from '../../src/api/rpc';
import type { Call, Message } from '../../src/api/types';
import { hub } from '../../src/realtime/hub';
import { getState, setState, useDek } from '../../src/store';
import { Button, Toaster } from '../../src/ui/kit';
import { AttachmentButton, MessageAttachments, PendingUploads, useUploads } from '../../src/features/media';
import { uploader, urlCache } from '../../src/features/media/hooks';
import { finalizeUpload, putObject, accessToken } from '../../src/features/media/transfer';
import { mintSignedUrls } from '../../src/features/media/sign';
import { AudioRoomPanel, CallButton, CallLayer, callEngine } from '../../src/features/calls';

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

const messageListeners = new Set<(m: Message) => void>();

async function boot(email: string, password: string, orgSlug = 'dek-qa'): Promise<{ userId: string; orgId: string }> {
  const { error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in failed: ${error.message}`);
  const me = await api.me();
  const org = me.orgs.find((o) => o.slug === orgSlug) ?? me.orgs[0];
  if (!org) throw new Error('no organization');
  const b = await api.bootstrap(org.id);
  setState({
    session: { ...getState().session, status: 'signed_in', userId: me.user_id, email: me.email },
    me, orgs: me.orgs, orgId: org.id, org: b.org,
    servers: byId(b.servers), channels: byId(b.channels), profiles: byId(b.profiles), topics: b.topics,
  });
  hub.setIdentity(me.user_id);
  hub.onEvent((e) => {
    if (e.event === 'call.ring' || e.event === 'call.upd') {
      const call = e.payload.call as Call;
      setState((s) => ({ calls: { ...s.calls, [call.id]: call } }));
    } else if (e.event === 'msg.new' || e.event === 'msg.upd') {
      for (const l of messageListeners) l(e.payload.message);
    }
  });
  hub.start();
  hub.setTopics(b.topics);
  return { userId: me.user_id, orgId: org.id };
}

function Conversation({ channelId }: { channelId: string }) {
  const channel = useDek((s) => s.channels[channelId]);
  const profiles = useDek((s) => s.profiles);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const key = channelId;
  const uploads = useUploads(key);

  const upsert = useCallback((m: Message) => {
    if (m.channel_id !== channelId || m.thread_root_id) return;
    setMessages((list) => {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const next = list.slice();
        next[i] = m;
        return next;
      }
      return [...list, m].sort((a, b) => a.seq - b.seq).slice(-30);
    });
  }, [channelId]);

  useEffect(() => {
    let alive = true;
    api.listMessages(channelId, null, 30).then((p) => { if (alive) setMessages(p.messages); }).catch(() => undefined);
    messageListeners.add(upsert);
    hub.joinView(channelId);
    return () => {
      alive = false;
      messageListeners.delete(upsert);
      hub.leaveView(channelId);
    };
  }, [channelId, upsert]);

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      const m = await api.sendMessage({ channel: channelId, clientId: crypto.randomUUID(), body: draft, attachmentIds: uploads.readyIds });
      upsert(m);
      setDraft('');
      uploads.clear();
    } catch (e) {
      setSendError((e as { hint?: string }).hint ?? 'Not sent. Your text is kept.');
    } finally {
      setSending(false);
    }
  };

  if (!channel) return <p>Unknown channel</p>;
  const title = channel.kind === 'dm' ? 'Direct message' : `#${channel.name}`;
  return (
    <section className="hx-conv" aria-label="Conversation">
      <header className="hx-head">
        <h1>{title}</h1>
        <CallButton channelId={channelId} />
      </header>
      {channel.kind === 'audio' ? <AudioRoomPanel channelId={channelId} /> : null}
      <ol className="hx-list" aria-label="Messages">
        {messages.filter((m) => m.attachments.length || m.body).slice(-8).map((m) => (
          <li key={m.id} className="hx-msg" data-message-id={m.id}>
            <strong>{(m.author_id && profiles[m.author_id]?.display_name) || 'Someone'}</strong>
            {m.body ? <p dir="auto">{m.body}</p> : null}
            {m.attachments.length ? <MessageAttachments message={m} attachments={m.attachments} /> : null}
          </li>
        ))}
      </ol>
      {channel.kind !== 'audio' ? (
        <div className="hx-composer">
          <PendingUploads uploadKey={key} />
          <div className="hx-row">
            <AttachmentButton uploadKey={key} channelId={channelId} />
            <label className="sr-only" htmlFor="hx-draft">Message</label>
            <textarea id="hx-draft" dir="auto" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Write a message" />
            <Button variant="primary" onClick={() => { void send(); }} loading={sending}
              disabled={uploads.busy || (!draft.trim() && uploads.readyIds.length === 0)}>Send</Button>
          </div>
          {uploads.busy ? <p className="hx-note">Uploading. You can send when it finishes.</p> : null}
          {sendError ? <p role="alert">{sendError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function Page() {
  const signedIn = useDek((s) => s.session.status === 'signed_in');
  const [channelId, setChannelId] = useState(() => new URLSearchParams(window.location.search).get('c'));
  useEffect(() => {
    const onPop = () => setChannelId(new URLSearchParams(window.location.search).get('c'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return (
    <>
      <main className="hx-main">
        {!signedIn ? <p>Signing in</p> : channelId ? <Conversation key={channelId} channelId={channelId} /> : <p>Pick a channel</p>}
      </main>
      <CallLayer />
      <Toaster />
    </>
  );
}

const style = document.createElement('style');
style.textContent = `
  #root { overflow: hidden; }
  .hx-main { height: 100%; overflow-y: auto; padding: 12px 16px 24px; }
  .hx-conv { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .hx-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; border-bottom: 1px solid var(--border); }
  .hx-head h1 { font-size: 18px; line-height: 24px; }
  .hx-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .hx-msg { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .hx-composer { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .hx-row { display: flex; align-items: flex-end; gap: 8px; }
  .hx-row textarea { flex: 1; min-width: 0; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg); color: var(--fg); }
  .hx-note { font-size: 13px; color: var(--fg-subtle); }
`;
document.head.appendChild(style);

const w = window as unknown as Record<string, unknown>;
w.__media = {
  boot,
  callEngine,
  uploader,
  urlCache,
  api,
  hub,
  getState,
  supabase,
  // Lower-level pieces, so a test can play a client that skips the browser-side
  // checks and prove the server still refuses (DEKA11).
  raw: { putObject, finalizeUpload, accessToken, mintSignedUrls },
  stats: () => callEngine.stats(),
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><Page /></StrictMode>);
