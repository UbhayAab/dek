// The quieter parts of the call layer: the audio elements that carry the other
// people's voices (mounted for the whole call, whatever the screen shows), the
// dialog after a refused microphone (DEK24), and the note that this person is in
// a call on another device or tab.
import { useEffect, useRef, useState } from 'react';
import type { Call } from '../../api/types';
import { api } from '../../api/rpc';
import { useDek } from '../../store';
import { Button, Modal } from '../../ui/kit';
import { applySink } from './devices';
import { isLiveStatus, useCallView } from './hooks';
import { useCallTitle } from './names';
import { callEngine } from './runtime';
import './calls.css';

function PeerAudio({ stream, sink, onBlocked }: { stream: MediaStream; sink: string | null; onBlocked: (el: HTMLAudioElement) => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream;
    el.play().catch((e: unknown) => {
      if ((e as { name?: string }).name === 'NotAllowedError') onBlocked(el);
    });
    return () => {
      el.pause();
      el.srcObject = null;
    };
  }, [stream, onBlocked]);
  useEffect(() => {
    if (ref.current) void applySink(ref.current, sink);
  }, [sink]);
  return <audio ref={ref} autoPlay playsInline />;
}

export function RemoteAudio() {
  const peers = useCallView((v) => v.peers);
  const sink = useCallView((v) => v.outputId);
  const live = useCallView((v) => isLiveStatus(v.status));
  const [blocked, setBlocked] = useState<HTMLAudioElement[]>([]);
  const onBlocked = useRef((el: HTMLAudioElement) => setBlocked((b) => (b.includes(el) ? b : [...b, el]))).current;
  useEffect(() => { if (!live) setBlocked([]); }, [live]);
  if (!live) return null;
  return (
    <>
      <div className="dc-audio" aria-hidden="true">
        {Object.values(peers).map((p) => (p.stream ? <PeerAudio key={p.sessionId} stream={p.stream} sink={sink} onBlocked={onBlocked} /> : null))}
      </div>
      {blocked.length ? (
        <div className="dc-unblock">
          <Button variant="primary" onClick={() => {
            for (const el of blocked) void el.play().catch(() => undefined);
            setBlocked([]);
          }}>Turn on call sound</Button>
        </div>
      ) : null}
    </>
  );
}

export function PermissionDialog() {
  const problem = useCallView((v) => v.problem);
  return (
    <Modal
      open={!!problem}
      onClose={() => callEngine.dismissProblem()}
      title={problem?.title ?? ''}
      size="sm"
      footer={problem ? (
        <>
          <Button variant="ghost" onClick={() => callEngine.dismissProblem()}>Not now</Button>
          {problem.canListenOnly ? <Button onClick={() => { void callEngine.retryProblem(true); }}>Join without microphone</Button> : null}
          <Button variant="primary" onClick={() => { void callEngine.retryProblem(false); }}>Try again</Button>
        </>
      ) : null}
    >
      {problem ? (
        <div className="dc-perm">
          <p>{problem.body}</p>
          {problem.steps.length ? (
            <ol className="dc-perm__steps">
              {problem.steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
          ) : null}
          <p className="dc-perm__note">Messages, files and everything else in Dek keep working without it.</p>
        </div>
      ) : null}
    </Modal>
  );
}

// I am joined in a call that this tab is not part of: another device, another
// tab, or a page that closed without saying goodbye. Offer to continue here.
export function ElsewhereNote() {
  const uid = useDek((s) => s.session.userId);
  const calls = useDek((s) => s.calls);
  const mine = useCallView((v) => (isLiveStatus(v.status) || v.final ? v.callId ?? v.call?.id ?? null : null));
  const busy = useCallView((v) => isLiveStatus(v.status));
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const other: Call | undefined = Object.values(calls).find((c) => !c.ended_at && c.id !== mine && !dismissed[c.id]
    && c.participants.some((p) => p.user_id === uid && p.state === 'joined'));
  const title = useCallTitle(other?.channel_id ?? null, other ?? null);
  if (!other || busy) return null;
  return (
    <div className="dc-elsewhere" role="status" data-call={other.id}>
      <p dir="auto"><strong>{`You are in a call with ${title}`}</strong> on another device or tab.</p>
      <div className="dc-elsewhere__actions">
        <Button size="sm" variant="primary" onClick={() => { void callEngine.answer(other.id); }}>Continue here</Button>
        <Button size="sm" onClick={() => {
          setDismissed((d) => ({ ...d, [other.id]: true }));
          void api.leaveCall(other.id).catch(() => undefined);
        }}>Leave that call</Button>
      </div>
    </div>
  );
}
