// Status helpers: when a status clears itself, and a few ready-made ones. Pure.

export type ClearAfter = '30m' | '1h' | '4h' | 'today' | 'never';

export const CLEAR_AFTER: readonly { value: ClearAfter; label: string }[] = [
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: 'today', label: 'Today' },
  { value: 'never', label: 'Do not clear' },
];

const MINUTE = 60_000;

// The moment the status clears (ISO), or null for never. "Today" ends at midnight
// on this device's clock; always at least a minute ahead so the server (which
// refuses a time in the past) accepts it.
export function statusUntil(choice: ClearAfter, now: Date = new Date()): string | null {
  const t = now.getTime();
  switch (choice) {
    case '30m': return new Date(t + 30 * MINUTE).toISOString();
    case '1h': return new Date(t + 60 * MINUTE).toISOString();
    case '4h': return new Date(t + 240 * MINUTE).toISOString();
    case 'today': {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return new Date(Math.max(end.getTime(), t + MINUTE)).toISOString();
    }
    case 'never':
    default:
      return null;
  }
}

export const STATUS_PRESETS: readonly { emoji: string; text: string; clear: ClearAfter }[] = [
  { emoji: '📅', text: 'In a meeting', clear: '1h' },
  { emoji: '🚌', text: 'Commuting', clear: '30m' },
  { emoji: '🎧', text: 'Focusing', clear: '4h' },
  { emoji: '🤒', text: 'Out sick', clear: 'today' },
  { emoji: '🏠', text: 'Working remotely', clear: 'today' },
  { emoji: '🌙', text: 'Away', clear: 'never' },
];
