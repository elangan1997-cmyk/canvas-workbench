// Inject Windows transport/platform dependencies into the actual layered service.
// This tests the Windows branch on macOS; it does not replace Windows Adobe QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const platformFile=new URL('../../lib/platform.js',import.meta.url);
const platformSource=await readFile(platformFile,'utf8');
const start=platformSource.indexOf('export async function runAdobeJsxViaCom('),end=platformSource.indexOf('\n/**',start);
const comBody=platformSource.slice(start,end);
const shim=`import {resolvePythonWithDeps,openWithSystem} from ${JSON.stringify(platformFile.href)};
export {resolvePythonWithDeps,openWithSystem};export const isMac=false,isWindows=true;
const ADOBE_APPS={illustrator:{progId:'Illustrator.Application'},photoshop:{progId:'Photoshop.Application'}};
const resolveFirst=async()=> 'powershell.exe';const psSingleQuote=s=>"'"+String(s).replace(/'/g,"''")+"'";
${comBody}`;
const shimURL='data:text/javascript;base64,'+Buffer.from(shim).toString('base64');
const serviceFile=new URL('../../src/host/services/layered-image.js',import.meta.url);
let source=await readFile(serviceFile,'utf8');source=source.replace(/from '([^']+)'/g,(all,path)=>'from '+JSON.stringify(path==='../../../lib/platform.js'?shimURL:path.startsWith('.')?new URL(path,serviceFile).href:path));
const {createLayeredImageService}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for(const failed of [false,true])test(`Windows native AI route ${failed?'retains COM failure without claiming success':'writes BOM JSX, uses encoded COM and validates artifact'}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-Win 中文-'));t.after(()=>rm(root,{recursive:true,force:true}));let comCalls=0;
 const h={ctx:{},projectDirectory:()=>root,previewUrl:p=>'preview:'+p,runProcessWithTimeout:async(exe,args,work)=>{
  comCalls++;assert.equal(exe,'powershell.exe');assert.deepEqual(args.slice(0,3),['-NoLogo','-NoProfile','-EncodedCommand']);const ps=Buffer.from(args[3],'base64').toString('utf16le');assert.match(ps,/Illustrator.Application/);
  const bytes=await readFile(join(work,'layers.jsx'));assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);const jsx=bytes.toString('utf8').slice(1);new Function(jsx.replace(/^#target[^\n]*\n/,''));assert.doesNotMatch(jsx,/\?Justification\./);assert.match(jsx,/AI text baseline mismatch/);
  if(failed)return{exitCode:0,stdout:'DSH_JSX_ERR=com-activate-failed\r\n',stderr:''};
  await writeFile(join(work,'layers.ai'),'%PDF-'+ 'fixture'.repeat(200));return{exitCode:0,stdout:'DSH_JSX=dsh-layered-ai-done\r\n',stderr:''};
 }};
 h.runProcess=h.runProcessWithTimeout;
 const pixel=async s=>{
  if(s.operation==='inspect'){await writeFile(s.output,await readFile(s.input));return{width:1,height:1};}
  if(s.operation==='source-flat'){await writeFile(s.output,'fixture');return{eligible:true,engine:'original'};}
  if(s.operation==='crop-layer'){await mkdir(join(s.output,'..'),{recursive:true});await writeFile(s.output,'fixture');return{bounds:{x:0,y:0,width:1,height:1}};}
  if(s.operation==='assemble'){const preview=join(s.directory,'preview.png'),composite=join(s.directory,'composite.rgba');await writeFile(preview,'fixture');await writeFile(composite,Buffer.alloc(4));return{preview,composite};}
  throw Error(s.operation);
 };
 const service=createLayeredImageService(h,{pixel,settings:async()=>({engine:'api',apiModel:'frozen'}),generate:async()=>{throw Error('Unexpected model call');}});
 const created=await service.analyze({flat:true,name:"中文 O'Neil.png",imageData:'data:image/png;base64,aGVsbG8='});await service.settled(created);await service.run({id:created.id,localOnly:true,maxImageRequests:0});const prepared=await service.settled(created);assert.equal(prepared.status,"ready",prepared.message);await service.export({id:created.id,format:'ai'});const task=await service.settled(created);
 assert.equal(comCalls,1,task.message);assert.equal(task.generationAttempts,0);
 if(failed){assert.equal(task.status,'failed');assert.equal(task.exports.length,0);assert.match(task.message,/Illustrator/);}else{assert.equal(task.status,'ready');assert.equal(task.exports[0].kind,'ai');assert.equal((await readFile(task.exports[0].path)).subarray(0,5).toString(),'%PDF-');}
});
