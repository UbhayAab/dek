// "From": pick one person of this organization to filter search by author. A
// combobox (type to find, arrows to move, Enter to choose, Escape to close); once
// chosen it shows as a removable chip.
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/rpc';
import type { Profile } from '../../api/types';
import { humanError } from '../../api/errors';
import { Icon } from '../../ui/icons';
import { Avatar, TextField } from '../../ui/kit';

const DEBOUNCE_MS = 250;
const LIMIT = 8;

interface Props {
  orgId: string;
  value: Pick<Profile, 'id' | 'display_name' | 'avatar_path'> | null;
  onChange: (p: Profile | null) => void;
  label?: string;
}

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; people: Profile[] } | { status: 'error'; message: string };

export function PersonPicker({ orgId, value, onChange, label = 'From' }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const [active, setActive] = useState(0);
  const inputId = useId();
  const listId = useId();

  useEffect(() => {
    if (!open || value) return undefined;
    let cancelled = false;
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    const t = setTimeout(() => {
      api.listOrgMembers(orgId, query.trim() || null, null, LIMIT)
        .then((res) => {
          if (cancelled) return;
          setLoad({ status: 'ready', people: res.items.map((i) => i.profile).filter((p) => !p.deleted) });
          setActive(0);
        })
        .catch((e: unknown) => { if (!cancelled) setLoad({ status: 'error', message: humanError(e) }); });
    }, query ? DEBOUNCE_MS : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [orgId, query, open, value]);

  const choose = (p: Profile) => {
    onChange(p);
    setQuery('');
    setOpen(false);
  };

  if (value) {
    return (
      <div className="dk-pp">
        <span className="dk-pp__label" id={`${inputId}-l`}>{label}</span>
        <div className="dk-pp__chosen" role="group" aria-labelledby={`${inputId}-l`}>
          <span className="dk-pp__chip">
            <Avatar name={value.display_name} path={value.avatar_path} seed={value.id} size={22} />
            <span className="dk-pp__chipname" dir="auto">{value.display_name}</span>
          </span>
          <button type="button" className="dk-pp__clear" onClick={() => onChange(null)} aria-label={`Remove the filter for ${value.display_name}`}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
    );
  }

  const people = load.status === 'ready' ? load.people : [];
  const expanded = open && load.status !== 'idle';
  const optionId = (i: number) => `${listId}-o${i}`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else if (people.length) setActive((a) => (a + 1) % people.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (people.length) setActive((a) => (a - 1 + people.length) % people.length);
    } else if (e.key === 'Enter') {
      // Choosing a person must not also submit the search form.
      if (open && people[active]) {
        e.preventDefault();
        choose(people[active]!);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  return (
    <div className="dk-pp">
      <TextField
        id={inputId}
        label={label}
        placeholder="Anyone"
        value={query}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && people[active] ? optionId(active) : undefined}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {expanded ? (
        <div className="dk-pp__pop">
          {load.status === 'loading' ? <p className="dk-pp__note" role="status">Finding people</p> : null}
          {load.status === 'error' ? <p className="dk-pp__note dk-pp__note--error" role="alert">{load.message}</p> : null}
          {load.status === 'ready' && !people.length ? (
            <p className="dk-pp__note" role="status">{query.trim() ? `Nobody matches "${query.trim()}".` : 'Nobody to show.'}</p>
          ) : null}
          <ul className="dk-pp__list" id={listId} role="listbox" aria-label="People">
            {people.map((p, i) => (
              <li
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`dk-pp__opt${i === active ? ' is-active' : ''}`}
                // Keep focus in the field so the click lands before the blur closes the list.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                onMouseEnter={() => setActive(i)}
              >
                <Avatar name={p.display_name} path={p.avatar_path} seed={p.id} size={24} />
                <span className="dk-pp__optname" dir="auto">{p.display_name}</span>
                {p.title ? <span className="dk-pp__opttitle" dir="auto">{p.title}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="dk-pp__list" id={listId} role="listbox" aria-label="People" hidden />
      )}
    </div>
  );
}
