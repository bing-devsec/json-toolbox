import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { captureEditorSnapshot } from '../src/components/utils/editorSnapshot.ts';
const source = await readFile('src/components/JsonToolWorkbench.vue','utf8');
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function editor(text='{}') {const model={version:1,disposed:false,getVersionId(){return this.version;},isDisposed(){return this.disposed;}};return {model,text,getModel(){return this.model;},getValue(){return this.text;}};}
async function handler(start,end,name,ctx) {
 const code=(await transform(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),{loader:'ts',format:'cjs'})).code;
 return new Function('ctx',`with(ctx){${code};return ${name};}`)(ctx);
}
function context() {
 const writes=[],errors=[];
 return {writes,errors,reviewConversionBusy:{value:0},recordReviewUse:()=>{},inputEditor:editor(),outputEditor:editor(),isTabPageClosing:{value:false},outputType:{value:'json'},captureEditorSnapshot,
  ensureProcessingFeatureAvailable:()=>true,repair:{busy:{value:false}},settingsTxt:{value:new Proxy({}, {get:(_,k)=>(...args)=>[k,...args].join(':')})},
  preprocessJSON:()=>({data:{},escapeMap:new Map()}),prepareHighPrecisionConversion:data=>({data,restoreOutput:s=>s}),
  setOutputEditorValue(text,language){writes.push([text,language]);this.outputEditor.model.version++;},
  showMessageError:m=>errors.push(m),showMessageSuccess:()=>{},localizeConvertError:e=>e.message,
  loadMonacoLanguageContribution:async()=>{},MAX_FILE_SIZE:100000,clearOutputFoldingInfo:()=>{},
  setInputEditorValue(text){writes.push(text);this.inputEditor.text=text;this.inputEditor.model.version++;},
 };
}

test('snapshot uses identity/version/disposal and never copies editor text', () => {
 let current=editor();current.getValue=()=>assert.fail('no text reads');const check=captureEditorSnapshot(()=>current);
 assert.equal(check(),true);current.model.version++;assert.equal(check(),false);
 const check2=captureEditorSnapshot(()=>current);current.model.disposed=true;assert.equal(check2(),false);
 current=editor();const check3=captureEditorSnapshot(()=>current);current=editor();assert.equal(check3(),false);
});

test('actual conversion handler rejects older completions and does not publish a pending output type', async () => {
 const ctx=context();const yaml=deferred(),toml=deferred();ctx.loadJsonConvertModule=async()=>({convertToYAML:()=>yaml.promise,convertToTOML:()=>toml.promise});
 const run=await handler('let conversionSequence =','// 兼容性函数','handleConvert',ctx);
 const first=run('yaml');await Promise.resolve();const second=run('toml');await Promise.resolve();
 assert.equal(ctx.outputType.value,'json');toml.resolve('new');await second;yaml.resolve('old');await first;
 assert.deepEqual(ctx.writes,[['new','toml']]);assert.equal(ctx.outputType.value,'toml');
});

test('actual conversion handler rejects changed input, output, disposal and unmount through each await',async()=>{
 for(const change of [ctx=>ctx.inputEditor.model.version++,ctx=>ctx.outputEditor.model.version++,ctx=>ctx.inputEditor=editor(),ctx=>ctx.outputEditor.model.disposed=true,ctx=>ctx.isTabPageClosing.value=true,ctx=>ctx.repair.busy.value=true]){
  const ctx=context(),pending=deferred();ctx.loadJsonConvertModule=()=>pending.promise;
  const run=await handler('let conversionSequence =','// 兼容性函数','handleConvert',ctx);
  const task=run('cookie');change(ctx);pending.resolve({cookieToJSON:()=>'{"stale":true}'});await task;
  assert.deepEqual(ctx.writes,[]);assert.equal(ctx.outputType.value,'json');
 }
 const ctx=context(),pending=deferred();ctx.loadJsonConvertModule=async()=>({convertToYAML:async()=> 'yaml'});ctx.loadMonacoLanguageContribution=()=>pending.promise;
 const run=await handler('let conversionSequence =','// 兼容性函数','handleConvert',ctx);const task=run('yaml');await new Promise(r=>setImmediate(r));ctx.outputEditor.model.version++;pending.resolve();await task;assert.deepEqual(ctx.writes,[]);
});

test('actual upload handler keeps the latest file and ignores edits made during FileReader',async()=>{
 for(const scenario of ['repeated','input-edit','output-edit','close']){
  const ctx=context(),readers=[];ctx.FileReader=class {readAsText(){readers.push(this);}};
  const run=await handler('let inputFileSequence =','// 文件上传','processInputFileUpload',ctx);
  const file={name:'a.json',size:20,type:'application/json'};const first=run(file);
  if(scenario==='repeated'){const second=run(file);readers[1].onload({target:{result:'new'}});await second;}
  else if(scenario==='input-edit')ctx.inputEditor.model.version++;
  else if(scenario==='output-edit')ctx.outputEditor.model.version++;
  else ctx.isTabPageClosing.value=true;
  readers[0].onload({target:{result:'old'}});await first;
  assert.deepEqual(ctx.writes,scenario==='repeated'?['new',['','json']]:[]);
 }
});

test('actual fold handler locks before its timer, rejects stale output and releases on failure', async () => {
 for (const scenario of ['success','changed','closed','rejected']) {
  const ctx=context(),timers=[],unmount=[];let folds=0,reveals=0;const pending=deferred();
  ctx.outputEditor.getVisibleRanges=()=>[{startLineNumber:1,endLineNumber:5}];ctx.outputEditor.revealLineInCenter=()=>reveals++;
  Object.assign(ctx,{setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},onBeforeUnmount:fn=>unmount.push(fn),
    isFoldOperationLocked:false,ensureCollapseFeatureAvailable:()=>true,prepareJsonOutputForFolding:()=>'{"a":{}}',
    selectedLevel:{value:1},maxFoldableLevel:{value:null},resolveMaxFoldableLevel:()=>pending.promise,
    foldByIndentation:async()=>{folds++;return {targetRegionCount:1,firstTargetLevelLine:10};},showMessageWarning:()=>{},
    shouldPrecomputeFoldingInfo:()=>false});
  const run=await handler('// Fold timers belong','// 打开数据脱敏对话框','handleLevelAction',ctx);
  run();run();assert.equal(timers.length,1,'second click must not enqueue another fold');assert.equal(ctx.isFoldOperationLocked,true);
  timers.shift()();await Promise.resolve();
  if(scenario==='changed')ctx.outputEditor.model.version++;
  if(scenario==='closed'){ctx.isTabPageClosing.value=true;for(const dispose of unmount)dispose();}
  if(scenario==='rejected')pending.reject(new Error('fold failed'));else pending.resolve(3);
  await new Promise(r=>setImmediate(r));
  assert.equal(folds,scenario==='success'?1:0);assert.equal(ctx.isFoldOperationLocked,false);
  if(scenario==='success'){ctx.outputEditor.model.version++;timers.shift()();assert.equal(reveals,0,'delayed refresh must not touch newer output');}
  assert.equal(ctx.errors.length,scenario==='rejected'?1:0);
 }
});

test('actual fold preparation reuses JSON output without flattening text and preserves whitespace fallback', async () => {
 for (const lines of [['{', '"a": 1', '}'], ['', '  ', '{', '}'], [' ', '\t', '\u00a0', '\uFEFF'], [' '.repeat(1024 * 1024) + '{}']]) {
  const ctx=context();let lineReads=0,configs=0,formats=0;
  ctx.outputEditor.getValue=()=>assert.fail('fold preparation must not read the full preview');
  Object.assign(ctx.outputEditor.model,{getLineCount:()=>lines.length,getLineContent:line=>{lineReads++;return lines[line-1];}});
  ctx.updateOutputEditorConfig=()=>configs++;
  ctx.jsonEngine={formatInput:()=>{formats++;return {formatted:'{}'};}};
  const prepare=await handler('const prepareJsonOutputForFolding =','// Fold timers belong','prepareJsonOutputForFolding',ctx);
  assert.equal(prepare(),true);
  const blank=lines.every(line=>!line.trim());
  assert.equal(formats,blank?1:0);
  assert.equal(configs,blank?0:1);
  assert.equal(lineReads,blank?lines.length:lines.findIndex(line=>line.trim())+1);
 }
});

test('actual fold handler does not schedule summary work when a level has no target regions', async () => {
 const ctx=context(),timers=[];
 Object.assign(ctx,{setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},onBeforeUnmount:()=>{},
  isFoldOperationLocked:false,ensureCollapseFeatureAvailable:()=>true,prepareJsonOutputForFolding:()=>true,
  selectedLevel:{value:7},maxFoldableLevel:{value:null},resolveMaxFoldableLevel:async()=>10,
  foldByIndentation:async()=>({targetRegionCount:0}),showMessageWarning:()=>{},
  precomputeFoldingInfo:()=>assert.fail('a targetless fold must not start summary work')});
 const run=await handler('// Fold timers belong','// 打开数据脱敏对话框','handleLevelAction',ctx);
 run();timers.shift()();await new Promise(r=>setImmediate(r));
 assert.equal(timers.length,0);
 assert.equal(ctx.isFoldOperationLocked,false);
});
