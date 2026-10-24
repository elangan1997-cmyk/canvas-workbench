import { textLayerGeometry } from './native-text-psd.js';

export function buildIllustratorTextJsx({ background, output, width, height, blocks }) {
  const rows = (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.enabled !== false && String(b.text || '').trim()).slice(0, 200)
    .map((b) => ({ text: String(b.text), font: String(b.fontPostScript || ''), color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#111827',
      tracking: Math.round(Number(b.tracking || 0)), ...textLayerGeometry(b) }));
  const cfg = JSON.stringify({ background, output, width, height, rows });
  return '#target illustrator\n(function(){\n'
    + 'var cfg=' + cfg + ';\n'
    + 'function rgb(hex){var c=new RGBColor();c.red=parseInt(hex.substr(1,2),16);c.green=parseInt(hex.substr(3,2),16);c.blue=parseInt(hex.substr(5,2),16);return c;}\n'
    + 'var doc=null;try{\n'
    + 'doc=app.documents.add(DocumentColorSpace.RGB,cfg.width,cfg.height);doc.rulerUnits=RulerUnits.Points;\n'
    + 'var ab=doc.artboards[0].artboardRect,ax=ab[0],ay=ab[1];\n'
    + 'doc.layers[0].name="背景与文字";\n'
    + 'var pi=doc.placedItems.add();pi.file=new File(cfg.background);pi.width=cfg.width;pi.height=cfg.height;pi.left=ax;pi.top=ay;pi.embed();\n'
    + 'for(var i=0;i<cfg.rows.length;i++){var b=cfg.rows[i],tr=b.transform;\n'
    // Point text is anchored at its baseline, unlike TextFrame.left/top
    // which describe visible bounds and shift with font/justification.
    + 'var px=ax+tr[4],py=ay-tr[5],tf=doc.textFrames.pointText([px,py]);tf.contents=b.text.replace(/\\r?\\n/g,"\\r");app.redraw();$.sleep(100);\n'
    + 'var ca=tf.textRange.characterAttributes;ca.size=b.fontSize;ca.tracking=b.tracking;\n'
    + 'ca.textFont=app.textFonts.getByName(b.font);app.redraw();ca=tf.textRange.characterAttributes;ca.size=b.fontSize;ca.tracking=b.tracking;ca.autoLeading=false;ca.leading=b.fontSize*1.2;\n'
    + 'ca.fillColor=rgb(b.color);\n'
    + 'if(b.align==="center"){tf.textRange.paragraphAttributes.justification=Justification.CENTER;}else if(b.align==="right"){tf.textRange.paragraphAttributes.justification=Justification.RIGHT;}else{tf.textRange.paragraphAttributes.justification=Justification.LEFT;}\n'
    // Convert the image's downward Y axis to Illustrator document coordinates.
    + 'if(Math.abs(tr[1])>.000001||Math.abs(tr[0]-1)>.000001){var m=app.getIdentityMatrix();m.mValueA=tr[0];m.mValueB=-tr[1];m.mValueC=-tr[2];m.mValueD=tr[3];m.mValueTX=px-tr[0]*px+tr[2]*py;m.mValueTY=py+tr[1]*px-tr[3]*py;tf.transform(m,true,true,true,true,100,Transformation.DOCUMENTORIGIN);}app.redraw();\n'
    + '}\n'
    + 'var options=new IllustratorSaveOptions();options.pdfCompatible=true;doc.saveAs(new File(cfg.output),options);\n'
    + 'doc.close(SaveOptions.DONOTSAVECHANGES);return "dsh-ai-done";\n'
    + '}catch(err){try{if(doc)doc.close(SaveOptions.DONOTSAVECHANGES);}catch(closeErr){}throw new Error("illustrator jsx: "+String(err));}\n'
    + '})();\n';
}
