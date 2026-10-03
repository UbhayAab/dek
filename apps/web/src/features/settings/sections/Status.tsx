// Status (CONTRACT 2.6 set_status): an emoji and a short text that clear after
// 30 minutes, 1 hour, 4 hours, at the end of today, or never.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { Button, Select, TextField, toast } from '../../../ui/kit';
import { patchMyProfile } from '../../admin/common/context';
import { formatDateTime } from '../../admin/common/format';
import { fieldFromHint, useAction } from '../../admin/common/load';
import { Card, FormError, Section } from '../../admin/common/ui';
import { clean, hasErrors, validateStatus } from '../../admin/common/validation';
import { CLEAR_AFTER, STATUS_PRESETS, statusUntil, type ClearAfter } from '../status';

export function StatusCard({ profile }: { profile: Profile }) {
  const [emoji, setEmoji] = useState(profile.status_emoji ?? '');
  const [text, setText] = useState(profile.status_text ?? '');
  const [clear, setClear] = useState<ClearAfter>('today');
  const [touched, setTouched] = useState(false);
  const errors = validateStatus({ text, emoji });
  const save = useAction(() => api.setStatus(clean(text) || null, clean(emoji) || null, statusUntil(clear)));
  const wipe = useAction(() => api.setStatus(null, null, null));
  const field = fieldFromHint(save.error, ['text', 'emoji', 'until'], { until: 'clear' });
  const has = !!(profile.status_text || profile.status_emoji);
  const empty = !clean(text) && !clean(emoji);

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors) || empty) return;
    const r = await save.run();
    if (!r.ok) return;
    patchMyProfile(r.value);
    setTouched(false);
    toast({ kind: 'success', title: 'Status set', body: r.value.status_until ? `It clears ${formatDateTime(r.value.status_until)}.` : 'It stays until you clear it.' });
  };
  const onClear = async () => {
    const r = await wipe.run();
    if (!r.ok) return;
    patchMyProfile(r.value);
    setEmoji('');
    setText('');
    toast({ kind: 'success', title: 'Status cleared' });
  };

  return (
    <Section title="Status" description="A short note next to your name, such as In a meeting.">
      <Card tone="muted">
        <p className="set-status__now" aria-live="polite">
          {has ? (
            <>
              <span className="set-status__emoji" aria-hidden="true">{profile.status_emoji}</span>
              <span dir="auto">{profile.status_text || 'Status set'}</span>
              <span className="ap-meta">{profile.status_until ? `clears ${formatDateTime(profile.status_until)}` : 'no end time'}</span>
            </>
          ) : <span className="ap-muted">No status right now.</span>}
        </p>
      </Card>
      <div className="set-presets" role="group" aria-label="Quick statuses">
        {STATUS_PRESETS.map((p) => (
          <button key={p.text} type="button" className="set-preset" onClick={() => { setEmoji(p.emoji); setText(p.text); setClear(p.clear); }}>
            <span aria-hidden="true">{p.emoji}</span>
            <span>{p.text}</span>
          </button>
        ))}
      </div>
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="set-statusgrid">
          <TextField label="Emoji" value={emoji} maxLength={16} placeholder="📅" error={(touched && errors.emoji) || (field === 'emoji' ? save.error?.hint ?? null : null)} onChange={(e) => setEmoji(e.target.value)} />
          <TextField label="What are you up to?" value={text} maxLength={120} placeholder="In a meeting" error={(touched && errors.text) || (field === 'text' ? save.error?.hint ?? null : null)} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select label="Clear after" value={clear} onChange={(e) => setClear(e.target.value as ClearAfter)} options={CLEAR_AFTER.map((c) => ({ value: c.value, label: c.label }))}
          error={field === 'clear' ? save.error?.hint ?? null : null} />
        {touched && empty ? <p className="ap-error-text" role="alert">Add an emoji or a few words first.</p> : null}
        <FormError error={save.error} onRetry={submit} hidden={!!field} />
        <FormError error={wipe.error} onRetry={onClear} />
        <div className="ap-form__actions">
          {has ? <Button variant="ghost" onClick={onClear} loading={wipe.busy}>Clear status</Button> : null}
          <Button type="submit" variant="primary" loading={save.busy}>Set status</Button>
        </div>
      </form>
    </Section>
  );
}
