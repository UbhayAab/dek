import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {listenToWorker} from '../../src/sw/register';
let sw:EventTarget;
beforeEach(()=>{sw=new EventTarget();Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:sw});
vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false})));listenToWorker();});
afterEach(()=>{document.body.innerHTML='';Reflect.deleteProperty(navigator,'serviceWorker');vi.unstubAllGlobals();});
function reply(){const send=vi.fn(),event=new MessageEvent('message',{data:{type:'visible-context'}});
Object.defineProperty(event,'ports',{value:[{postMessage:send}]});sw.dispatchEvent(event);return send.mock.calls[0]![0];}
it('reports phone thread context and covered channel panes rather than only the URL',()=>{
document.body.innerHTML='<section class="dk-thread"></section>';expect(reply()).toMatchObject({channelVisible:false,threadVisible:true});
document.body.innerHTML='<section class="dk-convo"></section><aside class="dk-side"></aside>';expect(reply()).toMatchObject({channelVisible:false,threadVisible:false});
vi.mocked(window.matchMedia).mockReturnValue({matches:true} as MediaQueryList);expect(reply()).toMatchObject({channelVisible:true});
});
it('keeps alerts eligible when a modal covers either conversation context',()=>{
document.body.innerHTML='<section class="dk-convo"></section><section class="dk-thread"></section><dialog open></dialog>';
expect(reply()).toMatchObject({channelVisible:false,threadVisible:false});
});
