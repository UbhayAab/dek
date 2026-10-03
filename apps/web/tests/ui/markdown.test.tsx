import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Markdown, highlightText, parseBlocks, splitTerms, toPlainText, type MdContext } from '../../src/ui/markdown';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';
const GRANTS = '44444444-4444-4444-8444-444444444444';
const SECRET = '55555555-5555-4555-8555-555555555555';

const NAMES: Record<string, string> = { [ME]: 'Alice Member', [BOB]: 'Bob Member' };
const CHANNELS: Record<string, string> = { [GRANTS]: 'grants' };

const ctx: MdContext = {
  meId: ME,
  userName: (id) => NAMES[id] ?? null,
  channelName: (id) => CHANNELS[id] ?? null,
  channelHref: (id) => `/o/org/c/${id}`,
};

afterEach(() => cleanup());

function md(body: string, c: MdContext = ctx): HTMLElement {
  const { container } = render(<Markdown body={body} ctx={c} />);
  return container.firstElementChild as HTMLElement;
}

function maxNesting(root: Element, selector: string): number {
  let max = 0;
  for (const el of Array.from(root.querySelectorAll(selector))) {
    let depth = 0;
    let cur: Element | null = el;
    while (cur && cur !== root) {
      if (cur.matches(selector)) depth += 1;
      cur = cur.parentElement;
    }
    max = Math.max(max, depth);
  }
  return max;
}

// Every anchor is either an in-app channel link or a safe external link.
function assertSafeDom(root: HTMLElement): void {
  expect(root.querySelectorAll('script, img, iframe, object, embed, style, svg, form, input').length).toBe(0);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on')).toBe(false);
      expect(attr.name).not.toBe('style');
    }
  }
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (a.classList.contains('dk-chanlink')) {
      expect(href.startsWith('/')).toBe(true);
      expect(a.hasAttribute('target')).toBe(false);
      continue;
    }
    expect(/^(https?:|mailto:)/.test(href)).toBe(true);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
  }
}

describe('markdown: hostile input', () => {
  const attacks: [string, string][] = [
    ['javascript link', '[x](javascript:alert(1))'],
    ['mixed case scheme', '[x](JaVaScRiPt:alert(1))'],
    ['tab inside scheme', '[x](java\tscript:alert(1))'],
    ['newline inside scheme', '[x](java\nscript:alert(1))'],
    ['entity encoded scheme', '[x](javascript&#58;alert(1))'],
    ['data url', '[x](data:text/html,<script>alert(1)</script>)'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['relative path', '[x](/settings/account)'],
    ['protocol relative', '[x](//evil.example/a)'],
    ['raw script tag', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['anchor tag', '<a href="javascript:alert(1)">x</a>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['autolink javascript', '<javascript:alert(1)>'],
    ['autolink data', '<data:text/html;base64,PHNjcmlwdD4=>'],
    ['bare javascript', 'javascript:alert(1)'],
    ['bare data url', 'data:text/html;base64,PHNjcmlwdD4='],
    ['style attribute attempt', '<span style="background:url(javascript:alert(1))">x</span>'],
    ['markdown image', '![alt](https://tracker.example/pixel.gif)'],
  ];

  // Literal text that happens to contain an https URL still gets a (safe) link.
  const mayLink = new Set(['iframe', 'markdown image']);
  for (const [name, body] of attacks) {
    it(`renders ${name} as inert text`, () => {
      const root = md(body);
      assertSafeDom(root);
      if (!mayLink.has(name)) expect(root.querySelectorAll('a').length).toBe(0);
    });
  }

  it('keeps the whole source of an unsafe link as literal text', () => {
    const root = md('see [x](javascript:alert(1)) now');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('see [x](javascript:alert(1)) now');
  });

  it('shows HTML as the literal characters people typed', () => {
    const root = md('<b>bold?</b> <script>alert(1)</script>');
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toBe('<b>bold?</b> <script>alert(1)</script>');
  });

  it('never renders images, even as markdown image syntax', () => {
    const root = md('![alt](https://tracker.example/pixel.gif)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('!');
    assertSafeDom(root);
  });

  it('safe links carry rel noopener noreferrer and open in a new tab', () => {
    const root = md('[docs](https://example.com/docs) and https://example.org and [mail](mailto:team@example.org)');
    const anchors = Array.from(root.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      'https://example.org/',
      'mailto:team@example.org',
    ]);
    assertSafeDom(root);
  });
});

describe('markdown: emphasis, nesting and unclosed markers', () => {
  it('nests italic inside bold', () => {
    const root = md('**a *b* c**');
    const strong = root.querySelector('strong');
    expect(strong?.textContent).toBe('a b c');
    expect(root.querySelector('strong em')?.textContent).toBe('b');
  });

  it('leaves an unclosed bold marker literal', () => {
    const root = md('**unclosed');
    expect(root.querySelector('strong')).toBeNull();
    expect(root.textContent).toBe('**unclosed');
  });

  it('leaves a lone asterisk literal', () => {
    const root = md('*a');
    expect(root.querySelector('em')).toBeNull();
    expect(root.textContent).toBe('*a');
  });

  it('italicises _snake_case_name_ as one span and keeps inner underscores', () => {
    const root = md('_snake_case_name_');
    expect(root.querySelectorAll('em').length).toBe(1);
    expect(root.querySelector('em')?.textContent).toBe('snake_case_name');
  });

  it('never emphasises underscores inside a word', () => {
    const root = md('call snake_case_name and __init__ please');
    expect(root.querySelector('em, strong')).toBeNull();
    expect(root.textContent).toBe('call snake_case_name and __init__ please');
  });

  it('allows intraword asterisk emphasis like CommonMark', () => {
    const root = md('a*b*c');
    expect(root.querySelector('em')?.textContent).toBe('b');
    expect(root.textContent).toBe('abc');
  });

  it('renders strike, triple markers and the multiple of three rule', () => {
    expect(md('~~gone~~').querySelector('del')?.textContent).toBe('gone');
    expect(md('***both***').querySelector('em strong, strong em')?.textContent).toBe('both');
    const root = md('*foo**bar**baz*');
    expect(root.querySelector('em')?.textContent).toBe('foobarbaz');
    expect(root.querySelector('em strong')?.textContent).toBe('bar');
  });

  it('honours backslash escapes', () => {
    const root = md('\\*not italic\\* and \\<@x\\>');
    expect(root.querySelector('em')).toBeNull();
    expect(root.textContent).toBe('*not italic* and <@x>');
  });

  it('does not treat a single tilde or long marker runs as formatting', () => {
    const root = md('~5 people and ~~~three~~~ and ****four****');
    expect(root.querySelector('del, strong, em')).toBeNull();
  });
});

describe('markdown: languages and emoji', () => {
  it('renders Hindi text unchanged with dir auto', () => {
    const root = md('नमस्ते, आज की मीटिंग चार बजे है।');
    expect(root.getAttribute('dir')).toBe('auto');
    expect(root.querySelector('p')?.textContent).toBe('नमस्ते, आज की मीटिंग चार बजे है।');
  });

  it('formats Hindi words', () => {
    const root = md('**नमस्ते** दुनिया _सब_');
    expect(root.querySelector('strong')?.textContent).toBe('नमस्ते');
    expect(root.querySelector('em')?.textContent).toBe('सब');
  });

  it('keeps emoji in running text without jumbo size', () => {
    const root = md('Great job 🎉🎉');
    expect(root.textContent).toBe('Great job 🎉🎉');
    expect(root.classList.contains('dk-md--jumbo')).toBe(false);
  });

  it('makes one to three emoji alone jumbo', () => {
    for (const body of ['🎉', '👍🏽', '👨‍👩‍👧', '❤️', '🇮🇳', '1️⃣', '🎉 🎉 🎉', '🏳️‍🌈']) {
      expect(md(body).classList.contains('dk-md--jumbo'), body).toBe(true);
      cleanup();
    }
    for (const body of ['🎉🎉🎉🎉', 'hi 🎉', '1', '', '**🎉**', 'ok']) {
      expect(md(body).classList.contains('dk-md--jumbo'), body).toBe(false);
      cleanup();
    }
  });
});

describe('markdown: real legacy shapes', () => {
  it('renders a sentence followed by a dash list as a paragraph and a list', () => {
    const root = md('Morning everyone. Here is the list for today:\n- call the hospital desk\n- send the consent forms\n- update the grants tracker');
    expect(Array.from(root.children).map((el) => el.tagName)).toEqual(['P', 'UL']);
    expect(Array.from(root.querySelectorAll('ul > li')).map((li) => li.textContent)).toEqual([
      'call the hospital desk', 'send the consent forms', 'update the grants tracker',
    ]);
  });

  it('renders bold and italic from the seed data', () => {
    expect(md('Welcome to **Dek QA**. This is the general channel.').querySelector('strong')?.textContent).toBe('Dek QA');
    expect(md('Reminder: the review is at *4 pm* today.').querySelector('em')?.textContent).toBe('4 pm');
  });

  it('keeps single line breaks and splits paragraphs on blank lines', () => {
    const root = md('line one\nline two\nline three\n\nsecond paragraph');
    const paras = root.querySelectorAll('p');
    expect(paras.length).toBe(2);
    expect(paras[0]?.querySelectorAll('br').length).toBe(2);
    expect(paras[1]?.textContent).toBe('second paragraph');
  });

  it('renders numbered lists with their start number', () => {
    const one = md('1. first\n2. second\n3. third');
    expect(one.querySelector('ol')?.hasAttribute('start')).toBe(false);
    expect(one.querySelectorAll('ol > li').length).toBe(3);
    cleanup();
    const three = md('3. third\n4. fourth');
    expect(three.querySelector('ol')?.getAttribute('start')).toBe('3');
    cleanup();
    expect(md('1) one\n2) two').querySelectorAll('ol > li').length).toBe(2);
  });

  it('lets only a list starting at 1 interrupt a paragraph', () => {
    const no = md('Steps:\n2. not a list');
    expect(no.querySelector('ol')).toBeNull();
    expect(no.querySelectorAll('br').length).toBe(1);
    cleanup();
    const yes = md('Steps:\n1. a\n2. b');
    expect(Array.from(yes.children).map((el) => el.tagName)).toEqual(['P', 'OL']);
  });

  it('accepts star and plus bullets', () => {
    expect(md('* star item\n* second').querySelectorAll('ul > li').length).toBe(2);
    cleanup();
    expect(md('+ plus').querySelectorAll('ul > li').length).toBe(1);
  });

  it('nests lists by indentation', () => {
    const root = md('- a\n  - a1\n  - a2\n- b\n1. one\n   - inner');
    const top = root.querySelector('ul')!;
    expect(top.querySelectorAll(':scope > li').length).toBe(2);
    expect(top.querySelectorAll(':scope > li > ul > li').length).toBe(2);
    expect(root.querySelector('ol > li > ul > li')?.textContent).toBe('inner');
  });

  it('continues a list item on the next plain line with a line break', () => {
    const root = md('- item one\ncontinued here\n- item two');
    const items = root.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0]?.querySelector('br')).not.toBeNull();
    expect(items[0]?.textContent).toBe('item onecontinued here');
  });

  it('groups quote lines and parses their content', () => {
    const root = md('> quoted line\n> second line\n\nafter');
    expect(root.querySelector('blockquote p')?.querySelectorAll('br').length).toBe(1);
    expect(root.lastElementChild?.textContent).toBe('after');
    cleanup();
    expect(md('> - a\n> - b').querySelectorAll('blockquote ul > li').length).toBe(2);
  });

  it('treats headings, rules and tables as plain text', () => {
    const root = md('# Title\n---\n| a | b |');
    expect(root.querySelector('h1, hr, table')).toBeNull();
    expect(root.textContent).toBe('# Title---| a | b |');
  });
});

describe('markdown: mentions and channel links', () => {
  it('renders user mentions as chips and highlights mine', () => {
    const root = md(`<@${ME}> and <@${BOB}> and <@${GHOST}>`);
    const chips = Array.from(root.querySelectorAll('.dk-mention'));
    expect(chips.map((c) => c.textContent)).toEqual(['@Alice Member', '@Bob Member', '@unknown']);
    expect(chips[0]?.classList.contains('dk-mention--me')).toBe(true);
    expect(chips[1]?.classList.contains('dk-mention--me')).toBe(false);
    expect(chips[1]?.getAttribute('data-user-id')).toBe(BOB);
  });

  it('matches my mention regardless of letter case', () => {
    const root = md(`<@${ME.toUpperCase()}>`);
    expect(root.querySelector('.dk-mention--me')?.textContent).toBe('@Alice Member');
  });

  it('renders channel and here chips', () => {
    const root = md('<!channel> please and <!here> too');
    const chips = Array.from(root.querySelectorAll('.dk-mention--all'));
    expect(chips.map((c) => c.textContent)).toEqual(['@channel', '@here']);
    expect(chips.every((c) => c.classList.contains('dk-mention--me'))).toBe(true);
  });

  it('keeps malformed tokens literal', () => {
    const root = md('<@not-a-uuid> <#nope> <!everyone>');
    expect(root.querySelector('.dk-mention, .dk-chanlink')).toBeNull();
    expect(root.textContent).toBe('<@not-a-uuid> <#nope> <!everyone>');
  });

  it('links known channels inside the app and hides unknown ones', () => {
    const onChannelLink = vi.fn((_id: string, e: { preventDefault: () => void }) => e.preventDefault());
    const root = md(`<#${GRANTS}> and <#${SECRET}>`, { ...ctx, onChannelLink });
    const link = root.querySelector('a.dk-chanlink')!;
    expect(link.getAttribute('href')).toBe(`/o/org/c/${GRANTS}`);
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.textContent).toBe('#grants');
    expect(root.querySelector('span.dk-chanlink--private')?.textContent).toBe('#private-channel');
    fireEvent.click(link);
    expect(onChannelLink).toHaveBeenCalledTimes(1);
    expect(onChannelLink.mock.calls[0]?.[0]).toBe(GRANTS);
  });

  it('refuses a channel href that leaves the app', () => {
    const root = md(`<#${GRANTS}>`, { ...ctx, channelHref: () => 'javascript:alert(1)' });
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('#grants');
  });

  it('renders mentions without a context', () => {
    const root = md(`<@${BOB}> <#${GRANTS}>`, {});
    expect(root.textContent).toBe('@unknown #private-channel');
  });
});

describe('markdown: code', () => {
  it('does not parse inside inline code', () => {
    const root = md(`\`**not bold** <@${ME}>\``);
    expect(root.querySelector('code')?.textContent).toBe(`**not bold** <@${ME}>`);
    expect(root.querySelector('strong, .dk-mention')).toBeNull();
  });

  it('matches backtick run lengths', () => {
    expect(md('``a ` b``').querySelector('code')?.textContent).toBe('a ` b');
    cleanup();
    const root = md('an ` unmatched tick');
    expect(root.querySelector('code')).toBeNull();
    expect(root.textContent).toBe('an ` unmatched tick');
  });

  it('renders fenced blocks verbatim', () => {
    const root = md("```js\nconst a = '<b>';\n**x**\n```");
    expect(root.querySelector('pre code')?.textContent).toBe("const a = '<b>';\n**x**");
    expect(root.querySelector('strong, b')).toBeNull();
  });

  it('runs an unclosed fence to the end', () => {
    const root = md('```\ncode to end\n**x**');
    expect(root.querySelector('pre code')?.textContent).toBe('code to end\n**x**');
  });

  it('continues with normal text after a closed fence', () => {
    const root = md('```\nx\n```\nafter');
    expect(Array.from(root.children).map((el) => el.tagName)).toEqual(['PRE', 'P']);
  });
});

describe('markdown: URLs', () => {
  it('drops trailing punctuation from bare URLs', () => {
    const root = md('see https://example.com/path.');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/path');
    expect(a.textContent).toBe('https://example.com/path');
    expect(root.textContent).toBe('see https://example.com/path.');
  });

  it('drops an unbalanced closing parenthesis but keeps balanced ones', () => {
    expect(md('(https://example.com)').querySelector('a')?.textContent).toBe('https://example.com');
    cleanup();
    const wiki = md('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(wiki.querySelector('a')?.textContent).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(wiki.querySelector('a')?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('links www hosts over http', () => {
    expect(md('go to www.example.com now').querySelector('a')?.getAttribute('href')).toBe('http://www.example.com/');
  });

  it('renders labelled links and autolinks', () => {
    const root = md('[label](https://example.com) <https://example.com/x> [t](https://example.com/y "Title")');
    const anchors = Array.from(root.querySelectorAll('a'));
    expect(anchors.map((a) => a.textContent)).toEqual(['label', 'https://example.com/x', 't']);
    expect(anchors[2]?.getAttribute('href')).toBe('https://example.com/y');
  });

  it('does not emphasise underscores inside a URL and links bold URLs', () => {
    const root = md('https://example.com/a_b_c and **https://example.org**');
    expect(root.querySelector('em')).toBeNull();
    expect(root.querySelector('a')?.textContent).toBe('https://example.com/a_b_c');
    expect(root.querySelector('strong > a')?.textContent).toBe('https://example.org');
  });

  it('does not link URLs glued to a word or without a host', () => {
    const root = md('xhttps://example.com and http://nohost and https://');
    expect(root.querySelector('a')).toBeNull();
  });

  it('formats inside link labels but never nests links', () => {
    const root = md('[**bold** https://example.org](https://example.com)');
    const anchors = root.querySelectorAll('a');
    expect(anchors.length).toBe(1);
    expect(anchors[0]?.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('markdown: search highlighting', () => {
  it('marks word starts only, case-insensitively', () => {
    const root = md('History line 5 and prehistory', { ...ctx, highlight: ['hist'] });
    const marks = Array.from(root.querySelectorAll('mark.dk-md-hl'));
    expect(marks.map((m) => m.textContent)).toEqual(['Hist']);
    expect(root.textContent).toBe('History line 5 and prehistory');
  });

  it('marks inside formatting', () => {
    const root = md('**grant** report for grants', { ...ctx, highlight: ['grant'] });
    expect(root.querySelector('strong mark')?.textContent).toBe('grant');
    expect(root.querySelectorAll('mark').length).toBe(2);
  });

  it('highlightText marks every match and keeps the text', () => {
    const { container } = render(<p>{highlightText('Grant grants regrant', ['grant'])}</p>);
    expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['Grant', 'grant']);
    expect(container.textContent).toBe('Grant grants regrant');
  });

  it('matches one-letter terms as whole words only', () => {
    const { container } = render(<p>{highlightText('a plan and a', ['a'])}</p>);
    expect(container.querySelectorAll('mark').length).toBe(2);
  });

  it('splitTerms lowercases, dedupes, keeps letters and caps at 8', () => {
    expect(splitTerms('  Grant, budget!! grant  ')).toEqual(['grant', 'budget']);
    expect(splitTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(splitTerms('नमस्ते दुनिया')).toEqual(['नमस्ते', 'दुनिया']);
    expect(splitTerms('')).toEqual([]);
  });
});

describe('markdown: plain text', () => {
  it('flattens formatting, lists and tokens into one line', () => {
    const body = `**Bold** and *it*\n- one\n- two\n\n<@${ME}> <#${GRANTS}> <!here>\n\n\`\`\`\ncode\n\`\`\``;
    expect(toPlainText(body, ctx)).toBe('Bold and it one two @Alice Member #grants @here code');
  });

  it('handles empty and unknown references', () => {
    expect(toPlainText('')).toBe('');
    expect(toPlainText(`<@${BOB}>   <#${SECRET}>`)).toBe('@unknown #private-channel');
  });
});

describe('markdown: adversarial size and depth', () => {
  it('caps quote nesting', () => {
    const root = md(`${'>'.repeat(5000)} x`);
    expect(maxNesting(root, 'blockquote')).toBeLessThanOrEqual(8);
  });

  it('caps emphasis nesting and survives long marker runs', () => {
    const root = md(`${'**a '.repeat(2000)}b${' c**'.repeat(2000)}`);
    expect(maxNesting(root, 'strong, em')).toBeLessThanOrEqual(8);
    cleanup();
    expect(() => md(`${'*'.repeat(5000)}a${'*'.repeat(5000)}`)).not.toThrow();
  });

  it('caps list nesting', () => {
    const body = Array.from({ length: 200 }, (_, i) => `${' '.repeat(i * 2)}- level ${i}`).join('\n');
    const root = md(body);
    expect(maxNesting(root, 'ul')).toBeLessThanOrEqual(9);
    expect(root.textContent).toContain('level 199');
  });

  it('survives bracket and angle floods', () => {
    expect(() => md(`${'['.repeat(5000)}x${']'.repeat(5000)}(https://example.com)`)).not.toThrow();
    cleanup();
    expect(() => md('<'.repeat(8000))).not.toThrow();
    cleanup();
    expect(() => md('`'.repeat(3000) + 'a' + '``'.repeat(1000))).not.toThrow();
  });

  it('parses an 8000 character pathological body quickly', () => {
    const bodies = ['a* '.repeat(2666), '_a '.repeat(2666), 'http://'.repeat(1142), '[a]('.repeat(2000), '\\'.repeat(8000)];
    for (const body of bodies) {
      const t0 = performance.now();
      parseBlocks(body);
      expect(performance.now() - t0, body.slice(0, 12)).toBeLessThan(1500);
    }
  });
});
