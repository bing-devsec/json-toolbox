import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundled = await build({
    stdin: { contents: `export { useJsonFoldingSummaryPrecompute } from './src/components/composables/useJsonFoldingSummaryPrecompute';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'folding-fixtures', setup(build) {
        build.onResolve({ filter: /\?worker$|^vue$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'vue' ? 'export const onBeforeUnmount = callback => fixture.hooks.push(callback);' : 'export default fixture.Worker;' }));
    } }],
});
function setup(model = null) {
    const timers = new Map(); let id = 0;
    const fixture = { hooks: [], workers: [], refreshes: 0, throwConstructor: false, throwPost: false, throwRefresh: false, model };
    fixture.Worker = class {
        constructor() { if (fixture.throwConstructor) throw Error('constructor'); fixture.workers.push(this); }
        postMessage(value) { if (fixture.throwPost) throw Error('post'); this.message = value; }
        terminate() { this.terminated = true; }
    };
    const module = { exports: {} };
    runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, fixture, console,
        setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: handle => timers.delete(handle),
    });
    const controller = module.exports.useJsonFoldingSummaryPrecompute({ getOutputEditor: () => ({ getModel: () => fixture.model, __enableFoldingInfoUpdateAndRefresh: () => { fixture.refreshes++; if (fixture.throwRefresh) throw Error('detached display'); } }) });
    return { fixture, timers, controller, flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}
const large = ' '.repeat(10 * 1024 * 1024);

test('unmount clears delayed work, resolves its promise and never creates a late Worker', async () => {
    const { fixture, controller, timers, flush } = setup();
    const pending = controller.schedulePrecomputeFoldingInfo(large, 1200);
    fixture.hooks.forEach(hook => hook());
    assert.equal(await pending, false); assert.equal(timers.size, 0);
    flush();
    assert.equal(fixture.workers.length, 0);
    assert.equal(await controller.precomputeFoldingInfo(large), false);
    assert.equal(await controller.schedulePrecomputeFoldingInfo(large), false);
});

test('new scheduling and cancellation settle obsolete delayed tasks without waiting for timers', async () => {
    const { fixture, controller, timers } = setup();
    const first = controller.schedulePrecomputeFoldingInfo(large, 1200);
    const second = controller.schedulePrecomputeFoldingInfo(large, 300);
    assert.equal(await first, false); assert.equal(timers.size, 1);
    controller.cancelFoldingInfoWorker();
    assert.equal(await second, false); assert.equal(timers.size, 0);
    assert.equal(fixture.workers.length, 0);
});

test('constructor, postMessage and unreadable response failures settle and release Worker state', async () => {
    for (const failure of ['constructor', 'post', 'message']) {
        const { fixture, controller } = setup();
        fixture.throwConstructor = failure === 'constructor'; fixture.throwPost = failure === 'post';
        const pending = controller.precomputeFoldingInfo(large);
        if (failure === 'message') fixture.workers[0].onmessageerror({});
        assert.equal(await pending, false);
        if (failure !== 'constructor') assert.equal(fixture.workers[0].terminated, true);
        assert.equal(fixture.refreshes, 0);
    }
});

test('cancelled Worker responses cannot replace newer folding summaries', async () => {
    const { fixture, controller } = setup();
    const first = controller.precomputeFoldingInfo(large), oldWorker = fixture.workers[0];
    const second = controller.precomputeFoldingInfo(large), nextWorker = fixture.workers[1];
    assert.equal(await first, false); assert.equal(oldWorker.terminated, true);
    oldWorker.onmessage({ data: { id: oldWorker.message.id, startLines: new Uint32Array([99]), counts: new Uint32Array([1]), types: new Uint8Array([1]) } });
    nextWorker.onmessage({ data: { id: nextWorker.message.id, startLines: new Uint32Array([1]), counts: new Uint32Array([2]), types: new Uint8Array([1]) } });
    assert.equal(await second, true);
    assert.equal(controller.getFoldingSummaryIndex().startLines[0], 1);
    assert.equal(fixture.refreshes, 1);
});

function createModel(text = large) {
    return { version: 1, disposed: false, reads: 0,
        getVersionId() { return this.version; }, isDisposed() { return this.disposed; },
        getValueLength: () => text.length, getValue() { this.reads++; return text; },
    };
}
function finishWorker(worker, count = 2) {
    worker.onmessage({ data: { id: worker.message.id, startLines: new Uint32Array([1]), counts: new Uint32Array([count]), types: new Uint8Array([1]) } });
}

test('summary responses cannot publish after output model changes even before explicit invalidation', async () => {
    for (const change of [f => f.model.version++, f => { f.model.disposed = true; }, f => { f.model = createModel(); }]) {
        const { controller, fixture } = setup(createModel());
        const pending = controller.precomputeFoldingInfo(large);
        change(fixture);
        finishWorker(fixture.workers[0]);
        assert.equal(await pending, false);
        assert.equal(controller.getFoldingSummaryIndex().startLines.length, 0);
        assert.equal(fixture.refreshes, 0);
    }
});

test('scheduling newer summary work releases an already running obsolete Worker immediately', async () => {
    const { controller, fixture, timers } = setup();
    const old = controller.precomputeFoldingInfo(large);
    const next = controller.schedulePrecomputeFoldingInfo(large, 1200);
    assert.equal(fixture.workers[0].terminated, true);
    assert.equal(await old, false);
    assert.equal(timers.size, 1);
    controller.cancelFoldingInfoWorker();
    assert.equal(await next, false);
});

test('unchanged output reuses pending and completed summaries without another full text read or Worker clone', async () => {
    const model = createModel();
    const { controller, fixture, flush, timers } = setup(model);
    const scheduled = controller.schedulePrecomputeFoldingInfo(undefined, 300);
    assert.equal(controller.schedulePrecomputeFoldingInfo(undefined, 300), scheduled);
    assert.equal(controller.precomputeFoldingInfo(), scheduled);
    assert.equal(model.reads, 0, 'no full text retained by a delayed request');
    assert.equal(timers.size, 1);
    flush();
    assert.equal(model.reads, 1);
    assert.equal(fixture.workers.length, 1);
    assert.equal(controller.precomputeFoldingInfo(), scheduled, 'in-flight folds share one request');
    finishWorker(fixture.workers[0]);
    assert.equal(await scheduled, true);
    const index = controller.getFoldingSummaryIndex();
    for (let repeat = 0; repeat < 4; repeat++) {
        assert.equal(await controller.precomputeFoldingInfo(), true);
        assert.equal(controller.getFoldingSummaryIndex(), index);
    }
    assert.equal(model.reads, 1);
    assert.equal(fixture.workers.length, 1);
});

test('model versions, identities, resets and empty results respect summary cache ownership', async () => {
    for (const change of [f => f.model.version++, f => { f.model = createModel(); }, (_f, c) => c.resetPrecomputedFoldingInfo()]) {
        const { controller, fixture } = setup(createModel());
        const first = controller.precomputeFoldingInfo();
        finishWorker(fixture.workers[0]);
        assert.equal(await first, true);
        change(fixture, controller);
        assert.equal(controller.getFoldingSummaryIndex().startLines.length, 0);
        const next = controller.precomputeFoldingInfo();
        assert.equal(fixture.workers.length, 2);
        finishWorker(fixture.workers[1], 3);
        assert.equal(await next, true);
        assert.equal(controller.getFoldingSummaryIndex().counts[0], 3);
    }
    const model = createModel('{}');
    const { controller } = setup(model);
    assert.equal(await controller.precomputeFoldingInfo(), true);
    assert.equal(await controller.precomputeFoldingInfo(), true);
    assert.equal(model.reads, 1, 'empty summary indexes are valid reusable results');
});

test('raw string requests cannot poison or claim a model-keyed cache entry', async () => {
    const model = createModel('{"actual": 1}');
    const { controller } = setup(model);
    assert.equal(await controller.precomputeFoldingInfo('{"other": 1, "text": 2}'), true);
    assert.equal(controller.getFoldingSummaryIndex().counts[0], 2);
    assert.equal(model.reads, 0);
    assert.equal(await controller.precomputeFoldingInfo(), true);
    assert.equal(controller.getFoldingSummaryIndex().counts[0], 1);
    assert.equal(model.reads, 1);
    assert.equal(await controller.precomputeFoldingInfo('{"another": 1, "source": 2, "value": 3}'), true);
    assert.equal(controller.getFoldingSummaryIndex().counts[0], 3, 'explicit raw text does not reuse the previous model index');
});

test('delayed, in-flight and completed model summaries reject edits, replacement, disposal and unmount', async () => {
    for (const change of [f => f.model.version++, f => { f.model = createModel(); }, f => { f.model.disposed = true; }, f => f.hooks.forEach(hook => hook())]) {
        const { controller, fixture, flush } = setup(createModel());
        const oldModel = fixture.model;
        const scheduled = controller.schedulePrecomputeFoldingInfo(undefined, 300);
        change(fixture);
        flush();
        assert.equal(await scheduled, false);
        assert.equal(oldModel.reads, 0);
        assert.equal(fixture.workers.length, 0);
    }
    for (const change of [f => f.model.version++, f => { f.model = createModel(); }, f => { f.model.disposed = true; }, f => f.hooks.forEach(hook => hook())]) {
        const { controller, fixture } = setup(createModel());
        const pending = controller.precomputeFoldingInfo();
        change(fixture);
        finishWorker(fixture.workers[0]);
        assert.equal(await pending, false);
        assert.equal(controller.getFoldingSummaryIndex().startLines.length, 0);
    }
});

test('superseding a model request terminates immediately and an obsolete message cannot clear newer pending work', async () => {
    const { controller, fixture, flush } = setup(createModel());
    const old = controller.precomputeFoldingInfo();
    fixture.model.version++;
    const next = controller.schedulePrecomputeFoldingInfo(undefined, 300);
    assert.equal(await old, false);
    assert.equal(fixture.workers[0].terminated, true);
    finishWorker(fixture.workers[0]);
    await Promise.resolve();
    assert.equal(controller.precomputeFoldingInfo(), next);
    flush();
    finishWorker(fixture.workers[1], 3);
    assert.equal(await next, true);
    assert.equal(controller.getFoldingSummaryIndex().counts[0], 3);
});

test('unmount releases a completed cache and over-budget models never materialize full text', async () => {
    const { controller, fixture } = setup(createModel('{"a":1}'));
    assert.equal(await controller.precomputeFoldingInfo(), true);
    assert.equal(controller.getFoldingSummaryIndex().counts[0], 1);
    fixture.hooks.forEach(hook => hook());
    assert.equal(controller.getFoldingSummaryIndex().counts.length, 0);
    const model = createModel();
    model.getValueLength = () => 256 * 1024 * 1024 + 1;
    const next = setup(model);
    assert.equal(await next.controller.precomputeFoldingInfo(), false);
    assert.equal(model.reads, 0);
    assert.equal(next.fixture.workers.length, 0);
});


test('a throwing display hook cannot strand worker completion or turn cache hits into synchronous throws', async () => {
    for (const text of [large, '{"a": 1}']) {
        const { controller, fixture } = setup(createModel(text));
        fixture.throwRefresh = true;
        const pending = controller.precomputeFoldingInfo();
        if (fixture.workers.length) finishWorker(fixture.workers[0]);
        assert.equal(await pending, true);
        const cached = controller.precomputeFoldingInfo();
        assert.equal(typeof cached.then, 'function');
        assert.equal(await cached, true);
        assert.equal(controller.getFoldingSummaryIndex().startLines.length, 1);
    }
});
