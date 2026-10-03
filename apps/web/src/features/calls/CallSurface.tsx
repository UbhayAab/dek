// The call while it happens (DEK21): full screen on phones (with a pill to get
// back to chat), a movable compact panel on desktop. States: starting, ringing,
// connecting, connected, reconnecting, and the endings (ended, declined,
// unavailable). Controls: mute, camera for video calls, input, output and camera
// selection, and leave. Participants are listed once per person with a speaking
// ring from the engine's analysers.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Banner, Button, IconButton, Select } from '../../ui/kit';
import { MIcon } from '../media/icons';
import { sinkSupported } from './devices';
import type { CallView, PeerView } from './engine';
import { isLiveStatus, joinedPeople, useCallView, useElapsed, useIsPhone } from './hooks';
import { displayName, useCallTitle, useProfiles } from './names';
import { callEngine } from './runtime';
import './calls.css';

function statusText(v: CallView, elapsed: string, alone: boolean): string {
  if (v.final) return v.endTitle ?? 'Call ended';
  switch (v.status) {
    case 'starting': return v.busy === 'answer' ? 'Answering' : v.busy === 'join' ? 'Joining' : 'Starting the call';
    case 'ringing': return 'Ringing';
    case 'connecting': return 'Connecting';
    case 'connected': return alone ? 'You are the only one here' : `Connected ${elapsed}`.trim();
    case 'reconnecting': return 'Reconnecting';
    case 'unavailable': return 'Could not connect';
    default: return '';
  }
}

const PEER_LABEL: Partial<Record<PeerView['state'], string>> = {
  new: 'Connecting', connecting: 'Connecting', reconnecting: 'Reconnecting', failed: 'Could not connect',
};

function VideoEl({ stream, mirror, label }: { stream: MediaStream; mirror?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    return () => { el.srcObject = null; };
  }, [stream]);
  // Audio plays through the hidden audio elements; video elements stay muted.
  return <video ref={ref} className={`dc-video${mirror ? ' is-mirror' : ''}`} autoPlay playsInline muted aria-label={label} />;
}

function Tile({ name, userId, avatarPath, speaking, muted, badge, stream, video, self, mirror }: {
  name: string; userId: string; avatarPath?: string | null; speaking: boolean; muted?: boolean; badge?: string;
  stream?: MediaStream | null; video?: boolean; self?: boolean; mirror?: boolean;
}) {
  return (
    <li className={`dc-tile${speaking ? ' is-speaking' : ''}${video && stream ? ' has-video' : ''}`} data-user={userId} data-self={self ? '1' : undefined}>
      {video && stream ? <VideoEl stream={stream} mirror={mirror} label={self ? 'Your camera' : `${name}'s camera`} /> : (
        <span className="dc-tile__avatar"><Avatar name={name} path={avatarPath} seed={userId} size={56} /></span>
      )}
      <span className="dc-tile__name" dir="auto">
        {muted ? <Icon name="micOff" size={14} aria-hidden="true" /> : null}
        <span>{self ? 'You' : name}</span>
      </span>
      {badge ? <span className="dc-tile__badge">{badge}</span> : null}
      {speaking ? <span className="sr-only">speaking</span> : null}
    </li>
  );
}

function Stage({ v }: { v: CallView }) {
  const me = useDek((s) => s.session.userId);
  const people = joinedPeople(v.call).filter((p) => p.user_id !== me);
  const ringing = v.kind === 'direct' ? (v.call?.participants ?? []).filter((p) => p.user_id !== me && p.state === 'ringing') : [];
  const ids = [...people.map((p) => p.user_id), ...ringing.map((p) => p.user_id), me];
  const profiles = useProfiles(ids);
  const self = me ? profiles[me] : undefined;
  const local = v.local;
  return (
    <ul className={`dc-stage dc-stage--${Math.min(people.length + ringing.length + 1, 8)}`} aria-label="People in the call">
      {people.map((p) => {
        const peer = p.session_id ? v.peers[p.session_id] : undefined;
        const name = displayName(profiles[p.user_id]);
        return (
          <Tile
            key={p.user_id}
            userId={p.user_id}
            name={name}
            avatarPath={profiles[p.user_id]?.avatar_path}
            speaking={!!peer?.speaking}
            badge={peer ? PEER_LABEL[peer.state] : 'Connecting'}
            stream={peer?.stream}
            video={!!peer?.video}
          />
        );
      })}
      {ringing.map((p) => (
        <Tile key={p.user_id} userId={p.user_id} name={displayName(profiles[p.user_id])} avatarPath={profiles[p.user_id]?.avatar_path} speaking={false} badge="Ringing" />
      ))}
      {me ? (
        <Tile
          key="self"
          self
          mirror
          userId={me}
          name={displayName(self, 'You')}
          avatarPath={self?.avatar_path}
          speaking={v.speakingSelf && !v.muted}
          muted={v.muted || v.listenOnly}
          stream={local}
          video={v.cameraOn && !!local}
        />
      ) : null}
    </ul>
  );
}

function DevicePicker({ v, onClose }: { v: CallView; onClose: () => void }) {
  useEffect(() => { void callEngine.refreshDevices(); }, []);
  const opts = (list: MediaDeviceInfo[], fallback: string) => list.map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  const inputs = opts(v.devices.audioinput, 'Microphone');
  const outputs = opts(v.devices.audiooutput, 'Speaker');
  const cameras = opts(v.devices.videoinput, 'Camera');
  return (
    <div className="dc-devices" role="group" aria-label="Call devices">
      {inputs.length ? (
        <Select label="Microphone" options={inputs} value={v.inputId ?? inputs[0]?.value ?? ''} disabled={v.listenOnly}
          onChange={(e) => { void callEngine.setInput(e.currentTarget.value); }} />
      ) : <p className="dc-devices__note">No microphone is available to choose.</p>}
      {sinkSupported() && outputs.length ? (
        <Select label="Speaker" options={outputs} value={v.outputId ?? outputs[0]?.value ?? ''}
          onChange={(e) => callEngine.setOutput(e.currentTarget.value)} />
      ) : <p className="dc-devices__note">This browser plays calls through the system speaker. Change it in your system sound settings.</p>}
      {v.media === 'video' && cameras.length ? (
        <Select label="Camera" options={cameras} value={v.cameraId ?? cameras[0]?.value ?? ''}
          onChange={(e) => { void callEngine.setCamera(e.currentTarget.value); }} />
      ) : null}
      <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
    </div>
  );
}

function Control({ icon, label, pressed, danger, disabled, onClick }: {
  icon: ReactNode; label: string; pressed?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`dc-ctl${danger ? ' dc-ctl--danger' : ''}${pressed ? ' is-on' : ''}`}
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="dc-ctl__icon">{icon}</span>
      <span className="dc-ctl__label" aria-hidden="true">{label}</span>
    </button>
  );
}

function Controls({ v }: { v: CallView }) {
  const [devices, setDevices] = useState(false);
  const leaving = v.busy === 'leave';
  return (
    <>
      {devices ? <DevicePicker v={v} onClose={() => setDevices(false)} /> : null}
      <div className="dc-controls" role="toolbar" aria-label="Call controls">
        <Control
          icon={<Icon name={v.muted || v.listenOnly ? 'micOff' : 'mic'} size={22} />}
          label={v.listenOnly ? 'No microphone' : v.muted ? 'Unmute' : 'Mute'}
          pressed={v.muted}
          disabled={v.listenOnly || !v.local}
          onClick={() => callEngine.toggleMute()}
        />
        {v.media === 'video' ? (
          <Control
            icon={<Icon name={v.cameraOn ? 'video' : 'videoOff'} size={22} />}
            label={v.cameraOn ? 'Camera off' : 'Camera on'}
            pressed={!v.cameraOn}
            onClick={() => { void callEngine.toggleCamera(); }}
          />
        ) : null}
        <Control icon={<MIcon name="sliders" size={22} />} label="Devices" pressed={devices} onClick={() => setDevices((d) => !d)} />
        <Control
          icon={<Icon name="phoneOff" size={22} />}
          label={v.kind === 'room' ? 'Leave' : v.status === 'ringing' ? 'Cancel' : 'End'}
          danger
          disabled={leaving}
          onClick={() => { void callEngine.leave(); }}
        />
      </div>
    </>
  );
}

function Banners({ v, title }: { v: CallView; title: string }) {
  return (
    <div className="dc-banners">
      {v.status === 'unavailable' && !v.final ? (
        <Banner tone="danger" action={<Button size="sm" onClick={() => callEngine.reconnect()}>Try again</Button>}>
          <span dir="auto">{`The call could not connect to ${title}.`}</span>
        </Banner>
      ) : null}
      {v.relayWarning ? (
        <Banner tone="warning">
          The call relay is not available right now. On restrictive networks, such as some mobile data and office Wi-Fi,
          calls cannot connect without it. Try another network, or send a message instead.
        </Banner>
      ) : null}
      {v.listenOnly ? <Banner tone="info">You joined without a microphone. You can listen; others cannot hear you.</Banner> : null}
      {v.notice ? <Banner tone="info">{v.notice}</Banner> : null}
    </div>
  );
}

function FinalState({ v }: { v: CallView }) {
  const icon = v.status === 'declined' ? 'phoneOff' : v.status === 'unavailable' ? 'alert' : 'check';
  return (
    <div className="dc-final" role="status">
      <span className={`dc-final__icon dc-final__icon--${v.status}`}><Icon name={icon} size={26} /></span>
      <p className="dc-final__title">{v.endTitle}</p>
      {v.endBody ? <p className="dc-final__body">{v.endBody}</p> : null}
      <div className="dc-final__actions">
        {v.kind === 'direct' && v.channelId && v.status !== 'ended' ? (
          <Button variant="primary" onClick={() => { const c = v.channelId as string; const m = v.media; callEngine.dismissFinal(); void callEngine.startDirect(c, m); }}>
            Call again
          </Button>
        ) : null}
        <Button onClick={() => callEngine.dismissFinal()}>Close</Button>
      </div>
    </div>
  );
}

function Body({ v, layout, handle, onMinimize, collapsed, onCollapse }: {
  v: CallView; layout: 'full' | 'panel'; handle?: ReactNode; onMinimize?: () => void; collapsed?: boolean; onCollapse?: () => void;
}) {
  const me = useDek((s) => s.session.userId);
  const title = useCallTitle(v.channelId, v.call);
  const elapsed = useElapsed(v.status === 'connected' ? v.connectedAt : null);
  const alone = v.kind === 'room' && joinedPeople(v.call).filter((p) => p.user_id !== me).length === 0;
  return (
    <>
      <header className="dc-head">
        {handle}
        {onMinimize && !v.final ? <IconButton icon="chevronLeft" label="Back to chat" className="dc-headbtn" onClick={onMinimize} /> : null}
        <div className="dc-head__text">
          <h2 className="dc-title" dir="auto">{title}</h2>
          <p className="dc-status" data-status={v.status} aria-live="polite">
            <span className="dc-dot" aria-hidden="true" />
            {statusText(v, elapsed, alone)}
          </p>
        </div>
        {onCollapse ? (
          <IconButton icon={collapsed ? 'chevronDown' : 'chevronRight'} label={collapsed ? 'Show the call' : 'Make the call panel smaller'}
            className="dc-headbtn" onClick={onCollapse} />
        ) : null}
      </header>
      {v.final ? <FinalState v={v} /> : collapsed ? (
        <div className="dc-compact"><Controls v={v} /></div>
      ) : (
        <div className={`dc-main dc-main--${layout}`}>
          <Banners v={v} title={title} />
          <Stage v={v} />
          <Controls v={v} />
        </div>
      )}
    </>
  );
}

function Pill({ onExpand }: { onExpand: () => void }) {
  const v = useCallView((s) => s);
  const title = useCallTitle(v.channelId, v.call);
  const elapsed = useElapsed(v.status === 'connected' ? v.connectedAt : null);
  return (
    <div className="dc-pill" role="region" aria-label="Call in progress" data-status={v.status}>
      <button type="button" className="dc-pill__main" onClick={onExpand} aria-label={`Return to the call with ${title}`}>
        <span className="dc-dot" aria-hidden="true" />
        <span className="dc-pill__title" dir="auto">{title}</span>
        <span className="dc-pill__time">{v.status === 'connected' ? elapsed : statusText(v, elapsed, false)}</span>
      </button>
      <button type="button" className="dc-pill__btn" onClick={() => callEngine.toggleMute()} aria-pressed={v.muted}
        aria-label={v.muted ? 'Unmute microphone' : 'Mute microphone'} disabled={v.listenOnly || !v.local}>
        <Icon name={v.muted || v.listenOnly ? 'micOff' : 'mic'} size={20} />
      </button>
      <button type="button" className="dc-pill__btn dc-pill__btn--end" onClick={() => { void callEngine.leave(); }} aria-label="Leave the call">
        <Icon name="phoneOff" size={20} />
      </button>
    </div>
  );
}

const PANEL_MARGIN = 12;
const KEY_STEP = 24;

function Panel() {
  const v = useCallView((s) => s);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const clamp = (x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 360;
    const h = el?.offsetHeight ?? 240;
    return {
      x: Math.min(Math.max(PANEL_MARGIN, x), Math.max(PANEL_MARGIN, window.innerWidth - w - PANEL_MARGIN)),
      y: Math.min(Math.max(PANEL_MARGIN, y), Math.max(PANEL_MARGIN, window.innerHeight - h - PANEL_MARGIN)),
    };
  };

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  };
  const onUp = () => { drag.current = null; };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    setPos(clamp(r.left + m[0], r.top + m[1]));
  };

  const handle = (
    <button type="button" className="dc-grip" aria-label="Move the call panel (arrow keys)" onPointerDown={onDown} onPointerMove={onMove}
      onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
      <MIcon name="grip" size={18} />
    </button>
  );
  return (
    <section
      ref={ref}
      className={`dc-surface dc-panel${collapsed ? ' is-collapsed' : ''}`}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      aria-label="Call"
      data-status={v.status}
    >
      <Body v={v} layout="panel" handle={handle} collapsed={collapsed} onCollapse={v.final ? undefined : () => setCollapsed((c) => !c)} />
    </section>
  );
}

export function CallSurface() {
  const status = useCallView((s) => s.status);
  const final = useCallView((s) => s.final);
  const phone = useIsPhone();
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    if (status === 'idle' || final) setMinimized(false);
  }, [status, final]);
  if (status === 'idle') return null;
  if (!phone) return <Panel />;
  if (minimized && isLiveStatus(status)) return <Pill onExpand={() => setMinimized(false)} />;
  return <FullScreen onMinimize={() => setMinimized(true)} />;
}

function FullScreen({ onMinimize }: { onMinimize: () => void }) {
  const v = useCallView((s) => s);
  return (
    <section className="dc-surface dc-full" aria-label="Call" data-status={v.status}>
      <Body v={v} layout="full" onMinimize={onMinimize} />
    </section>
  );
}
