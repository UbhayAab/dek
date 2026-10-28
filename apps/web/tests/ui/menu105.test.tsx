import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Menu,Modal} from '../../src/ui/kit';
const chosen=vi.fn();let touch=false;
const box=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON:()=>({})});
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
beforeEach(()=>{touch=false;chosen.mockReset();window.matchMedia=((q:string)=>({matches:touch&&q==='(pointer: coarse)',media:q,addEventListener(){},removeEventListener(){}})) as unknown as typeof window.matchMedia;});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const items=()=>[{label:'Disabled',disabled:true,onSelect:chosen},{label:'First',onSelect:chosen},{label:'Last',onSelect:chosen}];
describe('viewport popup interaction',()=>{
 it('portals out of clipping and keeps an inside pointerdown clickable exactly once',()=>{
  const view=render(<div style={{height:40,overflow:'hidden'}}><Menu label="Server options" items={items()}/></div>);fireEvent.click(screen.getByRole('button',{name:'Server options'}));
  const popup=screen.getByRole('menu');expect(popup.parentElement).toBe(document.body);expect(view.container.contains(popup)).toBe(false);
  fireEvent.pointerDown(screen.getByRole('menuitem',{name:'First'}));expect(screen.getByRole('menu')).toBe(popup);fireEvent.click(screen.getByRole('menuitem',{name:'First'}));expect(chosen).toHaveBeenCalledTimes(1);expect(screen.queryByRole('menu')).toBeNull();
 });
 it('skips disabled items, supports arrows/Home/End and restores focus on Escape and Tab',()=>{
  render(<Menu label="Server options" items={items()}/>);const trigger=screen.getByRole('button',{name:'Server options'});fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'First'}));const menu=screen.getByRole('menu');fireEvent.keyDown(menu,{key:'End'});expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'Last'}));
  fireEvent.keyDown(menu,{key:'ArrowDown'});expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'First'}));fireEvent.keyDown(menu,{key:'Home'});expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'First'}));
  fireEvent.keyDown(menu,{key:'Escape'});expect(document.activeElement).toBe(trigger);expect(screen.queryByRole('menu')).toBeNull();fireEvent.click(trigger);fireEvent.keyDown(screen.getByRole('menu'),{key:'Tab'});expect(screen.queryByRole('menu')).toBeNull();expect(document.activeElement).toBe(trigger);
 });
 it('dismisses on outside pointer, navigation and native Back',()=>{
  render(<Menu label="Options" items={items()}/>);const trigger=screen.getByRole('button',{name:'Options'});fireEvent.click(trigger);fireEvent.pointerDown(document.body);expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);act(()=>window.dispatchEvent(new PopStateEvent('popstate')));expect(screen.queryByRole('menu')).toBeNull();fireEvent.click(trigger);const back=new Event('dek:back',{cancelable:true});act(()=>window.dispatchEvent(back));expect(back.defaultPrevented).toBe(true);expect(screen.queryByRole('menu')).toBeNull();
 });
 it('clamps both axes and follows a shrinking, panned visual viewport',()=>{
  const viewport=new EventTarget() as VisualViewport;Object.assign(viewport,{offsetLeft:500,offsetTop:100,width:400,height:300});vi.stubGlobal('visualViewport',viewport);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return this.getAttribute('role')==='menu'?box(0,0,300,200):box(860,360,30,25);});
  render(<Menu label="Options" items={items()}/>);fireEvent.click(screen.getByRole('button',{name:'Options'}));const popup=screen.getByRole('menu');
  expect(popup.style.left).toBe('590px');expect(popup.style.top).toBe('156px');expect(popup.style.maxWidth).toBe('384px');
  Object.assign(viewport,{width:250,height:180});act(()=>viewport.dispatchEvent(new Event('resize')));expect(screen.queryByRole('menu')).toBeNull();
 });
 it('repositions on scroll and constrains long menus to available height',()=>{
  let top=700;vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return this.getAttribute('role')==='menu'?box(0,0,250,1600):box(950,top,28,28);});
  render(<Menu label="Options" items={items()}/>);fireEvent.click(screen.getByRole('button',{name:'Options'}));const menu=screen.getByRole('menu');expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);expect(parseFloat(menu.style.maxHeight)).toBeLessThan(window.innerHeight);
  const before=menu.style.top;top=100;act(()=>window.dispatchEvent(new Event('scroll')));expect(menu.style.top).not.toBe(before);
 });
 it('keeps a popup inside its modal top layer and closes before the callback',()=>{
  render(<Modal open title="Parent" onClose={()=>{}}><Menu label="Nested options" items={[{label:'Choose',onSelect:()=>chosen(!!document.querySelector('[role=menu]'))}]}/></Modal>);
  fireEvent.click(screen.getByRole('button',{name:'Nested options'}));expect(screen.getByRole('menu').parentElement).toBe(screen.getByRole('dialog'));fireEvent.click(screen.getByRole('menuitem',{name:'Choose'}));expect(chosen).toHaveBeenCalledWith(false);
 });
 it('retains a touch action sheet with keyboard-safe height and selection',()=>{
  touch=true;const viewport=new EventTarget() as VisualViewport;Object.assign(viewport,{offsetLeft:0,offsetTop:0,width:390,height:300});vi.stubGlobal('visualViewport',viewport);
  render(<Menu label="Phone options" items={items()}/>);fireEvent.click(screen.getByRole('button',{name:'Phone options'}));expect(screen.getByRole('dialog',{name:'Phone options'})).toBeTruthy();expect(parseFloat(screen.getByRole('menu').style.maxHeight)).toBeLessThan(300);
  fireEvent.click(screen.getByRole('menuitem',{name:'First'}));expect(chosen).toHaveBeenCalledTimes(1);
 });
});
