// Emoji picker panel: search, category tabs and a keyboard navigable grid. Only the
// panel content: the caller places it in a desktop popover or the kit Modal sheet on
// phones. Picking records the emoji in this person's recents, then calls onPick.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EmptyState, TextField } from '../../../ui/kit';
import { EMOJI_GROUPS, emojiName, noteEmoji, recentEmoji, searchEmoji, type EmojiGroup, type EmojiItem } from './data';
import './emoji.css';

const RECENT_GROUP = { id: 'recent', label: 'Recent', icon: '🕘' } as const;

interface EmojiPickerProps {
  userId: string | null;
  onPick: (ch: string) => void;
  autoFocus?: boolean;
}

export function EmojiPicker({ userId, onPick, autoFocus = false }: EmojiPickerProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Recents are read once per open, so the grid does not reshuffle while picking.
  const groups = useMemo<EmojiGroup[]>(() => {
    const recents = recentEmoji(userId);
    if (!recents.length) return EMOJI_GROUPS;
    const items: EmojiItem[] = recents.map((ch) => ({ ch, name: emojiName(ch) ?? 'emoji', keywords: [] }));
    return [{ ...RECENT_GROUP, items }, ...EMOJI_GROUPS];
  }, [userId]);

  const [groupId, setGroupId] = useState<string>(() => groups[0]?.id ?? 'smileys');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = query.trim();
  const group = groups.find((g) => g.id === groupId) ?? groups[0]!;
  const items = useMemo(() => (q ? searchEmoji(q) : group.items), [q, group]);

  useEffect(() => {
    setActive(0);
  }, [q, groupId]);

  useEffect(() => {
    if (!autoFocus) return undefined;
    const raf = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>('input')?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  const pick = (ch: string) => {
    noteEmoji(userId, ch);
    onPick(ch);
  };

  const cells = () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-emoji-cell]') ?? []);

  // Columns from the rendered layout, so arrow keys follow what people see.
  const columns = (list: HTMLButtonElement[]) => {
    const top = list[0]?.offsetTop ?? 0;
    let n = 0;
    for (const cell of list) {
      if (cell.offsetTop !== top) break;
      n += 1;
    }
    return Math.max(1, n);
  };

  const focusCell = (index: number) => {
    const list = cells();
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, index));
    setActive(next);
    list[next]?.focus();
  };

  const focusSearch = () => rootRef.current?.querySelector<HTMLInputElement>('input')?.focus();

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = cells();
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const cols = columns(list);
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = current + 1; break;
      case 'ArrowLeft': next = current - 1; break;
      case 'ArrowDown': next = current + cols; break;
      case 'ArrowUp':
        if (current - cols < 0) {
          e.preventDefault();
          focusSearch();
          return;
        }
        next = current - cols;
        break;
      case 'Home': next = 0; break;
      case 'End': next = list.length - 1; break;
      default: return;
    }
    e.preventDefault();
    focusCell(next);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusCell(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = items[0];
      if (first) pick(first.ch);
    }
  };

  const selectGroup = (id: string) => {
    setGroupId(id);
    setQuery('');
  };

  // Tabs follow the ARIA tabs pattern: arrows move and select, Home and End jump.
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = groups.findIndex((g) => g.id === group.id);
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % groups.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + groups.length) % groups.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = groups.length - 1;
    else return;
    e.preventDefault();
    const target = groups[next];
    if (!target) return;
    selectGroup(target.id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const panelId = `${uid}-panel`;
  const labelId = `${uid}-label`;
  const tabId = (id: string) => `${uid}-tab-${id}`;

  return (
    <div className="dk-emoji" ref={rootRef}>
      <TextField
        label="Search emoji"
        hideLabel
        type="search"
        placeholder="Search emoji"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
      />
      <div className="dk-emoji__tabs" role="tablist" aria-label="Emoji categories" onKeyDown={onTabsKeyDown}>
        {groups.map((g) => (
          <button
            key={g.id}
            id={tabId(g.id)}
            type="button"
            role="tab"
            className="dk-emoji__tab"
            aria-selected={!q && g.id === group.id}
            aria-controls={panelId}
            aria-label={g.label}
            title={g.label}
            tabIndex={g.id === group.id ? 0 : -1}
            onClick={() => selectGroup(g.id)}
          >
            <span aria-hidden="true">{g.icon}</span>
          </button>
        ))}
      </div>
      <p className="dk-emoji__label" id={labelId}>{q ? 'Search results' : group.label}</p>
      {items.length === 0 ? (
        <EmptyState icon="smile" title="No emoji match" body="Try another word." className="dk-emoji__empty" />
      ) : (
        <div
          ref={gridRef}
          id={panelId}
          className="dk-emoji__grid"
          role={q ? 'group' : 'tabpanel'}
          aria-labelledby={q ? labelId : tabId(group.id)}
          onKeyDown={onGridKeyDown}
        >
          {items.map((item, i) => (
            <button
              key={item.ch}
              type="button"
              className="dk-emoji__cell"
              data-emoji-cell=""
              tabIndex={i === active ? 0 : -1}
              aria-label={item.name}
              title={item.name}
              onClick={() => pick(item.ch)}
            >
              {item.ch}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
