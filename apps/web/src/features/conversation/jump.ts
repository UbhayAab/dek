// Where a message lives: its channel with the message highlighted, or its thread
// with the reply highlighted (DEK18 deep links, search and view jumps).
import type { Message } from '../../api/types';
import { channelRoute, href, navigate, navigateDeeper, type Route } from '../../app/router';

export function messageRoute(orgId: string, m: Pick<Message, 'id' | 'channel_id' | 'thread_root_id'>): Route {
  if (m.thread_root_id) return channelRoute(orgId, m.channel_id, { threadId: m.thread_root_id, threadMessageId: m.id });
  return channelRoute(orgId, m.channel_id, { messageId: m.id });
}

export function messageUrl(orgId: string, m: Pick<Message, 'id' | 'channel_id' | 'thread_root_id'>): string {
  return `${window.location.origin}${href(messageRoute(orgId, m))}`;
}

// From a list screen: deeper on phones (so back returns to the list), plain on desktop.
export function openMessage(orgId: string, m: Pick<Message, 'id' | 'channel_id' | 'thread_root_id'>, deeper: boolean): void {
  const to = messageRoute(orgId, m);
  if (deeper) navigateDeeper(to);
  else navigate(to);
}

export function openThread(orgId: string, channelId: string, rootId: string, deeper: boolean): void {
  const to = channelRoute(orgId, channelId, { threadId: rootId });
  if (deeper) navigateDeeper(to);
  else navigate(to);
}
