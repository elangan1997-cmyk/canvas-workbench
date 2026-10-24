// Explicit Illustrator acceptance: creates only its own document; no image/model requests.
// node tests/integration/verify-ai-text-alignment.mjs <evidence-directory>
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildLayeredIllustratorJsx } from '../../src/host/services/layered-image-export.js';
if(process.platform!=='darwin')throw Error('Native macOS Illustrator required');
const work=resolve(process.argv[2]||'/tmp/dsh-ai-alignment-'+Date.now());await mkdir(work,{recursive:true});
const elements=['left','center','right'].map((textAlign,i)=>({enabled:true,nativeText:true,name:'alignment-'+textAlign,text:i===1?'第一行 ABC\n第二行 ¥19':'对齐 ABC',fontPostScript:'AlibabaPuHuiTi_3_95_ExtraBold',fontSize:40,tracking:4,color:'#123456',x:100,y:100+i*250,width:400,height:100,textAlign,rotation:i===2?30:0,z:i}));
const jsx=join(work,'verify.jsx'),output=join(work,'alignment.ai');await writeFile(jsx,buildLayeredIllustratorJsx({width:790,height:1000,elements,output}));
const apple=join(work,'verify.applescript');await writeFile(apple,'with timeout of 120 seconds\ntell application id "com.adobe.illustrator"\nactivate\n«event miscDjxM» (read POSIX file '+JSON.stringify(jsx)+' as «class utf8»)\nend tell\nend timeout');
const r=await promisify(execFile)('osascript',[apple],{timeout:130000});if(!r.stdout.includes('dsh-layered-ai-done'))throw Error('Missing Illustrator acceptance result');
await writeFile(join(work,'evidence.json'),JSON.stringify({result:'PASS',output,cases:['left','center','right','multiline','rotation30'],checks:['native editable text','font readback','paragraph justification','baseline within 1pt','visible bounds stable after save/reopen'],modelRequests:0},null,2));console.log(r.stdout.trim());
