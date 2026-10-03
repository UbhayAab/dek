// Pick people from the whole organization (list_org_members): adding members to a
// team server, to a channel, or to a new private channel, where people from other
// team servers are welcome (DEK02 cross-team work).
import { useState, type ReactNode } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { Icon } from '../../../ui/icons';
import { Avatar, IconButton, TextField } from '../../../ui/kit';
import { useLoad } from './load';
import { cx, ErrorView, Loading, Pill, useDebounced } from './ui';

interface Props {
  orgId: string;
  selected: Profile[];
  onChange: (next: Profile[]) => void;
  label: string;
  hint?: ReactNode;
  excludeIds?: ReadonlySet<string>;
  excludeGuests?: boolean;
  max?: number;
}

export function PeoplePicker({ orgId, selected, onChange, label, hint, excludeIds, excludeGuests, max }: Props) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const load = useLoad(() => api.listOrgMembers(orgId, q || null, null, 20, 0), [orgId, q]);
  const chosen = new Set(selected.map((p) => p.id));
  const results = (load.data?.items ?? []).filter((m) =>
    (m.status ?? 'active') === 'active'
    && !(excludeGuests && m.role === 'guest')
    && !excludeIds?.has(m.profile.id)
    && !m.profile.deleted);
  const full = max !== undefined && selected.length >= max;

  const toggle = (p: Profile) => {
    if (chosen.has(p.id)) onChange(selected.filter((x) => x.id !== p.id));
    else if (!full) onChange([...selected, p]);
  };

  let body: ReactNode;
  if (load.data === null && load.status === 'error' && load.error) body = <ErrorView error={load.error} onRetry={load.reload} what="list of people" />;
  else if (load.data === null) body = <Loading rows={2} label="Loading people" />;
  else if (results.length === 0) body = <p className="ap-hint ap-picker__none">{q ? 'Nobody matches that search.' : 'Everyone who could be added is already here.'}</p>;
  else {
    body = (
      <ul className="ap-picker__list" aria-label="People you can add">
        {results.map((m) => {
          const on = chosen.has(m.profile.id);
          return (
            <li key={m.profile.id}>
              <button
                type="button"
                className={cx('ap-picker__option', on && 'is-on')}
                aria-pressed={on}
                disabled={!on && full}
                onClick={() => toggle(m.profile)}
              >
                <Avatar name={m.profile.display_name} path={m.profile.avatar_path} seed={m.profile.id} size={28} />
                <span className="ap-picker__name">
                  <span className="ap-picker__display" dir="auto">{m.profile.display_name}</span>
                  {m.profile.handle ? <span className="ap-meta">@{m.profile.handle}</span> : null}
                </span>
                {m.role === 'guest' ? <Pill>Guest</Pill> : null}
                <span className="ap-picker__mark" aria-hidden="true"><Icon name={on ? 'check' : 'plus'} size={18} /></span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="ap-picker">
      <TextField
        label={label}
        hint={hint}
        type="search"
        value={query}
        placeholder="Search by name or handle"
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      {selected.length ? (
        <ul className="ap-chips" aria-label="Chosen people">
          {selected.map((p) => (
            <li key={p.id} className="ap-chip">
              <span className="ap-chip__text" dir="auto">{p.display_name}</span>
              <IconButton icon="x" size="sm" label={`Remove ${p.display_name}`} onClick={() => toggle(p)} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ap-picker__results">{body}</div>
      {full ? <p className="ap-hint">You can add at most {max} people at a time.</p> : null}
    </div>
  );
}
