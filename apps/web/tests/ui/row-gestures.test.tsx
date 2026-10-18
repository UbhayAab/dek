import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {createPortal} from 'react-dom';
import {useRowGestures,HOLD_MS,type ContextRequest} from '../../src/ui/useRowGestures';
import {ContextMenu} from '../../src/ui/ContextMenu';
const menu=vi.fn(),swipe=vi.fn(),tap=vi.fn(),chosen=vi.fn();
function Row({identity='one',disabled=false,portal=false}:{identity?:string;disabled?:boolean;portal?:boolean}) {
 const [request,setRequest]=useState<ContextRequest|null>(null);
 const g=useRowGestures({identity,disabled,onMenu:r=>{menu(r);setRequest(r);},onSwipe:swipe,left:true,right:true});
 return <article aria-label="row" {...g.handlers} tabIndex={0} onClick={tap} data-offset={g.offset}>Body text<a href="#link">Link</a><button>Native button</button><button data-swipe-handle>Swipe handle</button>
  {portal?<ContextMenu request={request} label="Actions" items={[{label:'Reply in thread',onSelect:chosen}]} onClose={()=>setRequest(null)}/>:null}
  {request&&!portal?createPortal(<button onClick={chosen}>Portal action</button>,document.body):null}
 </article>;
}
class TestPointer extends MouseEvent {pointerId:number;pointerType:string;isPrimary:boolean;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;this.pointerType=init.pointerType??'touch';this.isPrimary=init.isPrimary??true;}}
const down=(el:Element,extra={})=>fireEvent.pointerDown(el,{pointerId:1,pointerType:'touch',isPrimary:true,button:0,clientX:180,clientY:120,...extra});
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('PointerEvent',TestPointer);vi.clearAllMocks();Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
describe('shared row gestures',()=>{
 it('opens touch hold once, allows immediate portalled choice, suppresses original release click',()=>{
  render(<Row portal/>);const row=screen.getByRole('article');down(row);act(()=>vi.advanceTimersByTime(HOLD_MS));
  expect(menu).toHaveBeenCalledTimes(1);fireEvent.pointerUp(row,{pointerId:1,pointerType:'touch'});fireEvent.contextMenu(row);expect(menu).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('menuitem',{name:'Reply in thread'}),{detail:1});expect(chosen).toHaveBeenCalledTimes(1);
  fireEvent.click(row,{detail:1});expect(tap).toHaveBeenCalledTimes(1); // only the permitted portalled choice bubbles
 });
 it.each(['move','scroll','cancel','extra','identity','unmount','lostcapture'])('cancels hold on %s',kind=>{
  const v=render(<Row/>),row=screen.getByRole('article');down(row);
  if(kind==='move')fireEvent.pointerMove(row,{pointerId:1,pointerType:'touch',clientX:180,clientY:150});
  if(kind==='scroll')fireEvent.scroll(document);
  if(kind==='cancel')fireEvent.pointerCancel(row,{pointerId:1});
  if(kind==='extra')fireEvent.pointerDown(document,{pointerId:2,pointerType:'touch'});
  if(kind==='identity')v.rerender(<Row identity="two"/>);
  if(kind==='unmount')v.unmount();
  if(kind==='lostcapture')fireEvent.lostPointerCapture(row,{pointerId:1});
  act(()=>vi.advanceTimersByTime(HOLD_MS+1));expect(menu).not.toHaveBeenCalled();
 });
 it('preserves mouse selection, links, buttons and browser edge gestures',()=>{
  render(<Row/>);for(const el of [screen.getByRole('link'),screen.getByRole('button',{name:'Native button'})]){down(el);act(()=>vi.advanceTimersByTime(HOLD_MS));}
  down(screen.getByRole('article'),{pointerType:'mouse'});act(()=>vi.advanceTimersByTime(HOLD_MS));
  down(screen.getByRole('article'),{clientX:12});act(()=>vi.advanceTimersByTime(HOLD_MS));expect(menu).not.toHaveBeenCalled();
 });
 it('uses right click and keyboard paths with focus restoration and one immediate selection',()=>{
  render(<Row portal/>);const row=screen.getByRole('article');row.focus();fireEvent.contextMenu(row,{clientX:1200,clientY:800});
  expect(screen.getByRole('menu')).toBeTruthy();expect(document.activeElement).toBe(screen.getByRole('menuitem'));
  fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(screen.queryByRole('menu')).toBeNull();expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row,{key:'F10',shiftKey:true});fireEvent.click(screen.getByRole('menuitem'),{detail:1});expect(chosen).toHaveBeenCalledTimes(1);
 });
 it.each([['left',-130],['right',130]])('commits %s exactly once and never taps', (direction,dx)=>{
  render(<Row/>);const row=screen.getByRole('article');down(row);fireEvent.pointerMove(row,{pointerId:1,pointerType:'touch',clientX:180+Number(dx),clientY:122});fireEvent.pointerUp(row,{pointerId:1,pointerType:'touch'});fireEvent.click(row,{detail:1});
  act(()=>vi.advanceTimersByTime(HOLD_MS));expect(swipe).toHaveBeenCalledExactlyOnceWith(direction);expect(menu).not.toHaveBeenCalled();expect(tap).not.toHaveBeenCalled();expect(row.getAttribute('data-offset')).toBe('0');
 });
 it('springs back a partial swipe; a second row cancels the first gesture',()=>{
  render(<><Row/><Row/></>);const [a,b]=screen.getAllByRole('article');down(a!);fireEvent.pointerMove(a!,{pointerId:1,pointerType:'touch',clientX:220,clientY:120});fireEvent.pointerUp(a!,{pointerId:1,pointerType:'touch'});expect(swipe).not.toHaveBeenCalled();expect(a!.getAttribute('data-offset')).toBe('0');
  down(a!);down(b!);act(()=>vi.advanceTimersByTime(HOLD_MS));expect(menu).toHaveBeenCalledTimes(1);expect(menu.mock.calls[0]![0].restore).toBe(b);
 });
 it('native Back dismisses without leaving the row',()=>{
  render(<Row portal/>);fireEvent.contextMenu(screen.getByRole('article'));const ev=new Event('dek:back',{cancelable:true});act(()=>window.dispatchEvent(ev));expect(ev.defaultPrevented).toBe(true);expect(screen.queryByRole('menu')).toBeNull();
 });
 it('clamps against a panned/shrunken visual viewport and reclamps on resize',()=>{
  const viewport=new EventTarget() as VisualViewport;Object.assign(viewport,{offsetLeft:500,offsetTop:100,width:400,height:300});vi.stubGlobal('visualViewport',viewport);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:300,height:200,left:0,top:0,right:300,bottom:200,x:0,y:0,toJSON:()=>({})});
  render(<Row portal/>);fireEvent.contextMenu(screen.getByRole('article'),{clientX:1200,clientY:800});const el=screen.getByRole('menu');expect(el.style.left).toBe('592px');expect(el.style.top).toBe('192px');
  Object.assign(viewport,{width:250,height:180});act(()=>viewport.dispatchEvent(new Event('resize')));expect(el.style.left).toBe('508px');expect(el.style.top).toBe('108px');expect(el.style.maxWidth).toBe('234px');expect(el.style.maxHeight).toBe('164px');
 });
});
