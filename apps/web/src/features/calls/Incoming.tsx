// The incoming call sheet: from store.calls (call.ring and call.upd events), any
// direct call that is ringing for me and that this tab is not already in. A short
// WebAudio chime while it shows (silent under automation or when the page may
// not play audio). Accept and Decline are always visible buttons; the sheet is
// non-modal, so somebody typing a message is not yanked out of it.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Call } from '../../api/types';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar } from '../../ui/kit';
import { MIcon } from '../media/icons';
import { isLiveStatus, useCallView } from './hooks';
import { displayName, useCallTitle, useProfiles } from './names';
import { startRingtone } from './ringtone';
import { callEngine } from './runtime';
import './calls.css';

// The server marks a ring missed after 45 s; this is the backstop for a sheet
// whose ending never reached this tab.
const SHEET_MAX_MS = 60_000;

export function IncomingCalls() {
  const uid = useDek((s) => s.session.userId);
  const calls = useDek((s) => s.calls);
  const activeId = useCallView((v) => (isLiveStatus(v.status) ? v.callId : null));
  const [hidden, setHidden] = useState<Record<string, true>>({});
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());

  const ringing = useMemo(() => Object.values(calls).filter((c) => (
    !c.ended_at && c.kind === 'direct' && c.id !== activeId && !hidden[c.id] && !callEngine.wasDeclinedHere(c.id)
    && c.participants.some((p) => p.user_id === uid && p.state === 'ringing')
  )), [calls, uid, activeId, hidden]);

  useEffect(() => {
    const t = Date.now();
    for (const c of ringing) if (!firstSeen.current.has(c.id)) firstSeen.current.set(c.id, t);
    if (!ringing.length) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [ringing]);

  const visible = ringing.filter((c) => now - (firstSeen.current.get(c.id) ?? now) < SHEET_MAX_MS);
  const call = visible[visible.length - 1];
  if (!call) return null;
  return <IncomingSheet key={call.id} call={call} onHide={() => setHidden((h) => ({ ...h, [call.id]: true }))} />;
}

function IncomingSheet({ call, onHide }: { call: Call; onHide: () => void }) {
  const id = useId();
  const inCall = useCallView((v) => isLiveStatus(v.status));
  const caller = useProfiles([call.started_by])[call.started_by];
  const callerName = displayName(caller);
  const title = useCallTitle(call.channel_id, call);
  const group = useDek((s) => s.channels[call.channel_id]?.kind === 'group_dm');
  const kind = call.media === 'video' ? 'video call' : 'voice call';

  useEffect(() => startRingtone(), []);

  const accept = () => {
    onHide();
    void callEngine.answer(call.id);
  };
  const decline = () => {
    onHide();
    void callEngine.decline(call.id);
  };

  return (
    <div
      className="dc-incoming"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-kind`}
      data-call={call.id}
    >
      <p className="sr-only" aria-live="assertive">{`Incoming ${kind} from ${callerName}`}</p>
      <div className="dc-incoming__who">
        <Avatar name={callerName} path={caller?.avatar_path} seed={call.started_by} size={48} />
        <div className="dc-incoming__text">
          <p className="dc-incoming__name" id={`${id}-name`} dir="auto">{callerName}</p>
          <p className="dc-incoming__kind" id={`${id}-kind`}>
            {`Incoming ${kind}`}{group ? <span dir="auto">{` with ${title}`}</span> : null}
          </p>
          {inCall ? <p className="dc-incoming__warn">Answering ends the call you are in now.</p> : null}
        </div>
      </div>
      <div className="dc-incoming__actions">
        <button type="button" className="dc-act dc-act--danger" onClick={decline} aria-label={`Decline the ${kind} from ${callerName}`}>
          <span className="dc-act__icon"><Icon name="phoneOff" size={22} /></span>
          <span className="dc-act__label">Decline</span>
        </button>
        <button type="button" className="dc-act dc-act--accept" onClick={accept} aria-label={inCall ? `Leave your call and answer ${callerName}` : `Accept the ${kind} from ${callerName}`}>
          <span className="dc-act__icon">{call.media === 'video' ? <Icon name="video" size={22} /> : <MIcon name="phone" size={22} />}</span>
          <span className="dc-act__label">Accept</span>
        </button>
      </div>
    </div>
  );
}
