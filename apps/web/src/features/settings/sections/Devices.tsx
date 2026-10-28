// Devices that receive notifications (DEK14 per device status, DEK15): each
// browser or app with when it last got a notification and what went wrong last;
// remove one with unregister_push_device.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Device } from '../../../api/types';
import { Icon } from '../../../ui/icons';
import { Button, ConfirmDialog, EmptyState, toast } from '../../../ui/kit';
import { relTime } from '../../admin/common/format';
import { useAction, useLoad } from '../../admin/common/load';
import { linkProps } from '../../admin/common/nav';
import { Dot, FormError, Gate, List, Pill, Row, Section, TimeText, type PillTone } from '../../admin/common/ui';

const KIND_LABEL: Record<Device['kind'], string> = { webpush: 'Browser', fcm: 'Android app', apns: 'iPhone app' };

export function deviceState(d: Device): { tone: PillTone; label: string; detail: string } {
  if (!d.enabled) return { tone: 'neutral', label: 'Off', detail: d.last_status ? `Stopped: ${d.last_status}` : 'Notifications are off on this device.' };
  const failedLast = !!d.last_attempt_at && (!d.last_success_at || Date.parse(d.last_attempt_at) > Date.parse(d.last_success_at));
  if (failedLast && d.failure_count > 0) {
    return { tone: 'danger', label: 'Failing', detail: `The last ${d.failure_count > 1 ? `${d.failure_count} attempts` : 'attempt'} failed${d.last_status ? `: ${d.last_status}` : ''}.` };
  }
  if (d.last_success_at) return { tone: 'success', label: 'Working', detail: `Last notification accepted ${relTime(d.last_success_at)}.` };
  return { tone: 'neutral', label: 'Ready', detail: 'Nothing sent to it yet.' };
}

export function DevicesSection() {
  const load = useLoad(() => api.listMyDevices(), [], { key: 'devices' });
  const [removing, setRemoving] = useState<Device | null>(null);
  return (
    <Section
      title="Devices"
      description="Browsers and apps where you turned on notifications. Accepted means the push service took it; your device can still hold it back, for example in a focus mode."
    >
      <Gate
        load={load}
        what="device list"
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon="smartphone" title="No devices yet" body={<>Turn on notifications on this device in <a {...linkProps({ name: 'settings', section: 'health' })}>Notification health</a>.</>} />}
      >
        {(list) => (
          <List label="Devices">
            {list.map((d) => {
              const st = deviceState(d);
              return (
                <Row
                  key={d.id}
                  muted={!d.enabled}
                  leading={<span className="adm-roundicon" aria-hidden="true"><Icon name={d.kind === 'webpush' ? 'globe' : 'smartphone'} size={18} /></span>}
                  title={<><span>{d.label || d.platform || KIND_LABEL[d.kind]}</span><Pill tone={st.tone}>{st.label}</Pill></>}
                  meta={(
                    <>
                      <span>{KIND_LABEL[d.kind]}</span>
                      <Dot />
                      <TimeText iso={d.created_at} prefix="added" />
                      {d.last_seen_at ? <><Dot /><TimeText iso={d.last_seen_at} prefix="last seen" /></> : null}
                    </>
                  )}
                  trailing={<Button variant="ghost" icon="trash" onClick={() => setRemoving(d)}>Remove</Button>}
                >
                  <p className="ap-hint">{st.detail}</p>
                </Row>
              );
            })}
          </List>
        )}
      </Gate>
      {removing ? (
        <RemoveDevice
          device={removing}
          onClose={() => setRemoving(null)}
          onDone={() => load.mutate((prev) => (prev ? prev.filter((x) => x.id !== removing.id) : prev))}
        />
      ) : null}
    </Section>
  );
}

function RemoveDevice({ device, onClose, onDone }: { device: Device; onClose: () => void; onDone: () => void }) {
  const act = useAction(() => api.unregisterPushDevice({ device: device.id }));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    toast({ kind: 'success', title: 'Device removed', body: 'It gets no more notifications from Dek.' });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Remove ${device.label || KIND_LABEL[device.kind]}?`}
      body={(
        <div className="ap-form">
          <p>It stops getting Dek notifications. You can turn them on again from that device later. Unread counts inside Dek are not affected.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Remove device"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
