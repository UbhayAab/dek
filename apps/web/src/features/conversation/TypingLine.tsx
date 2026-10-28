// "Alice is typing" under the list. A fixed-height line so the list never jumps;
// entries expire on their own (DEK12: transient signals only).
import { useEffect, useMemo, useState } from 'react';
import { useDek } from '../../store';
import { personName } from './names';

const EMPTY: never[] = [];

export function typingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

export function TypingLine({ channelId, threadRootId, meId }: { channelId: string; threadRootId: string | null; meId: string | null }) {
  const entries = useDek((s) => s.typing[channelId] ?? EMPTY);
  const profiles = useDek((s) => s.profiles);
  const [now, setNow] = useState(() => Date.now());

  const live = useMemo(
    () => entries.filter((e) => e.userId !== meId && e.until > now && (e.threadRootId ?? null) === threadRootId),
    [entries, meId, now, threadRootId],
  );

  useEffect(() => {
    if (!entries.length) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [entries.length]);

  const text = typingText(live.map((e) => personName(profiles, e.userId).split(/\s+/)[0] ?? 'Someone'));
  return (
    <div className="dk-typing" aria-hidden={text ? undefined : true}>
      {text ? (
        <>
          <span className="dk-typing__dots" aria-hidden="true"><span /><span /><span /></span>
          <span className="dk-typing__text">{text}</span>
        </>
      ) : null}
    </div>
  );
}
