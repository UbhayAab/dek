// Notification preferences (DEK14): channels (every message, mentions, nothing),
// direct messages, followed threads, quiet hours with their time zone, and lock
// screen previews. Explains in plain words how unread badges inside Dek differ
// from phone and browser notifications, and links to the health check.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { NotificationPrefs } from '../../../api/types';
import { setState } from '../../../store';
import { Button, Switch, TextField, toast } from '../../../ui/kit';
import { fieldFromHint, useAction, useLoad } from '../../admin/common/load';
import { linkProps } from '../../admin/common/nav';
import { Card, FormError, Gate, RadioGroup, Section } from '../../admin/common/ui';
import { hhmmLabel, validateQuietHours } from '../../admin/common/validation';
import { TimezoneField } from '../TimezoneField';
import { deviceTimezone } from '../timezones';

export function NotificationsSection() {
  const load = useLoad(() => api.getNotificationPrefs(), [], { key: 'prefs' });
  return (
    <>
      <Section title="Notifications" description="Choose what may alert you outside Dek.">
        <Card tone="muted">
          <p className="ap-card__text"><span className="ap-strong">Inside Dek</span> every channel and conversation with something new shows a bold name and an unread count. That never changes with the choices below.</p>
          <p className="ap-card__text"><span className="ap-strong">Notifications</span> are the alerts your phone or computer shows when Dek is closed or in the background. Your device has to allow them for Dek, and these choices decide which messages may send one.</p>
          <p className="ap-card__text">
            Turned notifications on but nothing arrives? <a {...linkProps({ name: 'settings', section: 'health' })}>Check notification health</a> to see whether this device can receive them and to send yourself a test.
          </p>
        </Card>
      </Section>
      <Gate load={load} what="notification settings">
        {(prefs) => <PrefsForm key={JSON.stringify(prefs)} prefs={prefs} onSaved={(p) => load.mutate(() => p)} />}
      </Gate>
    </>
  );
}

type Patch = Partial<NotificationPrefs>;

function PrefsForm({ prefs, onSaved }: { prefs: NotificationPrefs; onSaved: (p: NotificationPrefs) => void }) {
  const [level, setLevel] = useState(prefs.default_level);
  const [dm, setDm] = useState(prefs.dm_level);
  const [threads, setThreads] = useState(prefs.thread_replies);
  const [quiet, setQuiet] = useState(prefs.quiet_start !== null && prefs.quiet_end !== null);
  const [start, setStart] = useState(prefs.quiet_start ?? '22:00');
  const [end, setEnd] = useState(prefs.quiet_end ?? '07:00');
  const [tz, setTz] = useState(prefs.quiet_tz || deviceTimezone() || 'Asia/Kolkata');
  const [preview, setPreview] = useState(prefs.preview);
  const [touched, setTouched] = useState(false);
  const errors = validateQuietHours({ enabled: quiet, start, end });

  const patch: Patch = {};
  if (level !== prefs.default_level) patch.default_level = level;
  if (dm !== prefs.dm_level) patch.dm_level = dm;
  if (threads !== prefs.thread_replies) patch.thread_replies = threads;
  if (preview !== prefs.preview) patch.preview = preview;
  const qs = quiet ? start : null;
  const qe = quiet ? end : null;
  if (qs !== prefs.quiet_start) patch.quiet_start = qs;
  if (qe !== prefs.quiet_end) patch.quiet_end = qe;
  if (quiet && tz !== prefs.quiet_tz) patch.quiet_tz = tz;
  const dirty = Object.keys(patch).length > 0;

  const act = useAction(() => api.setNotificationPrefs(patch));
  const field = fieldFromHint(act.error, ['quiet_start', 'quiet_end', 'quiet_tz', 'default_level', 'dm_level', 'preview'], { 'quiet hours': 'quiet_end' });

  const submit = async () => {
    setTouched(true);
    if (errors.quiet_start || errors.quiet_end || !dirty) return;
    const r = await act.run();
    if (!r.ok) return;
    setState((s) => (s.me ? { me: { ...s.me, prefs: r.value } } : {}));
    onSaved(r.value);
    toast({ kind: 'success', title: 'Notification settings saved' });
  };

  return (
    <Section title="What may notify you">
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <RadioGroup
          legend="Channels"
          hint="The usual setting for every channel. Each channel can still choose its own under its settings."
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: 'Every new message' },
            { value: 'mentions', label: 'Only when someone mentions me', description: 'Also @channel and @here in channels you are in. Recommended.' },
            { value: 'none', label: 'Nothing', description: 'Channels only show unread counts inside Dek.' },
          ]}
        />
        <RadioGroup
          legend="Direct messages"
          compact
          value={dm}
          onChange={setDm}
          options={[
            { value: 'all', label: 'Every message' },
            { value: 'none', label: 'Nothing' },
          ]}
        />
        <Switch label="Replies in threads I follow" description="You follow a thread when you start it, reply to it, or are mentioned in it." checked={threads} onChange={setThreads} />

        <fieldset className="ap-radios">
          <legend className="ap-legend">Quiet hours</legend>
          <Switch
            label="Pause notifications at night"
            description={quiet ? `From ${hhmmLabel(start)} to ${hhmmLabel(end)}. Messages still arrive and count as unread.` : 'Messages still arrive; only the alerts wait.'}
            checked={quiet}
            onChange={setQuiet}
          />
          {quiet ? (
            <div className="ap-form">
              <div className="ap-form__grid">
                <TextField label="From" type="time" value={start} required error={(touched ? errors.quiet_start : undefined) ?? (field === 'quiet_start' ? act.error?.hint ?? null : null)} onChange={(e) => setStart(e.target.value)} />
                <TextField label="Until" type="time" value={end} required error={(touched ? errors.quiet_end : undefined) ?? (field === 'quiet_end' ? act.error?.hint ?? null : null)} onChange={(e) => setEnd(e.target.value)} />
              </div>
              <TimezoneField label="Quiet hours time zone" value={tz} onChange={setTz} error={field === 'quiet_tz' ? act.error?.hint ?? null : null} />
            </div>
          ) : null}
        </fieldset>

        <RadioGroup
          legend="Lock screen preview"
          hint="What a notification shows on a locked phone or a shared screen."
          value={preview}
          onChange={setPreview}
          options={[
            { value: 'full', label: 'Name and message', description: 'Asha in #grants: The budget draft is ready' },
            { value: 'name_only', label: 'Only who and where', description: 'Asha in #grants: New message' },
            { value: 'none', label: 'Nothing private', description: 'Dek: New message' },
          ]}
        />
        <FormError error={act.error} onRetry={submit} hidden={!!field} />
        <div className="ap-form__actions">
          <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty}>Save notification settings</Button>
        </div>
      </form>
    </Section>
  );
}
