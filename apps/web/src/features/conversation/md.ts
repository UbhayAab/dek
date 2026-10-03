// The markdown renderer is store-agnostic; this hook gives it names, links and
// navigation from the current store and router.
import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import { channelRoute, href, navigate } from '../../app/router';
import { getState, useDek } from '../../store';
import type { MdContext } from '../../ui/markdown';
import { channelTitle } from './names';

export function useMdContext(orgId: string | null, highlight?: string[]): MdContext {
  const meId = useDek((s) => s.session.userId ?? s.me?.user_id ?? null);
  const profiles = useDek((s) => s.profiles);
  const channels = useDek((s) => s.channels);
  return useMemo<MdContext>(() => ({
    meId,
    highlight,
    userName: (id) => profiles[id]?.display_name ?? null,
    channelName: (id) => {
      const c = channels[id];
      if (!c) return null;
      return c.kind === 'text' || c.kind === 'audio' ? c.name : channelTitle(c, profiles);
    },
    channelHref: (id) => (orgId ? href(channelRoute(orgId, id)) : null),
    onChannelLink: (id: string, e: MouseEvent<HTMLAnchorElement>) => {
      if (!orgId || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(channelRoute(orgId, id));
    },
  }), [meId, profiles, channels, orgId, highlight]);
}

// For long lists (the message list, a thread): one context whose resolvers read
// the store when called, so its identity changes only with the organization.
// Rows decide when to re-render (see MessageRow's name signature).
export function lazyMdContext(orgId: string, meId: string | null): MdContext {
  return {
    meId,
    userName: (id) => getState().profiles[id]?.display_name ?? null,
    channelName: (id) => {
      const st = getState();
      const c = st.channels[id];
      if (!c) return null;
      return c.kind === 'text' || c.kind === 'audio' ? c.name : channelTitle(c, st.profiles);
    },
    channelHref: (id) => href(channelRoute(orgId, id)),
    onChannelLink: (id: string, e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(channelRoute(orgId, id));
    },
  };
}
