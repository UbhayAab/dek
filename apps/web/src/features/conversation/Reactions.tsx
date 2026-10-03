// The reactions under a message: one chip per emoji (pressed when it includes
// you), and an add button that opens the picker. The visual pill stays compact;
// the button box is the full touch target on phones.
import { useRef, useState } from 'react';
import type { Message, Profile } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { toast } from '../../ui/kit';
import { emojiName } from './emoji';
import { EmojiPopover } from './EmojiPopover';
import { joinNames, personName } from './names';
import { run } from './safe';

export function reactionNames(users: string[], profiles: Record<string, Profile>, meId: string | null): string {
  const names = users.map((u) => (u === meId ? 'you' : personName(profiles, u)));
  return joinNames(names);
}

export function react(messageId: string, emoji: string): void {
  run(() => actions.toggleReaction(messageId, emoji)).catch((e: unknown) => {
    toast({ kind: 'error', title: 'Reaction not saved', body: humanError(e) });
  });
}

interface Props {
  message: Message;
  meId: string | null;
  canReact: boolean;
}

export function Reactions({ message, meId, canReact }: Props) {
  const profiles = useDek((s) => s.profiles);
  const [picker, setPicker] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const entries = Object.entries(message.reactions ?? {}).filter(([, users]) => users.length > 0);
  if (!entries.length) return null;

  return (
    <div className="dk-reacts" role="group" aria-label="Reactions">
      {entries.map(([emoji, users]) => {
        const mine = !!meId && users.includes(meId);
        const who = reactionNames(users, profiles, meId);
        const name = emojiName(emoji) ?? emoji;
        return (
          <button
            key={emoji}
            type="button"
            className={`dk-react${mine ? ' is-mine' : ''}`}
            aria-pressed={mine}
            aria-label={`${name}, ${users.length}: ${who}.${canReact ? (mine ? ' Remove your reaction.' : ' Add yours.') : ''}`}
            title={`${who} reacted with ${name}`}
            disabled={!canReact}
            onClick={() => react(message.id, emoji)}
          >
            <span className="dk-react__pill">
              <span className="dk-react__emoji" aria-hidden="true">{emoji}</span>
              <span className="dk-react__count" aria-hidden="true">{users.length}</span>
            </span>
          </button>
        );
      })}
      {canReact ? (
        <>
          <button ref={addRef} type="button" className="dk-react dk-react--add" aria-label="Add reaction" title="Add reaction"
            onClick={() => setPicker((p) => !p)} aria-expanded={picker}>
            <span className="dk-react__pill"><Icon name="smile" size={16} /><Icon name="plus" size={12} /></span>
          </button>
          <EmojiPopover open={picker} onClose={() => setPicker(false)} anchor={addRef.current} onPick={(ch) => react(message.id, ch)} />
        </>
      ) : null}
    </div>
  );
}
