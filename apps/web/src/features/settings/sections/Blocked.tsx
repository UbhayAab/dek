// Blocked people (DEK13): who you blocked, and unblock (with an undo).
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { Avatar, Button, EmptyState, toast } from '../../../ui/kit';
import { useAction, useLoad } from '../../admin/common/load';
import { setBlocked } from '../../conversation/blocks';
import { FormError, Gate, List, Row, Section } from '../../admin/common/ui';

export function BlockedSection() {
  const load = useLoad(() => api.listBlocks(), [], { key: 'blocks' });
  const [busyId, setBusyId] = useState<string | null>(null);
  // setBlocked also drops the shared block list, so an open DM composer updates
  const unblock = useAction((p: Profile) => setBlocked(p.id, false));
  const reblock = useAction((p: Profile) => setBlocked(p.id, true));

  const onUnblock = async (p: Profile) => {
    setBusyId(p.id);
    const r = await unblock.run(p);
    setBusyId(null);
    if (!r.ok) return;
    load.mutate((prev) => (prev ? { items: prev.items.filter((x) => x.id !== p.id) } : prev));
    toast({
      kind: 'success',
      title: `${p.display_name} is unblocked`,
      body: 'They can message you again.',
      action: {
        label: 'Undo',
        onClick: () => {
          void reblock.run(p).then((res) => {
            if (res.ok) load.mutate((prev) => (prev ? { items: [p, ...prev.items.filter((x) => x.id !== p.id)] } : prev));
            else toast({ kind: 'error', title: 'Could not block again', body: res.error?.hint });
          });
        },
      },
    });
  };

  return (
    <Section title="Blocked people" description="People you blocked cannot start or write in a direct message with you, and their mentions do not notify you. They are not told.">
      <FormError error={unblock.error} />
      <Gate load={load} what="list of blocked people" isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon="shield" title="You have not blocked anyone" body="Block someone from their profile or a message menu. You can unblock them here." />}>
        {(d) => (
          <List label="Blocked people">
            {d.items.map((p) => (
              <Row
                key={p.id}
                leading={<Avatar name={p.display_name} path={p.avatar_path} seed={p.id} size={36} />}
                title={<span dir="auto">{p.display_name}</span>}
                meta={p.handle ? <span>@{p.handle}</span> : null}
                trailing={<Button onClick={() => onUnblock(p)} loading={busyId === p.id}>Unblock</Button>}
              />
            ))}
          </List>
        )}
      </Gate>
    </Section>
  );
}
