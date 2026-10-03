// Audio rooms (DEK21, DEK23): the panel an audio channel shows, and the header
// button. Up to 8 people (a WebRTC mesh); at 8 the room says it is full instead of
// offering a Join that the server would refuse. Join permission is the channel's
// posting permission (api.join_room checks it). Everyone in a room can speak;
// muting is each person's own choice. Leaving or closing the page leaves.
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Button } from '../../ui/kit';
import { isLiveStatus, joinedPeople, useCallView, useRoomCall } from './hooks';
import { displayName, useProfiles } from './names';
import { callEngine } from './runtime';
import './calls.css';

export const ROOM_CAPACITY = 8;

function useRoomState(channelId: string) {
  const me = useDek((s) => s.session.userId);
  const room = useRoomCall(channelId);
  const here = useCallView((v) => v.kind === 'room' && v.channelId === channelId && isLiveStatus(v.status));
  const busy = useCallView((v) => (v.channelId === channelId && v.status === 'starting') || (here && v.busy === 'leave'));
  const people = joinedPeople(room);
  const meInRoom = !!me && people.some((p) => p.user_id === me);
  const full = people.length >= ROOM_CAPACITY && !here && !meInRoom;
  return { me, room, here, busy, people, full };
}

export function AudioRoomPanel({ channelId }: { channelId: string }) {
  const channel = useDek((s) => s.channels[channelId]);
  const { me, here, busy, people, full } = useRoomState(channelId);
  const peers = useCallView((v) => (here ? v.peers : null));
  const speakingSelf = useCallView((v) => here && v.speakingSelf && !v.muted);
  const muted = useCallView((v) => here && (v.muted || v.listenOnly));
  const profiles = useProfiles(people.map((p) => p.user_id));
  const archived = !!channel?.archived;
  const titleId = `room-${channelId}`;
  return (
    <section className="dc-room" aria-labelledby={titleId} data-channel={channelId}>
      <header className="dc-room__head">
        <span className="dc-room__icon" aria-hidden="true"><Icon name="volume" size={22} /></span>
        <div className="dc-room__text">
          <h2 className="dc-room__title" id={titleId} dir="auto">{channel?.name ?? 'Audio room'}</h2>
          <p className="dc-room__count" aria-live="polite">
            {people.length ? `${people.length} of ${ROOM_CAPACITY} people here` : 'Nobody is here yet'}
          </p>
        </div>
      </header>
      {people.length ? (
        <ul className="dc-room__people" aria-label="In the room">
          {people.map((p) => {
            const isMe = p.user_id === me;
            const peer = here && p.session_id ? peers?.[p.session_id] : undefined;
            const speaking = isMe ? speakingSelf : !!peer?.speaking;
            const name = displayName(profiles[p.user_id]);
            const state = !here || isMe ? null : !peer ? 'Connecting' : peer.state === 'connected' ? null
              : peer.state === 'reconnecting' ? 'Reconnecting' : peer.state === 'failed' ? 'Could not connect' : 'Connecting';
            return (
              <li key={p.user_id} className={`dc-room__person${speaking ? ' is-speaking' : ''}`} data-user={p.user_id}>
                <span className="dc-room__avatar"><Avatar name={name} path={profiles[p.user_id]?.avatar_path} seed={p.user_id} size={40} /></span>
                <span className="dc-room__name" dir="auto">{isMe ? `${name} (you)` : name}</span>
                {isMe && muted ? <span className="dc-room__muted"><Icon name="micOff" size={16} label="Muted" /></span> : null}
                {state ? <span className="dc-room__state">{state}</span> : null}
                {speaking ? <span className="sr-only">speaking</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="dc-room__empty">Join to start talking. Anyone in this channel can join, up to {ROOM_CAPACITY} people.</p>
      )}
      <div className="dc-room__actions">
        {here ? (
          <>
            <Button icon={muted ? 'micOff' : 'mic'} onClick={() => callEngine.toggleMute()} aria-pressed={muted}>
              {muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button icon="phoneOff" variant="danger" loading={busy} onClick={() => { void callEngine.leave(); }}>Leave room</Button>
          </>
        ) : (
          <Button icon="headphones" variant="primary" size="lg" disabled={full || archived} loading={busy}
            onClick={() => { void callEngine.joinRoom(channelId); }}>
            {full ? 'Room is full' : 'Join room'}
          </Button>
        )}
      </div>
      {full ? <p className="dc-room__full" role="status">This room has {ROOM_CAPACITY} people, the most a room can hold. Try again when someone leaves.</p> : null}
      {archived ? <p className="dc-room__full">This channel is archived, so its room is closed.</p> : null}
    </section>
  );
}

export function RoomButton({ channelId }: { channelId: string }) {
  const { here, busy, people, full } = useRoomState(channelId);
  if (here) {
    return (
      <Button icon="phoneOff" size="sm" variant="danger" loading={busy} onClick={() => { void callEngine.leave(); }}
        aria-label="Leave the audio room">
        Leave
      </Button>
    );
  }
  return (
    <Button icon="headphones" size="sm" variant="primary" disabled={full} loading={busy}
      onClick={() => { void callEngine.joinRoom(channelId); }}
      aria-label={full ? 'The audio room is full' : people.length ? `Join the audio room, ${people.length} people in it` : 'Join the audio room'}>
      {full ? 'Full' : people.length ? `Join (${people.length})` : 'Join'}
    </Button>
  );
}
