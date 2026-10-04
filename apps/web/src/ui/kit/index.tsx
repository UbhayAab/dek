// Dek UI kit: the primitives every screen is built from, so states, spacing,
// focus and touch behave the same everywhere. Styles in kit.css, tokens in
// ../tokens.css. Accessibility is built in: real buttons, labels tied to inputs,
// native <dialog> for focus trapping and Escape, aria-live toasts.
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { create } from 'zustand';
import { config } from '../../config';
import { Icon, type IconName } from '../icons';
import './kit.css';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ------------------------------------------------------------------ Button

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: IconName;
  block?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, block, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('dk-btn', `dk-btn--${variant}`, `dk-btn--${size}`, block && 'dk-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={18} /> : null}
      {children ? <span className="dk-btn__label">{children}</span> : null}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
  badge?: number;
}

export function IconButton({ icon, label, size = 'md', active, badge, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('dk-iconbtn', `dk-iconbtn--${size}`, active && 'is-active', className)}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 18 : 20} />
      {badge ? <Badge count={badge} className="dk-iconbtn__badge" /> : null}
    </button>
  );
}

// ------------------------------------------------------------------ Fields

interface FieldShellProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, hideLabel, children }: FieldShellProps) {
  return (
    <div className={cx('dk-field', error && 'has-error')}>
      <label htmlFor={id} className={cx('dk-field__label', hideLabel && 'sr-only')}>{label}</label>
      {children}
      {error ? <p className="dk-field__error" id={`${id}-err`} role="alert">{error}</p>
        : hint ? <p className="dk-field__hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
}

export function TextField({ label, hint, error, hideLabel, id, className, ...rest }: TextFieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error} hideLabel={hideLabel}>
      <input
        id={fid}
        className={cx('dk-input', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-err` : hint ? `${fid}-hint` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
}

export function TextArea({ label, hint, error, hideLabel, id, className, ...rest }: TextAreaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error} hideLabel={hideLabel}>
      <textarea
        id={fid}
        className={cx('dk-input', 'dk-textarea', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-err` : hint ? `${fid}-hint` : undefined}
        dir="auto"
        {...rest}
      />
    </FieldShell>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  options: { value: string; label: string }[];
}

export function Select({ label, hint, error, options, id, className, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error}>
      <select id={fid} className={cx('dk-input', 'dk-select', className)} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FieldShell>
  );
}

interface SwitchProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, description, checked, onChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="dk-switchrow">
      <div className="dk-switchrow__text">
        <label htmlFor={id} className="dk-switchrow__label">{label}</label>
        {description ? <p className="dk-switchrow__desc" id={`${id}-d`}>{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        className={cx('dk-switch', checked && 'is-on')}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="dk-switch__thumb" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Avatar

export function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${config.supabaseUrl}/storage/v1/object/public/avatars/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '';
  return (first + last).toUpperCase();
}

// Stable hue per person so initials avatars are tellable apart.
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

interface AvatarProps {
  name: string;
  path?: string | null;
  seed?: string;
  size?: number;
  active?: boolean;
  className?: string;
}

export function Avatar({ name, path, seed, size = 32, active, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const url = !failed ? avatarUrl(path) : null;
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)), ['--h' as string]: hue(seed ?? name) };
  return (
    <span className={cx('dk-avatar', className)} style={style} aria-hidden="true">
      {url ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span>{initials(name)}</span>}
      {active ? <span className="dk-avatar__dot" /> : null}
    </span>
  );
}

// ------------------------------------------------------------------ Feedback

export function Badge({ count, className, tone = 'danger' }: { count: number; className?: string; tone?: 'danger' | 'neutral' }) {
  if (!count) return null;
  return <span className={cx('dk-badge', `dk-badge--${tone}`, className)} aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>;
}

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span className="dk-spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label}>
      <span className="dk-spinner__ring" />
    </span>
  );
}

export function Skeleton({ lines = 3, avatar = true }: { lines?: number; avatar?: boolean }) {
  return (
    <div className="dk-skeleton" aria-hidden="true">
      {avatar ? <span className="dk-skeleton__avatar" /> : null}
      <div className="dk-skeleton__lines">
        {Array.from({ length: lines }, (_, i) => <span key={i} className="dk-skeleton__line" style={{ width: `${90 - i * 18}%` }} />)}
      </div>
    </div>
  );
}

interface StateProps {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon = 'inbox', title, body, action, className }: StateProps) {
  return (
    <div className={cx('dk-state', className)}>
      <span className="dk-state__icon"><Icon name={icon} size={28} /></span>
      <h3 className="dk-state__title">{title}</h3>
      {body ? <p className="dk-state__body">{body}</p> : null}
      {action ? <div className="dk-state__action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title = 'This did not load', body, onRetry, className }: Omit<StateProps, 'icon' | 'title'> & { title?: string; onRetry?: () => void }) {
  return (
    <div className={cx('dk-state', 'dk-state--error', className)} role="alert">
      <span className="dk-state__icon"><Icon name="alert" size={28} /></span>
      <h3 className="dk-state__title">{title}</h3>
      {body ? <p className="dk-state__body">{body}</p> : null}
      {onRetry ? <div className="dk-state__action"><Button icon="refresh" onClick={onRetry}>Try again</Button></div> : null}
    </div>
  );
}

export function Banner({ tone = 'info', icon, children, action, onClose }: { tone?: 'info' | 'warning' | 'danger' | 'success'; icon?: IconName; children: ReactNode; action?: ReactNode; onClose?: () => void }) {
  const fallback: IconName = tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info';
  return (
    <div className={cx('dk-banner', `dk-banner--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon ?? fallback} size={18} />
      <div className="dk-banner__body">{children}</div>
      {action}
      {onClose ? <IconButton icon="x" label="Dismiss" size="sm" onClick={onClose} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Modal / Sheet

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  // Bottom sheet on phones, centered dialog on larger screens.
  sheetOnMobile?: boolean;
  dismissable?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Native <dialog> modality (top layer, focus trap, Escape, ::backdrop) is missing
// on iOS 15.0 to 15.3, which the native app still supports: showModal() does not
// exist there and calling it throws.
export function supportsModalDialog(d: HTMLDialogElement | null): boolean {
  return !!d && typeof d.showModal === 'function';
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
}

export function Modal({ open, onClose, title, children, footer, size = 'md', sheetOnMobile = true, dismissable = true }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Without native modality the dialog element becomes a fixed overlay that
  // traps focus, closes on Escape and on a backdrop click, and gives focus back.
  const [fallback, setFallback] = useState(false);
  const restore = useRef<HTMLElement | null>(null);
  const trapping = useRef(false);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (supportsModalDialog(d)) {
      if (open && !d.open) {
        restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        d.showModal();
      }
      if (!open && d.open) {
        d.close();
        const back = restore.current;
        restore.current = null;
        if (back && document.contains(back)) back.focus();
      }
      return;
    }
    setFallback(true);
    if (open && !d.hasAttribute('open')) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.setAttribute('open', '');
      trapping.current = true;
      (focusables(d)[0] ?? d).focus();
    } else if (!open && d.hasAttribute('open')) {
      // Stand the trap down first, or giving focus back would be pulled inside again.
      trapping.current = false;
      d.removeAttribute('open');
      const back = restore.current;
      restore.current = null;
      if (back && document.contains(back)) back.focus();
    }
  }, [open]);

  // Most call sites render {x ? <ConfirmDialog open /> : null}: the dialog unmounts while
  // open and close() never runs, which used to drop focus to the page. Close it here and
  // give focus back to whatever opened it.
  useLayoutEffect(() => {
    const d = ref.current;
    return () => {
      trapping.current = false;
      if (d?.open) {
        try { d.close(); } catch { /* already detached */ }
      }
      const back = restore.current;
      restore.current = null;
      if (back && document.contains(back)) back.focus();
    };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (dismissable) onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose, dismissable]);

  // The fallback's own Escape and focus trap.
  useEffect(() => {
    const d = ref.current;
    if (!d || !fallback || !open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!trapping.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dismissable) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(d);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !d.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !d.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that escapes (a click on something behind) is brought back in.
    const onFocusIn = (e: FocusEvent) => {
      if (!trapping.current) return;
      if (e.target instanceof Node && !d.contains(e.target)) (focusables(d)[0] ?? d).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [fallback, open, dismissable, onClose]);

  return (
    <dialog
      ref={ref}
      className={cx('dk-modal', `dk-modal--${size}`, sheetOnMobile && 'dk-modal--sheet', fallback && 'dk-modal--fallback')}
      aria-labelledby={titleId}
      role={fallback ? 'dialog' : undefined}
      aria-modal={fallback ? true : undefined}
      tabIndex={fallback ? -1 : undefined}
      onClick={(e) => { if (dismissable && e.target === ref.current) onClose(); }}
    >
      {open ? (
        <div className="dk-modal__panel">
          <header className="dk-modal__header">
            <h2 id={titleId} className="dk-modal__title">{title}</h2>
            {dismissable ? <IconButton icon="x" label="Close" onClick={onClose} /> : null}
          </header>
          <div className="dk-modal__body scroll-y">{children}</div>
          {footer ? <footer className="dk-modal__footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
      </>}>
      {body ? <div className="dk-confirm__body">{body}</div> : null}
    </Modal>
  );
}

// ------------------------------------------------------------------ Menu

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  label: string;
  items: MenuItem[];
  icon?: IconName;
  trigger?: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  align?: 'start' | 'end';
}

const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// A popup menu on desktop; an action sheet on touch screens (long press is not
// reliable on iOS, so every message action also lives behind a visible button).
// The box that clips a popup list: the nearest ancestor that scrolls or hides
// overflow, inside the window.
function clipBox(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
  }
  return { top, bottom };
}

export function Menu({ label, items, icon = 'more', trigger, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asSheet = coarse();
  const close = useCallback(() => setOpen(false), []);

  // Opens upward when the room below the trigger (inside whatever box would clip
  // the list) is too small and there is more room above. Measured before paint.
  useLayoutEffect(() => {
    if (!open || asSheet) {
      setUp(false);
      return;
    }
    const w = wrap.current;
    const l = list.current;
    if (!w || !l) return;
    const r = w.getBoundingClientRect();
    const box = clipBox(w);
    const need = l.offsetHeight + 8;
    const below = box.bottom - r.bottom;
    const above = r.top - box.top;
    setUp(below < need && above > below);
  }, [open, asSheet]);

  useEffect(() => {
    if (!open || asSheet) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    const first = list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, asSheet]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); focusTrigger(); }
  };

  // Focus goes back to the trigger when the menu closes by keyboard or by choosing an
  // item (before onSelect, so a dialog the item opens returns focus there too).
  const focusTrigger = () => wrap.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  const triggerProps = { onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' as const };
  const rendered = items.map((it) => (
    <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
      className={cx('dk-menu__item', it.danger && 'is-danger')}
      onClick={() => { setOpen(false); if (!asSheet) focusTrigger(); it.onSelect(); }}>
      {it.icon ? <Icon name={it.icon} size={18} /> : null}
      <span>{it.label}</span>
    </button>
  ));

  return (
    <div className="dk-menu" ref={wrap}>
      {trigger ? trigger(triggerProps) : <IconButton icon={icon} label={label} {...triggerProps} />}
      {open && !asSheet ? (
        <div ref={list} className={cx('dk-menu__list', `dk-menu__list--${align}`, up && 'dk-menu__list--up')} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {rendered}
        </div>
      ) : null}
      {asSheet ? (
        <Modal open={open} onClose={close} title={label} size="sm">
          <div role="menu" aria-label={label} className="dk-menu__sheet">{rendered}</div>
        </Modal>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Tabs

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; badge?: number }[]; label: string }) {
  return (
    <div className="dk-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value}
          className={cx('dk-tabs__tab', t.value === value && 'is-active')} onClick={() => onChange(t.value)}>
          {t.label}{t.badge ? <Badge count={t.badge} tone="neutral" /> : null}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Toasts

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let toastSeq = 0;

export function toast(t: Omit<Toast, 'id' | 'duration' | 'kind'> & { kind?: Toast['kind']; duration?: number }): number {
  toastSeq += 1;
  const item: Toast = { id: toastSeq, kind: t.kind ?? 'info', duration: t.duration ?? (t.kind === 'error' ? 7000 : 4000), ...t };
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), item] }));
  if (item.duration > 0) setTimeout(() => dismissToast(item.id), item.duration);
  return item.id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="dk-toaster" aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <div key={t.id} className={cx('dk-toast', `dk-toast--${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="dk-toast__text">
            <strong>{t.title}</strong>
            {t.body ? <span>{t.body}</span> : null}
          </div>
          {t.action ? <Button size="sm" variant="ghost" onClick={() => { t.action?.onClick(); dismissToast(t.id); }}>{t.action.label}</Button> : null}
          <IconButton icon="x" label="Dismiss" size="sm" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
