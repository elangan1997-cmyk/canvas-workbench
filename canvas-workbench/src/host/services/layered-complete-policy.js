/** Complete reconstruction is explicit: no ordinary raster text or flattened
 * promotional panels may be reported as fully editable output. */
export function completeLayerPlan(elements){
 const plan=elements.map(raw=>{
  const e={...raw};
  if(e.type==='text'&&['handwriting','display'].includes(e.typographyKind)){
   e.type='image';e.visualKind='graphic';e.nativeText=false;e.foregroundColors=[e.color||'#111111'];
   e.description='独立装饰字形：'+e.text+'；保持原笔画，不含底色、商品和其他排版文字';e.classificationReason='视觉模型确认特殊书法/艺术字，原字形独立透明提取';
  }
  if(e.sourceParentId){delete e.sourceParentId;e.enabled=true;}
  if(e.type==='image'){
   if(['photo-panel','screenshot'].includes(e.visualKind)){
    e.extractionMode='photo';e.sourceRegion=true;e.modeLocked=true;
   }else{
    e.extractionMode='cutout';e.modeLocked=true;e.preserveSource=false;
    delete e.sourceRegion;delete e.resolutionPolicy;
   }
  }
  if(e.type==='background')e.preserveSource=false;
  if(e.type==='text'){
   e.textMode='editable';delete e.sourceTextFallback;delete e.retainedInBackground;
  }
  return e;
 });
 const words=plan.filter(e=>e.enabled&&['handwriting','display'].includes(e.typographyKind));
 for(const group of plan.filter(e=>e.enabled&&e.type==='image'&&e.visualKind==='graphic'&&!e.typographyKind&&/手写|书法|艺术字|装饰字/.test(e.name||''))){
  const inside=words.filter(e=>e.x>=group.x-8&&e.y>=group.y-8&&e.x+e.width<=group.x+group.width+8&&e.y+e.height<=group.y+group.height+8);
  if(inside.length){const x=Math.min(...inside.map(e=>e.x)),y=Math.min(...inside.map(e=>e.y)),r=Math.max(...inside.map(e=>e.x+e.width)),b=Math.max(...inside.map(e=>e.y+e.height));if((r-x)*(b-y)>group.width*group.height*.35){group.enabled=false;group.typographySuperseded=true;}}
 }
 return plan;
}

export function completeLayerAudit(elements){
 const visible=elements.filter(e=>e.enabled);
 const rasterText=visible.filter(e=>e.type==='text'&&!e.nativeText).map(e=>e.id);
 const opaqueSubjects=visible.filter(e=>e.type==='image'&&['product','graphic'].includes(e.visualKind)&&(e.sourceRegion||e.extractionMode!=='cutout')).map(e=>e.id);
 const hiddenText=elements.filter(e=>e.type==='text'&&!e.enabled&&e.retainedInBackground).map(e=>e.id);
 const uncertainText=visible.filter(e=>e.type==='text'&&e.contentUncertain).map(e=>e.id);
 const unconfirmedGlyphs=visible.filter(e=>e.unresolvedAsGlyph).map(e=>({id:e.id,reason:e.sourceGlyphReason||'原文未确认'}));
 return {complete:!rasterText.length&&!opaqueSubjects.length&&!hiddenText.length&&!uncertainText.length,rasterText,opaqueSubjects,hiddenText,uncertainText,
  unconfirmedGlyphs,allTextEditable:!rasterText.length&&!unconfirmedGlyphs.length&&!visible.some(e=>e.typographyKind),
  editableText:visible.filter(e=>e.type==='text'&&e.nativeText).length,independentImages:visible.filter(e=>e.type==='image').length};
}

/** Re-analysis numbers text again. Text IDs are not reusable material owners,
 * even when a new text candidate becomes an independent artwork glyph. */
export function reuseCompleteMaterials(elements,previous,fixedLayout){
 const owners=new Set(fixedLayout.map(e=>e.id)),prior=new Map(previous.map(e=>[e.id,e]));
 return elements.map(e=>owners.has(e.id)&&prior.has(e.id)?{...e,...prior.get(e.id),enabled:e.enabled}:e);
}

export function deduplicateCompleteText(elements){
 const compact=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
 const texts=elements.filter(e=>e.enabled&&e.type==='text').sort((a,b)=>Number(a.sourceTextSupplement)-Number(b.sourceTextSupplement)||Number(b.contentVerified)-Number(a.contentVerified));
 const kept=[];
 for(const e of texts){
  const b=e.cleanupBounds||e;
  const prior=kept.find(n=>{const a=n.cleanupBounds||n;const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return compact(n.text)===compact(e.text)&&area>Math.min(a.width*a.height,b.width*b.height)*.45;});
  if(prior){e.enabled=false;e.duplicateOf=prior.id;delete e.retainedInBackground;}else kept.push(e);
 }
 for(const e of texts.filter(e=>e.enabled&&e.sourceTextSupplement)){
  const a=e.cleanupBounds||e,parts=texts.filter(n=>n.enabled&&n.id!==e.id&&!n.sourceTextSupplement&&(()=>{const b=n.cleanupBounds||n;return b.x>=a.x-4&&b.y>=a.y-4&&b.x+b.width<=a.x+a.width+4&&b.y+b.height<=a.y+a.height+4;})());
  let rest=compact(e.text);for(const p of parts.sort((a,b)=>b.text.length-a.text.length))rest=rest.replace(compact(p.text),'');
  if(parts.length&&!rest){e.enabled=false;e.duplicateOf=parts[0].id;delete e.retainedInBackground;}
 }
}
