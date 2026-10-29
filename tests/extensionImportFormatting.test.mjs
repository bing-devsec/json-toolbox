import assert from 'node:assert/strict';
import test from 'node:test';
import { startImportedResponseFormat, fitsResponseFormatBudget, createFormattedImportController } from '../src/extension/formatImportedResponse.ts';
import { createExternalImportGate } from '../src/extension/externalImport.ts';
import { formatJsonInput } from '../src/components/utils/jsonEngine/service.ts';
const settings = { indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: false };
const engine = (input, options, repair) => {
    assert.equal(repair, false);
    return { promise: Promise.resolve().then(() => ({ formatted: formatJsonInput(input, options).formatted })), cancel() {} };
};
const prepare = (text, options = settings, dependencies = {}) => startImportedResponseFormat(text, options, { start: engine, ...dependencies });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const fixture = () => {
    let model = {}, version = 1, ready = true, text = '';
    let starts = 0, cancels = 0;
    const pending = [], imported = [], failed = [], writes = [];
    const gate = createExternalImportGate();
    const controller = createFormattedImportController({
        readEditor: () => ({ model, version, ready, hasContent: !!text }), settings: () => settings,
        write: request => gate.apply(request, { ready, hasContent: () => !!text, setText: value => { text=value; version++; writes.push(value); controller.editorChanged(); return true; } }),
        imported: (...args) => imported.push(args), failed: (...args) => failed.push(args),
        format: () => { starts++; const task=deferred(); pending.push(task); return { promise:task.promise, cancel:()=>{ cancels++; task.reject(Object.assign(new Error('Cancelled'), {name:'AbortError'})); } }; },
    });
    return { controller, pending, imported, failed, writes, get starts(){return starts;}, get cancels(){return cancels;},
        edit(value) { text=value; version++; }, replaceModel() { model={}; }, setReady(value){ready=value;} };
};

test('response formatting uses the real engine and preserves exact numeric literals and nested string values', async () => {
    const raw=String.raw`{"id":9223372036854775807,"amount":2.00,"n":-0,"exp":1e-30,"payload":"{\"id\":1}","note":"first\nsecond"}`;
    const result=await prepare(raw).promise;
    assert.equal(result.warning, undefined);
    assert.equal(result.text, '{\n  "id": 9223372036854775807,\n  "amount": 2.00,\n  "n": -0,\n  "exp": 1e-30,\n  "payload": "{\\"id\\":1}",\n  "note": "first\\nsecond"\n}');
});

test('current indentation, array layout and encoding settings are used without changing the settings object', async () => {
    const prefs={ ...settings, indentSize:4, arrayNewLine:false, encodingMode:true, preserveNumberLiterals:false };
    const before={...prefs};
    const result=await prepare(String.raw`{"a":[1,2],"text":"\u4e2d"}`, prefs).promise;
    assert.equal(result.text, '{\n    "a": [1, 2],\n    "text": "中"\n}');
    assert.deepEqual(prefs,before);
});

test('malformed responses are imported verbatim without automatically repairing their structure', async () => {
    const text='{"a":1 "b":2}';
    assert.deepEqual(await prepare(text).promise, {text,warning:'FORMAT_FAILED'});
});

test('preflight rejects output amplification before starting any worker', async () => {
    let started=0; const text='['.repeat(90)+Array(100).fill('1').join(',')+']'.repeat(90);
    const result=await prepare(text,settings,{ maxChars:5000, start:()=>{started++; throw Error('must not start');} }).promise;
    assert.equal(started,0); assert.deepEqual(result,{text,warning:'FORMAT_TOO_LARGE'});
    assert.equal(fitsResponseFormatBudget(JSON.stringify({note:'[{'.repeat(200)}),2),true);
    assert.equal(fitsResponseFormatBudget('/* '+ '['.repeat(200)+' */ {"ok":true}',2),true);
});

test('unexpectedly oversized worker results also fall back to the raw response', async () => {
    const text='{}'; const result=await prepare(text,settings,{maxChars:100,start:()=>({promise:Promise.resolve({formatted:' '.repeat(101)}),cancel(){}})}).promise;
    assert.deepEqual(result,{text,warning:'FORMAT_TOO_LARGE'});
});

test('explicit cancellation terminates work and never converts into raw-text fallback', async () => {
    let started=0, cancelled=0; const d=deferred();
    const task=prepare('{}',settings,{start:()=>{started++; return {promise:d.promise,cancel(){cancelled++; d.reject(Object.assign(Error('Cancelled'),{name:'AbortError'}));}};}});
    await Promise.resolve(); task.cancel();
    await assert.rejects(task.promise,{name:'AbortError'}); assert.equal(started,1); assert.equal(cancelled,1);
    const early=prepare('{}',settings,{start:()=>{throw Error('not started');}}); early.cancel();
    await assert.rejects(early.promise,{name:'AbortError'});
});

test('timed out workers are cancelled and leave a readable original response', async () => {
    const d=deferred(); let cancelled=0;
    const result=await prepare('{}',settings,{timeoutMs:1,start:()=>({promise:d.promise,cancel(){cancelled++;d.reject(Object.assign(Error('Cancelled'),{name:'AbortError'}));}})}).promise;
    assert.equal(cancelled,1); assert.deepEqual(result,{text:'{}',warning:'FORMAT_FAILED'});
});

test('duplicate readiness notifications start one worker and acknowledge only after a successful write', async () => {
    const f=fixture(), request={id:'a',text:'{}'};
    const run=f.controller.apply(request); await f.controller.apply(request);
    assert.equal(f.starts,1); assert.equal(f.imported.length,0); assert.equal(f.writes.length,0);
    f.pending[0].resolve({text:'{\n}'}); await run;
    assert.deepEqual(f.writes,['{\n}']); assert.deepEqual(f.imported,[['a',undefined]]); assert.deepEqual(f.failed,[]);
    f.edit('later user edit'); await f.controller.apply({...request});
    assert.equal(f.starts,1); assert.equal(f.writes.length,1); assert.equal(f.imported.length,2); f.controller.dispose();
});

test('input followed by clear is still an edit and must not be overwritten even without an event', async () => {
    const f=fixture(); const run=f.controller.apply({id:'a',text:'{}'});
    f.edit('typed'); f.edit(''); f.pending[0].resolve({text:'formatted'}); await run;
    assert.deepEqual(f.writes,[]); assert.deepEqual(f.failed,[['a','EDITOR_CHANGED']]); assert.deepEqual(f.imported,[]);
});

test('a real edit event immediately cancels the worker and preserves the ticket for retry', async () => {
    const f=fixture(); const run=f.controller.apply({id:'a',text:'{}'});
    f.edit('user'); f.controller.editorChanged(); await run;
    assert.equal(f.cancels,1); assert.deepEqual(f.writes,[]); assert.deepEqual(f.failed,[['a','EDITOR_CHANGED']]);
});

test('model replacement and entering Diff cannot commit results to a rebuilt editor', async () => {
    for(const change of ['model','ready']) {
        const f=fixture(); const run=f.controller.apply({id:'a',text:'{}'});
        if(change==='model')f.replaceModel(); else f.setReady(false);
        f.pending[0].resolve({text:'formatted'}); await run;
        assert.deepEqual(f.writes,[]); assert.deepEqual(f.failed,[['a','EDITOR_CHANGED']]);
    }
});

test('a new ticket cancels the older task and ignores its result without reporting a stale error', async () => {
    const f=fixture(); const old=f.controller.apply({id:'a',text:'{}'}); const current=f.controller.apply({id:'b',text:'[]'});
    f.pending[1].resolve({text:'[\n]'}); await Promise.all([old,current]);
    assert.equal(f.cancels,1); assert.deepEqual(f.imported,[['b',undefined]]); assert.deepEqual(f.writes,['[\n]']); assert.deepEqual(f.failed,[]);
});

test('unmount cancels pending work, prevents writes and does not acknowledge', async () => {
    const f=fixture(); const run=f.controller.apply({id:'a',text:'{}'}); f.controller.dispose(); await run;
    assert.equal(f.cancels,1); assert.deepEqual(f.writes,[]); assert.deepEqual(f.imported,[]); assert.deepEqual(f.failed,[]);
});

test('occupied editors never start formatting, and original-text warnings accompany the final acknowledgement', async () => {
    const f=fixture(); f.edit('existing'); await f.controller.apply({id:'a',text:'{}'});
    assert.equal(f.starts,0); assert.deepEqual(f.failed,[['a','EDITOR_HAS_CONTENT']]);
    f.edit(''); const run=f.controller.apply({id:'a',text:'broken'});
    f.pending[0].resolve({text:'broken',warning:'FORMAT_FAILED'}); await run;
    assert.deepEqual(f.writes,['broken']); assert.deepEqual(f.imported,[['a','FORMAT_FAILED']]);
});

test('failed writes and synchronous task failures are reported and remain retryable', async () => {
    for (const broken of ['write','format']) {
        const errors=[], model={};
        const f=createFormattedImportController({readEditor:()=>({model,version:1,ready:true,hasContent:false}),settings:()=>settings,
            write:()=>{throw Error('write');}, imported:()=>assert.fail('must not acknowledge'),failed:(...args)=>errors.push(args),
            format:()=>{if(broken==='format')throw Error('format'); return {promise:Promise.resolve({text:'{}'}),cancel(){}};},
        });
        await f.apply({id:'a',text:'{}'});
        assert.deepEqual(errors,[['a','EDITOR_IMPORT_FAILED']]);
    }
});
