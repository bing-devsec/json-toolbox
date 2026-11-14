import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    entryPoints: ['src/components/utils/walkthroughPlayback.ts'],
    bundle: true, write: false, format: 'cjs', platform: 'node',
});
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup() {
    let time = 0, sequence = 0;
    const timers = new Map(), updates = [];
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports, AbortController,
        Date: { now: () => time },
        setTimeout: (callback, duration) => {
            const id = ++sequence;
            timers.set(id, { callback, due: time + duration });
            return id;
        },
        clearTimeout: id => timers.delete(id),
    });
    const fireNext = () => {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        assert.ok(next, 'expected a scheduled playback wait');
        timers.delete(next[0]); time = next[1].due; next[1].callback();
        return time;
    };
    const playback = module.exports.createWalkthroughPlayback(pointer => updates.push({ ...pointer }));
    return { playback, updates, timers, fireNext, state: () => updates.at(-1), time: () => time };
}

test('pointer follows the actual target center and reduced motion still preserves the action sequence', async () => {
    const f = setup(), run = f.playback.start(() => true, true);
    const moving = run.point({ getBoundingClientRect: () => ({ left: 200, top: 100, width: 40, height: 40 }) });
    assert.deepEqual(f.state(), { x: 150, y: 170, visible: true, pressing: false });
    assert.equal(f.fireNext(), 30); await flush();
    assert.deepEqual(f.state(), { x: 220, y: 120, visible: true, pressing: false });
    assert.equal(f.fireNext(), 110); await moving;
    let clicks = 0;
    const pressing = run.press(() => clicks++);
    assert.equal(clicks, 0); assert.equal(f.state().pressing, true);
    f.fireNext(); await flush(); assert.equal(clicks, 1);
    f.fireNext(); await pressing;
    assert.equal(f.state().pressing, false);
    run.finish();
    assert.equal(f.state().visible, false); assert.equal(f.timers.size, 0);
});

test('cancel during an opening pointer animation clears its wait and prevents later rendering', async () => {
    const f = setup(), run = f.playback.start(() => true);
    const moving = run.point({ x: 300, y: 200 });
    const rejected = assert.rejects(moving, /playback cancelled/);
    f.playback.cancel();
    const cancelledUpdates = f.updates.length;
    await rejected; await flush();
    assert.equal(f.timers.size, 0);
    assert.equal(f.updates.length, cancelledUpdates);
    assert.equal(f.state().visible, false);
});

test('cancel after a wait resolves but before its continuation prevents a stale pointer from overwriting a new run', async () => {
    const f = setup(), old = f.playback.start(() => true);
    const oldMoving = old.point({ x: 100, y: 100 });
    const rejected = assert.rejects(oldMoving, /playback cancelled/);
    f.fireNext(); // Resolve the old opening wait, leaving its continuation queued.
    const current = f.playback.start(() => true, true);
    const moving = current.point({ x: 500, y: 400 });
    const currentAnchor = { ...f.state() };
    await rejected; await flush();
    assert.deepEqual(f.state(), currentAnchor);
    old.finish();
    assert.deepEqual(f.state(), currentAnchor, 'an old finally must not hide the active pointer');
    assert.equal(f.timers.size, 1);
    f.fireNext(); await flush();
    f.fireNext(); await moving;
    assert.deepEqual(f.state(), { x: 500, y: 400, visible: true, pressing: false });
    current.finish(); assert.equal(f.timers.size, 0);
});

test('cancelling before a press executes never clicks its target', async () => {
    const f = setup(), run = f.playback.start(() => true);
    let clicks = 0;
    const pressing = run.press(() => clicks++);
    const rejected = assert.rejects(pressing, /playback cancelled/);
    f.playback.cancel();
    await rejected; await flush();
    assert.equal(clicks, 0);
    assert.equal(f.state().pressing, false);
    assert.equal(f.timers.size, 0);
});

test('cancelling a completed press wait before its microtask prevents the old action from running', async () => {
    const f = setup(), run = f.playback.start(() => true);
    let clicks = 0;
    const pressing = run.press(() => clicks++);
    const rejected = assert.rejects(pressing, /playback cancelled/);
    f.fireNext();
    f.playback.cancel();
    await rejected;
    assert.equal(clicks, 0);
    assert.equal(f.timers.size, 0);
});

test('a stale press completion cannot reset the pressing state of the next run', async () => {
    const f = setup(), old = f.playback.start(() => true);
    let oldClicks = 0, newClicks = 0;
    const oldPress = old.press(() => oldClicks++);
    const rejected = assert.rejects(oldPress, /playback cancelled/);
    f.fireNext(); await flush();
    assert.equal(oldClicks, 1);
    f.fireNext(); // Queue the old tail continuation without running it yet.
    const current = f.playback.start(() => true);
    const currentPress = current.press(() => newClicks++);
    await rejected; await flush();
    assert.equal(f.state().pressing, true);
    old.finish(); assert.equal(f.state().pressing, true);
    f.fireNext(); await flush(); f.fireNext(); await currentPress;
    assert.equal(oldClicks, 1); assert.equal(newClicks, 1);
    current.finish(); assert.equal(f.timers.size, 0);
});

test('changing the guide generation prevents a pending action even without an explicit abort', async () => {
    const f = setup(); let current = true, clicks = 0;
    const run = f.playback.start(() => current);
    const pressing = run.press(() => clicks++);
    const rejected = assert.rejects(pressing, /playback cancelled/);
    current = false;
    f.fireNext(); await rejected;
    assert.equal(clicks, 0); assert.equal(f.timers.size, 0);
    run.finish(); assert.equal(f.state().pressing, false);
});

test('target polling finds a real result, times out when absent, and stops immediately on cancel', async () => {
    const f = setup(), run = f.playback.start(() => true);
    const target = { id: 'real-input' }; let ready = false, queries = 0;
    const found = run.waitFor(() => { queries++; return ready && target; });
    assert.equal(queries, 1);
    ready = true; f.fireNext(); assert.equal(await found, target);
    assert.equal(queries, 2); assert.equal(f.timers.size, 0);
    const absent = run.waitFor(() => null, 100);
    const failed = assert.rejects(absent, /target unavailable/);
    f.fireNext(); await flush(); f.fireNext(); await failed;
    assert.equal(f.timers.size, 0);
    const waiting = run.waitFor(() => { queries++; return null; });
    const cancelled = assert.rejects(waiting, /playback cancelled/);
    const beforeCancel = queries;
    f.playback.cancel(); await cancelled; await flush();
    assert.equal(queries, beforeCancel); assert.equal(f.timers.size, 0);
});

test('cancelled handles cannot schedule waits, clicks, polling or pointer updates', async () => {
    const f = setup(), run = f.playback.start(() => true);
    f.playback.cancel();
    const count = f.updates.length;
    assert.throws(run.check, /playback cancelled/);
    await assert.rejects(run.pause(10), /playback cancelled/);
    await assert.rejects(run.point({ x: 3, y: 4 }), /playback cancelled/);
    await assert.rejects(run.press(() => assert.fail('stale click')), /playback cancelled/);
    await assert.rejects(run.waitFor(() => assert.fail('stale query')), /playback cancelled/);
    assert.equal(f.updates.length, count); assert.equal(f.timers.size, 0);
});
