import test from 'node:test';
import assert from 'node:assert/strict';
import {layeredModeOptions,buildLayerProductionPlan} from '../../src/host/services/layered-production-plan.js';
import {normalizeLayerElements} from '../../src/host/services/layered-image-model.js';
const base=()=>[
 {id:'bg',type:'background',name:'独立背景',enabled:true,z:-10000,x:0,y:0,width:400,height:300},
 {id:'cup',type:'image',visualKind:'product',name:'产品含接触阴影',enabled:true,z:0,x:90,y:80,width:100,height:170,frontOf:['label']},
 {id:'label',type:'text',name:'普通描边字',enabled:true,z:10,text:'奶茶',x:10,y:10,width:100,height:30},
 {id:'card',type:'shape',name:'圆角底框',enabled:true,z:2,x:0,y:0,width:200,height:60,occludedBy:['label']},
 {id:'photo',type:'image',visualKind:'photo-panel',name:'矩形照片',enabled:true,z:3,x:250,y:0,width:150,height:100}
];
test('detailed routing keeps ordinary type, native shapes, alpha subjects and actual photo panels separate; explicit occlusion changes real order',()=>{
 const source=base(),{elements,plan}=buildLayerProductionPlan(source,400,300),byId=new Map(elements.map(e=>[e.id,e]));
 assert.ok(byId.get('card').z<byId.get('label').z&&byId.get('label').z<byId.get('cup').z);assert.equal(source[1].z,0,'caller plan remains untouched');
 assert.equal(plan.relations,2);assert.deepEqual(plan.entries.map(e=>e.method),['background','transparent-image','native-text','native-shape','photo-panel']);assert.deepEqual(plan.entries[1].anchor,{x:90,y:80,width:100,height:170});
});
test('crossing occlusion and nonexistent owners stop before extraction rather than flattening or sorting by type',()=>{
 const a=base();a[2].frontOf=['cup'];assert.throws(()=>buildLayerProductionPlan(a,400,300),/循环/);
 const b=base();b[1].frontOf=['missing'];assert.throws(()=>buildLayerProductionPlan(b,400,300),/不存在/);
 const c=base();c[0].frontOf=['cup'];assert.throws(()=>buildLayerProductionPlan(c,400,300),/背景/);
});
test('mode selection is explicit and normalized relations survive a task roundtrip; unconstrained order stays stable',()=>{
 assert.deepEqual(layeredModeOptions('detailed'),{reconstruction:'complete',completionPolicy:'strict'});assert.equal(layeredModeOptions('practical').completionPolicy,'practical');assert.equal(layeredModeOptions('preserve').reconstruction,'preserve');assert.throws(()=>layeredModeOptions('other'),/无效/);
 const normalized=normalizeLayerElements(base(),400,300);assert.deepEqual(normalized.find(e=>e.id==='cup').frontOf,['label']);
 const disabled=base();disabled[2].enabled=false;assert.doesNotThrow(()=>buildLayerProductionPlan(disabled,400,300),'explicitly omitting a known layer must not block remaining layers');
 const noRelations=base().map(e=>({...e,frontOf:[],occludedBy:[]}));assert.deepEqual(buildLayerProductionPlan(noRelations,400,300).elements.map(e=>e.z),noRelations.map(e=>e.z));
});
