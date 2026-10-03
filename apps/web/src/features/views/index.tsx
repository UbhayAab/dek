// The organization views (DEK04): Unread, Mentions, Threads, Saved, DMs and the
// phone Activity tab. Each is a root screen with loading, empty, error and retry.
import type { OrgView } from '../../app/router';
import type { Layout } from '../shell/layout';
import { ActivityView } from './ActivityView';
import { DmsView } from './DmsView';
import { MentionsView } from './MentionsView';
import { SavedView } from './SavedView';
import { ThreadsView } from './ThreadsView';
import { UnreadView } from './UnreadView';

export function ViewScreen({ orgId, view, layout }: { orgId: string; view: OrgView; layout: Layout }) {
  switch (view) {
    case 'unread': return <UnreadView key={orgId} orgId={orgId} layout={layout} />;
    case 'mentions': return <MentionsView key={orgId} orgId={orgId} layout={layout} />;
    case 'threads': return <ThreadsView key={orgId} orgId={orgId} layout={layout} />;
    case 'saved': return <SavedView key={orgId} orgId={orgId} layout={layout} />;
    case 'dms': return <DmsView key={orgId} orgId={orgId} layout={layout} />;
    case 'activity': return <ActivityView key={orgId} orgId={orgId} layout={layout} />;
  }
}

export { ActivityView, DmsView, MentionsView, SavedView, ThreadsView, UnreadView };
