// Building blocks shared by the admin, server, channel, browse and settings screens,
// made from the lead's kit (../../../ui/kit). Layout: one layer at a time on phones
// with a back button in the header, two columns from 768 px.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DekError } from '../../../api/errors';
import { Icon, type IconName } from '../../../ui/icons';
import { Badge, Banner, Button, EmptyState, ErrorState, IconButton, Select, Skeleton, Tabs, toast } from '../../../ui/kit';
import { setNarrowNow, useIsPhone } from './context';
import { formatDateTime, relTime } from './format';
import type { Load, Paged } from './load';
import { isMissingFunction } from './load';
import './common.css';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const HEX = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ screen frame

// Below this width a screen shows one layer at a time (phones, and tablets where the
// shell's rail and sidebar take most of the width).
export const NARROW_PX = 720;

const NarrowContext = createContext<boolean | null>(null);

export function useNarrow(): boolean {
  const fromScreen = useContext(NarrowContext);
  const phone = useIsPhone();
  return fromScreen ?? phone;
}

// The screen's own width, measured (ResizeObserver), with the viewport as the first
// guess so the first paint is already right on phones.
export function useNarrowRef(): [RefObject<HTMLElement | null>, boolean] {
  const ref = useRef<HTMLElement | null>(null);
  const phone = useIsPhone();
  const [measured, setMeasured] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setMeasured(w < NARROW_PX);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const narrow = measured ?? phone;
  useEffect(() => {
    setNarrowNow(narrow);
    return () => setNarrowNow(null);
  }, [narrow]);
  return [ref, narrow];
}

interface ScreenProps {
  title: string;
  subtitle?: ReactNode;
  brand?: string | null;
  backLabel: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  rootRef?: RefObject<HTMLElement | null>;
  narrow?: boolean;
}

export function Screen({ title, subtitle, brand, backLabel, onBack, actions, children, className, rootRef, narrow }: ScreenProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  // A new layer moves focus to its heading so screen readers announce where they are.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <NarrowContext.Provider value={narrow ?? null}>
      <main className={cx('ap-screen', narrow && 'is-narrow', className)} ref={rootRef}>
        <header className="ap-header">
          <IconButton icon="chevronLeft" label={backLabel} onClick={onBack} className="ap-header__back" />
          <div className="ap-header__titles">
            <h1 className="ap-header__title" tabIndex={-1} ref={titleRef}>{title}</h1>
            {subtitle ? (
              <p className="ap-header__subtitle">
                {brand && HEX.test(brand) ? <span className="ap-swatch" style={{ background: brand }} aria-hidden="true" /> : null}
                <span className="ap-truncate">{subtitle}</span>
              </p>
            ) : null}
          </div>
          {actions ? <div className="ap-header__actions">{actions}</div> : null}
        </header>
        {children}
      </main>
    </NarrowContext.Provider>
  );
}

// Navigation column plus content column. On phones only one of them renders.
export function Split({ nav, navLabel, mode, children, className }: { nav: ReactNode; navLabel: string; mode: 'nav' | 'content'; children: ReactNode; className?: string }) {
  const narrow = useNarrow();
  const showNav = !narrow || mode === 'nav';
  const showMain = !narrow || mode === 'content';
  return (
    <div className={cx('ap-split', narrow && 'is-phone', className)}>
      {showNav ? <nav className="ap-split__nav scroll-y" aria-label={navLabel}>{nav}</nav> : null}
      {showMain ? (
        <div className="ap-split__main scroll-y">
          <div className="ap-content">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

// A single column (no navigation column), for screens with one list.
export function Single({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="ap-single scroll-y">
      <div className={cx('ap-content', wide && 'ap-content--wide')}>{children}</div>
    </div>
  );
}

export interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  href: string;
  onSelect: () => void;
  badge?: number;
  description?: string;
  tone?: 'danger';
}

export function NavList({ items, current, label }: { items: NavItem[]; current: string | null; label?: string }) {
  return (
    <ul className="ap-navlist" aria-label={label}>
      {items.map((it) => (
        <li key={it.key}>
          <a
            className={cx('ap-navlist__item', it.tone === 'danger' && 'is-danger')}
            href={it.href}
            aria-current={current === it.key ? 'page' : undefined}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              it.onSelect();
            }}
          >
            <span className="ap-navlist__icon">{it.icon}</span>
            <span className="ap-navlist__text">
              <span className="ap-navlist__label">{it.label}</span>
              {it.description ? <span className="ap-navlist__desc">{it.description}</span> : null}
            </span>
            {it.badge ? <Badge count={it.badge} tone="neutral" /> : null}
            <Icon name="chevronRight" size={18} className="ap-navlist__chev" />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function KitIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <Icon name={name} size={size} />;
}

// ------------------------------------------------------------------ content blocks

export function Section({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cx('ap-section', className)} aria-labelledby={id}>
      <div className="ap-section__head">
        <div className="ap-section__titles">
          <h2 id={id} className="ap-section__title">{title}</h2>
          {description ? <p className="ap-section__desc">{description}</p> : null}
        </div>
        {actions ? <div className="ap-section__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'danger' | 'muted' }) {
  return <div className={cx('ap-card', tone && `ap-card--${tone}`, className)}>{children}</div>;
}

export function List({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="ap-list" aria-label={label}>{children}</ul>;
}

interface RowProps {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  muted?: boolean;
  className?: string;
  testId?: string;
}

export function Row({ leading, title, meta, trailing, children, muted, className, testId }: RowProps) {
  return (
    <li className={cx('ap-row', muted && 'is-muted', className)} data-testid={testId}>
      {leading ? <div className="ap-row__lead">{leading}</div> : null}
      <div className="ap-row__body">
        <div className="ap-row__title">{title}</div>
        {meta ? <div className="ap-row__meta">{meta}</div> : null}
        {children}
      </div>
      {trailing ? <div className="ap-row__trail">{trailing}</div> : null}
    </li>
  );
}

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={cx('ap-pill', `ap-pill--${tone}`)}>{children}</span>;
}

export function TimeText({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {prefix ? `${prefix} ` : ''}{relTime(iso)}
    </time>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <span className="ap-meta">{children}</span>;
}

export function Dot() {
  return <span className="ap-dot" aria-hidden="true">·</span>;
}

// ------------------------------------------------------------------ inputs

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function RadioGroup<T extends string>({ legend, value, options, onChange, disabled, hint, compact }: {
  legend: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  hint?: ReactNode;
  compact?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={cx('ap-radios', compact && 'ap-radios--compact')} disabled={disabled}>
      <legend className="ap-legend">{legend}</legend>
      {hint ? <p className="ap-hint">{hint}</p> : null}
      <div className="ap-radios__list">
        {options.map((o) => (
          <label key={o.value} className={cx('ap-radio', value === o.value && 'is-checked', (disabled || o.disabled) && 'is-disabled')}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled || o.disabled}
              aria-labelledby={`${name}-${o.value}-l`} aria-describedby={o.description ? `${name}-${o.value}-d` : undefined}
              onChange={() => onChange(o.value)} />
            <span className="ap-radio__text">
              <span className="ap-radio__label" id={`${name}-${o.value}-l`}>{o.label}</span>
              {o.description ? <span className="ap-radio__desc" id={`${name}-${o.value}-d`}>{o.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Checkbox({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label className={cx('ap-check', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-labelledby={`${id}-l`} aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="ap-check__text">
        <span className="ap-check__label" id={`${id}-l`}>{label}</span>
        {description ? <span className="ap-check__desc" id={`${id}-d`}>{description}</span> : null}
      </span>
    </label>
  );
}

// Status filters: tabs where there is room, a select on narrow screens (five tabs
// do not fit next to each other on a phone).
export function FilterTabs<T extends string>({ label, value, onChange, options }: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; count?: number }[];
}) {
  const narrow = useNarrow();
  if (narrow) {
    return (
      <div className="ap-filter">
        <Select
          label={label}
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          options={options.map((o) => ({ value: o.value, label: o.count !== undefined ? `${o.label} (${o.count})` : o.label }))}
        />
      </div>
    );
  }
  return <Tabs<T> label={label} value={value} onChange={onChange} tabs={options.map((o) => ({ value: o.value, label: o.label, badge: o.count }))} />;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ------------------------------------------------------------------ states

export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="ap-loading" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} lines={2} />)}
    </div>
  );
}

export function Denied({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return <EmptyState icon="lock" title={title} body={body} action={action} className="ap-denied" />;
}

// One view for every load failure: denied, gone, suspended, signed out, missing
// server function, retryable (network, timeout, server) and terminal.
export function ErrorView({ error, onRetry, what = 'page', action }: { error: DekError; onRetry?: () => void; what?: string; action?: ReactNode }) {
  if (error.code === 'forbidden') return <Denied title={`You do not have access to this ${what}`} body={error.hint} action={action} />;
  if (error.code === 'not_found') return <EmptyState icon="search" title={`This ${what} is not available`} body={error.hint} action={action} />;
  if (error.code === 'suspended') return <Denied title="Your membership is suspended" body="An admin of this organization suspended your access. Ask them to restore it." action={action} />;
  if (error.code === 'auth_required') return <Denied title="Sign in again" body={error.hint} action={action} />;
  if (isMissingFunction(error)) {
    return <ErrorState title="Not available yet" body="This part of Dek is not on the server yet. It will start working after the next update." />;
  }
  if (error.retryable) return <ErrorState title="This did not load" body={error.hint} onRetry={onRetry} />;
  return <ErrorState title="This could not be loaded" body={error.hint} />;
}

// Renders a Load: skeleton, failure view, empty view or the content.
export function Gate<T>({ load, children, empty, isEmpty, what, rows, action }: {
  load: Load<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  what?: string;
  rows?: number;
  action?: ReactNode;
}) {
  if (load.data === null) {
    if (load.status === 'error' && load.error) return <ErrorView error={load.error} onRetry={load.reload} what={what} action={action} />;
    return <Loading rows={rows} />;
  }
  const data = load.data;
  return (
    <>
      {load.error && load.status === 'ready' ? (
        <Banner tone="warning" action={<Button onClick={load.reload}>Refresh</Button>}>Showing what loaded before: {load.error.hint}</Banner>
      ) : null}
      {empty && isEmpty?.(data) ? empty : children(data)}
    </>
  );
}

// Renders a paged list: skeleton, failure, empty, items, "show more".
export function PagedView<T>({ paged, children, empty, what, rows, moreLabel }: {
  paged: Paged<T>;
  children: (items: T[]) => ReactNode;
  empty: ReactNode;
  what?: string;
  rows?: number;
  moreLabel?: string;
}) {
  if (paged.items.length === 0) {
    if (paged.status === 'error' && paged.error) return <ErrorView error={paged.error} onRetry={paged.reload} what={what} />;
    if (paged.status === 'loading') return <Loading rows={rows} />;
    return <>{empty}</>;
  }
  return (
    <>
      {children(paged.items)}
      <FormError error={paged.moreError} onRetry={paged.loadMore} />
      {paged.hasMore ? <MoreButton onClick={paged.loadMore} busy={paged.loadingMore} label={moreLabel} /> : null}
    </>
  );
}

// A failed action (the form keeps what was typed). Retryable failures offer a retry.
export function FormError({ error, onRetry, hidden }: { error: DekError | null; onRetry?: () => void; hidden?: boolean }) {
  if (!error || hidden) return null;
  return (
    <div className="ap-formerror">
      <Banner tone="danger" action={error.retryable && onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}>
        {error.hint}
      </Banner>
    </div>
  );
}

export function MoreButton({ onClick, busy, label = 'Show more' }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <div className="ap-more">
      <Button onClick={onClick} loading={busy}>{label}</Button>
    </div>
  );
}

// ------------------------------------------------------------------ copy and share

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function LinkBox({ url, label, shareTitle, shareText }: { url: string; label: string; shareTitle: string; shareText?: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const onCopy = async () => {
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      toast({ kind: 'success', title: 'Link copied' });
      setTimeout(() => setCopied(false), 2500);
    } else {
      inputRef.current?.select();
      toast({ kind: 'error', title: 'Copy did not work', body: 'The link is selected. Copy it with your keyboard or the menu.' });
    }
  };
  const onShare = async () => {
    try {
      await navigator.share({ title: shareTitle, text: shareText, url });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') toast({ kind: 'error', title: 'Sharing did not work', body: 'Copy the link instead.' });
    }
  };
  return (
    <div className="ap-linkbox">
      <label htmlFor={id} className="dk-field__label">{label}</label>
      <input id={id} ref={inputRef} className="dk-input ap-linkbox__input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <div className="ap-linkbox__actions">
        <Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={onCopy}>{copied ? 'Copied' : 'Copy link'}</Button>
        {canShare ? <Button icon="share" onClick={onShare}>Share</Button> : null}
      </div>
    </div>
  );
}
