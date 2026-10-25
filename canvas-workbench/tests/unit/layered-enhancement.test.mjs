import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {enhanceLayerRegion} from '../../src/host/services/layered-image-enhancement.js';

test('verified source enhancement retains high resolution and reuses raw requests within the shared budget',async t=>{
 const root=await mkdtemp(join(tmpdir(),'layer-hd-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'assets'));
 const task={directory:root,source:'source',width:200,height:200,analysisModel:{provider:'current',model:'ds'},engine:'dsh-codex',maxImageRequests:1,warnings:[]};
 const e={id:'cup',type:'image',name:'饮品杯',assetKey:'key',resolutionPolicy:'enhance',qualityReason:'原图仅80像素且明显模糊',x:20,y:30,width:80,height:100};let calls=0;
 const deps={ctx:{},save:async()=>{},generate:async()=>{calls++;return {bytes:Buffer.from('high resolution')};},verify:async()=>({accepted:true,reason:'杯型、配料与构图一致'}),pixel:async spec=>writeFile(spec.output,spec.input==='source'?'source pixels':await readFile(spec.input))};
 assert.equal(await enhanceLayerRegion(task,e,{},new AbortController().signal,deps),true);assert.equal(calls,1);assert.equal(task.generationAttempts,1);assert.ok(e.enhancedFile);assert.notEqual(e.file,e.enhancedFile);
 assert.equal(await enhanceLayerRegion(task,e,{},new AbortController().signal,deps),true);assert.equal(calls,1);
 const other={...e,id:'other',assetKey:'other'};assert.equal(await enhanceLayerRegion(task,other,{},new AbortController().signal,deps),false);assert.equal(calls,1);
 task.localOnly=true;assert.equal(await enhanceLayerRegion(task,e,{},new AbortController().signal,deps),false);
});

test('identity rejection retains source, while unknown image requests cannot be silently retried',async t=>{
 const root=await mkdtemp(join(tmpdir(),'layer-hd-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'assets'));
 const task={directory:root,source:'source',width:200,height:200,analysisModel:{},maxImageRequests:4,warnings:[]};
 const e={id:'cup',type:'image',name:'杯',assetKey:'key',resolutionPolicy:'enhance',qualityReason:'模糊',x:20,y:30,width:80,height:100};let calls=0;
 const deps={ctx:{},save:async()=>{},generate:async()=>{calls++;return {bytes:Buffer.from('changed cup')};},verify:async()=>({accepted:false,reason:'杯型改变'}),pixel:async spec=>writeFile(spec.output,'png')};
 e.enhancedFile='stale-previous-approved.png';
 assert.equal(await enhanceLayerRegion(task,e,{},new AbortController().signal,deps),false);assert.equal(e.enhancedFile,undefined);assert.equal(e.file,undefined);assert.match(task.warnings[0],/杯型改变/);
 e.id='unknown';e.requestState='unknown';await assert.rejects(enhanceLayerRegion(task,e,{},new AbortController().signal,deps),/未知/);assert.equal(calls,1);
});
