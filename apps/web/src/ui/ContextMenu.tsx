import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type CSSProperties} from 'react';
import {createPortal,flushSync} from 'react-dom';
import {Icon} from './icons';
import {Modal,type MenuItem} from './kit';
import type {ContextRequest} from './useRowGestures';
import './context-menu.css';
export function ContextMenu({request,label,items,quick=[],onClose}:{request:ContextRequest|null;label:string;items:MenuItem[];quick?:{label:string;text:string;onSelect:()=>void}[];onClose:()=>void}) {
  const ref=useRef<HTMLDivElement>(null),[position,setPosition]=useState<CSSProperties>({left:8,top:8});
  const close=(restore=true)=>{if(restore&&request?.restore.isConnected)request.restore.focus({preventScroll:true});onClose();};
  useLayoutEffect(()=>{
    if(!request)return;const el=ref.current;
    const clamp=()=>{if(!el)return;const r=el.getBoundingClientRect(),v=window.visualViewport,l=v?.offsetLeft??0,t=v?.offsetTop??0,w=v?.width??innerWidth,h=v?.height??innerHeight;
      if(request.sheet){
        const dialog=el.closest('dialog'),panel=el.closest<HTMLElement>('.dk-modal__panel'),header=panel?.querySelector('.dk-modal__header')?.getBoundingClientRect().height??64;
        if(dialog){dialog.style.maxWidth=`${w}px`;dialog.style.maxHeight=`${Math.max(44,h-8)}px`;dialog.style.marginLeft=`${l}px`;dialog.style.marginBottom=`${Math.max(0,innerHeight-h-t)}px`;}
        if(panel)panel.style.maxHeight=`${Math.max(44,h-8)}px`;
        setPosition({maxHeight:Math.max(44,h-header-40),maxWidth:'100%'});
      }else setPosition({left:Math.max(l+8,Math.min(request.x,l+w-Math.min(r.width,w-16)-8)),top:Math.max(t+8,Math.min(request.y,t+h-Math.min(r.height,h-16)-8)),maxWidth:Math.max(44,w-16),maxHeight:Math.max(44,h-16)});
    };
    clamp();window.addEventListener('resize',clamp);window.visualViewport?.addEventListener('resize',clamp);window.visualViewport?.addEventListener('scroll',clamp);
    el?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(clamp);if(el)observer?.observe(el);
    return()=>{observer?.disconnect();window.removeEventListener('resize',clamp);window.visualViewport?.removeEventListener('resize',clamp);window.visualViewport?.removeEventListener('scroll',clamp);};
  },[request]);
  useEffect(()=>{
    if(!request)return;
    const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))close(false);};
    const back=()=>close(false);
    const nativeBack=(e:Event)=>{e.preventDefault();close();};
    if(!request.sheet)document.addEventListener('pointerdown',outside);
    window.addEventListener('popstate',back);
    window.addEventListener('dek:back',nativeBack);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('popstate',back);window.removeEventListener('dek:back',nativeBack);};
  },[request]);
  if(!request)return null;
  const choose=(fn:()=>void)=>{flushSync(()=>onClose());if(request.restore.isConnected)request.restore.focus({preventScroll:true});fn();};
  const keys=(e:KeyboardEvent<HTMLDivElement>)=>{
    const buttons=[...ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]],i=buttons.indexOf(document.activeElement as HTMLButtonElement);
    if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();e.stopPropagation();close();}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}
    if(e.key==='Home'||e.key==='End'){e.preventDefault();(e.key==='Home'?buttons[0]:buttons.at(-1))?.focus();}
  };
  const menu=<div ref={ref} role="menu" aria-label={label} className={`dk-context${request.sheet?' is-sheet':''}`} onKeyDown={keys} style={position}>
    {quick.length?<div className="dk-context__quick" role="group" aria-label="Quick reactions">{quick.map((it,i)=><button key={it.label} autoFocus={i===0} role="menuitem" type="button" aria-label={it.label} onClick={()=>choose(it.onSelect)}>{it.text}</button>)}</div>:null}
    {items.map((it,i)=><button type="button" autoFocus={!quick.length&&i===0} role="menuitem" key={it.label} disabled={it.disabled} className={`dk-context__item${it.danger?' is-danger':''}`} onClick={()=>choose(it.onSelect)}>
      {it.icon?<Icon name={it.icon} size={18}/>:null}<span>{it.label}</span>
    </button>)}
  </div>;
  return createPortal(request.sheet?<Modal open title={label} onClose={()=>close()} size="sm">{menu}</Modal>:menu,document.body);
}
