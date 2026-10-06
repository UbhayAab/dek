// Activity: Mentions, Threads, Unread and Saved in one place (the phone Activity
// tab). The chosen tab is remembered for this browser session only.
import { useEffect, useId, useMemo, useState } from 'react';
import { useRoute } from '../../app/router';
import { useDek } from '../../store';
import { Tabs } from '../../ui/kit';
import type { Layout } from '../shell/layout';
import { orgCounts } from '../shell/model';
import { ScreenHeader } from '../shell/ScreenHeader';
import { MentionsView } from './MentionsView';
import { RequestsView } from './RequestsView';
import { useRequestCount } from '../../sync/requests';
import { SavedView } from './SavedView';
import { ThreadsView } from './ThreadsView';
import { UnreadView } from './UnreadView';

type ActivityTab = 'mentions' | 'threads' | 'unread' | 'saved' | 'requests';
const TABS: readonly ActivityTab[] = ['mentions', 'threads', 'unread', 'saved', 'requests'];
const KEY = 'dek.activityTab';

// ?tab= wins (a request notification opens /activity?tab=requests), then the tab
// chosen last in this browser session.
function readTab(): ActivityTab {
  const fromUrl = new URLSearchParams(window.location.search).get('tab');
  if (fromUrl && (TABS as readonly string[]).includes(fromUrl)) return fromUrl as ActivityTab;
  try {
    const v = window.sessionStorage.getItem(KEY);
    return v && (TABS as readonly string[]).includes(v) ? (v as ActivityTab) : 'mentions';
  } catch {
    return 'mentions';
  }
}

function writeTab(tab: ActivityTab): void {
  try {
    window.sessionStorage.setItem(KEY, tab);
  } catch {
    // Storage unavailable: the tab simply starts at Mentions next time.
  }
}

const LABELS: Record<ActivityTab, string> = { mentions: 'Mentions', threads: 'Threads', unread: 'Unread', saved: 'Saved', requests: 'Requests' };

export function ActivityView({ orgId, layout }: { orgId: string; layout: Layout }) {
  const [tab, setTab] = useState<ActivityTab>(readTab);
  const requests = useRequestCount(orgId);
  // Requests is a tab only for people who have some to decide (or were sent to it).
  const showRequests = requests > 0 || tab === 'requests';
  // Already on Activity when a "Review" notice links to ?tab=requests: follow it.
  const route = useRoute();
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TABS as readonly string[]).includes(t)) setTab(t as ActivityTab);
  }, [route]);
  const channels = useDek((s) => s.channels);
  const counts = useMemo(() => orgCounts(orgId, channels), [orgId, channels]);
  const titleId = useId();
  const panelId = useId();

  const choose = (t: ActivityTab) => {
    setTab(t);
    writeTab(t);
  };

  return (
    <section className="dk-view dk-activity" aria-labelledby={titleId}>
      <ScreenHeader title="Activity" icon="bell" titleId={titleId} />
      <div className="dk-activity__tabs">
        <Tabs<ActivityTab>
          label="Activity"
          value={tab}
          onChange={choose}
          tabs={[
            { value: 'mentions', label: LABELS.mentions, badge: counts.mentions },
            { value: 'threads', label: LABELS.threads },
            { value: 'unread', label: LABELS.unread, badge: counts.unreadChannels },
            { value: 'saved', label: LABELS.saved },
            ...(showRequests ? [{ value: 'requests' as const, label: LABELS.requests, badge: requests }] : []),
          ]}
        />
      </div>
      <div className="dk-view__body scroll-y" role="tabpanel" id={panelId} aria-label={LABELS[tab]}>
        {tab === 'mentions' ? <MentionsView key={`m:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'threads' ? <ThreadsView key={`t:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'unread' ? <UnreadView key={`u:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'saved' ? <SavedView key={`s:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'requests' ? <RequestsView key={`r:${orgId}`} orgId={orgId} /> : null}
      </div>
    </section>
  );
}
