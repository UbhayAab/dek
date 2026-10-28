import { describe, expect, it } from 'vitest';
import cases from '../../../../supabase/tests/mention-syntax-cases.json';
import { notificationLiteralMask, parseBlocks } from '../../src/ui/markdown/parse';
import type { Block, Inline } from '../../src/ui/markdown/types';
const TOKEN='<@304ca758-4908-41e8-ba54-a4a0428b0e0e>';
function ins(ns:Inline[]):number {return ns.reduce((n,x)=>n+(x.t==='user'||x.t==='all'?1:'c' in x?ins(x.c):0),0);}
function blocks(ns:Block[]):number {return ns.reduce((n,x)=>n+(x.t==='p'?ins(x.c):x.t==='quote'?blocks(x.c):x.t==='list'?x.items.reduce((s,i)=>s+ins(i.c)+blocks(i.children),0):0),0);}
describe('rendered notification syntax',()=>{
  for(const c of cases)it(c.name,()=>{
    const body=c.body.replaceAll('TOKEN',TOKEN),mask=notificationLiteralMask(body);
    const rendered=blocks(parseBlocks(body));
    expect(rendered).toBe(c.active);
    const encoded=[...body.matchAll(/<@[^>]+>|<!(?:channel|here)>/g)].filter(m=>!mask[m.index!]);
    expect(encoded).toHaveLength(rendered);
  });
  it('pairs the scanner against renderer boundaries across generated containers and long links',()=>{
    const bodies:string[]=[];
    const heads=['','> ','- item\n  ','1. item\n  ','> > ','- item\n  > '];
    const inners=['TOKEN','`TOKEN`','```\nTOKEN\n```','```bad`info\nTOKEN','~~~\nTOKEN\n~~~',
      '[TOKEN](https://x.test)','[TOKEN](javascript:x)','[TOKEN](x','https://x.test/[TOKEN](x)',
      'ְhttps://x.test/[TOKEN](x)','ाhttps://x.test/[TOKEN](x)','𝅥https://x.test/[TOKEN](x)',
      '`\n\u00a0\nTOKEN`','```\nTOKEN\n```\ufeff\nTOKEN'];
    for(const h of heads)for(const inner of inners) {
      const prefix=h.includes('\n')?h.slice(h.indexOf('\n')+1):h;
      bodies.push(h+inner.replaceAll('\n',`\n${prefix}`));
    }
    for(const n of [1010,1020,1024,1030,2040,2048]) {
      bodies.push(`[TOKEN](https://x.test/${'🙂'.repeat(n)})`);
      bodies.push(`[TOKEN](https://x.test "${'🙂'.repeat(n)}")`);
    }
    const oracle=[...cases.map(c=>({name:c.name,body:c.body.replaceAll('TOKEN',TOKEN),expected:c.active})),
      ...bodies.map((s,i)=>{const body=s.replaceAll('TOKEN',TOKEN);return {name:`generated${i}`,body,expected:blocks(parseBlocks(body))};})];
    for(const c of oracle) {
      const mask=notificationLiteralMask(c.body);
      expect([...c.body.matchAll(/<@[^>]+>|<!(?:channel|here)>/g)].filter(m=>!mask[m.index!]).length,c.name).toBe(c.expected);
    }
  });
});
