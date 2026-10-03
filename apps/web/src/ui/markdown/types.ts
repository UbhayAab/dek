// The message body AST (CONTRACT section 0 subset) and the context the renderer
// needs to resolve mentions and channel links. Parsing never produces HTML strings;
// Markdown.tsx turns these nodes into React elements.
import type { MouseEvent } from 'react';

export interface MdContext {
  // The signed-in user: their own mentions are highlighted.
  meId?: string | null;
  // Display name for a <@uuid> token, or null when unknown.
  userName?: (id: string) => string | null;
  // Channel name for a <#uuid> token, or null when the reader cannot see it.
  channelName?: (id: string) => string | null;
  // In-app path for a channel link (must start with a single slash).
  channelHref?: (id: string) => string | null;
  onChannelLink?: (id: string, e: MouseEvent<HTMLAnchorElement>) => void;
  // Search terms to mark (see splitTerms in highlight.ts).
  highlight?: string[];
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'user'; id: string }
  | { t: 'channel'; id: string }
  | { t: 'all'; v: 'channel' | 'here' };

export interface ListItem {
  c: Inline[];
  children: Block[];
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; v: string; lang: string | null }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] };
