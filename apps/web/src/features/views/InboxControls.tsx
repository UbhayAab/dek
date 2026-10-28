import { Button, Tabs } from '../../ui/kit';

export type InboxFilter = 'unread' | 'all';

export function InboxControls({ value, onChange, onRefresh, loading }: {
  value: InboxFilter; onChange: (next: InboxFilter) => void; onRefresh: () => void; loading: boolean;
}) {
  return <div className="dk-inbox-controls">
    <Tabs<InboxFilter> label="Show activity" value={value} onChange={onChange}
      tabs={[{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }]} />
    <Button variant="ghost" onClick={onRefresh} disabled={loading}>Refresh</Button>
  </div>;
}
