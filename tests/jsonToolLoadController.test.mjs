import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonToolLoadController, createRetryableModuleLoader } from '../src/components/utils/jsonToolLoadController.ts';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
    return { promise, resolve, reject };
};

test('module loading is shared and successful modules stay cached', async () => {
    const result = deferred(); let calls = 0;
    const load = createRetryableModuleLoader(() => { calls++; return result.promise; });
    const first = load(), second = load();
    assert.equal(first, second);
    await Promise.resolve(); assert.equal(calls, 1);
    const component = {};
    result.resolve(component);
    assert.equal(await first, component);
    assert.equal(load(), first);
    assert.equal(calls, 1);
});

test('a rejected or synchronously throwing loader allows another attempt', async () => {
    for (const synchronous of [false, true]) {
        let calls = 0;
        const component = {};
        const load = createRetryableModuleLoader(() => {
            if (++calls === 1) {
                if (synchronous) throw new Error('network unavailable');
                return Promise.reject(new Error('network unavailable'));
            }
            return Promise.resolve(component);
        });
        await assert.rejects(load());
        assert.equal(await load(), component);
        assert.equal(calls, 2);
    }
});

test('slow loading continues until the real module resolves without a duplicate request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const result = deferred(), states = []; let calls = 0;
    const component = {};
    const controller = createJsonToolLoadController({
        load: () => { calls++; return result.promise; },
        onChange: state => states.push(state),
        slowAfterMs: 100,
    });
    const first = controller.start();
    assert.equal(controller.start(), first);
    assert.deepEqual(states, [{ status: 'loading', component: null }]);
    t.mock.timers.tick(100);
    assert.deepEqual(states.at(-1), { status: 'slow', component: null });
    await Promise.resolve(); assert.equal(calls, 1);
    result.resolve(component); await first;
    assert.deepEqual(states.at(-1), { status: 'ready', component });
    t.mock.timers.tick(1000);
    assert.equal(states.length, 3);
    controller.dispose();
});

test('an error can be retried and does not retain its previous slow timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result = deferred(); const states = [];
    const controller = createJsonToolLoadController({ load: () => result.promise, onChange: state => states.push(state), slowAfterMs: 100 });
    const first = controller.start();
    await Promise.resolve();
    result.reject(new Error('missing chunk')); await first;
    assert.equal(states.at(-1).status, 'error');
    t.mock.timers.tick(1000); assert.equal(states.at(-1).status, 'error');
    result = deferred(); const second = controller.start();
    assert.equal(states.at(-1).status, 'loading');
    await Promise.resolve();
    result.resolve({}); await second;
    assert.equal(states.at(-1).status, 'ready');
    controller.dispose();
});

test('leaving the view suppresses late success, late failure and slow notifications', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const failure of [false, true]) {
        const result = deferred(), states = [];
        const controller = createJsonToolLoadController({ load: () => result.promise, onChange: state => states.push(state), slowAfterMs: 100 });
        const loading = controller.start(); await Promise.resolve();
        controller.dispose();
        t.mock.timers.tick(1000);
        if (failure) result.reject(new Error('left page')); else result.resolve({});
        await loading;
        await controller.start();
        assert.deepEqual(states, [{ status: 'loading', component: null }]);
    }
});

test('disposing one view does not cancel the shared download for another view', async () => {
    const result = deferred(), oldStates = [], newStates = []; let calls = 0;
    const load = createRetryableModuleLoader(() => { calls++; return result.promise; });
    const previous = createJsonToolLoadController({ load, onChange: state => oldStates.push(state) });
    const oldAttempt = previous.start();
    await Promise.resolve();
    previous.dispose();
    const current = createJsonToolLoadController({ load, onChange: state => newStates.push(state) });
    const newAttempt = current.start();
    await Promise.resolve();
    const component = {};
    result.resolve(component);
    await Promise.all([oldAttempt, newAttempt]);
    assert.equal(calls, 1);
    assert.deepEqual(oldStates, [{ status: 'loading', component: null }]);
    assert.deepEqual(newStates.at(-1), { status: 'ready', component });
    current.dispose();
});
