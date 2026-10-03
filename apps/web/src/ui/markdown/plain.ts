// One-line plain text of a body for previews, notifications in the app and aria
// labels: markers stripped, mentions and channel links resolved, whitespace collapsed.
import type { Block, Inline, MdContext } from './types';
import { parseBlocks } from './parse';

function inlineText(nodes: Inline[], ctx: MdContext): string {
  let s = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
      case 'code':
        s += node.v;
        break;
      case 'br':
        s += ' ';
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        s += inlineText(node.c, ctx);
        break;
      case 'user':
        s += `@${ctx.userName?.(node.id) ?? 'unknown'}`;
        break;
      case 'channel': {
        const name = ctx.channelName?.(node.id) ?? null;
        s += name === null ? '#private-channel' : `#${name}`;
        break;
      }
      case 'all':
        s += `@${node.v}`;
        break;
    }
  }
  return s;
}

function blocksText(blocks: Block[], ctx: MdContext, out: string[]): void {
  for (const block of blocks) {
    switch (block.t) {
      case 'p':
        out.push(inlineText(block.c, ctx));
        break;
      case 'code':
        out.push(block.v);
        break;
      case 'quote':
        blocksText(block.c, ctx, out);
        break;
      case 'list':
        for (const item of block.items) {
          out.push(inlineText(item.c, ctx));
          blocksText(item.children, ctx, out);
        }
        break;
    }
  }
}

export function toPlainText(body: string, ctx: MdContext = {}): string {
  const out: string[] = [];
  blocksText(parseBlocks(body ?? ''), ctx, out);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
