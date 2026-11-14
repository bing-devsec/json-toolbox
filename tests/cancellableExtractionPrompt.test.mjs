import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import * as vue from 'vue';

const bundle = await build({ entryPoints: ['src/components/utils/cancellableExtractionPrompt.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['vue'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup() {
    const module = { exports: {} };
    const buttons = new Map(), clicked = [], queries = [];
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports,
        require: name => { assert.equal(name, 'vue'); return vue; },
        document: { querySelector: selector => { queries.push(selector); return buttons.get(selector); } },
    });
    const mount = (hooks, name, cancel) => {
        const instanceClass = hooks.customClass.split(' ').find(value => /^json-tool-extract-values-prompt-\d+$/.test(value));
        assert.ok(instanceClass);
        const selector = '.' + instanceClass + ' .json-tool-extract-cancel';
        buttons.set(selector, { click: () => { clicked.push(name); buttons.delete(selector); cancel(); } });
        return selector;
    };
    return { prompt: module.exports.runCancellableExtractionPrompt, buttons, clicked, queries, mount };
}

test('an already aborted request never opens a prompt', async () => {
    const f = setup(), controller = new AbortController();
    controller.abort();
    let opened = 0;
    await assert.rejects(f.prompt(() => { opened++; return Promise.resolve({ value: 'name' }); }, controller.signal), { name: 'AbortError' });
    assert.equal(opened, 0);
    assert.deepEqual(f.clicked, []);
});

test('aborting one visible extraction prompt cancels only its own instance', async () => {
    const f = setup(), a = new AbortController(), b = new AbortController();
    const first = deferred(), second = deferred();
    const one = f.prompt(hooks => { f.mount(hooks, 'first', () => first.reject('cancel')); return first.promise; }, a.signal);
    const two = f.prompt(hooks => { f.mount(hooks, 'second', () => second.reject('cancel')); return second.promise; }, b.signal);
    const rejected = assert.rejects(one, { name: 'AbortError' });
    a.abort();
    await rejected;
    assert.deepEqual(f.clicked, ['first']);
    assert.equal(f.buttons.size, 1, 'the other prompt remains open');
    second.resolve({ value: 'name' });
    assert.equal((await two).value, 'name');
    b.abort();
    assert.deepEqual(f.clicked, ['first'], 'settling removes the abort listener');
});

test('abort during the opening render closes the owned prompt on the next Vue tick', async () => {
    const f = setup(), controller = new AbortController(), pending = deferred();
    const result = f.prompt(hooks => {
        void vue.nextTick(() => f.mount(hooks, 'opening', () => pending.reject('cancel')));
        return pending.promise;
    }, controller.signal);
    const rejected = assert.rejects(result, { name: 'AbortError' });
    controller.abort();
    await rejected;
    await vue.nextTick();
    assert.deepEqual(f.clicked, ['opening']);
    assert.equal(f.buttons.size, 0);
});

test('late prompt fulfillment after abort cannot resolve the cancelled operation', async () => {
    const f = setup(), controller = new AbortController(), pending = deferred();
    const result = f.prompt(() => pending.promise, controller.signal);
    const rejected = assert.rejects(result, { name: 'AbortError' });
    controller.abort();
    await rejected;
    pending.resolve({ value: 'late name' });
    await vue.nextTick();
    assert.deepEqual(f.clicked, []);
});

test('normal confirmation, cancellation and synchronous open failure settle without later side effects', async () => {
    for (const outcome of ['confirm', 'cancel', 'throw']) {
        const f = setup(), controller = new AbortController();
        const result = f.prompt(hooks => {
            assert.equal(hooks.confirmButtonClass, 'json-tool-extract-confirm');
            assert.equal(hooks.cancelButtonClass, 'json-tool-extract-cancel');
            assert.match(hooks.customClass, /^json-tool-extract-values-prompt /);
            if (outcome === 'throw') throw new Error('open failed');
            return outcome === 'confirm' ? Promise.resolve({ value: 'name' }) : Promise.reject('cancel');
        }, controller.signal);
        if (outcome === 'confirm') assert.equal((await result).value, 'name');
        else await assert.rejects(result, outcome === 'throw' ? /open failed/ : error => error === 'cancel');
        controller.abort();
        await vue.nextTick();
        assert.deepEqual(f.clicked, []);
        assert.deepEqual(f.queries, [], 'completed requests no longer try to close a prompt');
    }
});
