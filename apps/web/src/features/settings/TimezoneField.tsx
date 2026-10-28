// A time zone choice: the current value, and a searchable list in a dialog (a
// sheet on phones) with this device's zone first. Used by the profile and by
// quiet hours.
import { useId, useMemo, useState } from 'react';
import { Button, Modal, TextField } from '../../ui/kit';
import { allTimezones, deviceTimezone, filterTimezones, orderTimezones, tzLabel, tzOffset } from './timezones';

interface Props {
  label: string;
  value: string | null;
  onChange: (zone: string) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}

const SHOW = 120;

export function TimezoneField({ label, value, onChange, hint, error, disabled }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const device = deviceTimezone();
  return (
    <div className="dk-field">
      <span className="dk-field__label" id={`${id}-l`}>{label}</span>
      <div className="set-tz" aria-labelledby={`${id}-l`} role="group">
        <span className="set-tz__value" id={`${id}-v`}>
          {value ? <><span className="set-tz__name">{tzLabel(value)}</span><span className="set-tz__offset">{tzOffset(value)}</span></> : <span className="ap-muted">Not set</span>}
        </span>
        <Button onClick={() => setOpen(true)} disabled={disabled} aria-label={`Change ${label.toLowerCase()}`} aria-describedby={`${id}-v`}>Change</Button>
        {device && value !== device ? <Button variant="ghost" onClick={() => onChange(device)} disabled={disabled}>Use this device's</Button> : null}
      </div>
      {error ? <p className="dk-field__error" role="alert">{error}</p> : hint ? <p className="dk-field__hint">{hint}</p> : null}
      {open ? <TimezoneDialog title={label} value={value} device={device} onClose={() => setOpen(false)} onPick={(z) => { onChange(z); setOpen(false); }} /> : null}
    </div>
  );
}

function TimezoneDialog({ title, value, device, onClose, onPick }: { title: string; value: string | null; device: string | null; onClose: () => void; onPick: (z: string) => void }) {
  const [query, setQuery] = useState('');
  const all = useMemo(() => orderTimezones(allTimezones(), device, value), [device, value]);
  const matches = useMemo(() => filterTimezones(all, query), [all, query]);
  const shown = matches.slice(0, SHOW);
  const listId = useId();
  return (
    <Modal open size="sm" title={title} onClose={onClose}>
      <div className="set-tzdialog">
        <TextField
          label="Search"
          type="search"
          placeholder="City, region or country"
          value={query}
          autoFocus
          autoComplete="off"
          aria-controls={listId}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              onPick(shown[0]);
            }
          }}
        />
        <p className="ap-hint" aria-live="polite">{matches.length === 0 ? 'No time zone matches. Try a city name.' : matches.length > SHOW ? `Showing ${SHOW} of ${matches.length}. Keep typing to narrow it down.` : `${matches.length} time zones`}</p>
        <ul className="set-tzlist" id={listId} aria-label="Time zones">
          {shown.map((z) => (
            <li key={z}>
              <button type="button" className="set-tzlist__option" aria-pressed={z === value} onClick={() => onPick(z)}>
                <span className="set-tzlist__text">
                  <span className="set-tzlist__name">{tzLabel(z)}</span>
                  {z === device ? <span className="set-tzlist__tag">This device</span> : null}
                </span>
                <span className="set-tzlist__offset">{tzOffset(z)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
