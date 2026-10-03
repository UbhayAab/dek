// Create a channel in a team server (CONTRACT 2.3 create_channel, DEK02, DEK03):
// text or audio room, public or private, announcement posting, topic, auto join,
// and people from anywhere in the organization for cross-team work.
import { useState } from 'react';
import { api } from '../../api/rpc';
import type { Channel, Profile, Server } from '../../api/types';
import { Icon, type IconName } from '../../ui/icons';
import { Button, Modal, Switch, TextArea, TextField } from '../../ui/kit';
import { fieldFromHint, useAction } from './common/load';
import { PeoplePicker } from './common/PeoplePicker';
import { FormError, RadioGroup } from './common/ui';
import { hasErrors, validateChannel } from './common/validation';

export function channelIcon(c: Pick<Channel, 'kind' | 'visibility' | 'posting_policy'>): IconName {
  if (c.kind === 'audio') return 'volume';
  if (c.visibility === 'private') return 'lock';
  if (c.posting_policy === 'admins') return 'megaphone';
  return 'hash';
}

export function ChannelName({ c }: { c: Pick<Channel, 'kind' | 'visibility' | 'posting_policy' | 'name'> }) {
  return (
    <span className="adm-channel-name">
      <Icon name={channelIcon(c)} size={16} />
      <span dir="auto">{c.name ?? 'Untitled'}</span>
    </span>
  );
}

interface Props {
  orgId: string;
  server: Server;
  serverAdmin: boolean;
  onClose: () => void;
  onCreated: (c: Channel) => void;
}

export function CreateChannelDialog({ orgId, server, serverAdmin, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'text' | 'audio'>('text');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [announcement, setAnnouncement] = useState(false);
  const [topic, setTopic] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [autoJoin, setAutoJoin] = useState(false);
  const [people, setPeople] = useState<Profile[]>([]);
  const [touched, setTouched] = useState(false);
  const errors = validateChannel({ name, topic, description, category });
  const act = useAction(() => api.createChannel({
    server: server.id,
    name: name.trim(),
    kind,
    visibility,
    topic: topic.trim() || null,
    description: description.trim() || null,
    postingPolicy: announcement ? 'admins' : 'everyone',
    memberIds: people.map((p) => p.id),
    autoJoin: serverAdmin && visibility === 'public' ? autoJoin : false,
    category: category.trim() || null,
  }));
  const field = fieldFromHint(act.error, ['name', 'topic', 'description', 'category', 'kind', 'visibility']);
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
    <Modal open size="md" title={`New channel in ${server.name}`} onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.busy}>Create channel</Button>
        </>
      )}>
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="Name" value={name} maxLength={100} autoFocus placeholder="grants" error={show('name')} onChange={(e) => setName(e.target.value)} />
        <RadioGroup
          legend="Type"
          compact
          value={kind}
          onChange={setKind}
          options={[
            { value: 'text', label: 'Text channel', description: 'Messages, threads and files' },
            { value: 'audio', label: 'Audio room', description: 'Drop in voice room, up to 8 people' },
          ]}
        />
        <RadioGroup
          legend="Who can see it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'public', label: 'Public in this server', description: `Everyone in ${server.name} can find and join it.` },
            { value: 'private', label: 'Private', description: 'Only the people you add (and you). They can be from other teams.' },
          ]}
        />
        <TextField label="Topic (optional)" value={topic} maxLength={300} error={show('topic')} hint="One line under the channel name." onChange={(e) => setTopic(e.target.value)} />
        <TextArea label="Description (optional)" rows={2} value={description} error={show('description')} onChange={(e) => setDescription(e.target.value)} />
        <TextField label="Category (optional)" value={category} maxLength={60} error={show('category')} hint="Groups channels in the sidebar, for example Projects." onChange={(e) => setCategory(e.target.value)} />
        <div className="adm-switches">
          <Switch
            label="Announcement channel"
            description="Only admins post. Everyone can read, react and reply if you allow it."
            checked={announcement}
            onChange={setAnnouncement}
          />
          {serverAdmin && visibility === 'public' ? (
            <Switch
              label="Everyone joins automatically"
              description={`Current and new members of ${server.name} join it.`}
              checked={autoJoin}
              onChange={setAutoJoin}
            />
          ) : null}
        </div>
        <PeoplePicker
          orgId={orgId}
          selected={people}
          onChange={setPeople}
          label={visibility === 'private' ? 'Add people' : 'Add people now (optional)'}
          hint={visibility === 'private'
            ? 'Anyone in the organization, also from other team servers. They see this channel and nothing else of this server.'
            : 'They join the channel at once.'}
          max={200}
        />
        <FormError error={act.error} onRetry={submit} hidden={!!field} />
      </form>
    </Modal>
  );
}
