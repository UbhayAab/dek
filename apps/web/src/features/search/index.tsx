// Applied search scope lives in the URL, so reload and result/Back preserve it.
// Pending text/filters stay local until an explicit submit or filter/tab choice.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { back, href, navigate, parse, type SearchRouteScope } from '../../app/router';
import { useDek } from '../../store';
import { Banner, Button, EmptyState, Tabs, TextField } from '../../ui/kit';
import { splitTerms } from '../../ui/markdown';
import { ScreenHeader } from '../shell/ScreenHeader';
import { useOrgSummary } from '../shell/hooks';
import type { Layout } from '../shell/layout';
import { FileResults } from './FileResults';
import { Filters, NO_FILTERS, type SearchFilters } from './Filters';
import { MessageResults, type AppliedSearch } from './MessageResults';
import { filtersFromScope, scopeError, scopeFromFilters, type SearchTab } from './scope';
import './search.css';

interface Props { orgId: string; q: string; layout: Layout; scope?: SearchRouteScope }

export function SearchScreen(props: Props) {
  return <SearchInner key={props.orgId} {...props} />;
}

function runnable(query: string, f: SearchFilters): boolean {
  return splitTerms(query).length > 0 || !!f.channel || !!f.author;
}

function SearchInner({ orgId, q, layout, scope }: Props) {
  const org = useOrgSummary(orgId);
  const profiles = useDek(s => s.profiles);
  const titleId = useId();
  const panelId = useId();
  const deeper = layout === 'phone';
  const initialFilters = filtersFromScope(scope, profiles);
  const initialProblem = scopeError(scope, orgId);
  const initialTab: SearchTab = scope?.tab === 'files' ? 'files' : 'messages';
  const returnTo = !initialProblem ? scope?.back ?? '' : '';
  const initial = q.trim();
  const [input, setInput] = useState(q);
  const [tab, setTab] = useState<SearchTab>(initialTab);
  const [filters, setFilters] = useState(initialFilters);
  const [applied, setApplied] = useState<AppliedSearch | null>(() =>
    !initialProblem && runnable(initial, initialFilters) ? { query: initial, filters: initialFilters, run: 1 } : null);
  const [fileRun, setFileRun] = useState(1);
  const [fileQuery, setFileQuery] = useState(initial);
  const [problem, setProblem] = useState<string | null>(initialProblem);
  const signature = JSON.stringify([q, scope]);
  const ownRoute = useRef(signature);
  const incomingRoute = useRef(signature);
  const restoring = signature !== incomingRoute.current && signature !== ownRoute.current;

  useEffect(() => {
    if (signature === incomingRoute.current) return;
    incomingRoute.current = signature;
    if (signature === ownRoute.current) return;
    ownRoute.current = signature;
    setInput(q);
    setFilters(initialFilters);
    setTab(initialTab);
    setProblem(initialProblem);
    setApplied(s => !initialProblem && runnable(initial, initialFilters)
      ? { query: initial, filters: initialFilters, run: (s?.run ?? 0) + 1 } : null);
    setFileQuery(initial);
    setFileRun(n => n + 1);
    // Read the decoded scope/profiles at the moment an external URL changes.
    // Local URL writes are already applied and must retain filter focus/panels.
  }, [signature]);

  const submit = (query: string, next: SearchFilters, nextTab = tab, allowEmpty = false): void => {
    const trimmed = query.trim();
    // A changed conversation drops the return destination from the old context.
    const nextScope = scopeFromFilters(next, nextTab, next.channel === scope?.in ? returnTo : '');
    const err = scopeError(nextScope, orgId);
    if (err) { setProblem(err); return; }
    if (nextTab === 'messages' && !runnable(trimmed, next) && !allowEmpty) {
      setProblem('Type at least one word, or choose a conversation or a person in the filters.');
      setApplied(null);
      return;
    }
    const to = { name: 'search' as const, orgId, q: trimmed, scope: nextScope };
    const target = href(to);
    const written = parse(target);
    if (written.name === 'search') ownRoute.current = JSON.stringify([written.q, written.scope]);
    setProblem(null);
    setTab(nextTab);
    setApplied(s => runnable(trimmed, next) ? { query: trimmed, filters: next, run: (s?.run ?? 0) + 1 } : null);
    setFileQuery(trimmed);
    setFileRun(n => n + 1);
    if (target !== window.location.pathname + window.location.search) navigate(to, { replace: true });
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); submit(input, filters); };
  const onFilters = (next: SearchFilters) => {
    setFilters(next);
    // Editing dates can temporarily make an invalid range. Keep it editable and
    // never send a broader query while it is invalid.
    if (applied || tab === 'files') submit(input, next);
    else setProblem(scopeError(scopeFromFilters(next, tab), orgId));
  };
  const orgName = org?.name ?? 'this organization';
  const parkedFileFilters = tab === 'files' && !!(filters.author || filters.after || filters.before || filters.has);

  return (
    <section className="dk-search" aria-labelledby={titleId}>
      <ScreenHeader title="Search" icon="search" subtitle={`Messages and files in ${orgName}`} titleId={titleId}
        onBack={returnTo ? () => back(returnTo) : undefined} backLabel="Back to the conversation" />
      <div className="dk-search__body scroll-y">
        <form className="dk-search__form" role="search" aria-label={`Search ${orgName}`} onSubmit={onSubmit}>
          <div className="dk-search__input">
            <TextField label="Search messages" hideLabel type="search" enterKeyHint="search"
              placeholder={tab === 'files' ? 'Search file names' : 'Search messages'}
              value={input} autoFocus={!initial} autoComplete="off" maxLength={200} onChange={e => setInput(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" icon="search">Search</Button>
        </form>
        <div className="dk-search__tabs">
          <Tabs<SearchTab> label="What to search" value={tab}
            onChange={tab => submit(input, filters, tab, true)}
            tabs={[{ value: 'messages', label: 'Messages' }, { value: 'files', label: 'Files' }]} />
        </div>
        <Filters orgId={orgId} layout={layout} value={filters} onChange={onFilters} filesOnly={tab === 'files'} />
        {parkedFileFilters ? <p className="dk-view__hint">Files use the words and conversation only. Person, date and Has filters are kept for Messages.</p> : null}
        {problem ? <div className="dk-search__problem"><Banner tone="warning">{problem}</Banner>
          <Button variant="secondary" onClick={() => { setFilters(NO_FILTERS); submit(input, NO_FILTERS, 'messages', true); }}>Clear all filters</Button>
        </div> : null}
        <div className="dk-search__panel" role="tabpanel" id={panelId} aria-label={tab === 'files' ? 'Files' : 'Messages'}>
          {restoring ? <p role="status">Restoring search</p>
            : problem ? <EmptyState icon="search" title="Check the search filters" body="Correct the search or choose another scope, then press Search." />
            : tab === 'messages' ? applied ? <MessageResults orgId={orgId} search={applied} deeper={deeper} />
              : <EmptyState icon="search" title={`Search ${orgName}`}
                body="Type words to find messages, then press Search. To see one conversation or person, choose it in the filters and leave the words empty." />
            : <FileResults orgId={orgId} query={fileQuery} channel={filters.channel} run={fileRun} deeper={deeper} />}
        </div>
      </div>
    </section>
  );
}
