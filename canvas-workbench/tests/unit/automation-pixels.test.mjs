import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeLayeredImage, normalizeLayerElements } from '../../src/host/services/layered-image-model.js';

test('malformed model geometry gets one bounded analysis retry and never silently becomes a canvas-sized object', async () => {
  let calls = 0, persistentlyBad = false;
  const ctx = { attachments: { saveImage: async () => ({ id: 'source' }) }, llm: { resolveModelInfo: async () => ({ capabilities: { imageInput: true } }),
    prepareCall: async body => { assert.equal(body.model, 'current-chat'); return { config: {}, stream: async function* () {
      calls++; yield { type: 'text-delta', index: 0, text: JSON.stringify({ elements: [{ id: 'object', type: 'image', x: 100, y: 100, width: 200, ...(!persistentlyBad && calls > 1 ? { height: 300 } : {}) }] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }; } } };
  const run = () => analyzeLayeredImage(ctx, { bytes: Buffer.from('fixture'), mime: 'image/png' }, { provider: 'selected', model: 'current-chat' }, 500, 1000, new AbortController().signal);
  const result = await run(); assert.equal(calls, 2); assert.equal(result.analysisAttempts, 2); assert.equal(result.elements[1].height, 300);
  persistentlyBad = true; calls = 0; await assert.rejects(run(), /两次结构检查未通过/); assert.equal(calls, 2);
});

test('invalid model dimensions cannot become full-canvas layers and fitting metadata survives normalization', () => {
  let elements = normalizeLayerElements([{ id: 'subject', type: 'image', x: 10, y: 20, width: 200 }], 500, 1000);
  assert.equal(elements[1].height, 1); assert.deepEqual(elements[1].geometryIssues, ['height']);
  elements = normalizeLayerElements(elements, 500, 1000); assert.deepEqual(elements[1].geometryIssues, ['height']);
  const text = { id: 'text', type: 'text', x: 10, y: 20, width: 100, height: 30, text: '菜单', fontPostScript: 'SourceHanSansSC-Regular', fontSize: 24,
    cleanupBounds: { x: 12, y: 24, width: 70, height: 24 }, textFit: { text: '菜单', fontPostScript: 'SourceHanSansSC-Regular', fontSize: 24, tracking: 0, baselineOffset: 29, originOffsetX: 2, advance: 48 },
    styleConfidence: .88, fontAvailable: true, nativeText: true, fontAccepted: true };
  const normalized = normalizeLayerElements([text], 500, 1000)[1]; assert.deepEqual(normalized.textFit, text.textFit); assert.deepEqual(normalized.cleanupBounds, text.cleanupBounds);
});

test('region editing locks outside pixels; clean-plate repair preserves external leaders and stops at textured backgrounds', t => {
  const python = process.env.DSH_TEST_PYTHON || join(homedir(), '.dsh/canvas-workbench/psd-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (spawnSync(python, ['-c', 'from PIL import Image']).status !== 0) return t.skip('Python/Pillow unavailable');
  const script = `
import sys,tempfile,random
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from automation_image import run
from refine_layered_text import clean_background
from infer_text_style import pixel_foreground
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp);source=root/'source.png';out=root/'out.png';edit=root/'edit.png'
 im=Image.new('RGBA',(180,100))
 for y in range(im.height):
  for x in range(im.width):im.putpixel((x,y),(230+y//10,220+y//10,205+y//10,255))
 im.save(source);Image.new('RGBA',(30,20),'#336699').save(edit)
 inspect=run({'operation':'inspect','input':str(source)})
 assert inspect['alphaMin']==255 and inspect['foregroundBounds']['width']==180
 r={'x':20,'y':30,'width':30,'height':20}
 assert run({'operation':'crop','input':str(source),'region':r,'output':str(out)})['width']==30
 run({'operation':'composite','input':str(source),'edited':str(edit),'region':r,'output':str(out)})
 changed=Image.open(out);diff=ImageChops.difference(im,changed).convert('RGB').getbbox();assert diff==(20,30,50,50),diff
 try:run({'operation':'crop','input':str(source),'region':{**r,'x':170},'output':str(out)});raise AssertionError('invalid region accepted')
 except ValueError:pass
 dirty=im.copy();d=ImageDraw.Draw(dirty)
 d.rectangle((40,42,43,45),fill='black')
 for x in range(105,160,8):d.rectangle((x,44,x+1,45),fill='black')
 dirty.save(root/'dirty.png')
 spec={'input':str(root/'dirty.png'),'source':str(source),'output':str(out),'elements':[{'id':'title','nativeText':True,'cleanupBounds':{'x':30,'y':30,'width':60,'height':30}}]}
 q=clean_background(spec);assert len(q['repairedRegions'])==1 and not q['issues'],q
 repaired=Image.open(out);assert repaired.getpixel((41,43))[0]>220
 for y in range(100):
  for x in range(180):
   if not (26<=x<94 and 26<=y<64):assert repaired.getpixel((x,y))==dirty.getpixel((x,y))
 rng=random.Random(123);texture=im.copy()
 for y in range(24,68):
  for x in range(24,98):texture.putpixel((x,y),tuple(rng.randrange(256) for _ in range(3))+(255,))
 texture.save(root/'dirty.png');q=clean_background(spec)
 assert q['issues'][0]['code']=='textured-background' and not q['repairedRegions'],q
 assert ImageChops.difference(texture,Image.open(out)).convert('RGB').getbbox() is None
 # A broad OCR box containing a bold heading and a much lighter adjacent
 # line must fit the heading alone, without swallowing the second baseline.
 wide=Image.new('RGB',(300,180),'white');dw=ImageDraw.Draw(wide)
 dw.rectangle((20,20,110,100),fill='black');dw.rectangle((160,20,250,100),fill='black')
 for x in range(20,255,8):dw.rectangle((x,140,x+2,150),fill='black')
 fg=pixel_foreground(wide,(0,0,300,180),'#000000',True)
 assert fg['top']<25 and fg['mask'].height<90,(fg['top'],fg['mask'].size)
print('PASS: bounded edit, exact outside pixels, local clean plate and textured stop')
`;
  const result = spawnSync(python, ['-c', script], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
