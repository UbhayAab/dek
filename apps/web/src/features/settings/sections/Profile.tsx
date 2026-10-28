// Profile (CONTRACT 2.6 update_profile): picture, name, handle, title and time
// zone, plus the status card. Saving sends only what changed.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { Button, TextField, toast } from '../../../ui/kit';
import { patchMyProfile, useMe } from '../../admin/common/context';
import { fieldFromHint, useAction } from '../../admin/common/load';
import { ErrorView, FormError, Loading, Section } from '../../admin/common/ui';
import { clean, hasErrors, normalizeHandle, validateProfile } from '../../admin/common/validation';
import { TimezoneField } from '../TimezoneField';
import { deviceTimezone } from '../timezones';
import { AvatarEditor } from './Avatar';
import { StatusCard } from './Status';

export function ProfileSection() {
  const { me, status, error, retry } = useMe();
  if (!me) {
    return status === 'error' && error ? <ErrorView error={error} onRetry={retry} what="profile" /> : <Loading label="Loading your profile" />;
  }
  return (
    <>
      <ProfileForm key={me.profile.id} profile={me.profile} />
      <StatusCard profile={me.profile} />
    </>
  );
}

function ProfileForm({ profile }: { profile: Profile }) {
  const [name, setName] = useState(profile.display_name);
  const [handle, setHandle] = useState(profile.handle ?? '');
  const [title, setTitle] = useState(profile.title ?? '');
  const [timezone, setTimezone] = useState<string | null>(profile.timezone ?? null);
  const [touched, setTouched] = useState(false);
  const errors = validateProfile({ display_name: name, handle, title });

  const patch: Parameters<typeof api.updateProfile>[0] = {};
  if (clean(name) !== profile.display_name) patch.display_name = clean(name);
  if (normalizeHandle(handle) !== (profile.handle ?? null)) patch.handle = normalizeHandle(handle);
  if ((clean(title) || null) !== (profile.title ?? null)) patch.title = clean(title) || null;
  if (timezone && timezone !== profile.timezone) patch.timezone = timezone;
  const dirty = Object.keys(patch).length > 0;

  const act = useAction(() => api.updateProfile(patch));
  const field = fieldFromHint(act.error, ['display_name', 'handle', 'title', 'timezone']);
  const show = (k: 'display_name' | 'handle' | 'title'): string | null => {
    const local = touched ? errors[k] : undefined;
    if (local) return local;
    return field === k ? act.error?.hint ?? null : null;
  };

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors) || !dirty) return;
    const r = await act.run();
    if (!r.ok) return;
    patchMyProfile(r.value);
    setHandle(r.value.handle ?? '');
    setTouched(false);
    toast({ kind: 'success', title: 'Profile saved' });
  };
  const reset = () => {
    setName(profile.display_name);
    setHandle(profile.handle ?? '');
    setTitle(profile.title ?? '');
    setTimezone(profile.timezone ?? null);
    setTouched(false);
    act.reset();
  };

  return (
    <Section title="Profile" description="How you appear to people in every organization you are in.">
      <AvatarEditor profile={profile} />
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="Name" value={name} maxLength={100} autoComplete="name" error={show('display_name')} onChange={(e) => setName(e.target.value)} />
        <div className="ap-form__grid">
          <TextField
            label="Handle (optional)"
            value={handle}
            maxLength={40}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            hint="Lowercase letters, digits, dots, dashes or underscores."
            error={show('handle')}
            onChange={(e) => setHandle(e.target.value)}
          />
          <TextField label="Title (optional)" value={title} maxLength={100} placeholder="Grants coordinator" error={show('title')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <TimezoneField
          label="Time zone"
          value={timezone}
          onChange={setTimezone}
          hint={timezone ? 'People see your local time from it.' : `Not set yet. This device uses ${deviceTimezone() ?? 'an unknown zone'}.`}
          error={field === 'timezone' ? act.error?.hint ?? null : null}
        />
        <FormError error={act.error} onRetry={submit} hidden={!!field} />
        <div className="ap-form__actions">
          <Button variant="ghost" onClick={reset} disabled={!dirty || act.busy}>Undo changes</Button>
          <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty}>Save profile</Button>
        </div>
      </form>
    </Section>
  );
}
