const contains=(a,b)=>b.x>=a.x-2&&b.y>=a.y-2&&b.x+b.width<=a.x+a.width+2&&b.y+b.height<=a.y+a.height+2;

// A diagonal/gradient cannot be represented by the current solid rectangle
// primitive. Preserve that original artwork group, rather than draw a knowingly
// wrong rectangle or duplicate native type over the original printed lettering.
export function denseSourceStructure(elements){
  const result=elements.map(e=>({...e})),warnings=[];
  for(const e of result){
    const background=result.find(item=>item.type==='background');
    const largeBand=background&&e.width*e.height>background.width*background.height*.04;
    if(e.type!=='shape'||e.modeLocked||e.geometryLocked||(!largeBand&&!/渐变|斜切|斜线|不规则|近似|gradient|diagonal/i.test(e.description||'')))continue;
    const children=result.filter(c=>c.type==='image'&&c.enabled!==false&&contains(e,c));
    e.type='image';e.sourceRegion=true;e.visualKind='graphic';e.extractionMode='photo';e.modeLocked=true;e.enabled=true;
    e.classificationReason='复杂或大面积底纹区域按原图完整保留，避免纯色近似覆盖原始纹理';e.name=e.name.replace(/与原图内容$/,'')+'与原图内容';
    e.mergedIds=[...new Set([...(e.mergedIds||[]),...children.map(c=>c.id)])];
    for(const c of children){c.enabled=false;c.sourceParentId=e.id;}
    warnings.push('“'+e.name+'”作为原图组合图层保留，未把斜边或渐变近似成矩形；组合内部的文字和图像不重复输出');
  }
  const images=result.filter(e=>e.type==='image'&&e.enabled!==false);
  for(const e of result){
    if(e.type==='image'&&!e.modeLocked)e.sourceRegion=true;
    if(e.type==='text'){const parent=images.find(image=>contains(image,e));if(parent){e.enabled=false;e.sourceParentId=parent.id;}}
  }
  return{elements:result,warnings};
}
