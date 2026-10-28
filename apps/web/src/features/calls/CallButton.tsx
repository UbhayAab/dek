// The conversation header's call controls. In a DM or group DM: voice and video
// call buttons (or "Join call" when a call is already going on there, or "In
// call" while this tab is in it). In an audio channel: join or leave the room.
// Text channels have no calls.
import { useDek } from '../../store';
import { Button, IconButton } from '../../ui/kit';
import { isLiveStatus, useCallView } from './hooks';
import { RoomButton } from './Room';
import { callEngine } from './runtime';
import './calls.css';

function DirectButtons({ channelId }: { channelId: string }) {
  const me = useDek((s) => s.session.userId);
  const archived = useDek((s) => !!s.channels[channelId]?.archived);
  const ongoing = useDek((s) => Object.values(s.calls).find((c) => c.channel_id === channelId && !c.ended_at
    && c.participants.some((p) => p.state === 'joined' && p.user_id !== me)));
  const here = useCallView((v) => v.channelId === channelId && isLiveStatus(v.status));
  const elsewhere = useCallView((v) => v.channelId !== channelId && isLiveStatus(v.status));
  const starting = useCallView((v) => v.channelId === channelId && v.status === 'starting');

  if (here) {
    return (
      <span className="dc-callbtns">
        <Button icon="phone" size="sm" variant="primary" loading={starting} aria-label="You are in this call" disabled>In call</Button>
      </span>
    );
  }
  const myState = ongoing?.participants.find((p) => p.user_id === me)?.state;
  if (ongoing && myState !== 'ringing') {
    return (
      <span className="dc-callbtns">
        <Button icon={ongoing.media === 'video' ? 'video' : 'phone'} size="sm" variant="primary" disabled={elsewhere || archived}
          onClick={() => { void callEngine.answer(ongoing.id); }}>
          Join call
        </Button>
      </span>
    );
  }
  const blocked = elsewhere || archived;
  const why = archived ? 'This conversation is archived' : elsewhere ? 'You are in another call' : null;
  return (
    <span className="dc-callbtns">
      <IconButton icon="phone" label={why ?? 'Start a voice call'} disabled={blocked}
        onClick={() => { void callEngine.startDirect(channelId, 'audio'); }} />
      <IconButton icon="video" label={why ?? 'Start a video call'} disabled={blocked}
        onClick={() => { void callEngine.startDirect(channelId, 'video'); }} />
    </span>
  );
}

export function CallButton({ channelId }: { channelId: string }) {
  const kind = useDek((s) => s.channels[channelId]?.kind);
  if (kind === 'audio') return <RoomButton channelId={channelId} />;
  if (kind === 'dm' || kind === 'group_dm') return <DirectButtons channelId={channelId} />;
  return null;
}
