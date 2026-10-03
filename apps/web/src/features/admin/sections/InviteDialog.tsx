// Create an invite link (CONTRACT 2.4 create_invite): who it is for (member or
// guest), which team server and channels it opens, an optional email it is locked
// to, expiry, use limit and approval. Shows the link with Copy and Share once the
// server has made it, never before.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Channel, InviteCreated, OrgSettings, Server } from '../../../api/types';
import { Button, IconButton, Modal, Select, Switch, TextField } from '../../../ui/kit';
import { inviteUrl } from '../common/context';
import { expiryChoices, formatDateTime, JOIN_POLICY } from '../common/format';
import { fieldFromHint, useAction, useLoad } from '../common/load';
import { Checkbox, ErrorView, FormError, LinkBox, Loading, RadioGroup } from '../common/ui';
import { clean, hasErrors, validateInvite, wholeNumber } from '../common/validation';

interface Props {
  orgId: string;
  orgName: string;
  settings: OrgSettings;
  servers: Server[];
  onClose: () => void;
  onCreated: (inv: InviteCreated) => void;
  // From a team server's settings: that server, already chosen.
  initialServerId?: string;
}

export function InviteDialog({ orgId, orgName, settings, servers, onClose, onCreated, initialServerId }: Props) {
  const live = servers.filter((s) => !s.archived);
  const [role, setRole] = useState<'member' | 'guest'>('member');
  const [serverId, setServerId] = useState(initialServerId ?? '');
  const [browse, setBrowse] = useState('');
  const [picked, setPicked] = useState<Channel[]>([]);
  const [email, setEmail] = useState('');
  const [hours, setHours] = useState(settings.default_invite_hours);
  const [maxUses, setMaxUses] = useState('');
  const [approval, setApproval] = useState(false);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const browseId = browse || (role === 'member' ? serverId : '') || live[0]?.id || '';
  const channels = useLoad(() => (browseId ? api.listChannels(browseId) : Promise.resolve([] as Channel[])), [browseId], { key: browseId ? `channels:${browseId}` : null });
  const errors = validateInvite({ email, expiresHours: hours, maxUses, channelCount: picked.length });
  const act = useAction(() => api.createInvite({
    org: orgId,
    server: role === 'member' && serverId ? serverId : null,
    channelIds: picked.map((c) => c.id),
    role,
    email: clean(email) || null,
    expiresHours: hours,
    maxUses: wholeNumber(maxUses),
    requiresApproval: approval,
  }));
  const serverField = fieldFromHint(act.error, ['email', 'expires_hours', 'max_uses', 'role'], { channel: 'channels', 'an invite can name': 'channels' });
  const show = (k: keyof typeof errors) => (touched ? errors[k] ?? null : null);

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors)) return;
    const r = await act.run();
    if (!r.ok) return;
    setCreated(r.value);
    onCreated(r.value);
  };

  const togglePick = (c: Channel) => {
    setPicked((prev) => (prev.some((x) => x.id === c.id) ? prev.filter((x) => x.id !== c.id) : [...prev, c]));
  };
  const serverName = (id: string | null) => servers.find((s) => s.id === id)?.name ?? '';
  const target = role === 'member' && serverId ? serverName(serverId) : null;

  if (created) {
    const url = inviteUrl(created.code);
    return (
      <Modal open size="md" title="Invite link ready" onClose={onClose}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setCreated(null); setTouched(false); act.reset(); }}>Create another</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        )}>
        <div className="ap-form">
          <p className="ap-card__text">
            Anyone with this link can {approval ? 'ask to join' : 'join'} {orgName}{target ? ` and ${target}` : ''}
            {role === 'guest' ? ' as a guest' : ''}{email ? `, signed in as ${clean(email)}` : ''}.
            The link works until {formatDateTime(created.expires_at)}{wholeNumber(maxUses) ? `, for ${wholeNumber(maxUses) === 1 ? 'one person' : `${wholeNumber(maxUses)} people`}` : ''}.
          </p>
          <LinkBox url={url} label="Invite link" shareTitle={`Join ${orgName} on Dek`} shareText={`You are invited to ${orgName} on Dek.`} />
          <p className="ap-hint">You can revoke it at any time from the invite list.</p>
        </div>
      </Modal>
    );
  }

  const roleOptions = [
    { value: 'member' as const, label: 'Member', description: 'Joins the organization, and the team server you pick.' },
    {
      value: 'guest' as const,
      label: 'Guest',
      description: settings.allow_guests ? 'Sees only the channels you pick. Never joins a team server.' : 'Guests are turned off for this organization.',
      disabled: !settings.allow_guests,
    },
  ];

  return (
    <Modal open size="md" title="Create an invite link" onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.busy}>Create link</Button>
        </>
      )}>
      <form className="ap-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <RadioGroup legend="Invite as" value={role} options={roleOptions} onChange={(v) => { setRole(v); act.reset(); }} compact />

        {role === 'member' ? (
          <Select
            label="Team server (optional)"
            hint={serverId ? JOIN_POLICY[servers.find((s) => s.id === serverId)?.join_policy ?? 'invite'].description : 'Without a server they join the organization only.'}
            value={serverId}
            onChange={(e) => { setServerId(e.target.value); setBrowse(''); }}
            options={[{ value: '', label: 'No team server' }, ...live.map((s) => ({ value: s.id, label: `${s.icon_emoji ? `${s.icon_emoji} ` : ''}${s.name}` }))]}
          />
        ) : null}

        <fieldset className="ap-radios">
          <legend className="ap-legend">Channels (optional)</legend>
          <p className="ap-hint">
            {role === 'guest'
              ? 'A guest sees only these channels. Without any, they see nothing until someone adds them.'
              : 'They also join these channels, including private ones and channels of other team servers.'}
          </p>
          {live.length > 1 ? (
            <Select label="Show channels in" value={browseId} onChange={(e) => setBrowse(e.target.value)}
              options={live.map((s) => ({ value: s.id, label: s.name }))} />
          ) : null}
          {channels.data === null
            ? (channels.status === 'error' && channels.error ? <ErrorView error={channels.error} onRetry={channels.reload} what="channel list" /> : <Loading rows={1} label="Loading channels" />)
            : (
              <div className="adm-channelpick">
                {channels.data.filter((c) => (c.kind === 'text' || c.kind === 'audio') && !c.archived).map((c) => (
                  <Checkbox
                    key={c.id}
                    label={`${c.kind === 'audio' ? 'Audio: ' : '#'}${c.name ?? ''}`}
                    description={c.visibility === 'private' ? 'Private' : c.topic ?? undefined}
                    checked={picked.some((x) => x.id === c.id)}
                    onChange={() => togglePick(c)}
                  />
                ))}
                {!channels.data.some((c) => (c.kind === 'text' || c.kind === 'audio') && !c.archived) ? <p className="ap-hint">No channels here you can share.</p> : null}
              </div>
            )}
          {picked.length ? (
            <ul className="ap-chips" aria-label="Chosen channels">
              {picked.map((c) => (
                <li key={c.id} className="ap-chip">
                  <span className="ap-chip__text">#{c.name} <span className="ap-meta">{serverName(c.server_id)}</span></span>
                  <IconButton icon="x" size="sm" label={`Remove #${c.name ?? ''}`} onClick={() => togglePick(c)} />
                </li>
              ))}
            </ul>
          ) : null}
          {show('channels') || (serverField === 'channels' ? act.error?.hint : null) ? <p className="ap-error-text" role="alert">{show('channels') ?? act.error?.hint}</p> : null}
        </fieldset>

        <TextField
          label="Only for this email (optional)"
          hint="The link then works only for the person signed in with this verified address."
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          error={show('email') ?? (serverField === 'email' ? act.error?.hint ?? null : null)}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="ap-form__grid">
          <Select
            label="Expires after"
            value={String(hours)}
            error={show('expires') ?? (serverField === 'expires_hours' ? act.error?.hint ?? null : null)}
            onChange={(e) => setHours(Number(e.target.value))}
            options={expiryChoices(settings.default_invite_hours).map((c) => ({ value: String(c.hours), label: c.label }))}
          />
          <TextField
            label="Use limit (optional)"
            hint="Empty means no limit."
            inputMode="numeric"
            pattern="[0-9]*"
            value={maxUses}
            error={show('max_uses') ?? (serverField === 'max_uses' ? act.error?.hint ?? null : null)}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </div>
        <Switch
          label="An admin approves each person"
          description="People who open the link ask to join; you decide in Join requests."
          checked={approval}
          onChange={setApproval}
        />
        <FormError error={act.error} onRetry={submit} hidden={!!serverField} />
      </form>
    </Modal>
  );
}
