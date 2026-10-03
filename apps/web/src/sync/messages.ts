// Message actions other than sending. Each resolves only after the server
// confirmed (no success before persistence) and throws a DekError the screen shows.
import { api } from '../api/rpc';
import { DekError } from '../api/errors';
import type { Message } from '../api/types';
import { getState, setState } from '../store/state';
import { applyUpdatedMessage, newer } from './reducers';
import { scheduleCacheWrite } from './channels';

function put(msg: Message): void {
  const s = getState();
  const patch = applyUpdatedMessage(s, msg);
  if (patch) setState(patch);
  else if (newer(s.messages[msg.id], msg)) setState({ messages: { ...s.messages, [msg.id]: msg } });
  scheduleCacheWrite(msg.channel_id);
}

export async function editMessage(messageId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new DekError('invalid_input', 'A message cannot be empty. Delete it instead.');
  put(await api.editMessage(messageId, text));
}

export async function deleteMessage(messageId: string): Promise<void> {
  put(await api.deleteMessage(messageId));
}

// Optimistic: the reaction shows at once and is put back if the server says no.
export async function toggleReaction(messageId: string, emoji: string): Promise<void> {
  const s = getState();
  const me = s.session.userId;
  const msg = s.messages[messageId];
  if (!me || !msg) throw new DekError('not_found');
  const users = msg.reactions[emoji] ?? [];
  const on = !users.includes(me);
  const optimistic: Record<string, string[]> = { ...msg.reactions };
  if (on) optimistic[emoji] = [...users, me];
  else {
    const rest = users.filter((u) => u !== me);
    if (rest.length) optimistic[emoji] = rest;
    else delete optimistic[emoji];
  }
  setState({ messages: { ...s.messages, [messageId]: { ...msg, reactions: optimistic } } });
  try {
    const r = await api.toggleReaction(messageId, emoji, on);
    const now = getState();
    const cur = now.messages[messageId];
    if (cur) setState({ messages: { ...now.messages, [messageId]: { ...cur, reactions: r.reactions } } });
  } catch (e) {
    const now = getState();
    const cur = now.messages[messageId];
    if (cur) setState({ messages: { ...now.messages, [messageId]: { ...cur, reactions: msg.reactions } } });
    throw e;
  }
}

export async function pinMessage(messageId: string, pinned: boolean): Promise<void> {
  const r = await api.pinMessage(messageId, pinned);
  const s = getState();
  const cur = s.messages[messageId];
  if (cur) setState({ messages: { ...s.messages, [messageId]: { ...cur, pinned: r.pinned } } });
}

// Saving is in ./saved.ts (setSaved): optimistic, with the store kept current.
