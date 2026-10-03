// Screens the shell owns: the phone Home tab, the desktop org landing, the
// legacy link resolver, not found, and the no-organization state.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/rpc';
import { toDekError } from '../../api/errors';
import { channelRoute, navigate, navigateDeeper } from '../../app/router';
import { actions, useDek } from '../../store';
import { Button, EmptyState, ErrorState, Spinner } from '../../ui/kit';
import { NotificationPrompt } from '../notifications';
import { ChannelTree } from './ChannelTree';
import { ConversationLink } from './ConversationLink';
import { dmChannels, serverSections } from './model';
import { OrgSwitcherMenu } from './Sidebar';
import { useMeId, useOrgSummary } from './hooks';
import { lastChannel, openDmPicker } from './ui-store';
import { Icon } from '../../ui/icons';
import { IconButton } from '../../ui/kit';
import { Conversation } from '../conversation/Conversation';

// Phone Home tab: the organization (brand colored), servers and channels, DMs.
export function HomeScreen({ orgId }: { orgId: string }) {
  const open = (channelId: string) => navigateDeeper(channelRoute(orgId, channelId));
  return (
    <div className="dk-home">
      <header className="dk-home__head">
        <OrgSwitcherMenu orgId={orgId} variant="home" />
        <IconButton icon="search" label="Search" onClick={() => navigate({ name: 'search', orgId, q: '' })} className="dk-home__icon" />
        <IconButton icon="edit" label="New message" onClick={openDmPicker} className="dk-home__icon" />
      </header>
      <div className="dk-home__scroll scroll-y">
        <div className="dk-home__prompt"><NotificationPrompt /></div>
        <ChannelTree orgId={orgId} activeChannelId={null} onOpen={open} variant="home" dmLimit={5}
          onAllDms={() => navigate({ name: 'view', orgId, view: 'dms' })} />
        <div className="dk-home__browse">
          <Button variant="secondary" icon="plus" block onClick={() => navigate({ name: 'browse', orgId, serverId: null })}>Browse channels</Button>
        </div>
      </div>
    </div>
  );
}

// Desktop org landing: back to where you were, or a short guide to your work.
export function OrgHome({ orgId }: { orgId: string }) {
  const meId = useMeId();
  const org = useOrgSummary(orgId);
  const channels = useDek((s) => s.channels);
  const servers = useDek((s) => s.servers);
  const profiles = useDek((s) => s.profiles);
  const ready = useDek((s) => s.bootstrap.status === 'ready' && s.orgId === orgId);

  useEffect(() => {
    if (!ready) return;
    const last = lastChannel(meId, orgId);
    const c = last ? channels[last] : undefined;
    if (c && c.member && !c.archived) {
      navigate(channelRoute(orgId, c.id), { replace: true });
    }
  }, [ready, meId, orgId, channels]);

  const sections = useMemo(() => serverSections(orgId, servers, channels), [orgId, servers, channels]);
  const mine = useMemo(() => {
    const list = sections.flatMap((s) => s.groups.flatMap((g) => g.channels));
    return [...list].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0)).slice(0, 8);
  }, [sections]);
  const dms = useMemo(() => dmChannels(orgId, channels).slice(0, 4), [orgId, channels]);

  if (!ready) return <div className="dk-center"><Spinner size={22} label="Loading" /></div>;
  return (
    <div className="dk-orghome scroll-y">
      <div className="dk-orghome__inner">
        <h1 className="dk-orghome__title">{`Welcome to ${org?.name ?? 'Dek'}`}</h1>
        <p className="dk-orghome__lead">Pick a conversation to start. Your channels and direct messages are in the sidebar; Browse finds every channel you can join.</p>
        {mine.length ? (
          <section className="dk-orghome__section" aria-labelledby="oh-ch">
            <h2 id="oh-ch" className="dk-orghome__h">Your channels</h2>
            <ul className="dk-orghome__list">
              {mine.map((c) => <li key={c.id}><ConversationLink channel={c} profiles={profiles} active={false} size="roomy" onOpen={(id) => navigate(channelRoute(orgId, id))} /></li>)}
            </ul>
          </section>
        ) : (
          <EmptyState icon="hash" title="You are not in any channel yet" body="Browse the channels of your servers and join the ones for your work." />
        )}
        {dms.length ? (
          <section className="dk-orghome__section" aria-labelledby="oh-dm">
            <h2 id="oh-dm" className="dk-orghome__h">Recent direct messages</h2>
            <ul className="dk-orghome__list">
              {dms.map((c) => <li key={c.id}><ConversationLink channel={c} profiles={profiles} active={false} size="roomy" onOpen={(id) => navigate(channelRoute(orgId, id))} /></li>)}
            </ul>
          </section>
        ) : null}
        <div className="dk-row-actions">
          <Button variant="primary" icon="search" onClick={() => navigate({ name: 'browse', orgId, serverId: null })}>Browse channels</Button>
          <Button variant="secondary" icon="edit" onClick={openDmPicker}>New message</Button>
        </div>
      </div>
    </div>
  );
}

// Old links (/c/<channel>, /c/<channel>/m/<message>, #/c/...) keep working.
export function LegacyRedirect({ channelId, messageId }: { channelId: string; messageId: string | null }) {
  const channel = useDek((s) => s.channels[channelId]);
  const ready = useDek((s) => s.bootstrap.status === 'ready');
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (messageId) {
      api.getMessageContext(messageId)
        .then((ctx) => {
          if (!live) return;
          const m = ctx.message;
          navigate(channelRoute(ctx.channel.org_id, ctx.channel.id, m.thread_root_id
            ? { threadId: m.thread_root_id, threadMessageId: m.id }
            : { messageId: m.id }), { replace: true });
        })
        .catch((e: unknown) => {
          if (!live) return;
          const err = toDekError(e);
          setFailed(err.code === 'not_found' ? 'That message does not exist any more, or you no longer have access to it.' : err.hint);
        });
      return () => { live = false; };
    }
    if (channel) {
      navigate(channelRoute(channel.org_id, channel.id), { replace: true });
    } else if (ready) {
      setFailed('That conversation is not in this organization, or you no longer have access to it. If it belongs to another organization, switch to it first.');
    }
    return () => { live = false; };
  }, [channelId, messageId, channel, ready]);

  if (failed) {
    return (
      <div className="dk-center">
        <ErrorState title="This link cannot be opened" body={failed} />
        <Button variant="secondary" onClick={() => navigate({ name: 'home' }, { replace: true })}>Go to Home</Button>
      </div>
    );
  }
  return <div className="dk-center"><Spinner size={22} label="Opening the link" /></div>;
}

export function NotFoundScreen({ orgId }: { orgId: string | null }) {
  return (
    <div className="dk-center">
      <EmptyState icon="globe" title="This page does not exist"
        body="The link may be mistyped, or it pointed to a part of Dek that was removed (task boards, timesheets and similar tools now live elsewhere)."
        action={<Button variant="primary" onClick={() => navigate(orgId ? { name: 'org', orgId } : { name: 'home' })}>Go to Home</Button>} />
    </div>
  );
}

export function NoOrgScreen() {
  return (
    <div className="dk-center">
      <EmptyState icon="users" title="You are not in an organization yet"
        body="Dek is for teams. Ask your coordinator for an invite link; opening it adds you to the right organization and channels."
        action={<Button variant="secondary" icon="logout" onClick={() => { void Promise.resolve().then(() => actions.signOut()).catch(() => undefined); }}>Sign out</Button>} />
    </div>
  );
}

export function NotMemberScreen() {
  const orgs = useDek((s) => s.orgs);
  return (
    <div className="dk-center">
      <EmptyState icon="lock" title="You are not a member of this organization"
        body="The link points to an organization you are not in, or your access was removed."
        action={orgs[0] ? <Button variant="primary" onClick={() => navigate({ name: 'org', orgId: orgs[0]!.id }, { replace: true })}>{`Go to ${orgs[0]!.name}`}</Button> : undefined} />
    </div>
  );
}

export function BootstrapError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="dk-center">
      <ErrorState title="Dek could not load this organization" body={message ?? 'Check your connection and try again.'} onRetry={onRetry} />
    </div>
  );
}

// /o/<org>/call/<call>: the call itself is drawn by the calls builder's
// CallLayer (rendered once by the shell); underneath, the call's conversation
// stays readable. The URL is left alone so the call layer can use it.
export function CallRouteScreen({ orgId, callId }: { orgId: string; callId: string }) {
  const call = useDek((s) => s.calls[callId]);
  if (call) {
    return <Conversation orgId={orgId} channelId={call.channel_id} messageId={null} threadId={null} threadMessageId={null} />;
  }
  return (
    <div className="dk-center">
      <Icon name="phone" size={28} />
      <p className="dk-center__text">Opening the call. The call controls appear on top of the conversation.</p>
      <Button variant="secondary" onClick={() => navigate({ name: 'org', orgId })}>Go to Home</Button>
    </div>
  );
}
