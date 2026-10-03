// Direct messages: every DM and group DM in this organization, most recent first,
// with a filter and "New message". The phone DMs tab and a desktop route.
import { useMemo, useState } from 'react';
import { channelRoute, navigate, navigateDeeper } from '../../app/router';
import { useDek } from '../../store';
import { Button, EmptyState, TextField } from '../../ui/kit';
import { channelTitle } from '../conversation/names';
import { fullTimeLabel, relativeShort } from '../conversation/time';
import { ConversationLink } from '../shell/ConversationLink';
import type { Layout } from '../shell/layout';
import { dmChannels } from '../shell/model';
import { openDmPicker } from '../shell/ui-store';
import { ViewFrame, isDeeper, useEnsureProfiles } from './common';

export function DmsView({ orgId, layout }: { orgId: string; layout: Layout }) {
  const channels = useDek((s) => s.channels);
  const profiles = useDek((s) => s.profiles);
  const bootstrap = useDek((s) => s.bootstrap.status);
  const [filter, setFilter] = useState('');
  const deeper = isDeeper(layout);

  const dms = useMemo(() => dmChannels(orgId, channels), [orgId, channels]);
  const people = useMemo(() => dms.flatMap((c) => c.dm_user_ids ?? []), [dms]);
  useEnsureProfiles(people);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return dms;
    return dms.filter((c) => channelTitle(c, profiles).toLowerCase().includes(q)
      || (c.dm_user_ids ?? []).some((id) => (profiles[id]?.handle ?? '').toLowerCase().includes(q)));
  }, [dms, filter, profiles]);

  const open = (channelId: string) => {
    const to = channelRoute(orgId, channelId);
    if (deeper) navigateDeeper(to);
    else navigate(to);
  };

  const newButton = <Button variant="primary" icon="edit" onClick={openDmPicker}>New message</Button>;

  let body;
  if (bootstrap === 'loading' && !dms.length) {
    body = <p className="dk-view__hint" role="status">Loading your conversations.</p>;
  } else if (!dms.length) {
    body = (
      <EmptyState icon="message" title="No direct messages yet"
        body="Message one person, or up to eight people at once. Conversations stay inside this organization."
        action={<Button variant="primary" icon="edit" onClick={openDmPicker}>Start a conversation</Button>} />
    );
  } else {
    body = (
      <>
        <div className="dk-dms__filter">
          <TextField label="Find a conversation" hideLabel placeholder="Find a conversation" type="search"
            value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" />
        </div>
        {shown.length ? (
          <ul className="dk-dms__list" aria-label="Direct messages">
            {shown.map((c) => (
              <li key={c.id} className="dk-dms__row">
                <ConversationLink channel={c} profiles={profiles} active={false} onOpen={open} size="roomy" />
                {c.last_message_at ? (
                  <time className="dk-dms__time" dateTime={c.last_message_at} title={fullTimeLabel(c.last_message_at)}>
                    {relativeShort(c.last_message_at)}
                  </time>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dk-view__hint" role="status">{`No conversation matches "${filter.trim()}".`}</p>
        )}
      </>
    );
  }

  return (
    <ViewFrame title="Direct messages" icon="message" actions={dms.length ? newButton : null}>
      {body}
    </ViewFrame>
  );
}
