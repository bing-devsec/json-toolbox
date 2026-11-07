import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    entryPoints: ['src/utils/jsonToolMessage.ts'],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    loader: { '.css': 'empty' },
    plugins: [{
        name: 'message-boundary',
        setup(build) {
            build.onResolve({ filter: /^(element-plus|vue)$/ }, args => ({ path: args.path, namespace: 'boundary' }));
            build.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({
                contents: args.path === 'vue'
                    ? "export const h = (tag, props, children) => ({ tag, props, children });"
                    : "export const ElMessage = options => globalThis.notify(options);",
                loader: 'js',
            }));
        },
    }],
});

function fixture() {
    const calls = [], values = new Map(), listeners = new Map(), observers = [];
    const body = { style: {
        getPropertyValue: name => values.get(name) || '',
        setProperty: (name, value) => values.set(name, value),
        removeProperty: name => values.delete(name),
    } };
    const view = {
        innerWidth: 1200,
        ResizeObserver: class {
            targets = []; disconnected = false;
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(target) { this.targets.push(target); }
            disconnect() { this.disconnected = true; }
        },
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    };
    const stacks = [];
    const makeNode = () => ({
        children: [], parentElement: null, removed: false,
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        remove() {
            this.removed = true;
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
    });
    Object.assign(body, makeNode());

    const document = { body, defaultView: view, createElement: () => {
        const node = makeNode(); stacks.push(node); return node;
    } };
    const parent = { parentElement: body };
    let rect = { top: 0, height: 44, width: 1200, right: 1200 };
    const toolbar = { ownerDocument: document, parentElement: parent, getBoundingClientRect: () => rect };
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, notify: options => {
        const call = { options, closes: 0 };
        calls.push(call);
        return { close: () => { call.closes++; } };
    } });
    return { ...module.exports, calls, values, listeners, observers, toolbar, parent, body, stacks, view,
        move: next => { rect = { ...rect, ...next }; },
    };
}

test('the feedback center follows the toolbar when an import notice appears, grows and closes', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    assert.equal(f.values.get('--json-tool-message-center-y'), '22px');
    assert.ok(f.observers[0].targets.includes(f.parent), 'observe the flex ancestor, not just toolbar height');
    f.move({ top: 32 });
    f.observers[0].callback();
    assert.equal(f.values.get('--json-tool-message-center-y'), '54px');
    f.move({ top: 64 });
    f.observers[0].callback();
    assert.equal(f.values.get('--json-tool-message-center-y'), '86px');
    f.move({ top: 0 });
    f.observers[0].callback();
    assert.equal(f.values.get('--json-tool-message-center-y'), '22px');
    dispose();
});

test('mode height and viewport changes use actual bounds and retain the right inset', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.move({ top: 40, height: 50, right: 1100, width: 1000 });
    f.listeners.get('resize')();
    assert.equal(f.values.get('--json-tool-message-center-y'), '65px');
    assert.equal(f.values.get('--json-tool-message-right'), '115px');
    assert.equal(f.values.get('--json-tool-message-width'), '970px');
    f.move({ top: 20, height: 40 });
    f.listeners.get('scroll')();
    assert.equal(f.values.get('--json-tool-message-center-y'), '40px');
    dispose();
});

test('warnings and successes from one action coexist in arrival order with independent lifetimes', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageWarning('long line protection enabled', 7000);
    f.showMessageSuccess('compressed');
    f.showMessageError('invalid JSON', 0);
    assert.deepEqual(f.calls.map(call => call.closes), [0, 0, 0], 'new feedback must not close earlier feedback');
    assert.deepEqual(f.calls.map(call => call.options.type), ['warning', 'success', 'error']);
    assert.equal(f.calls[0].options.duration, 7000);
    assert.equal(f.calls[1].options.duration, undefined, 'retain the library default duration');
    assert.equal(f.calls[2].options.duration, 0, 'persistent messages must remain persistent');
    for (const { options } of f.calls) {
        assert.equal(options.placement, 'top-right');
        assert.equal(options.appendTo, f.stacks[0]);
        assert.equal(options.appendTo.parentElement, f.body);
        assert.equal(options.message.props.title, options.message.children);
    }
    dispose();
    assert.deepEqual(f.calls.map(call => call.closes), [1, 1, 1], 'release every active message');
});

test('closing the middle or first message leaves the other messages alive', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageWarning('first', 7000);
    f.showMessageSuccess('middle');
    f.showMessageInfo('last');
    f.calls[1].options.onClose();
    f.calls[0].options.onClose();
    f.showMessageError('new last');
    assert.deepEqual(f.calls.map(call => call.closes), [0, 0, 0, 0]);
    dispose();
    assert.deepEqual(f.calls.map(call => call.closes), [0, 0, 1, 1], 'closed entries are released without affecting survivors');
});

test('messages share a flow container that survives close callbacks until toolbar teardown', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    assert.equal(f.stacks.length, 0, 'create the container only when there is feedback');
    f.showMessageWarning('first', 7000);
    f.showMessageSuccess('second');
    assert.equal(f.stacks.length, 1);
    const stack = f.calls[0].options.appendTo;
    assert.notEqual(stack, f.body, 'messages need a dedicated flow container');
    assert.equal(f.calls[1].options.appendTo, stack);
    assert.equal(stack.parentElement, f.body);
    f.calls[1].options.onClose();
    f.calls[0].options.onClose();
    assert.equal(stack.removed, false, 'onClose precedes the fade; keep the container mounted');
    f.showMessageInfo('arrives while old messages fade');
    assert.equal(f.calls[2].options.appendTo, stack, 'new feedback stays after the fading DOM nodes');
    dispose();
    assert.equal(stack.removed, true);
    assert.equal(f.body.children.length, 0);
});

test('a new message reads moved bounds even before the resize observer delivers', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.move({ top: 70 });
    f.showMessageSuccess('formatted');
    assert.equal(f.values.get('--json-tool-message-center-y'), '92px');
    dispose();
});

test('rebinding releases the entire old stack and ignores stale cleanup and close callbacks', () => {
    const f = fixture();
    f.values.set('--json-tool-message-center-y', '100px');
    const oldDispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageInfo('first');
    f.showMessageWarning('second', 7000);
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    assert.deepEqual(f.calls.map(call => call.closes), [1, 1]);
    assert.equal(f.stacks[0].removed, true);
    f.showMessageInfo('new owner');
    assert.equal(f.stacks.length, 2);
    assert.equal(f.calls[2].options.appendTo, f.stacks[1]);
    oldDispose();
    f.calls[0].options.onClose();
    f.calls[1].options.onClose();
    assert.equal(f.calls[2].closes, 0, 'stale cleanup must not close the new owner');
    assert.equal(f.stacks[1].removed, false);
    dispose();
    dispose();
    assert.deepEqual(f.calls.map(call => call.closes), [1, 1, 1], 'cleanup is idempotent');
    assert.equal(f.stacks[1].removed, true);
    assert.equal(f.listeners.size, 0);
    assert.ok(f.observers.every(observer => observer.disconnected));
    assert.equal(f.values.get('--json-tool-message-center-y'), '100px');
    assert.equal(f.values.has('--json-tool-message-width'), false);
    f.move({ top: 200 });
    f.observers[1].callback();
    assert.equal(f.values.get('--json-tool-message-center-y'), '100px');
});
