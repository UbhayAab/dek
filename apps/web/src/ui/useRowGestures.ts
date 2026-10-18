// Shared message/activity gestures. Native links/controls and selected desktop
// text retain their browser behavior; a hold never becomes a later row tap.
import {useCallback,useEffect,useRef,useState,type HTMLAttributes} from 'react';
export interface ContextRequest {x:number;y:number;sheet:boolean;restore:HTMLElement;via:'hold'|'context'|'keyboard'}
export const HOLD_MS=500, MOVE_SLOP=10, SWIPE_COMMIT=96;
const NATIVE='a,button,input,textarea,select,video,audio,[contenteditable="true"],[data-gesture-native]';
let activeCancel:(()=>void)|null=null;
interface Options {identity:string;disabled?:boolean;onMenu:(request:ContextRequest)=>void;onSwipe?:(direction:'left'|'right')=>void;left?:boolean;right?:boolean;}
export function useRowGestures(options:Options) {
  const latest=useRef(options);latest.current=options;
  const state=useRef<{id:number;x:number;y:number;offset:number;horizontal:boolean;held:boolean;mouseSwipe:boolean;target:HTMLElement;onSwipe?:Options['onSwipe'];left?:boolean;right?:boolean}|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),suppress=useRef(0),heldUntil=useRef(0);
  const [offset,setOffset]=useState(0);
  const cancel=useCallback(()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;state.current=null;setOffset(0);if(activeCancel===cancel)activeCancel=null;},[]);
  const open=(target:HTMLElement,x:number,y:number,via:ContextRequest['via'],touch=false)=>{
    if(timer.current)clearTimeout(timer.current);timer.current=null;
    suppress.current=Date.now()+900;
    latest.current.onMenu({x,y,restore:target,via,sheet:touch||innerWidth<760});
  };
  useEffect(()=>{
    const stop=()=>cancel();
    const extra=(e:PointerEvent)=>{if(state.current&&e.pointerId!==state.current.id)cancel();};
    document.addEventListener('scroll',stop,true);window.addEventListener('blur',stop);document.addEventListener('pointerdown',extra,true);
    return()=>{cancel();document.removeEventListener('scroll',stop,true);window.removeEventListener('blur',stop);document.removeEventListener('pointerdown',extra,true);};
  },[cancel,options.identity,options.disabled]);
  const handlers:HTMLAttributes<HTMLElement>={
    onPointerDown:e=>{
      if(e.button===2){heldUntil.current=0;return;}
      const handle=!!(e.target as Element).closest('[data-swipe-handle]');
      if(latest.current.disabled||e.button!==0||((e.target as Element).closest(NATIVE)&&!handle))return;
      if(!e.isPrimary&&e.pointerType!=='mouse'){cancel();return;}
      heldUntil.current=0;
      activeCancel?.();activeCancel=cancel;
      const target=e.currentTarget,kind=e.pointerType;
      // Leave browser edge navigation and desktop text selection alone.
      if(kind!=='mouse'&&(e.clientX<24||e.clientX>innerWidth-24))return;
      state.current={id:e.pointerId,x:e.clientX,y:e.clientY,offset:0,horizontal:false,held:false,mouseSwipe:handle,target,onSwipe:latest.current.onSwipe,left:latest.current.left,right:latest.current.right};
      if(kind!=='mouse')timer.current=setTimeout(()=>{const s=state.current;if(!s)return;s.held=true;heldUntil.current=Date.now()+1500;open(target,s.x,s.y,'hold',true);},HOLD_MS);
    },
    onPointerMove:e=>{
      const s=state.current;if(!s||e.pointerId!==s.id||s.held)return;
      const dx=e.clientX-s.x,dy=e.clientY-s.y;
      if(Math.hypot(dx,dy)<MOVE_SLOP)return;
      if(timer.current)clearTimeout(timer.current);timer.current=null;
      if(!s.horizontal) {
        if(!s.onSwipe||Math.abs(dx)<Math.abs(dy)*1.5||(e.pointerType==='mouse'&&!s.mouseSwipe)){cancel();return;}
        s.horizontal=true;s.target.setPointerCapture?.(e.pointerId);
      }
      if(e.cancelable)e.preventDefault();
      s.offset=dx<0&&!s.left||dx>0&&!s.right?dx*.15:Math.max(-160,Math.min(160,dx));setOffset(s.offset);
    },
    onPointerUp:e=>{
      const s=state.current;if(!s||s.id!==e.pointerId)return;
      if(s.held||s.horizontal)suppress.current=Date.now()+900;
      const committed=s.horizontal&&Math.abs(s.offset)>=SWIPE_COMMIT;
      const direction=s.offset<0?'left':'right',action=s.onSwipe,allowed=direction==='left'?s.left:s.right;
      cancel();if(committed&&allowed)action?.(direction);
    },
    onPointerCancel:cancel,
    onLostPointerCapture:cancel,
    onPointerLeave:e=>{if(!state.current?.horizontal&&e.pointerType==='mouse')cancel();},
    onContextMenu:e=>{
      if(latest.current.disabled||(e.target as Element).closest(NATIVE))return;
      const held=state.current?.held||Date.now()<heldUntil.current;
      if(!held&&document.getSelection()?.toString())return;
      e.preventDefault();if(held)return;
      open(e.currentTarget,e.clientX,e.clientY,'context');cancel();
    },
    onClickCapture:e=>{if(e.currentTarget.contains(e.target as Node)&&e.detail!==0&&Date.now()<suppress.current){e.preventDefault();e.stopPropagation();suppress.current=0;}},
    onKeyDown:e=>{
      if(latest.current.disabled||e.target!==e.currentTarget)return;
      if(e.key==='ContextMenu'||(e.key==='F10'&&e.shiftKey)) {
        e.preventDefault();const r=e.currentTarget.getBoundingClientRect();open(e.currentTarget,r.left+24,r.top+24,'keyboard');
      }
    },
  };
  return {handlers,offset,cancel};
}
