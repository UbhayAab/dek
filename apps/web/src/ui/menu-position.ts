export interface MenuViewport {left:number;top:number;width:number;height:number}
export function placeMenu(anchor:{left:number;right:number;top:number;bottom:number},size:{width:number;height:number},viewport:MenuViewport,align:'start'|'end') {
 const pad=8,gap=4,maxWidth=Math.max(0,viewport.width-pad*2),width=Math.min(Math.max(200,size.width),maxWidth);
 const bottom=viewport.top+viewport.height-pad,top=viewport.top+pad;
 const below=Math.max(0,bottom-anchor.bottom-gap),above=Math.max(0,anchor.top-gap-top);
 const up=size.height>below&&above>below,maxHeight=up?above:below,height=Math.min(size.height,maxHeight);
 const left=Math.max(viewport.left+pad,Math.min(align==='end'?anchor.right-width:anchor.left,viewport.left+viewport.width-width-pad));
 return {left,top:Math.max(top,Math.min(up?anchor.top-gap-height:anchor.bottom+gap,bottom-height)),maxWidth,minWidth:Math.min(200,maxWidth),maxHeight};
}
