// The markdown renderer is store-agnostic; this hook gives it names, links and
// navigation from the current store and router.
import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import { channelRoute, href, navigate } from '../../app/router';
import { actions,getState, useDek } from '../../store';
async function messagePerson(orgId:string,id:string):Promise<void> {
 const owner=getState().session.userId;
 if(getState().orgId!==orgId)return;
 const channelId=await actions.openDm([id]);
 if(getState().session.userId===owner&&getState().orgId===orgId)navigate(channelRoute(orgId,channelId));
}
import type { MdContext } from '../../ui/markdown';
import { channelTitle } from './names';
import {channelDisplay} from './composer-text';
function readableChannel(id:string,orgId:string|null):string|null {
 const st=getState(),c=st.channels[id];if(!c||c.org_id!==orgId)return null;
 const name=c.kind==='text'||c.kind==='audio'?c.name:channelTitle(c,st.profiles);if(name===null)return null;
 const peers=Object.values(st.channels).filter(x=>x.org_id===orgId&&(x.kind==='text'||x.kind==='audio')).map(x=>({id:x.id,name:x.name??''}));
 return channelDisplay(name,id,peers,c.server_id?st.servers[c.server_id]?.name:null).slice(1);
}

export function useMdContext(orgId: string | null, highlight?: string[]): MdContext {
  const meId = useDek((s) => s.session.userId ?? s.me?.user_id ?? null);
  const profiles = useDek((s) => s.profiles);
  const channels = useDek((s) => s.channels);
  return useMemo<MdContext>(() => ({
    scope:`${orgId}:${meId}`,
    meId,
    highlight,
    userName: (id) => profiles[id]?.display_name ?? null,
    userInfo:id=>profiles[id]??null,
    onUserMessage:orgId?id=>messagePerson(orgId,id):undefined,
    channelName: (id) => readableChannel(id,orgId),
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
    scope:`${orgId}:${meId}`,
    meId,
    userName: (id) => getState().profiles[id]?.display_name ?? null,
    userInfo:id=>getState().profiles[id]??null,
    onUserMessage:id=>messagePerson(orgId,id),
    channelName: (id) => readableChannel(id,orgId),
    channelHref: (id) => href(channelRoute(orgId, id)),
    onChannelLink: (id: string, e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(channelRoute(orgId, id));
    },
  };
}
