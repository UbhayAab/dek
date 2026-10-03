// Activity: Mentions, Threads, Unread and Saved in one place (the phone Activity
// tab). The chosen tab is remembered for this browser session only.
import { useId, useMemo, useState } from 'react';
import { useDek } from '../../store';
import { Tabs } from '../../ui/kit';
import type { Layout } from '../shell/layout';
import { orgCounts } from '../shell/model';
import { ScreenHeader } from '../shell/ScreenHeader';
import { MentionsView } from './MentionsView';
import { SavedView } from './SavedView';
import { ThreadsView } from './ThreadsView';
import { UnreadView } from './UnreadView';

type ActivityTab = 'mentions' | 'threads' | 'unread' | 'saved';
const TABS: readonly ActivityTab[] = ['mentions', 'threads', 'unread', 'saved'];
const KEY = 'dek.activityTab';

function readTab(): ActivityTab {
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

const LABELS: Record<ActivityTab, string> = { mentions: 'Mentions', threads: 'Threads', unread: 'Unread', saved: 'Saved' };

export function ActivityView({ orgId, layout }: { orgId: string; layout: Layout }) {
  const [tab, setTab] = useState<ActivityTab>(readTab);
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
          ]}
        />
      </div>
      <div className="dk-view__body scroll-y" role="tabpanel" id={panelId} aria-label={LABELS[tab]}>
        {tab === 'mentions' ? <MentionsView key={`m:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'threads' ? <ThreadsView key={`t:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'unread' ? <UnreadView key={`u:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
        {tab === 'saved' ? <SavedView key={`s:${orgId}`} orgId={orgId} layout={layout} embedded /> : null}
      </div>
    </section>
  );
}
