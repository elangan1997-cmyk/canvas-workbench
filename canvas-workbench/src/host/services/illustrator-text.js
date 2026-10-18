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
    + 'var tf=doc.textFrames.pointText([0,0]);tf.contents=b.text;\n'
    + 'var ca=tf.textRange.characterAttributes;ca.size=b.fontSize;ca.tracking=b.tracking;\n'
    + 'try{ca.textFont=app.textFonts.getByName(b.font);}catch(fontErr){}\n'
    + 'ca.fillColor=rgb(b.color);\n'
    + 'tf.textRange.paragraphAttributes.justification=b.align==="center"?Justification.CENTER:b.align==="right"?Justification.RIGHT:Justification.LEFT;\n'
    // Convert the image's downward Y axis to Illustrator document coordinates.
    + 'var m=app.getIdentityMatrix();m.mValueA=tr[0];m.mValueB=-tr[1];m.mValueC=-tr[2];m.mValueD=tr[3];m.mValueTX=ax+tr[4];m.mValueTY=ay-tr[5];\n'
    + 'tf.transform(m,true,true,true,true,100,Transformation.DOCUMENTORIGIN);\n'
    + '}\n'
    + 'var options=new IllustratorSaveOptions();options.pdfCompatible=true;doc.saveAs(new File(cfg.output),options);\n'
    + 'doc.close(SaveOptions.DONOTSAVECHANGES);return "dsh-ai-done";\n'
    + '}catch(err){try{if(doc)doc.close(SaveOptions.DONOTSAVECHANGES);}catch(closeErr){}throw new Error("illustrator jsx: "+String(err));}\n'
    + '})();\n';
}
