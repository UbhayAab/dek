// Organization settings (CONTRACT 2.3 update_org): name, short name and brand color
// (DEK01: switching organization must be unmistakable), and what members may do:
// guests, creating channels and team servers, inviting, how long a message stays
// editable, and how long new invite links last. Owners and admins; saving sends only
// what changed, and the store is updated from the server's answer.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { OrgSettings, OrgSummary } from '../../../api/types';
import { brandVars } from '../../../lib/color';
import { setState, useDek } from '../../../store';
import { Button, Select, Switch, TextField, toast } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { DEFAULT_ORG_SETTINGS, refreshShell } from '../common/context';
import { editWindowChoices, editWindowFromValue, editWindowValue, expiryChoices } from '../common/format';
import { fieldFromHint, useAction, useLoad } from '../common/load';
import { Card, ErrorView, FormError, Loading, Section } from '../common/ui';
import { clean, hasErrors, isHexColor, normalizeHexColor, validateOrg } from '../common/validation';

type OrgDetails = OrgSummary & { settings: OrgSettings };

// The confirmed organization everywhere the app shows it (switcher, header colors).
function patchStoreOrg(o: OrgDetails): void {
  const summary = { name: o.name, short_name: o.short_name, brand_color: o.brand_color, logo_path: o.logo_path };
  setState((s) => ({
    org: s.org && s.org.id === o.id ? { ...s.org, ...summary, settings: o.settings } : s.org,
    orgs: s.orgs.map((x) => (x.id === o.id ? { ...x, ...summary } : x)),
    me: s.me ? { ...s.me, orgs: s.me.orgs.map((x) => (x.id === o.id ? { ...x, ...summary } : x)) } : s.me,
  }));
}

export function OrgSettingsSection({ ctx }: { ctx: AdminCtx }) {
  const boot = useDek((s) => (s.org && s.org.id === ctx.orgId ? s.org : null));
  // The shell has the selected organization from bootstrap; a deep link before that
  // finished asks once.
  const load = useLoad(() => api.bootstrap(ctx.orgId).then((b) => b.org), [ctx.orgId], { key: `orgdetails:${ctx.orgId}`, enabled: !boot });
  const org: OrgDetails | null = boot ?? load.data;
  if (!org) {
    return load.status === 'error' && load.error
      ? <ErrorView error={load.error} onRetry={load.reload} what="organization settings" />
      : <Loading label="Loading organization settings" />;
  }
  return <OrgForm key={org.id} org={org} onSaved={(o) => load.mutate(() => o)} />;
}

function OrgForm({ org, onSaved }: { org: OrgDetails; onSaved: (o: OrgDetails) => void }) {
  const cur: OrgSettings = { ...DEFAULT_ORG_SETTINGS, ...org.settings };
  const [name, setName] = useState(org.name);
  const [shortName, setShortName] = useState(org.short_name ?? '');
  const [color, setColor] = useState(org.brand_color.toUpperCase());
  const [allowGuests, setAllowGuests] = useState(cur.allow_guests);
  const [createChannels, setCreateChannels] = useState(cur.member_can_create_channels);
  const [canInvite, setCanInvite] = useState(cur.member_can_invite);
  const [editWindow, setEditWindow] = useState<number | null>(cur.edit_window_minutes);
  const [inviteHours, setInviteHours] = useState(cur.default_invite_hours);
  const [touched, setTouched] = useState(false);

  const hex = normalizeHexColor(color);
  const errors = validateOrg({ name, short_name: shortName, brand_color: color, edit_window_minutes: editWindow, default_invite_hours: inviteHours });

  const patch: Parameters<typeof api.updateOrg>[1] = {};
  if (clean(name) !== org.name) patch.name = clean(name);
  if ((clean(shortName) || null) !== (org.short_name ?? null)) patch.short_name = clean(shortName);
  if (isHexColor(hex) && hex.toUpperCase() !== org.brand_color.toUpperCase()) patch.brand_color = hex;
  const settings: Partial<OrgSettings> = {};
  if (allowGuests !== cur.allow_guests) settings.allow_guests = allowGuests;
  if (createChannels !== cur.member_can_create_channels) settings.member_can_create_channels = createChannels;
  if (canInvite !== cur.member_can_invite) settings.member_can_invite = canInvite;
  if (editWindow !== cur.edit_window_minutes) settings.edit_window_minutes = editWindow;
  if (inviteHours !== cur.default_invite_hours) settings.default_invite_hours = inviteHours;
  if (Object.keys(settings).length) patch.settings = settings;
  const dirty = Object.keys(patch).length > 0;

  const act = useAction(() => api.updateOrg(org.id, patch));
  const field = fieldFromHint(act.error, ['name', 'short_name', 'brand_color', 'edit_window_minutes', 'default_invite_hours']);
  const show = (k: keyof typeof errors): string | null => {
    const local = touched ? errors[k] : undefined;
    if (local) return local;
    return field === k ? act.error?.hint ?? null : null;
  };

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors) || !dirty) return;
    const r = await act.run();
    if (!r.ok) return;
    patchStoreOrg(r.value);
    onSaved(r.value);
    refreshShell();
    setTouched(false);
    toast({ kind: 'success', title: 'Organization settings saved', body: 'Everyone sees the change at once.' });
  };
  const reset = () => {
    setName(org.name);
    setShortName(org.short_name ?? '');
    setColor(org.brand_color.toUpperCase());
    setAllowGuests(cur.allow_guests);
    setCreateChannels(cur.member_can_create_channels);
    setCanInvite(cur.member_can_invite);
    setEditWindow(cur.edit_window_minutes);
    setInviteHours(cur.default_invite_hours);
    setTouched(false);
    act.reset();
  };

  const preview = brandVars(isHexColor(hex) ? hex : org.brand_color);
  const previewName = clean(name) || org.name;

  return (
    <Section title="Organization" description="How the organization looks in Dek, and what its members may do. Changes reach everyone at once.">
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Card>
          <h3 className="ap-card__title">Name and color</h3>
          <TextField label="Name" value={name} maxLength={100} error={show('name')} onChange={(e) => setName(e.target.value)} />
          <TextField label="Short name (optional)" value={shortName} maxLength={40} error={show('short_name')}
            hint="Where space is tight, such as the organization switcher." onChange={(e) => setShortName(e.target.value)} />
          <div className="adm-color">
            <TextField label="Brand color" value={color} maxLength={7} spellCheck={false} autoCapitalize="characters" error={show('brand_color')}
              hint="Colors the organization's header and icon, so it is clear which organization you are in." onChange={(e) => setColor(e.target.value)} />
            <input
              type="color"
              className="adm-color__picker"
              aria-label="Pick the brand color"
              value={(isHexColor(hex) ? hex : org.brand_color).toLowerCase()}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
            />
          </div>
          <div className="adm-orgpreview" aria-hidden="true">
            <span className="adm-orgpreview__mark" style={{ background: preview.org, color: preview.orgFg }}>
              {(clean(shortName) || previewName).charAt(0).toUpperCase()}
            </span>
            <span className="adm-orgpreview__bar" style={{ background: preview.org, color: preview.orgFg }}>
              <span className="ap-truncate" dir="auto">{previewName}</span>
            </span>
          </div>
        </Card>

        <Card>
          <h3 className="ap-card__title">What members may do</h3>
          <div className="adm-switches">
            <Switch label="Guests" description="People from outside can be invited to single channels. Turning this off keeps current guests." checked={allowGuests} onChange={setAllowGuests} />
            <Switch label="Members create channels and team servers" description="Off: only admins create them." checked={createChannels} onChange={setCreateChannels} />
            <Switch label="Members send invite links" description="Off: only admins and server admins invite." checked={canInvite} onChange={setCanInvite} />
          </div>
          <div className="ap-form__grid">
            <Select
              label="Messages can be edited"
              value={editWindowValue(editWindow)}
              error={show('edit_window_minutes')}
              onChange={(e) => setEditWindow(editWindowFromValue(e.target.value))}
              options={editWindowChoices(cur.edit_window_minutes).map((c) => ({ value: editWindowValue(c.minutes), label: c.label }))}
            />
            <Select
              label="New invite links last"
              value={String(inviteHours)}
              error={show('default_invite_hours')}
              onChange={(e) => setInviteHours(Number(e.target.value))}
              options={expiryChoices(cur.default_invite_hours).map((c) => ({ value: String(c.hours), label: c.label.replace(' (organization default)', ' (current)') }))}
            />
          </div>
        </Card>

        <FormError error={act.error} onRetry={submit} hidden={!!field} />
        <div className="ap-form__actions">
          <Button variant="ghost" onClick={reset} disabled={!dirty || act.busy}>Undo changes</Button>
          <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty}>Save changes</Button>
        </div>
      </form>
    </Section>
  );
}
