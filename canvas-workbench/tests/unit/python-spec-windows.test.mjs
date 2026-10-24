import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { runPythonSpec } from '../../src/host/services/python-launch.js';
for(const input of ["C:\\用户 中文\\O'Neil\\商品.png",'\\\\服务器\\设计共享\\素材 图片.png','\\\\?\\C:\\长路径\\'+ '目录\\'.repeat(60)+'图片.png'])test('Windows Python spec/result preserves UTF-8 and structured path '+input.slice(0,16),async()=>{
 const result=await runPythonSpec(async(exe,args,cwd)=>{assert.equal(exe,'py.exe');assert.equal(args[0],'-3');assert.equal(args[1],'C:\\插件 空格\\layered_image.py');assert.equal(args[2],'--spec');assert.equal(args.length,4);const spec=JSON.parse(await readFile(args[3],'utf8'));assert.equal(spec.input,input);assert.equal(spec.element.text,'奶茶 ¥19');assert.equal(cwd,'C:\\工作区');await writeFile(spec.result_output,JSON.stringify({success:true,name:'中文结果',input}),'utf8');return{exitCode:0,stdout:'garbled legacy codepage',stderr:''};},{executable:'py.exe',prefixArgs:['-3']},'C:\\插件 空格\\layered_image.py',{input,element:{text:'奶茶 ¥19'}},{cwd:'C:\\工作区',timeoutMs:1000});
 assert.deepEqual(JSON.parse(result.stdout),{success:true,name:'中文结果',input});
});
