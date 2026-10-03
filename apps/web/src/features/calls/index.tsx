// OWNER: media and calls client builder.
// Conversation headers render <CallButton/>; the shell renders <CallLayer/> once.
// An audio channel's pane can render <AudioRoomPanel channelId/> (optional): who
// is in the room, Join, Mute and Leave.
import { CallSurface } from './CallSurface';
import { ElsewhereNote, PermissionDialog, RemoteAudio } from './Extras';
import { IncomingCalls } from './Incoming';

export { CallButton } from './CallButton';
export { AudioRoomPanel } from './Room';
export { callEngine } from './runtime';

export function CallLayer() {
  return (
    <>
      <IncomingCalls />
      <CallSurface />
      <RemoteAudio />
      <PermissionDialog />
      <ElsewhereNote />
    </>
  );
}
