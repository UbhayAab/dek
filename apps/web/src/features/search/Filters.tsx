// Search filters: In (a conversation), From (a person), a date range and Has
// (file, link, pin). On phones they fold behind a "Filters" button that shows how
// many are active. Files search only uses In.
import { useId, useMemo, useState } from 'react';
import type { Channel, Profile } from '../../api/types';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button, Select, TextField } from '../../ui/kit';
import { channelLabel, channelTitle } from '../conversation/names';
import type { Layout } from '../shell/layout';
import { dateRangeError, toDateInput } from './dates';
import { PersonPicker } from './PersonPicker';

export type HasFilter = '' | 'file' | 'link' | 'pin';

export interface SearchFilters {
  channel: string;            // '' = any conversation
  author: Profile | null;
  after: string;              // 'YYYY-MM-DD' or ''
  before: string;
  has: HasFilter;
}

export const NO_FILTERS: SearchFilters = { channel: '', author: null, after: '', before: '', has: '' };

export function activeFilterCount(f: SearchFilters, filesOnly: boolean): number {
  if (filesOnly) return f.channel ? 1 : 0;
  return [f.channel, f.author, f.after, f.before, f.has].filter(Boolean).length;
}

const HAS_OPTIONS = [
  { value: '', label: 'Anything' },
  { value: 'file', label: 'A file' },
  { value: 'link', label: 'A link' },
  { value: 'pin', label: 'A pin' },
];

function conversationOrder(a: Channel, b: Channel): number {
  const dmA = a.kind === 'dm' || a.kind === 'group_dm';
  const dmB = b.kind === 'dm' || b.kind === 'group_dm';
  if (dmA !== dmB) return dmA ? 1 : -1;
  return 0;
}

// The conversations this person can search in, from the store: their channels
// (with the server name, since two servers can both have #general) and DMs.
export function useConversationOptions(orgId: string): { value: string; label: string }[] {
  const channels = useDek((s) => s.channels);
  const servers = useDek((s) => s.servers);
  const profiles = useDek((s) => s.profiles);
  return useMemo(() => {
    const mine = Object.values(channels).filter((c) => c.org_id === orgId && c.member && !c.hidden);
    const labelled = mine.map((c) => {
      const dm = c.kind === 'dm' || c.kind === 'group_dm';
      const server = c.server_id ? servers[c.server_id] : undefined;
      const base = dm ? channelTitle(c, profiles) : channelLabel(c, profiles);
      const where = !dm && server ? ` (${server.name})` : '';
      return { c, label: `${base}${where}${c.archived ? ', archived' : ''}` };
    });
    labelled.sort((x, y) => conversationOrder(x.c, y.c) || x.label.localeCompare(y.label));
    return [{ value: '', label: 'Any conversation' }, ...labelled.map(({ c, label }) => ({ value: c.id, label }))];
  }, [channels, servers, profiles, orgId]);
}

interface Props {
  orgId: string;
  layout: Layout;
  value: SearchFilters;
  onChange: (next: SearchFilters) => void;
  filesOnly: boolean;
}

export function Filters({ orgId, layout, value, onChange, filesOnly }: Props) {
  const options = useConversationOptions(orgId);
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const count = activeFilterCount(value, filesOnly);
  const rangeError = dateRangeError(value.after, value.before);
  const today = toDateInput(new Date());
  const folded = layout === 'phone';
  const set = (patch: Partial<SearchFilters>) => onChange({ ...value, ...patch });
  // A conversation that left the store (left or archived away) falls back to "any".
  const channelValue = options.some((o) => o.value === value.channel) ? value.channel : '';

  const fields = (
    <div className={`dk-sfilters__grid${filesOnly ? ' is-files' : ''}`}>
      <div className="dk-sfilters__field dk-sfilters__field--in">
        <Select label="In" options={options} value={channelValue} onChange={(e) => set({ channel: e.target.value })} />
      </div>
      {!filesOnly ? (
        <>
          <div className="dk-sfilters__field dk-sfilters__field--from">
            <PersonPicker orgId={orgId} value={value.author} onChange={(author) => set({ author })} />
          </div>
          <div className="dk-sfilters__field">
            <TextField label="On or after" type="date" value={value.after} max={value.before || today}
              onChange={(e) => set({ after: e.target.value })} />
          </div>
          <div className="dk-sfilters__field">
            <TextField label="On or before" type="date" value={value.before} min={value.after || undefined} max={today}
              onChange={(e) => set({ before: e.target.value })} error={rangeError} />
          </div>
          <div className="dk-sfilters__field">
            <Select label="Has" options={HAS_OPTIONS} value={value.has} onChange={(e) => set({ has: e.target.value as HasFilter })} />
          </div>
        </>
      ) : null}
      {count ? (
        <div className="dk-sfilters__clear">
          <Button variant="ghost" icon="x" onClick={() => onChange(filesOnly ? { ...value, channel: '' } : NO_FILTERS)}>Clear filters</Button>
        </div>
      ) : null}
    </div>
  );

  if (!folded) {
    return <div className="dk-sfilters" role="group" aria-label="Search filters">{fields}</div>;
  }

  return (
    <div className="dk-sfilters dk-sfilters--folded">
      <Button variant="secondary" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} aria-controls={panelId}
        className="dk-sfilters__toggle">
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />
        <span>{count ? `Filters (${count} on)` : 'Filters'}</span>
      </Button>
      <div id={panelId} role="group" aria-label="Search filters" hidden={!expanded}>
        {expanded ? fields : null}
      </div>
    </div>
  );
}
