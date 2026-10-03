// Team servers (DEK01, DEK05): every server of the organization, create one,
// archive and unarchive, and the way into each server's settings.
import { useEffect, useState } from 'react';
import { api } from '../../../api/rpc';
import type { Server } from '../../../api/types';
import { Button, ConfirmDialog, EmptyState, Modal, TextArea, TextField, toast } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { refreshShell, useServers } from '../common/context';
import { JOIN_POLICY, plural, SERVER_ROLE_LABEL } from '../common/format';
import { fieldFromHint, invalidate, useAction } from '../common/load';
import { go, linkProps, pathWithHash, useHashValue } from '../common/nav';
import { Dot, FormError, Gate, List, Pill, RadioGroup, Row, Section } from '../common/ui';
import { hasErrors, validateServer } from '../common/validation';

export function ServerMark({ server, size = 36 }: { server: Pick<Server, 'name' | 'icon_emoji'>; size?: number }) {
  return (
    <span className="adm-servermark" style={{ width: size, height: size }} aria-hidden="true">
      {server.icon_emoji || server.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function ServersSection({ ctx }: { ctx: AdminCtx }) {
  const servers = useServers(ctx.orgId);
  const hash = useHashValue();
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Server | null>(null);
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const unarchive = useAction((s: Server) => api.archiveServer(s.id, false));

  useEffect(() => {
    if (hash === 'new') setCreating(true);
  }, [hash]);
  const closeCreate = () => {
    setCreating(false);
    if (hash === 'new') go(pathWithHash(null), 'replace');
  };
  const replaceServer = (s: Server) => servers.mutate((prev) => (prev ? prev.map((x) => (x.id === s.id ? s : x)) : prev));
  const onUnarchive = async (s: Server) => {
    setUnarchivingId(s.id);
    const r = await unarchive.run(s);
    setUnarchivingId(null);
    if (r.ok) {
      replaceServer(r.value);
      refreshShell();
      toast({ kind: 'success', title: `${s.name} is active again` });
    }
  };

  return (
    <Section
      title="Team servers"
      description="Each team has a server; projects live in its channels. People from other teams can be added to single channels."
      actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create team server</Button>}
    >
      <Gate
        load={servers}
        what="server list"
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon="users" title="No team servers yet" body="Create one for each team, then add its people and channels." />}
      >
        {(list) => {
          const live = list.filter((s) => !s.archived);
          const archived = list.filter((s) => s.archived);
          const row = (s: Server) => (
            <Row
              key={s.id}
              muted={s.archived}
              leading={<ServerMark server={s} />}
              title={(
                <>
                  <span dir="auto">{s.name}</span>
                  {s.archived ? <Pill tone="neutral">Archived</Pill> : <Pill tone="accent">{JOIN_POLICY[s.join_policy].label}</Pill>}
                  {s.my_role ? <Pill>{SERVER_ROLE_LABEL[s.my_role]}</Pill> : null}
                </>
              )}
              meta={(
                <>
                  <span>{plural(s.member_count, 'member', 'members')}</span>
                  {s.description ? <><Dot /><span className="adm-clamp" dir="auto">{s.description}</span></> : null}
                </>
              )}
              trailing={(
                <>
                  <a className="dk-btn dk-btn--secondary dk-btn--md" {...linkProps({ name: 'serverSettings', orgId: ctx.orgId, serverId: s.id })}>Settings</a>
                  {s.archived
                    ? <Button onClick={() => onUnarchive(s)} loading={unarchivingId === s.id}>Unarchive</Button>
                    : <Button variant="ghost" icon="archive" onClick={() => setArchiving(s)}>Archive</Button>}
                </>
              )}
            />
          );
          return (
            <>
              <FormError error={unarchive.error} />
              {live.length ? <List label="Active team servers">{live.map(row)}</List> : <p className="ap-hint">Every team server is archived.</p>}
              {archived.length ? (
                <>
                  <h3 className="adm-subhead">Archived</h3>
                  <List label="Archived team servers">{archived.map(row)}</List>
                </>
              ) : null}
            </>
          );
        }}
      </Gate>

      {creating ? (
        <CreateServerDialog
          orgId={ctx.orgId}
          onClose={closeCreate}
          onCreated={(s) => {
            servers.mutate((prev) => (prev ? [...prev, s] : [s]));
            invalidate(`servers:${ctx.orgId}`);
            refreshShell();
            toast({ kind: 'success', title: `${s.name} is ready`, body: 'It has a #general channel. Add people and channels next.',
              action: { label: 'Open settings', onClick: () => go({ name: 'serverSettings', orgId: ctx.orgId, serverId: s.id }) } });
          }}
        />
      ) : null}
      {archiving ? (
        <ArchiveServerDialog
          server={archiving}
          onClose={() => setArchiving(null)}
          onDone={(s) => { replaceServer(s); refreshShell(); }}
        />
      ) : null}
    </Section>
  );
}

const POLICY_OPTIONS = (['invite', 'approval', 'open'] as const).map((p) => ({ value: p, label: JOIN_POLICY[p].label, description: JOIN_POLICY[p].description }));

export function CreateServerDialog({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (s: Server) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [policy, setPolicy] = useState<Server['join_policy']>('invite');
  const [touched, setTouched] = useState(false);
  const errors = validateServer({ name, description, icon_emoji: icon });
  const act = useAction(() => api.createServer(orgId, name.trim(), description.trim() || null, policy, icon.trim() || null));
  const field = fieldFromHint(act.error, ['name', 'description', 'icon_emoji', 'join_policy']);
  const show = (k: keyof typeof errors): string | null => {
    const local = touched ? errors[k] : undefined;
    if (local) return local;
    return field === k ? act.error?.hint ?? null : null;
  };
  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors)) return;
    const r = await act.run();
    if (!r.ok) return;
    onCreated(r.value);
    onClose();
  };
  return (
    <Modal open size="md" title="Create a team server" onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.busy}>Create</Button>
        </>
      )}>
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="adm-namegrid">
          <TextField label="Icon" hint="One emoji" value={icon} maxLength={16} error={show('icon_emoji')} onChange={(e) => setIcon(e.target.value)} />
          <TextField label="Name" value={name} maxLength={100} autoFocus error={show('name')} placeholder="Medical Partnerships" onChange={(e) => setName(e.target.value)} />
        </div>
        <TextArea label="Description (optional)" rows={3} value={description} error={show('description')} onChange={(e) => setDescription(e.target.value)} />
        <RadioGroup legend="Who can join" value={policy} options={POLICY_OPTIONS} onChange={setPolicy} />
        <p className="ap-hint">You become its server admin. It starts with a #general channel everyone in it joins.</p>
        <FormError error={act.error} onRetry={submit} hidden={!!field} />
      </form>
    </Modal>
  );
}

export function ArchiveServerDialog({ server, onClose, onDone }: { server: Server; onClose: () => void; onDone: (s: Server) => void }) {
  const act = useAction(() => api.archiveServer(server.id, true));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone(r.value);
    toast({ kind: 'success', title: `${server.name} is archived`, body: 'It is read only now. You can unarchive it later.' });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Archive ${server.name}?`}
      body={(
        <div className="ap-form">
          <p>Everything in it becomes read only: nobody can post, join, or be added, and its invite links stop working. Members can still read the history. You can unarchive it later.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Archive server"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
