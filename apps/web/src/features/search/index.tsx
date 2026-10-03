// Search (DEK04, DEK11): messages and files of ONE organization, only in
// conversations the person can open (the server enforces it; the screen is keyed
// by organization so no query, filter or result survives a switch). Searches run
// on submit, never per keystroke: the server allows 30 searches a minute.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { navigate } from '../../app/router';
import { Banner, Button, EmptyState, Tabs, TextField } from '../../ui/kit';
import { splitTerms } from '../../ui/markdown';
import { ScreenHeader } from '../shell/ScreenHeader';
import { useOrgSummary } from '../shell/hooks';
import type { Layout } from '../shell/layout';
import { dateRangeError } from './dates';
import { FileResults } from './FileResults';
import { Filters, NO_FILTERS, type SearchFilters } from './Filters';
import { MessageResults, type AppliedSearch } from './MessageResults';
import './search.css';

type SearchTab = 'messages' | 'files';

interface Props {
  orgId: string;
  q: string;
  layout: Layout;
}

export function SearchScreen(props: Props) {
  return <SearchInner key={props.orgId} {...props} />;
}

// Without words the server needs a conversation or a person, or it returns nothing.
function runnable(query: string, f: SearchFilters): boolean {
  return splitTerms(query).length > 0 || !!f.channel || !!f.author;
}

function SearchInner({ orgId, q, layout }: Props) {
  const org = useOrgSummary(orgId);
  const titleId = useId();
  const panelId = useId();
  const deeper = layout === 'phone';
  const initial = q.trim();

  const [input, setInput] = useState(q);
  const [tab, setTab] = useState<SearchTab>('messages');
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const runRef = useRef(1);
  const [applied, setApplied] = useState<AppliedSearch | null>(() => (initial ? { query: initial, filters: NO_FILTERS, run: 1 } : null));
  const [fileQuery, setFileQuery] = useState(initial);
  const [fileRun, setFileRun] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const lastQ = useRef(q);

  const apply = (query: string, f: SearchFilters, quiet = false): void => {
    const trimmed = query.trim();
    const rangeErr = dateRangeError(f.after, f.before);
    if (rangeErr) {
      if (!quiet) setProblem(rangeErr);
      return;
    }
    if (!runnable(trimmed, f)) {
      setApplied(null);
      if (!quiet) setProblem('Type at least one word, or choose a conversation or a person in the filters.');
      return;
    }
    setProblem(null);
    runRef.current += 1;
    setApplied({ query: trimmed, filters: f, run: runRef.current });
  };

  // The URL changed from outside (back and forward, a new search link).
  useEffect(() => {
    if (q === lastQ.current) return;
    lastQ.current = q;
    setInput(q);
    const trimmed = q.trim();
    setFileQuery(trimmed);
    setFileRun((n) => n + 1);
    if (trimmed) apply(trimmed, filters, true);
    else {
      setApplied(null);
      setProblem(null);
    }
    // apply and filters are read at the moment the URL changes, on purpose.
  }, [q]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = input.trim();
    lastQ.current = trimmed;
    navigate({ name: 'search', orgId, q: trimmed }, { replace: true });
    setFileQuery(trimmed);
    setFileRun((n) => n + 1);
    apply(trimmed, filters, tab === 'files');
  };

  const onFilters = (next: SearchFilters) => {
    setFilters(next);
    // Once a search has run, a changed filter applies at once; before that it
    // waits for Search, so nobody burns the rate limit while setting filters up.
    if (applied) apply(input, next, tab === 'files');
    else if (problem) setProblem(null);
  };

  const orgName = org?.name ?? 'this organization';

  return (
    <section className="dk-search" aria-labelledby={titleId}>
      <ScreenHeader title="Search" icon="search" subtitle={`Messages and files in ${orgName}`} titleId={titleId} />
      <div className="dk-search__body scroll-y">
        <form className="dk-search__form" role="search" aria-label={`Search ${orgName}`} onSubmit={onSubmit}>
          <div className="dk-search__input">
            <TextField
              label="Search messages"
              hideLabel
              type="search"
              enterKeyHint="search"
              placeholder={tab === 'files' ? 'Search file names' : 'Search messages'}
              value={input}
              autoFocus={!initial}
              autoComplete="off"
              maxLength={200}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" icon="search">Search</Button>
        </form>

        <div className="dk-search__tabs">
          <Tabs<SearchTab>
            label="What to search"
            value={tab}
            onChange={(t) => { setTab(t); setProblem(null); }}
            tabs={[{ value: 'messages', label: 'Messages' }, { value: 'files', label: 'Files' }]}
          />
        </div>

        <Filters orgId={orgId} layout={layout} value={filters} onChange={onFilters} filesOnly={tab === 'files'} />

        {problem ? <div className="dk-search__problem"><Banner tone="warning">{problem}</Banner></div> : null}

        <div className="dk-search__panel" role="tabpanel" id={panelId} aria-label={tab === 'files' ? 'Files' : 'Messages'}>
          {tab === 'messages' ? (
            applied ? (
              <MessageResults orgId={orgId} search={applied} deeper={deeper} />
            ) : (
              <EmptyState
                icon="search"
                title={`Search ${orgName}`}
                body="Type words to find messages, then press Search. To see everything from one conversation or one person, choose it in the filters and leave the words empty."
              />
            )
          ) : (
            <FileResults orgId={orgId} query={fileQuery} channel={filters.channel} run={fileRun} deeper={deeper} />
          )}
        </div>
      </div>
    </section>
  );
}
