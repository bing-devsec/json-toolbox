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
    const document = { body, defaultView: view };
    const parent = { parentElement: body };
    let rect = { top: 0, height: 44, width: 1200, right: 1200 };
    const toolbar = { ownerDocument: document, parentElement: parent, getBoundingClientRect: () => rect };
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, notify: options => {
        const call = { options, closes: 0 };
        calls.push(call);
        return { close: () => { call.closes++; } };
    } });
    return { ...module.exports, calls, values, listeners, observers, toolbar, parent, body, view,
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

test('new results replace the current feedback without a late close clearing the replacement', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageSuccess('formatted');
    f.showMessageError('invalid JSON', 7000);
    assert.equal(f.calls[0].closes, 1);
    f.calls[0].options.onClose();
    f.showMessageWarning('check input');
    assert.equal(f.calls[1].closes, 1);
    assert.equal(f.calls[1].options.duration, 7000);
    assert.equal(f.calls[1].options.message.props.title, 'invalid JSON');
    assert.equal(f.calls[1].options.message.children, 'invalid JSON');
    assert.equal(f.calls[1].options.appendTo, f.body, 'messages stay above modal stacking contexts');
    assert.equal(f.calls[1].options.placement, 'top-right');
    dispose();
    assert.equal(f.calls[2].closes, 1);
});

test('a new message reads moved bounds even before the resize observer delivers', () => {
    const f = fixture();
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.move({ top: 70 });
    f.showMessageSuccess('formatted');
    assert.equal(f.values.get('--json-tool-message-center-y'), '92px');
    dispose();
});

test('teardown restores styles and releases listeners, observers and the current message', () => {
    const f = fixture();
    f.values.set('--json-tool-message-center-y', '100px');
    const oldDispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageInfo('first');
    const dispose = f.bindJsonToolMessageToolbar(f.toolbar);
    f.showMessageInfo('second');
    oldDispose();
    assert.equal(f.calls[1].closes, 0, 'stale cleanup must not close the new owner');
    dispose();
    assert.equal(f.calls[1].closes, 1);
    assert.equal(f.listeners.size, 0);
    assert.ok(f.observers.every(observer => observer.disconnected));
    assert.equal(f.values.get('--json-tool-message-center-y'), '100px');
    assert.equal(f.values.has('--json-tool-message-width'), false);
    f.move({ top: 200 });
    f.observers[1].callback();
    assert.equal(f.values.get('--json-tool-message-center-y'), '100px');
});
