// Threads - the feature the whole product is organised around.
//
// The Slack contract: replying to a message does NOT disturb the channel. The
// reply goes into a side panel attached to that message, and only the people who
// opted in see it. The escape hatch is the "Also send to #channel" checkbox,
// which puts that single reply back into the main flow. That checkbox is the
// difference between a thread people use and a thread people fear.
import { api } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, el, esc, plain, relTime } from '../util.js';
import { registerPanel, openPanel, closePanel, toast, confirmModal, formModal, currentPanel } from '../ui.js';
import { buildMessage, appendMessage, loadReactions, claimMessage,
  refreshThreadIndicator, avatarHtml, renderedIn, atBottom } from './messages.js';
import { bindAutocomplete, mentionScope } from './composer.js';

export const threadState = { id: null, root: null, following: false, maxSeq: 0 };

// ------------------------------------------------------------------ open
export async function openThread(rootMessage) {
  let t = store.rootThreads.get(rootMessage.id);
  if (!t) {
    // Threads are created lazily: the first reply mints one.
    try {
      const data = await api.createThread(rootMessage.id, null);
      t = { threadId: data.id, count: data.reply_count || 0 };
      store.rootThreads.set(rootMessage.id, t);
      refreshThreadIndicator(rootMessage.id);
    } catch (e) {
      toast(e.message || 'Could not open thread', 'error');
      return;
    }
  }
  threadState.id = t.threadId;
  threadState.root = rootMessage;
  await openPanel('thread', { threadId: t.threadId, root: rootMessage });
  bus.emit('thread:open', { threadId: t.threadId, root: rootMessage });
}

// Thread replies arrive on the CHANNEL topic, because nothing anywhere in the
// server ever emits to `th:` - the subscription that used to be here was to a
// topic no publisher has ever written to, so a reply appeared live only for the
// person who typed it while the indicator said "3 replies" over a panel showing
// two. Core already forwards every arriving message (live or healed) as
// 'message:new'; that is the real feed, so listen to it. This also gives back
// one of the hundred realtime channels per thread opened.
bus.on('message:new', ({ msg }) => {
  if (!msg || !threadState.id || msg.thread_id !== threadState.id) return;
  const host = $('threadMsgs');
  // Same reason as the channel side: an also-send reply is claimed by whichever
  // container saw it first, so the panel asks itself.
  if (!host || renderedIn(host, msg.id)) return;
  store.seen.add(msg.id);
  // The panel is its own scroll container and had no at-bottom test at all, so a
  // reply arriving while you read back through a long thread threw you to the
  // end of it. Same contract as the channel: only follow a reader who was
  // already on the last reply.
  const stick = atBottom(host, 80);
  appendMessage(host, msg, 'thread');
  if (stick) host.scrollTop = host.scrollHeight;
  threadState.maxSeq = Math.max(threadState.maxSeq, msg.seq || 0);
  api.markThreadRead(threadState.id, threadState.maxSeq).catch(() => {});
});

// ------------------------------------------------------------------ the panel
registerPanel({
  id: 'thread',
  title: 'Thread',
  onClose() {
    threadState.id = null;
    threadState.root = null;
  },
  async render(body, ctx) {
    const threadId = ctx.threadId || threadState.id;
    const root = ctx.root || threadState.root;
    if (!threadId) { body.innerHTML = '<div class="empty">No thread open</div>'; return; }

    body.innerHTML = '';
    const head = el('div', 'thread-head');
    head.innerHTML = `
      <div class="thread-chan muted">in #${esc(store.current?.name || '')}</div>
      <div class="thread-tools">
        <button class="ghost sm" data-a="follow">Follow</button>
        <button class="ghost sm" data-a="promote" title="Turn this thread into its own channel">Promote</button>
      </div>`;
    body.appendChild(head);

    const list = el('div', 'thread-msgs');
    list.id = 'threadMsgs';
    body.appendChild(list);

    if (root) {
      const rootRow = buildMessage(root, { context: 'thread' });
      rootRow.classList.add('thread-root');
      list.appendChild(rootRow);
      list.appendChild(el('div', 'thread-sep', '<span></span>'));
    }

    let msgs = [];
    let loaded = false;
    try { msgs = (await api.threadMessages(threadId)) || []; loaded = true; }
    catch (e) { list.appendChild(el('div', 'muted pad', esc(e.message))); }

    const replies = msgs.filter((m) => !root || m.id !== root.id);

    // Opening the thread is the one moment the true count is in our hands, so it
    // is where a badge that has drifted gets repaired. Only ever from a load that
    // actually succeeded: the catch above leaves msgs empty, and treating that as
    // "zero replies" would wipe a correct badge every time the connection
    // hiccupped. Not applied at the 500-row page limit either, where the answer
    // would be "500" rather than the truth.
    if (loaded && root && msgs.length < 500) {
      const t = store.rootThreads.get(root.id);
      if (t && t.count !== replies.length) {
        t.count = replies.length;
        refreshThreadIndicator(root.id);
      }
    }
    if (!replies.length) {
      list.appendChild(el('div', 'empty', 'No replies yet. Say something - only people following this thread get notified.'));
    }
    for (const m of replies) {
      claimMessage(m);
      appendMessage(list, m, 'thread');
      threadState.maxSeq = Math.max(threadState.maxSeq, m.seq || 0);
    }
    await loadReactions(replies.map((m) => m.id));
    list.scrollTop = list.scrollHeight;

    // read state for the thread, so the Threads view can show unread counts
    if (threadState.maxSeq) api.markThreadRead(threadId, threadState.maxSeq).catch(() => {});

    const followBtn = head.querySelector('[data-a="follow"]');
    const paintFollow = () => {
      followBtn.textContent = threadState.following ? 'Following' : 'Follow';
      followBtn.classList.toggle('on', threadState.following);
    };
    // Anyone who replies is auto-followed server-side; assume followed if I have a reply here.
    threadState.following = replies.some((m) => m.author_id === store.me);
    paintFollow();
    followBtn.onclick = async () => {
      try {
        if (threadState.following) await api.unfollowThread(threadId);
        else await api.followThread(threadId);
        threadState.following = !threadState.following;
        paintFollow();
      } catch (e) { toast(e.message, 'error'); }
    };

    head.querySelector('[data-a="promote"]').onclick = async () => {
      const out = await formModal({
        title: 'Promote thread to a channel',
        note: 'This thread outgrew a side conversation. Give it a home.',
        fields: [{ name: 'name', label: 'New channel name', required: true, placeholder: 'design-review' }],
        submitLabel: 'Create channel',
      });
      if (!out) return;
      try {
        await api.promoteThread(threadId, out.name.trim().toLowerCase().replace(/\s+/g, '-'));
        toast('Promoted to #' + out.name);
        bus.emit('channels:reload');
        closePanel();
      } catch (e) { toast(e.message, 'error'); }
    };
  },

  footer(foot, ctx) {
    const threadId = ctx.threadId || threadState.id;
    foot.innerHTML = `
      <div class="thread-composer">
        <!-- The picker's own popup, inside this box rather than the channel's.
             .acpop is absolutely positioned, so reusing the channel's #acPop
             would have drawn the dropdown above the CHANNEL composer at the
             bottom of the screen while you typed over here. -->
        <div id="threadAcPop" class="acpop hidden"></div>
        <textarea id="threadComposer" rows="1" placeholder="Reply in thread"></textarea>
        <div class="thread-composer-row">
          <label class="alsosend" title="Post this reply into the channel as well, so people not in the thread see it">
            <input type="checkbox" id="alsoSend"> <span>Also send to <b>#${esc(store.current?.name || 'channel')}</b></span>
          </label>
          <button id="threadSend" class="sm">Reply</button>
        </div>
      </div>`;
    const ta = foot.querySelector('#threadComposer');
    const alsoSend = foot.querySelector('#alsoSend');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
    ta.addEventListener('input', grow);

    // "I am not able to tag people when I am within a reply thread."
    //
    // Nothing was broken - the picker had simply never been told this box
    // exists. It read one hardcoded #composer and was wired once at boot to the
    // channel box; this textarea is built fresh on every thread open. Same
    // engine, same keys, same @people / #channels / :emoji.
    //
    // ui.js wipes #panelFooter on every openPanel, so the listeners die with the
    // node - but detach explicitly anyway, because the picker holds a reference
    // to whichever box it is serving and a stale one would keep this whole
    // subtree alive.
    const unbindAc = bindAutocomplete(ta, foot.querySelector('#threadAcPop'));
    ctx.onTeardown = unbindAc;

    const doSend = async () => {
      const text = ta.value.trim();
      if (!text || !threadId || !store.current) return;
      ta.value = '';
      grow();
      const also = alsoSend.checked;
      alsoSend.checked = false;
      const nonce = crypto.randomUUID();
      store.seen.add('n:' + nonce);
      try {
        const data = await api.send({
          channel: store.current.id,
          nonce,
          text,
          mentions: bus.resolveMentions ? bus.resolveMentions(text) : [],
          // WITHOUT THIS, @channel and @here typed in a thread reply were sent
          // with scope 'none' - api.send defaults it - so they looked like they
          // had worked and notified nobody. The channel composer has always
          // passed it; this call was written without it.
          mentionScope: mentionScope(text),
          thread: threadId,
          alsoSend: also,
        });
        // Render my own reply immediately. Each container decides for itself
        // whether it already holds this message - the shared claim gate cannot,
        // because an also-send reply belongs in the thread AND the channel and
        // whichever path ran first would swallow the other.
        store.seen.delete('n:' + nonce);
        if (data) store.seen.add(data.id);
        const host = $('threadMsgs');
        if (host && data && !renderedIn(host, data.id)) {
          appendMessage(host, data, 'thread');
          host.scrollTop = host.scrollHeight;
        }
        // NOT counted here. The reply's own realtime echo comes back to its
        // sender (broadcast self is on) and channels.js applyIncoming() counts it
        // there, for every client including this one. Counting locally as well is
        // what made the badge read double for whoever wrote the replies: two
        // replies showed four, which is the number both organisations reported.
        // One increment per delivered message, in one place, and applyEvents()
        // covers the echo the transport drops.

        // "Also send to channel" has to put the message in the channel for the
        // SENDER too. claimMessage() above already registered this id on behalf
        // of the thread panel, so the realtime echo that normally paints the
        // channel copy is deduped away and the author is the one person who
        // never sees their own broadcast. Everyone else saw it, which is why
        // this looked like it worked from the outside.
        if (also && data && store.current && data.channel_id === store.current.id) {
          const list = $('messages');
          if (list && !renderedIn(list, data.id)) {
            appendMessage(list, data, 'channel');
            list.scrollTop = list.scrollHeight;
          }
        }
      } catch (e) {
        toast(e.message || 'Reply failed', 'error');
        ta.value = text;
      }
    };

    ta.addEventListener('keydown', (e) => {
      // The mention picker runs first and calls preventDefault when it consumes
      // a key. Without this check, Enter while the dropdown is open SENDS the
      // half-typed "@meh" instead of completing it to "@mehak_k1" - which is
      // the same complaint in a new place, so it is asserted in
      // scripts/probe-threadmention.mjs rather than left to review.
      if (e.defaultPrevented) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    foot.querySelector('#threadSend').onclick = doSend;
    setTimeout(() => ta.focus(), 40);
  },
});

// ------------------------------------------------------------------ Threads view
// Slack's "Threads" item: every thread you are part of across the workspace.
registerPanel({
  id: 'threads-list',
  title: 'Threads',
  async render(body) {
    body.innerHTML = '<div class="muted pad">loading…</div>';
    let rows = [];
    try { rows = (await api.listThreads(store.ws.id, 60)) || []; }
    catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!rows.length) {
      body.innerHTML = '<div class="empty">No threads yet. Reply to a message to start one - it stays out of the channel until you say otherwise.</div>';
      return;
    }
    body.innerHTML = '';
    for (const t of rows) {
      const card = el('div', 'thread-card' + (t.unread_count > 0 ? ' unread' : ''));
      card.innerHTML = `
        <div class="tc-head">
          <span class="muted">#${esc(t.channel_name || '')}</span>
          ${t.unread_count > 0 ? `<span class="badge">${t.unread_count}</span>` : ''}
          <span class="muted tc-time">${esc(relTime(t.last_message_at || t.created_at))}</span>
        </div>
        <div class="tc-root">${avatarHtml(t.root_author_id, 20)}
          <b>${esc(nameOf(t.root_author_id))}</b>
          <span>${esc(plain(t.root_body_text, 110))}</span></div>
        <div class="muted tc-foot">${t.reply_count || 0} ${t.reply_count === 1 ? 'reply' : 'replies'}</div>`;
      card.onclick = () => bus.emit('thread:openById', {
        threadId: t.thread_id, channelId: t.channel_id, rootMessageId: t.root_message_id,
      });
      body.appendChild(card);
    }
  },
});

bus.on('thread:request', ({ message }) => openThread(message));
