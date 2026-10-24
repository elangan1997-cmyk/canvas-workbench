// Explicit native acceptance; never part of npm test and never edits source files.
// node tests/integration/verify-layered-adobe.mjs <task.json> <output-dir> <ai|psd>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('This native acceptance driver requires macOS');
const [taskFile, outputDirectory, kind] = process.argv.slice(2);
if (!taskFile || !outputDirectory || !['ai', 'psd'].includes(kind)) throw new Error('Expected task.json output-dir ai|psd');
const task = JSON.parse(await readFile(taskFile, 'utf8'));
const file = [...task.exports].reverse().find(e => e.kind === kind);
const texts = task.elements.filter(e => e.enabled && e.nativeText);
if (!file || texts.length < 2) throw new Error('Need an exported file containing at least two native text layers');
const work = resolve(outputDirectory); await mkdir(work, { recursive: true });
const config = JSON.stringify({ file: file.path, texts, rows: task.elements.filter(e => e.enabled), width: task.width, height: task.height, work });
const common = `var c=${config},doc=null,f=new File(c.work+'/evidence.txt');f.encoding='UTF8';f.open('w');function assert(v,s){if(!v)throw Error(s);}function near(a,b){return Math.abs(a-b)<2;}`;
const ai = `#target illustrator
(function(){${common}var prior=app.userInteractionLevel;app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;try{
doc=app.open(new File(c.file));app.activeDocument=doc;app.redraw();$.sleep(800);
assert(doc.layers.length===c.rows.length,'Layer count');assert(doc.textFrames.length===c.texts.length,'Editable text count');assert(doc.placedItems.length===0,'Images must be embedded');
for(var i=0;i<c.texts.length;i++){var r=c.texts[i],t=doc.layers.getByName(r.name).textFrames[0];assert(t.contents===r.text,'Text readback '+r.id);assert(t.textRange.characterAttributes.textFont.name===r.fontPostScript,'Font readback '+r.id);f.writeln('text='+r.text+'|'+r.fontPostScript);}
var opts=new ExportOptionsPNG24();opts.artBoardClipping=true;opts.horizontalScale=100;opts.verticalScale=100;opts.transparency=false;doc.exportFile(new File(c.work+'/before.png'),ExportType.PNG24,opts);
var title=doc.layers.getByName(c.texts[0].name).textFrames[0],price=doc.layers.getByName(c.texts[1].name).textFrames[0];title.contents='中文编辑验收';price.contents='¥19';var left=price.left;price.translate(18,0);
var save=new IllustratorSaveOptions();save.pdfCompatible=true;doc.saveAs(new File(c.work+'/edited.ai'),save);doc.close(SaveOptions.DONOTSAVECHANGES);doc=app.open(new File(c.work+'/edited.ai'));app.activeDocument=doc;app.redraw();$.sleep(800);
assert(doc.layers.getByName(c.texts[0].name).textFrames[0].contents==='中文编辑验收','Chinese edit persisted');var p=doc.layers.getByName(c.texts[1].name).textFrames[0];assert(p.contents==='¥19','Price persisted');assert(near(p.left,left+18),'Layout move persisted');
doc.exportFile(new File(c.work+'/after.png'),ExportType.PNG24,opts);f.writeln('edit-Chinese-price-move-save-reopen=PASS');f.writeln('result=PASS');doc.close(SaveOptions.DONOTSAVECHANGES);doc=null;
}catch(e){f.writeln('result=FAIL '+e);throw e;}finally{f.close();app.userInteractionLevel=prior;}})();`;
const psd = `#target photoshop
(function(){${common}var prior=app.displayDialogs;app.displayDialogs=DialogModes.NO;try{
doc=app.open(new File(c.file));app.activeDocument=doc;app.refresh();$.sleep(800);
assert(doc.width.as('px')===c.width&&doc.height.as('px')===c.height,'Document dimensions');assert(doc.layers.length===c.rows.length,'Layer count');
for(var i=0;i<c.texts.length;i++){var r=c.texts[i],t=doc.artLayers.getByName(r.name);assert(t.kind===LayerKind.TEXT,'Editable text '+r.id);assert(t.textItem.contents===r.text,'Text readback '+r.id);assert(t.textItem.font===r.fontPostScript,'Font readback '+r.id);f.writeln('text='+r.text+'|'+r.fontPostScript);}
var opts=new PNGSaveOptions();doc.saveAs(new File(c.work+'/before.png'),opts,true,Extension.LOWERCASE);
var title=doc.artLayers.getByName(c.texts[0].name),price=doc.artLayers.getByName(c.texts[1].name);title.textItem.contents='中文编辑验收';price.textItem.contents='¥19';var left=price.textItem.position[0].as('px');price.translate(UnitValue(18,'px'),UnitValue(0,'px'));
var save=new PhotoshopSaveOptions();save.layers=true;doc.saveAs(new File(c.work+'/edited.psd'),save,true,Extension.LOWERCASE);doc.close(SaveOptions.DONOTSAVECHANGES);doc=app.open(new File(c.work+'/edited.psd'));app.activeDocument=doc;app.refresh();$.sleep(800);
assert(doc.artLayers.getByName(c.texts[0].name).textItem.contents==='中文编辑验收','Chinese edit persisted');var p=doc.artLayers.getByName(c.texts[1].name);assert(p.textItem.contents==='¥19','Price persisted');assert(near(p.textItem.position[0].as('px'),left+18),'Layout move persisted');
doc.saveAs(new File(c.work+'/after.png'),opts,true,Extension.LOWERCASE);f.writeln('edit-Chinese-price-move-save-reopen=PASS');f.writeln('result=PASS');doc.close(SaveOptions.DONOTSAVECHANGES);doc=null;
}catch(e){f.writeln('result=FAIL '+e);throw e;}finally{f.close();app.displayDialogs=prior;}})();`;
const jsx = join(work, 'verify.jsx'); await writeFile(jsx, kind === 'ai' ? ai : psd);
const script = join(work, 'verify.applescript');
await writeFile(script, 'with timeout of 180 seconds\ntell application id ' + JSON.stringify(kind === 'ai' ? 'com.adobe.illustrator' : 'com.adobe.Photoshop') + '\nactivate\n'
  + (kind === 'ai' ? '«event miscDjxM» (read POSIX file ' + JSON.stringify(jsx) + ' as «class utf8»)' : 'do javascript file POSIX file ' + JSON.stringify(jsx)) + '\nend tell\nend timeout\n');
try { await promisify(execFile)('/usr/bin/osascript', [script], { timeout: 190000 }); }
finally { console.log(await readFile(join(work, 'evidence.txt'), 'utf8').catch(() => 'No evidence')); }
