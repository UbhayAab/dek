import type { Server } from '../../../api/types';
import { Checkbox } from './ui';

// Invitations always remain available to authorized inviters. A second method is
// either an approval queue or immediate joining, never both at the same time.
export function ServerJoinMethods({ value, onChange }: {
  value: Server['join_policy']; onChange: (v: Server['join_policy']) => void;
}) {
  return (
    <fieldset className="ap-radios">
      <legend className="ap-legend">Joining methods</legend>
      <p className="ap-hint">Keep invite links and choose up to one additional method. Choosing one replaces the other.</p>
      <Checkbox label="Invite links" checked disabled onChange={() => undefined}
        description="Authorized people can invite members. The server's approval requirement still applies." />
      <Checkbox label="Ask to join" checked={value === 'approval'}
        onChange={(checked) => onChange(checked ? 'approval' : 'invite')}
        description="Organization members can request access from Browse. A server admin approves requests, including people with invite links." />
      <Checkbox label="Open" checked={value === 'open'}
        onChange={(checked) => onChange(checked ? 'open' : 'invite')}
        description="Organization members can join from Browse without approval. Invite links still work." />
    </fieldset>
  );
}
