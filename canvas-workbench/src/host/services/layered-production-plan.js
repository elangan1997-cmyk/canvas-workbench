/** Executable region routing adapted from the LSF workflow. Acceptance policy
 * remains separate: a file that opens is not proof of faithful reconstruction. */
export function layeredModeOptions(mode){
 if(!['detailed','practical','preserve'].includes(mode))throw new Error('拆分方式无效');
 return {reconstruction:mode==='preserve'?'preserve':'complete',completionPolicy:mode==='practical'?'practical':'strict'};
}

export function buildLayerProductionPlan(elements,width,height){
 const result=elements.map(e=>({...e})),visible=result.filter(e=>e.enabled!==false),byId=new Map(visible.map(e=>[e.id,e]));
 const known=new Set(result.map(e=>e.id));
 const edges=new Map(visible.map(e=>[e.id,new Set()])),indegree=new Map(visible.map(e=>[e.id,0]));let relations=0;
 const edge=(back,front)=>{
  if(!known.has(back)||!known.has(front))throw new Error('遮挡关系引用不存在的图层：'+back+' → '+front);
  if(!byId.has(back)||!byId.has(front))return;
  if(back===front)throw new Error('图层不能遮挡自身：'+front);
  if(byId.get(front).type==='background')throw new Error('背景不能放在前景上方');
  if(!edges.get(back).has(front)){edges.get(back).add(front);indegree.set(front,indegree.get(front)+1);relations++;}
 };
 for(const e of visible){for(const id of e.frontOf||[])edge(id,e.id);for(const id of e.occludedBy||[])edge(e.id,id);}
 const pending=visible.filter(e=>indegree.get(e.id)===0),ordered=[];
 while(pending.length){pending.sort((a,b)=>a.z-b.z||visible.indexOf(a)-visible.indexOf(b));const e=pending.shift();ordered.push(e);
  for(const id of edges.get(e.id)){indegree.set(id,indegree.get(id)-1);if(!indegree.get(id))pending.push(byId.get(id));}}
 if(ordered.length!==visible.length)throw new Error('遮挡关系形成循环；需要把交错物件拆为关联的前后子层，不能强行排序');
 if(relations)ordered.filter(e=>e.type!=='background').forEach((e,i)=>{e.z=i;});
 const entries=visible.map(e=>{
  const method=e.type==='background'?'background':e.type==='text'?'native-text':e.type==='shape'?'native-shape':e.sourceFallbackGroup?'source-group':['photo-panel','screenshot'].includes(e.visualKind)?'photo-panel':'transparent-image';
  const notes=[];if(e.type==='text')notes.push('内容核对、字体拟合与可编辑性分别验收；拟合字体不等于原字体');
  if(e.type==='shape')notes.push('先核对原图实心覆盖率；渐变和纹理不能冒充纯色形状');
  if(method==='transparent-image')notes.push('检查真实Alpha、可见轮廓、半透明细节与指定的接触阴影；产品印字随产品保留');
  if(method==='background')notes.push('独立底稿；完整模式清除前景与旧字，不以整图覆盖拆分结果');
  if(method==='photo-panel')notes.push('矩形照片保留原场景；独立商品不能仅因外接框为矩形就归为照片');
  if(method==='source-group')notes.push('原图组合例外，不声称内部元素独立或普通文字全部可编辑');
  return{id:e.id,name:e.name,method,anchor:{x:e.x,y:e.y,width:e.width,height:e.height},frontOf:e.frontOf||[],occludedBy:e.occludedBy||[],z:e.z,
   reason:e.classificationReason||e.sourceGlyphReason||e.description||'按已识别的元素类型分流',checks:notes};
 });
 return{elements:result,plan:{version:1,width,height,relations,entries,counts:Object.fromEntries([...new Set(entries.map(e=>e.method))].map(m=>[m,entries.filter(e=>e.method===m).length]))}};
}
