import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import * as vue from 'vue';

const { outputFiles } = await build({
    entryPoints: ['src/components/composables/useJsonToolFirstUseGuide.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['vue'],
});
const storageKey = 'json-tool:first-use-guide-dismissed:v1';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// A small host renderer exercises Vue's real refs, watchers and mount/unmount hooks.
// Browser storage and focus stay isolated to each controller instance.
const renderer = vue.createRenderer({
    createElement: type => ({ type, children: [] }),
    createText: text => ({ text }),
    createComment: text => ({ text }),
    insert: (child, parent) => { child.parent = parent; parent.children.push(child); },
    remove: child => { child.parent.children = child.parent.children.filter(item => item !== child); },
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; },
    parentNode: node => node.parent,
    nextSibling: () => null,
    patchProp: () => {},
});

function mountGuide(context, config = {}) {
    const writes = [], prepares = [], actions = [], focuses = [];
    const storage = config.storage ?? new Map();
    let begins = 0, restores = 0, api;
    class Element {
        isConnected = true;
        constructor(name) { this.name = name; }
        focus(options) { focuses.push({ name: this.name, options }); }
    }
    const invoker = new Element('invoker');
    const fallback = new Element('settings');
    const element = new Element('target');
    const options = {
        ...(config.stepCount === undefined ? {} : { stepCount: config.stepCount }),
        locale: vue.ref(config.locale ?? 'zh'),
        editorsInitialized: vue.ref(config.ready ?? true),
        isDiffMode: vue.ref(false),
        isInputDragActive: vue.ref(false),
        unavailable: vue.ref(false),
        ...(config.suppressAutomaticInvitation === undefined ? {} : { suppressAutomaticInvitation: vue.ref(config.suppressAutomaticInvitation) }),
        beginDemo: () => { begins++; return config.beginResult ?? true; },
        restoreDemo: () => { restores++; },
        prepareStep: async (step, isCurrent) => { prepares.push(step); await config.prepareStep?.(step, isCurrent); },
        performStep: async (step, isCurrent) => { actions.push(step); return await config.performStep?.(step, isCurrent); },
        getTarget: () => element,
    };
    const module = { exports: {} };
    runInNewContext(outputFiles[0].text, {
        module,
        exports: module.exports,
        require: name => { assert.equal(name, 'vue'); return vue; },
        HTMLElement: Element,
        document: { activeElement: invoker, querySelector: () => fallback },
        localStorage: {
            getItem: key => {
                if (config.storageThrows) throw new Error('storage unavailable');
                return storage.get(key) ?? null;
            },
            setItem: (key, value) => {
                if (config.storageThrows) throw new Error('storage unavailable');
                writes.push({ key, value });
                storage.set(key, value);
            },
        },
    });
    const app = renderer.createApp({
        setup() {
            api = module.exports.useJsonToolFirstUseGuide(options);
            return () => null;
        },
    });
    app.mount({ children: [] });
    let unmounted = false;
    const unmount = () => { if (!unmounted) { unmounted = true; app.unmount(); } };
    context.after(unmount);
    return { api, options, writes, prepares, actions, focuses, storage, invoker, element, unmount,
        get begins() { return begins; }, get restores() { return restores; } };
}

test('first visit offers the guide; skipping persists the existing v1 preference across mounts', context => {
    const storage = new Map();
    const first = mountGuide(context, { storage });
    assert.equal(first.api.shouldShowFirstUseGuide.value, true);
    first.api.dismissFirstUseGuide();
    assert.equal(first.api.shouldShowFirstUseGuide.value, false);
    assert.deepEqual(first.writes, [{ key: storageKey, value: '1' }]);
    const reopened = mountGuide(context, { storage });
    assert.equal(reopened.api.shouldShowFirstUseGuide.value, false);
    assert.equal(first.begins, 0);
    assert.equal(first.restores, 0);
});

test('existing content and a previous dismissal cannot be bypassed by a stale start event', async context => {
    for (const config of [{}, { storage: new Map([[storageKey, '1']]) }]) {
        const c = mountGuide(context, config);
        c.api.inputHasContent.value = true;
        assert.equal(c.api.shouldShowFirstUseGuide.value, false);
        await c.api.start();
        assert.equal(c.begins, 0);
        assert.equal(c.api.active.value, false);
        assert.deepEqual(c.writes, []);
        assert.equal('invite' in c.api, false, 'the settings re-entry API has been removed');
    }
});

test('shared or imported data suppresses the first-use dialog without consuming it', async context => {
    const storage = new Map();
    const imported = mountGuide(context, { storage, suppressAutomaticInvitation: true });
    assert.equal(imported.api.shouldShowFirstUseGuide.value, false);
    imported.api.inputHasContent.value = true;
    await imported.api.start();
    assert.equal(imported.begins, 0);
    assert.equal(imported.api.active.value, false);
    assert.deepEqual(imported.writes, [], 'opening shared or imported data must not persist a skip');
    const normalVisit = mountGuide(context, { storage });
    assert.equal(normalVisit.api.shouldShowFirstUseGuide.value, true);
});

test('automatic suppression is reactive but never cancels an active guide', async context => {
    const c = mountGuide(context, { suppressAutomaticInvitation: true });
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    c.options.suppressAutomaticInvitation.value = false;
    assert.equal(c.api.shouldShowFirstUseGuide.value, true);
    c.options.suppressAutomaticInvitation.value = true;
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    assert.deepEqual(c.writes, []);
    c.options.suppressAutomaticInvitation.value = false;
    await c.api.start();
    c.options.suppressAutomaticInvitation.value = true;
    assert.equal(c.api.active.value, true);
    assert.equal(c.restores, 0, 'suppressing a future invitation is not an unavailable-editor signal');
    await c.api.action();
    assert.deepEqual(c.actions, [0]);
    assert.equal(c.api.done.value, true);
    c.api.finish(false);
    assert.equal(c.restores, 1);
});

test('fresh first-visit invitation also stays hidden for input content and dragging', context => {
    const c = mountGuide(context);
    c.api.inputHasContent.value = true;
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    c.api.inputHasContent.value = false;
    c.options.isInputDragActive.value = true;
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    c.options.isInputDragActive.value = false;
    assert.equal(c.api.shouldShowFirstUseGuide.value, true);
});

test('unready, diff and externally unavailable editors cannot start or persist a dismissal', async context => {
    for (const mode of ['ready', 'diff', 'unavailable']) {
        const c = mountGuide(context, { ready: mode !== 'ready' });
        if (mode === 'diff') c.options.isDiffMode.value = true;
        if (mode === 'unavailable') c.options.unavailable.value = true;
        await c.api.start();
        assert.equal(c.api.shouldShowFirstUseGuide.value, false, mode);
        assert.equal(c.api.active.value, false, mode);
        assert.equal(c.begins, 0, mode);
        assert.equal(c.restores, 0, mode);
        assert.deepEqual(c.writes, [], mode);
    }
});

test('a refused demo snapshot leaves the invitation and user preference untouched', async context => {
    const c = mountGuide(context, { beginResult: false });
    await c.api.start();
    assert.equal(c.begins, 1);
    assert.equal(c.api.active.value, false);
    assert.equal(c.api.shouldShowFirstUseGuide.value, true);
    assert.deepEqual(c.prepares, []);
    assert.deepEqual(c.writes, []);
    assert.equal(c.restores, 0);
});

test('preparing a step blocks duplicate starts, actions and navigation', async context => {
    const pending = deferred();
    const c = mountGuide(context, { prepareStep: () => pending.promise });
    const started = c.api.start();
    assert.equal(c.api.busy.value, true);
    await Promise.all([c.api.start(), c.api.action(), c.api.next(), c.api.back(), c.api.goTo(4), c.api.goTo(7)]);
    assert.equal(c.begins, 1);
    assert.deepEqual(c.prepares, [0]);
    assert.deepEqual(c.actions, []);
    assert.equal(c.api.step.value, 0);
    pending.resolve();
    await started;
    assert.equal(c.api.busy.value, false);
    assert.equal(c.api.target.value, c.element);
});

test('executing a step once blocks double clicks and navigation until it completes', async context => {
    const pending = deferred();
    const c = mountGuide(context, { performStep: () => pending.promise });
    await c.api.start();
    const action = c.api.action();
    await Promise.all([c.api.action(), c.api.next(), c.api.back()]);
    assert.deepEqual(c.actions, [0]);
    assert.equal(c.api.busy.value, true);
    assert.equal(c.api.done.value, false);
    assert.equal(c.api.step.value, 0);
    pending.resolve();
    await action;
    assert.equal(c.api.done.value, true);
    assert.equal(c.api.busy.value, false);
    await c.api.next();
    assert.equal(c.api.step.value, 1);
    assert.equal(c.api.done.value, false);
});

test('exiting a pending step invalidates its write guard and never resurrects the guide', async context => {
    for (const phase of ['prepare', 'perform']) {
        const pending = deferred();
        const staleWrites = [];
        const operation = async (_step, isCurrent) => {
            await pending.promise;
            if (isCurrent()) staleWrites.push('late demo write');
        };
        const c = mountGuide(context, phase === 'prepare' ? { prepareStep: operation } : { performStep: operation });
        const started = c.api.start();
        let running = started;
        if (phase === 'perform') { await started; running = c.api.action(); }
        c.api.finish(false);
        assert.equal(c.restores, 1);
        pending.resolve();
        await running;
        assert.deepEqual(staleWrites, [], phase);
        assert.equal(c.api.active.value, false, phase);
        assert.equal(c.api.busy.value, false, phase);
        assert.equal(c.api.done.value, false, phase);
        assert.equal(c.api.target.value, null, phase);
        assert.equal(c.api.error.value, '', phase);
    }
});

test('a dismissed guide cannot restart while a previous action settles', async context => {
    for (const fail of [false, true]) {
        const pending = deferred();
        let isOldCurrent;
        const c = mountGuide(context, { performStep: (_step, isCurrent) => { isOldCurrent = isCurrent; return pending.promise; } });
        await c.api.start();
        const action = c.api.action();
        c.api.finish(false);
        await c.api.start();
        assert.equal(c.begins, 1, 'late or duplicate start events do not create another demo');
        assert.equal(isOldCurrent(), false);
        if (fail) pending.reject(new Error('old operation failed')); else pending.resolve();
        await action;
        assert.equal(c.api.active.value, false);
        assert.equal(c.api.busy.value, false);
        assert.equal(c.api.done.value, false);
        assert.equal(c.api.error.value, '');
        assert.equal(c.api.target.value, null);
        assert.equal(c.restores, 1);
    }
});

test('external exclusion and component unmount synchronously cancel pending work', async context => {
    for (const mode of ['unavailable', 'diff', 'unready', 'unmount']) {
        const pending = deferred();
        let isCurrent;
        const c = mountGuide(context, { performStep: (_step, current) => { isCurrent = current; return pending.promise; } });
        await c.api.start();
        const action = c.api.action();
        if (mode === 'unavailable') c.options.unavailable.value = true;
        if (mode === 'diff') c.options.isDiffMode.value = true;
        if (mode === 'unready') c.options.editorsInitialized.value = false;
        if (mode === 'unmount') c.unmount();
        assert.equal(c.api.active.value, false, mode);
        assert.equal(isCurrent(), false, mode);
        assert.equal(c.restores, 1, mode);
        pending.resolve();
        await action;
        assert.equal(c.api.target.value, null, mode);
        assert.deepEqual(c.focuses, [], mode);
    }
});

test('finish restores the snapshot once and restores focus without scrolling', async context => {
    const c = mountGuide(context);
    await c.api.start();
    c.api.finish();
    c.api.finish();
    await vue.nextTick();
    c.unmount();
    assert.equal(c.restores, 1);
    assert.equal(c.api.active.value, false);
    assert.equal(c.focuses.length, 1);
    assert.equal(c.focuses[0].name, 'invoker');
    assert.equal(c.focuses[0].options.preventScroll, true);
});

test('completing the final step restores the snapshot once and can fall back to settings focus', async context => {
    const c = mountGuide(context);
    await c.api.start();
    c.invoker.isConnected = false;
    for (let step = 0; step < 7; step++) await c.api.next();
    await vue.nextTick();
    assert.equal(c.api.active.value, false);
    assert.equal(c.restores, 1);
    assert.equal(c.focuses[0].name, 'settings');
    c.api.finish();
    c.unmount();
    assert.equal(c.restores, 1);
});

test('step failures are recoverable and successful retry clears localized error state', async context => {
    for (const locale of ['zh', 'en']) {
        let fail = true;
        const c = mountGuide(context, { locale, performStep: () => { if (fail) throw new Error('format failed'); } });
        await c.api.start();
        await c.api.action();
        assert.equal(c.api.busy.value, false);
        assert.equal(c.api.done.value, false);
        assert.equal(c.api.active.value, true);
        assert.match(c.api.error.value, locale === 'en' ? /Try again/ : /重试/);
        fail = false;
        await c.api.action();
        assert.equal(c.api.done.value, true);
        assert.equal(c.api.error.value, '');
    }
});

test('unavailable browser storage keeps the automatic invitation hidden', async context => {
    const c = mountGuide(context, { storageThrows: true });
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    await c.api.start();
    assert.equal(c.begins, 0);
    assert.equal(c.api.active.value, false);
    c.api.dismissFirstUseGuide();
    c.api.finish(false);
    assert.equal(c.restores, 0);
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
});

test('topic navigation prepares only requested topics and resets action completion', async context => {
    const c = mountGuide(context);
    await c.api.start();
    await c.api.action();
    assert.equal(c.api.done.value, true);
    await c.api.goTo(5);
    assert.equal(c.api.step.value, 5);
    assert.equal(c.api.done.value, false);
    await c.api.action();
    await c.api.goTo(2);
    assert.equal(c.api.step.value, 2);
    assert.equal(c.api.done.value, false);
    assert.deepEqual(c.prepares, [0, 5, 2], 'jumping does not run intermediate topics');
    assert.deepEqual(c.actions, [0, 5]);
    assert.equal(c.restores, 0);
    assert.equal(c.api.target.value, c.element);
});

test('configured step count supports short and longer catalogs and finishes at its boundary', async context => {
    for (const count of [1, 4, 9]) {
        const c = mountGuide(context, { stepCount: count });
        await c.api.start();
        await c.api.goTo(count - 1);
        assert.equal(c.api.active.value, true, String(count));
        assert.equal(c.api.step.value, count - 1, String(count));
        assert.deepEqual(c.prepares, [0, count - 1]);
        await c.api.next();
        assert.equal(c.api.active.value, false, String(count));
        assert.equal(c.restores, 1, String(count));
        assert.equal(c.api.target.value, null);
        assert.equal(c.focuses.length, 1);
        await c.api.goTo(0);
        assert.deepEqual(c.prepares, [0, count - 1], 'navigation cannot restart a finished session');
    }
});

test('jumping beyond the catalog completes without preparing a nonexistent topic', async context => {
    const c = mountGuide(context, { stepCount: 4 });
    await c.api.start();
    await c.api.goTo(10);
    assert.deepEqual(c.prepares, [0]);
    assert.equal(c.api.active.value, false);
    assert.equal(c.restores, 1);
    assert.equal(c.api.target.value, null);
});

test('invalid topic indexes leave the current topic, result and target untouched', async context => {
    const c = mountGuide(context);
    await c.api.start();
    await c.api.goTo(3);
    await c.api.action();
    for (const invalid of [NaN, Infinity, -Infinity, 0.5, -1.5, 7.5, '2', null, undefined]) {
        await c.api.goTo(invalid);
        assert.equal(c.api.step.value, 3, String(invalid));
        assert.equal(c.api.active.value, true, String(invalid));
        assert.equal(c.api.done.value, true, String(invalid));
        assert.equal(c.api.target.value, c.element, String(invalid));
        assert.equal(c.api.busy.value, false, String(invalid));
        assert.equal(c.restores, 0, String(invalid));
    }
    assert.deepEqual(c.prepares, [0, 3]);
    assert.deepEqual(c.actions, [3]);
    await c.api.goTo(-20);
    assert.equal(c.api.step.value, 0, 'negative integer navigation clamps to the first topic');
    assert.equal(c.api.done.value, false);
    assert.deepEqual(c.prepares, [0, 3, 0]);
});

test('a pending topic jump blocks other navigation and cancellation prevents late writes', async context => {
    const pending = deferred();
    const writes = [];
    const c = mountGuide(context, { prepareStep: async (step, isCurrent) => {
        if (step !== 4) return;
        await pending.promise;
        if (isCurrent()) writes.push(step);
    } });
    await c.api.start();
    await c.api.action();
    const jumped = c.api.goTo(4);
    assert.equal(c.api.step.value, 4);
    assert.equal(c.api.busy.value, true);
    assert.equal(c.api.done.value, false);
    assert.equal(c.api.target.value, null, 'the previous topic is not highlighted during preparation');
    await Promise.all([c.api.goTo(1), c.api.goTo(7), c.api.next(), c.api.back(), c.api.action()]);
    assert.equal(c.api.active.value, true, 'a finish-index jump is also blocked while busy');
    assert.equal(c.api.step.value, 4);
    assert.deepEqual(c.prepares, [0, 4]);
    assert.deepEqual(c.actions, [0]);
    c.api.finish(false);
    pending.resolve();
    await jumped;
    assert.deepEqual(writes, []);
    assert.equal(c.restores, 1);
    assert.equal(c.api.active.value, false);
    assert.equal(c.api.busy.value, false);
    assert.equal(c.api.done.value, false);
    assert.equal(c.api.target.value, null);
});

test('a late topic preparation cannot revive a finished one-time guide', async context => {
    for (const fail of [false, true]) {
        const pending = deferred();
        const writes = [];
        const c = mountGuide(context, { prepareStep: async (step, isCurrent) => {
            if (step === 4) await pending.promise;
            if (isCurrent()) writes.push(step);
        } });
        await c.api.start();
        const oldJump = c.api.goTo(4);
        c.api.finish(false);
        await Promise.all([c.api.start(), c.api.goTo(2)]);
        if (fail) pending.reject(new Error('stale preparation')); else pending.resolve();
        await oldJump;
        assert.equal(c.api.active.value, false);
        assert.equal(c.api.busy.value, false);
        assert.equal(c.api.target.value, null);
        assert.equal(c.api.error.value, '');
        assert.equal(c.api.done.value, false);
        assert.deepEqual(writes, [0]);
        assert.deepEqual(c.prepares, [0, 4]);
        assert.equal(c.restores, 1);
        assert.equal(c.begins, 1);
    }
});


test('entering records the one-time choice before preparation and keeps it across reloads', async context => {
    const storage = new Map();
    const pending = deferred();
    const c = mountGuide(context, { storage, prepareStep: () => pending.promise });
    const started = c.api.start();
    assert.equal(storage.get(storageKey), '1');
    assert.equal(c.api.shouldShowFirstUseGuide.value, false);
    const reloaded = mountGuide(context, { storage });
    assert.equal(reloaded.api.shouldShowFirstUseGuide.value, false);
    await reloaded.api.start();
    assert.equal(reloaded.begins, 0);
    c.api.finish(false);
    pending.resolve();
    await started;
    assert.equal(c.restores, 1);
});

test('clearing persisted site data restores the invitation on the next visit', async context => {
    for (const choice of ['cancel', 'enter']) {
        const storage = new Map();
        const first = mountGuide(context, { storage });
        if (choice === 'cancel') first.api.dismissFirstUseGuide();
        else { await first.api.start(); first.api.finish(false); }
        first.unmount();
        const returning = mountGuide(context, { storage });
        assert.equal(returning.api.shouldShowFirstUseGuide.value, false, choice);
        returning.unmount();
        storage.clear();
        const resetVisit = mountGuide(context, { storage });
        assert.equal(resetVisit.api.shouldShowFirstUseGuide.value, true, choice);
        await resetVisit.api.start();
        assert.equal(resetVisit.begins, 1, choice);
        assert.equal(resetVisit.api.active.value, true, choice);
    }
});

test('a partial action releases busy state but stays incomplete until the user continues', async context => {
    let calls = 0;
    const c = mountGuide(context, { performStep: () => ++calls === 1 ? false : undefined });
    await c.api.start(); await c.api.action();
    assert.equal(c.api.busy.value, false); assert.equal(c.api.done.value, false);
    assert.equal(c.api.target.value, c.element); assert.deepEqual(c.actions, [0]);
    await vue.nextTick(); await vue.nextTick(); assert.equal(calls, 1, 'no automatic continuation');
    await c.api.action(); assert.equal(c.api.done.value, true); assert.equal(c.api.busy.value, false);
    assert.deepEqual(c.actions, [0, 0]);
});

test('exiting or choosing another topic after a partial action invalidates the old action guard', async context => {
    for (const leave of ['exit', 'topic']) {
        let oldCurrent;
        const c = mountGuide(context, { performStep: (_step, isCurrent) => { oldCurrent = isCurrent; return false; } });
        await c.api.start(); await c.api.action(); assert.equal(oldCurrent(), true);
        if (leave === 'exit') c.api.finish(false);
        else await c.api.goTo(2);
        assert.equal(oldCurrent(), false, leave); assert.equal(c.api.done.value, false, leave);
        await vue.nextTick(); assert.deepEqual(c.actions, [0], leave);
        if (leave === 'exit') { await c.api.action(); assert.deepEqual(c.actions, [0]); assert.equal(c.restores, 1); }
        else { assert.equal(c.api.step.value, 2); assert.deepEqual(c.prepares, [0, 2]); }
    }
});
