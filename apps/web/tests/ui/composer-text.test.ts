import { describe, expect, it } from 'vitest';
import { applyCompletion, decodeForEditing, encodeForSending, findTrigger, type MentionRef } from '../../src/features/conversation/composer-text';

const ALICE = '11111111-1111-4111-8111-111111111111';
const ANNA = '44444444-4444-4444-8444-444444444444';
const GRANTS = '55555555-5555-4555-8555-555555555555';

const resolve = {
  user: (id: string) => ({ [ALICE]: 'Alice Member', [ANNA]: 'Ann' } as Record<string, string>)[id] ?? null,
  channel: (id: string) => (id === GRANTS ? 'grants' : null),
};

describe('mention tokens', () => {
  it('preserves same-name channel IDs through drafts and edits, with readable permitted server scopes',()=>{
    const other='55555555-5555-4555-8555-555555555556',original=`<#${GRANTS}> and <#${other}>`;
    const resolvers={user:()=>null,channel:()=> 'general',channelScope:(id:string)=>id===GRANTS?'Care':'Operations'};
    const doc=decodeForEditing(original,resolvers);
    expect(new Set(doc.refs.map(r=>r.display)).size).toBe(2);expect(doc.text).toContain('Care');expect(doc.text).toContain('Operations');
    expect(encodeForSending(doc.text,doc.refs,{allowAll:false})).toBe(original);
    const reloaded=decodeForEditing(encodeForSending(doc.text,doc.refs,{allowAll:false}),resolvers);
    expect(encodeForSending(reloaded.text,reloaded.refs,{allowAll:false})).toBe(original);
  });
  it('preserves two distinct people with the same name through draft/edit round trips', () => {
    const original = `<@${ALICE}> and <@${ANNA}>`;
    const decoded = decodeForEditing(original, { user: () => 'Alex Same', channel: () => null });
    expect(new Set(decoded.refs.map(r => r.display)).size).toBe(2);
    expect(encodeForSending(decoded.text, decoded.refs, { allowAll: false })).toBe(original);
  });
  it('keeps escaped names and code examples literal while encoding actual selected tags', () => {
    const refs: MentionRef[] = [{ kind: 'user', id: ALICE, display: '@Alice Member' }];
    const text = '\\@Alice Member `@Alice Member @channel`\n```\n@here\n```\n@Alice Member @channel';
    expect(encodeForSending(text, refs, { allowAll: true })).toBe(`\\@Alice Member \`@Alice Member @channel\`\n\`\`\`\n@here\n\`\`\`\n<@${ALICE}> <!channel>`);
  });
  it('round-trips user, channel and special mentions', () => {
    const body = `<@${ALICE}> please check <#${GRANTS}> <!here>`;
    const { text, refs } = decodeForEditing(body, resolve);
    expect(text).toBe('@Alice Member please check #grants @here');
    expect(encodeForSending(text, refs, { allowAll: true })).toBe(body);
  });

  it('leaves unknown tokens encoded so nothing is lost', () => {
    const body = '<@99999999-9999-4999-8999-999999999999> hi';
    const { text } = decodeForEditing(body, resolve);
    expect(text).toBe(body);
  });

  it('replaces only whole names, longest first', () => {
    const refs: MentionRef[] = [
      { kind: 'user', id: ANNA, display: '@Ann' },
      { kind: 'user', id: ALICE, display: '@Alice Member' },
    ];
    expect(encodeForSending('@Ann and @Anna and @Alice Member!', refs, { allowAll: false }))
      .toBe(`<@${ANNA}> and @Anna and <@${ALICE}>!`);
  });

  it('keeps @channel as text where it is not allowed', () => {
    expect(encodeForSending('@channel hello', [], { allowAll: false })).toBe('@channel hello');
    expect(encodeForSending('@Channel hello @here', [], { allowAll: true })).toBe('<!channel> hello <!here>');
  });

  it('does not touch email addresses', () => {
    const refs: MentionRef[] = [{ kind: 'user', id: ANNA, display: '@Ann' }];
    expect(encodeForSending('mail x@Ann.org', refs, { allowAll: false })).toBe('mail x@Ann.org');
  });
});

describe('autocomplete triggers', () => {
  it('keeps selected identities with differently cased names distinct',()=>{
    const body=`<@${ALICE}> and <@${ANNA}>`;
    const decoded=decodeForEditing(body,{user:id=>id===ALICE?'Alex':'alex',channel:()=>null});
    expect(encodeForSending(decoded.text,decoded.refs,{allowAll:false})).toBe(body);
  });
  it('finds @, # and : at the caret', () => {
    expect(findTrigger('hello @ali', 10)).toEqual({ char: '@', start: 6, query: 'ali' });
    expect(findTrigger('see #gra', 8)).toEqual({ char: '#', start: 4, query: 'gra' });
    expect(findTrigger('nice :thu', 9)).toEqual({ char: ':', start: 5, query: 'thu' });
    expect(findTrigger('@', 1)).toEqual({ char: '@', start: 0, query: '' });
  });

  it('allows spaces in names but not across lines or inside words', () => {
    expect(findTrigger('@Alice Mem', 10)).toEqual({ char: '@', start: 0, query: 'Alice Mem' });
    expect(findTrigger('mail x@y', 8)).toBeNull();
    expect(findTrigger('@ali\nce', 7)).toBeNull();
    expect(findTrigger('at 10:30', 8)).toBeNull();
    expect(findTrigger('#a b', 4)).toBeNull();
  });

  it('applies a completion with one trailing space', () => {
    const trig = findTrigger('hi @al', 6)!;
    expect(applyCompletion('hi @al', trig, 6, '@Alice Member')).toEqual({ text: 'hi @Alice Member ', caret: 17 });
    const mid = findTrigger('hi @al there', 6)!;
    expect(applyCompletion('hi @al there', mid, 6, '@Alice Member')).toEqual({ text: 'hi @Alice Member there', caret: 17 });
  });
});
