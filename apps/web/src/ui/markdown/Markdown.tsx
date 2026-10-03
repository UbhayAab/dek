// Renders a message body as React elements. Never innerHTML: user text only ever
// reaches the DOM as React text children, and the only attribute values taken from
// a body are hrefs that passed safeHref (http, https, mailto) in parse.ts.
import { Fragment, memo, useMemo, type ReactNode } from 'react';
import type { Block, Inline, MdContext } from './types';
import { isJumboEmoji, parseBlocks } from './parse';
import { highlightText } from './highlight';
import './markdown.css';

const EMPTY: MdContext = {};

// Channel links stay inside the app: a single leading slash, never a scheme.
function internalHref(href: string | null | undefined): string | null {
  return href && href.startsWith('/') && !href.startsWith('//') ? href : null;
}

function renderInlines(nodes: Inline[], ctx: MdContext): ReactNode[] {
  return nodes.map((node, i) => renderInline(node, ctx, i));
}

function renderInline(node: Inline, ctx: MdContext, key: number): ReactNode {
  switch (node.t) {
    case 'text':
      return ctx.highlight?.length
        ? <Fragment key={key}>{highlightText(node.v, ctx.highlight)}</Fragment>
        : node.v;
    case 'br':
      return <br key={key} />;
    case 'code':
      return <code key={key}>{node.v}</code>;
    case 'strong':
      return <strong key={key}>{renderInlines(node.c, ctx)}</strong>;
    case 'em':
      return <em key={key}>{renderInlines(node.c, ctx)}</em>;
    case 'del':
      return <del key={key}>{renderInlines(node.c, ctx)}</del>;
    case 'link':
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {renderInlines(node.c, ctx)}
        </a>
      );
    case 'user': {
      const me = !!ctx.meId && ctx.meId.toLowerCase() === node.id;
      const name = ctx.userName?.(node.id) ?? null;
      return (
        <span key={key} className={me ? 'dk-mention dk-mention--me' : 'dk-mention'} data-user-id={node.id}>
          @{name ?? 'unknown'}
        </span>
      );
    }
    case 'channel': {
      const name = ctx.channelName?.(node.id) ?? null;
      if (name === null) return <span key={key} className="dk-chanlink dk-chanlink--private">#private-channel</span>;
      const href = internalHref(ctx.channelHref?.(node.id));
      if (!href) return <span key={key} className="dk-chanlink" data-channel-id={node.id}>#{name}</span>;
      const onLink = ctx.onChannelLink;
      return (
        <a key={key} className="dk-chanlink" href={href} data-channel-id={node.id}
          onClick={onLink ? (e) => onLink(node.id, e) : undefined}>
          #{name}
        </a>
      );
    }
    case 'all':
      return <span key={key} className="dk-mention dk-mention--all dk-mention--me">@{node.v}</span>;
  }
}

function renderBlocks(blocks: Block[], ctx: MdContext): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.t) {
      case 'p':
        return <p key={i} dir="auto">{renderInlines(block.c, ctx)}</p>;
      case 'code':
        return <pre key={i}><code>{block.v}</code></pre>;
      case 'quote':
        return <blockquote key={i}>{renderBlocks(block.c, ctx)}</blockquote>;
      case 'list': {
        const items = block.items.map((item, j) => (
          <li key={j} dir="auto">
            {renderInlines(item.c, ctx)}
            {item.children.length ? renderBlocks(item.children, ctx) : null}
          </li>
        ));
        return block.ordered
          ? <ol key={i} start={block.start !== 1 ? block.start : undefined}>{items}</ol>
          : <ul key={i}>{items}</ul>;
      }
    }
  });
}

interface MarkdownProps {
  body: string;
  ctx?: MdContext;
  className?: string;
}

function MarkdownView({ body, ctx, className }: MarkdownProps) {
  const text = body ?? '';
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const jumbo = useMemo(() => isJumboEmoji(text), [text]);
  const cls = ['dk-md', jumbo ? 'dk-md--jumbo' : null, className].filter(Boolean).join(' ');
  return <div className={cls} dir="auto">{renderBlocks(blocks, ctx ?? EMPTY)}</div>;
}

export const Markdown = memo(MarkdownView);
