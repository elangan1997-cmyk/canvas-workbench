import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildLayeredIllustratorJsx } from '../../src/host/services/layered-image-export.js';

function execute({corrupt=false}={}) {
  const texts=[],layers=[];layers.add=()=>{const l={textFrames:[]};layers.unshift(l);return l;};layers.add();layers.getByName=n=>layers.find(l=>l.name===n);
  const doc={layers,artboards:[{artboardRect:[10,1010,800,10]}],placedItems:[],saveAs(){},close(){},textFrames:texts};
  texts.pointText=anchor=>{
    const tf={anchor:Array.from(anchor),name:'',textRange:{paragraphAttributes:{},characterAttributes:{}},transform(m){this.anchor=[m.mValueA*this.anchor[0]+m.mValueC*this.anchor[1]+m.mValueTX,m.mValueB*this.anchor[0]+m.mValueD*this.anchor[1]+m.mValueTY];},get geometricBounds(){return [this.anchor[0]-40,this.anchor[1]+30,this.anchor[0]+40,this.anchor[1]-10];}};
    texts.push(tf);doc.activeLayer.textFrames.push(tf);return tf;
  };
  const rows=['left','center','right'].map((textAlign,i)=>({enabled:true,z:i,nativeText:true,name:'text-'+textAlign,text:i===1?'第一行\n第二行':'文字 ABC',fontPostScript:'Font-Bold',fontSize:40,color:'#123456',tracking:4,x:100,y:100+i*200,width:400,height:90,textAlign,rotation:i===2?30:0}));
  const jsx=buildLayeredIllustratorJsx({width:790,height:1000,output:'/tmp/qa.ai',elements:rows});
  const just={LEFT:'left',CENTER:'center',RIGHT:'right'};
  const context={app:{userInteractionLevel:0,redraw(){},documents:{add:()=>doc},open(){if(corrupt)texts[0].anchor[0]+=20;return doc;},textFonts:{getByName:name=>({name})},getIdentityMatrix:()=>({})},$:{sleep(){}},File:function(path){this.fsName=path;},RGBColor:function(){},IllustratorSaveOptions:function(){},UserInteractionLevel:{DONTDISPLAYALERTS:1},DocumentColorSpace:{RGB:1},RulerUnits:{Points:1},Justification:just,Transformation:{DOCUMENTORIGIN:0},SaveOptions:{DONOTSAVECHANGES:2}};
  const run=()=>vm.runInNewContext(jsx.replace(/^#target[^\n]*\n/,''),context);
  return {run,texts,jsx};
}

test('layered AI positions left, center and right point text at its fitted baseline; rotation keeps that baseline fixed',()=>{
 const {run,texts,jsx}=execute();assert.equal(run(),'dsh-layered-ai-done');
 const expected=[[110,870],[310,670],[510,470]];
 for(let i=0;i<3;i++){assert.ok(Math.abs(texts[i].anchor[0]-expected[i][0])<1e-8);assert.ok(Math.abs(texts[i].anchor[1]-expected[i][1])<1e-8);assert.equal(texts[i].textRange.paragraphAttributes.justification,['left','center','right'][i]);}
 assert.equal(texts[1].contents,'第一行\r第二行');
 assert.doesNotMatch(jsx,/\?Justification\./,'Native enum wrapper conditional regression');
 assert.doesNotMatch(jsx,/tf\.move\(|tf\.anchor\s*=/,'Do not invalidate the fresh text handle or use unsupported anchor setter');
});

test('layered AI rejects a baseline that moved during save/reopen',()=>{
 const {run}=execute({corrupt:true});assert.throws(run,/AI text baseline mismatch/);
});
