import { readFile } from 'node:fs/promises';
import { textLayerGeometry } from './native-text-psd.js';

const escapeXml = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export function nativeLayerText(b) {
  if (!b.fontAccepted || !b.text || !b.fontPostScript) throw new Error('原生文字必须确认内容及候选字体：' + b.name);
  const geo = textLayerGeometry(b), hex = b.color.slice(1);
  return { text: String(b.text), transform: geo.transform, shapeType: 'point', pointBase: [0, 0], orientation: 'horizontal', antiAlias: 'sharp',
    style: { font: { name: b.fontPostScript }, fontSize: geo.fontSize, tracking: Math.round(b.tracking || 0), leading: geo.fontSize * 1.2, autoLeading: false,
      fillColor: { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4), 16) } },
    paragraphStyle: { justification: geo.align } };
}

export function nativeShapeLayer(b) {
  const x=b.x,y=b.y,w=b.width,h=b.height,r=Math.min(b.radius||0,w/2,h/2),k=.5522847498;
  const knot=(a,incoming=a,outgoing=a)=>({linked:false,points:[...incoming,...a,...outgoing]});
  const knots=r ? [knot([x+r,y],[x+r-k*r,y]),knot([x+w-r,y],undefined,[x+w-r+k*r,y]),
    knot([x+w,y+r],[x+w,y+r-k*r]),knot([x+w,y+h-r],undefined,[x+w,y+h-r+k*r]),
    knot([x+w-r,y+h],[x+w-r+k*r,y+h]),knot([x+r,y+h],undefined,[x+r-k*r,y+h]),
    knot([x,y+h-r],[x,y+h-r+k*r]),knot([x,y+r],undefined,[x,y+r-k*r])] : [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(a=>knot(a));
  const hex=(b.fill||'#FFFFFF').slice(1),color={r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)};
  return {vectorFill:{type:'color',color},vectorMask:{paths:[{open:false,operation:'combine',fillRule:'non-zero',knots}],fillStartsWithAllPixels:false}};
}

export async function buildLayeredPsd(manifest) {
  const psd = await import('ag-psd');
  psd.initializeCanvas(() => { throw new Error('PSD pixel buffers do not require native canvas'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const children = [];
  for (const item of manifest.layers) {
    const data = new Uint8ClampedArray(await readFile(item.raw));
    if (data.length !== item.width * item.height * 4) throw new Error('图层像素长度不匹配');
    children.push({ name: item.name, left: item.left, top: item.top, hidden: item.hidden === true,
      imageData: { width: item.width, height: item.height, data },
      ...(item.element.nativeText ? { text: nativeLayerText(item.element) } : {}), ...(item.element.type==='shape'?nativeShapeLayer(item.element):{}) });
  }
  const { width, height } = manifest;
  const composite = new Uint8ClampedArray(await readFile(manifest.composite));
  if (composite.length !== width * height * 4) throw new Error('合成像素长度不匹配');
  const buffer = psd.writePsdBuffer({ width, height, children, imageData: { width, height, data: composite },
    imageResources: { resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } }
  }, { invalidateTextLayers: false, noBackground: true });
  const saved = psd.readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  if (saved.children.length !== children.length || saved.width !== width || saved.height !== height) throw new Error('PSD 保存后检查不通过');
  for (let i = 0; i < children.length; i++) {
    if (saved.children[i].name !== children[i].name) throw new Error('PSD 图层顺序读回不一致');
    if (children[i].text && saved.children[i].text?.text.replace(/\r\n?/g, '\n') !== children[i].text.text.replace(/\r\n?/g, '\n')) throw new Error('PSD 文字读回不一致');
  }
  return buffer;
}

export async function buildLayeredSvg(task) {
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="' + task.width + '" height="' + task.height + '" viewBox="0 0 ' + task.width + ' ' + task.height + '">'];
  for (const b of task.elements.filter(e => e.enabled).sort((a, b) => a.z - b.z)) {
    parts.push('<g id="' + escapeXml(b.id) + '" data-layer-name="' + escapeXml(b.name) + '"><title>' + escapeXml(b.name) + '</title>');
    if (b.nativeText) {
      const geo = textLayerGeometry(b), tr = geo.transform;
      parts.push('<text transform="matrix(' + tr.join(' ') + ')" fill="' + escapeXml(b.color) + '" font-family="' + escapeXml(b.fontPostScript) + '" font-size="' + geo.fontSize + '" letter-spacing="' + (Math.round(b.tracking || 0) * geo.fontSize / 1000) + '" text-anchor="' + ({ center: 'middle', right: 'end' }[geo.align] || 'start') + '" xml:space="preserve">');
      const lines = b.text.replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => parts.push('<tspan x="0" y="' + i * geo.fontSize * 1.2 + '">' + escapeXml(line) + '</tspan>'));
      parts.push('</text>');
    } else if(b.type==='shape') {
      parts.push('<rect x="'+b.x+'" y="'+b.y+'" width="'+b.width+'" height="'+b.height+'" rx="'+(b.radius||0)+'" fill="'+escapeXml(b.fill)+'"/>');
    } else {
      const bounds = b.bounds || { x: 0, y: 0, width: task.width, height: task.height };
      parts.push('<image x="' + bounds.x + '" y="' + bounds.y + '" width="' + bounds.width + '" height="' + bounds.height + '" href="data:image/png;base64,' + (await readFile(b.contentFile || b.file)).toString('base64') + '"/>');
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('');
}

export function buildLayeredIllustratorJsx({ width, height, elements, output }) {
  const rows = elements.filter(e => e.enabled).sort((a, b) => a.z - b.z).map(b => ({
    name: b.name, file: b.file, nativeText: b.nativeText === true, ...(b.type==='shape'?{shape:{x:b.x,y:b.y,width:b.width,height:b.height,radius:b.radius||0,fill:b.fill}}:{}), bounds: b.bounds || { x: 0, y: 0, width, height },
    ...(b.nativeText ? { text: b.text, font: b.fontPostScript, color: b.color, tracking: Math.round(b.tracking || 0), ...textLayerGeometry(b) } : {})
  }));
  const config = JSON.stringify({ width, height, rows, output });
  return '#target illustrator\n(function(){\n'
    + 'var cfg=' + config + ';var doc=null,stage="create",previousInteraction=app.userInteractionLevel;app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;\n'
    + 'function rgb(hex){var c=new RGBColor();c.red=parseInt(hex.substr(1,2),16);c.green=parseInt(hex.substr(3,2),16);c.blue=parseInt(hex.substr(5,2),16);return c;}\n'
    + 'try{doc=app.documents.add(DocumentColorSpace.RGB,cfg.width,cfg.height);doc.rulerUnits=RulerUnits.Points;\n'
    + 'var ab=doc.artboards[0].artboardRect,ax=ab[0],ay=ab[1];var expectedTexts=0;\n'
    + 'for(var i=0;i<cfg.rows.length;i++){stage="layer "+i;var b=cfg.rows[i],layer=i===0?doc.layers[0]:doc.layers.add();layer.name=b.name;doc.activeLayer=layer;\n'
    + 'if(b.shape){var s=b.shape,sp=s.radius?doc.pathItems.roundedRectangle(ay-s.y,ax+s.x,s.width,s.height,s.radius,s.radius):doc.pathItems.rectangle(ay-s.y,ax+s.x,s.width,s.height);sp.name=b.name;sp.filled=true;sp.fillColor=rgb(s.fill);sp.stroked=false;sp.move(layer,ElementPlacement.PLACEATBEGINNING);\n'
    + '}else if(b.nativeText){var font;try{font=app.textFonts.getByName(b.font);}catch(e){throw new Error("Missing Illustrator font: "+b.font);}\n'
    + 'var tr=b.transform,px=ax+tr[4],py=ay-tr[5],tf=doc.textFrames.pointText([px,py]);tf.name=b.name;tf.contents=b.text.replace(/\\r?\\n/g,"\\r");app.redraw();$.sleep(100);var ca=tf.textRange.characterAttributes;ca.textFont=app.textFonts.getByName(b.font);app.redraw();ca=tf.textRange.characterAttributes;ca.size=b.fontSize;ca.tracking=b.tracking;ca.autoLeading=false;ca.leading=b.fontSize*1.2;ca.fillColor=rgb(b.color);\n'
    // ExtendScript's native enum wrappers are unsafe in conditional expressions:
    // Illustrator 30 selected RIGHT for CENTER. Assign each enum in its own branch.
    + 'if(b.align==="center"){tf.textRange.paragraphAttributes.justification=Justification.CENTER;}else if(b.align==="right"){tf.textRange.paragraphAttributes.justification=Justification.RIGHT;}else{tf.textRange.paragraphAttributes.justification=Justification.LEFT;}\n'
    + 'if(Math.abs(tr[1])>.000001||Math.abs(tr[0]-1)>.000001){var m=app.getIdentityMatrix();m.mValueA=tr[0];m.mValueB=-tr[1];m.mValueC=-tr[2];m.mValueD=tr[3];m.mValueTX=px-tr[0]*px+tr[2]*py;m.mValueTY=py+tr[1]*px-tr[3]*py;tf.transform(m,true,true,true,true,100,Transformation.DOCUMENTORIGIN);}app.redraw();b.savedBounds=tf.geometricBounds;expectedTexts++;\n'
    + '}else{var pi=doc.placedItems.add();pi.file=new File(b.file);pi.move(layer,ElementPlacement.PLACEATBEGINNING);pi.width=b.bounds.width;pi.height=b.bounds.height;pi.left=ax+b.bounds.x;pi.top=ay-b.bounds.y;pi.embed();}}\n'
    + 'stage="save";app.redraw();$.sleep(100);for(var si=0;si<cfg.rows.length;si++){var sr=cfg.rows[si];if(!sr.nativeText)continue;var st=doc.layers.getByName(sr.name).textFrames[0],sb=st.geometricBounds;sr.savedBounds=[sb[0],sb[1],sb[2],sb[3]];}var opts=new IllustratorSaveOptions();opts.pdfCompatible=true;doc.saveAs(new File(cfg.output),opts);app.redraw();doc.close(SaveOptions.DONOTSAVECHANGES);doc=null;$.sleep(500);\n'
    + 'stage="reopen";doc=app.open(new File(cfg.output));app.redraw();if(doc.layers.length!==cfg.rows.length||doc.textFrames.length!==expectedTexts||doc.placedItems.length!==0)throw new Error("AI saved layers, type or embedding verification failed");\n'
    + 'for(var j=0;j<cfg.rows.length;j++){var r=cfg.rows[j];if(!r.nativeText)continue;var found=false;for(var t=0;t<doc.textFrames.length;t++){var f=doc.textFrames[t];if(f.name===r.name&&f.contents.replace(/\\r/g,"\\n")===r.text.replace(/\\r\\n?/g,"\\n")){var ap=f.anchor;if(Math.abs(ap[0]-ax-r.transform[4])>1||Math.abs(ap[1]-ay+r.transform[5])>1)throw new Error("AI text baseline mismatch: "+r.name);var rb=f.geometricBounds;for(var q=0;q<4;q++)if(Math.abs(rb[q]-r.savedBounds[q])>1)throw new Error("AI text position changed after save: "+r.name);var ja=f.textRange.paragraphAttributes.justification;if(r.align==="center"&&ja!==Justification.CENTER)throw new Error("AI text alignment mismatch: "+r.name);if(r.align==="right"&&ja!==Justification.RIGHT)throw new Error("AI text alignment mismatch: "+r.name);if(r.align==="left"&&ja!==Justification.LEFT)throw new Error("AI text alignment mismatch: "+r.name);if(f.textRange.characterAttributes.textFont.name!==r.font)throw new Error("AI font readback mismatch: "+r.name);found=true;break;}}if(!found)throw new Error("AI text readback mismatch: "+r.name);}\n'
    + 'stage="close";doc.close(SaveOptions.DONOTSAVECHANGES);doc=null;return "dsh-layered-ai-done";\n'
    + '}catch(err){try{if(doc)doc.close(SaveOptions.DONOTSAVECHANGES);}catch(closeErr){}throw new Error("Layered Illustrator export ["+stage+"]: "+String(err));}finally{app.userInteractionLevel=previousInteraction;}\n})();\n';
}
