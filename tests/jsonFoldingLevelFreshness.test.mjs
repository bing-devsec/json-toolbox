import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';
const { useJsonFoldingLevels }=await bundleModule('src/components/composables/useJsonFoldingLevels.ts');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const pending=deferred();let toggles=0;
 const model={version:1,disposed:false,getVersionId(){return this.version;},isDisposed(){return this.disposed;},getLanguageId:()=> 'json'};
 const editor={getModel:()=>model,getContribution:()=>({getFoldingModel:()=>pending.promise})};
 let current=editor;const selectedLevel={value:1},maxFoldableLevel={value:null};
 const api=useJsonFoldingLevels({selectedLevel,maxFoldableLevel,getOutputEditor:()=>current});
 const result={regions:{length:1,getStartLineNumber:()=>1,getEndLineNumber:()=>5,isCollapsed:()=>false,toRegion:()=>({})},toggleCollapseState:()=>toggles++};
 return {api,pending,model,selectedLevel,maxFoldableLevel,result,get toggles(){return toggles;},replace:()=>{current={...editor};}};
}
test('folding composable does not toggle regions after content/model/disposal/level changes',async()=>{
 for(const change of [f=>f.model.version++,f=>f.replace(),f=>f.model.disposed=true,f=>f.selectedLevel.value=2]){
  const f=fixture(),task=f.api.foldByIndentation();change(f);f.pending.resolve(f.result);assert.equal((await task).targetRegionCount,0);assert.equal(f.toggles,0);
 }
});
test('folding composable preserves successful folds and does not publish stale max levels',async()=>{
 const f=fixture(),task=f.api.foldByIndentation();f.pending.resolve(f.result);assert.equal((await task).targetRegionCount,1);assert.equal(f.toggles,1);
 const g=fixture(),refresh=g.api.refreshMaxFoldableLevel();g.replace();g.pending.resolve(g.result);await refresh;assert.equal(g.maxFoldableLevel.value,null);
});
