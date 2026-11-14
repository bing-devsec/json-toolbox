import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';

const flush = async () => { for (let i = 0; i < 10; i++) await vue.nextTick(); };
const componentPath = 'src/components/JsonToolWalkthrough.vue';
const { descriptor } = parse(await readFile(componentPath, 'utf8'), { filename: componentPath });
const compiled = compileScript(descriptor, { id: 'walkthrough-lifecycle-test' });
const bundle = await build({
    stdin: { contents: compiled.content, loader: 'ts', resolveDir: resolve('src/components') },
    bundle: true, write: false, format: 'cjs', platform: 'node', external: ['vue'],
    plugins: [{ name: 'overlay-target', setup(builder) {
        builder.onResolve({ filter: /themes\/overlayTarget$/ }, () => ({ path: 'overlay-target', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useJsonToolOverlayTarget = () => null;' }));
    } }],
});
const renderer = vue.createRenderer({
    createElement: type => ({ type, children: [] }),
    createText: text => ({ text }), createComment: text => ({ text }),
    insert: (child, parent) => { child.parent = parent; parent.children.push(child); },
    remove: child => { child.parent.children = child.parent.children.filter(item => item !== child); },
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null, patchProp: () => {},
});
function mountView(context) {
    const observers = [], frames = new Map(), listeners = new Map();
    let frameId = 0, closed = 0;
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports,
        require: name => { assert.equal(name, 'vue'); return vue; },
        ResizeObserver: class {
            targets = new Set();
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(target) { this.targets.add(target); }
            disconnect() { this.targets.clear(); }
        },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
        window: {
            innerHeight: 1000,
            addEventListener: (type, callback) => listeners.set(type, callback),
            removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); },
        },
        document: { documentElement: { clientWidth: 1400 } },
        getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
    });
    const component = module.exports.default;
    component.render = () => null;
    const target = vue.markRaw({ isConnected: true, parentElement: null,
        getBoundingClientRect: () => ({ x: 50, y: 100, left: 50, top: 100, right: 450, bottom: 500, width: 400, height: 400 }) });
    const app = renderer.createApp(component, {
        active: true, step: 0, busy: false, done: false, target,
        onClose: () => closed++,
    });
    app.mount({ children: [] });
    let removed = false;
    const unmount = () => { if (!removed) { removed = true; app.unmount(); } };
    context.after(unmount);
    return { observers, frames, listeners, target, unmount, get closed() { return closed; } };
}

test('unmounting an active guide before its nextTick tracking resumes cannot restart observers or frames', async context => {
    const view = mountView(context);
    assert.equal(view.observers.length, 1);
    assert.deepEqual([...view.listeners.keys()].sort(), ['animationend', 'keydown', 'resize', 'scroll', 'transitionend']);
    view.unmount(); // Settings-step transitions remove a still-active guide instance.
    await flush();
    assert.equal(view.observers[0].targets.size, 0);
    assert.equal(view.frames.size, 0);
    assert.equal(view.listeners.size, 0);
});

test('normal view disposal clears active observations and animation frames including queued observer callbacks', async context => {
    const view = mountView(context);
    await flush();
    assert(view.observers[0].targets.has(view.target));
    assert.equal(view.frames.size, 1);
    const lateCallback = view.observers[0].callback;
    view.unmount(); lateCallback();
    await vue.nextTick();
    assert.equal(view.observers[0].targets.size, 0);
    assert.equal(view.frames.size, 0);
    assert.equal(view.listeners.size, 0);
});

test('only a trusted Escape exits the guide; internal menu-closing Escape passes through', context => {
    const view = mountView(context);
    const listener = view.listeners.get('keydown');
    let prevented = 0, stopped = 0;
    const event = (key, isTrusted) => ({ key, isTrusted,
        preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
    listener(event('Escape', false)); listener(event('Enter', true));
    assert.equal(view.closed, 0); assert.equal(prevented, 0); assert.equal(stopped, 0);
    listener(event('Escape', true));
    assert.equal(view.closed, 1); assert.equal(prevented, 1); assert.equal(stopped, 1);
});


test('dialog transition and animation completion schedule a fresh measurement and are detached on exit', async context => {
    const view = mountView(context);
    await flush();
    const measure = () => { const [id, callback] = [...view.frames][0]; view.frames.delete(id); callback(); };
    measure(); await flush();
    assert.equal(view.frames.size, 0);
    view.listeners.get('transitionend')();
    assert.equal(view.frames.size, 1);
    view.listeners.get('animationend')();
    assert.equal(view.frames.size, 1, 'events before the next paint share one measurement');
    measure(); await flush();
    view.listeners.get('animationend')();
    assert.equal(view.frames.size, 1);
    view.unmount();
    assert.equal(view.frames.size, 0); assert.equal(view.listeners.size, 0);
});
