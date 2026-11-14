import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';

const componentPath = 'src/components/JsonToolWalkthrough.vue';
const { descriptor } = parse(await readFile(componentPath, 'utf8'), { filename: componentPath });
const compiled = compileScript(descriptor, { id: 'walkthrough-controls-test', inlineTemplate: true });
const bundle = await build({
    stdin: { contents: compiled.content, loader: 'ts', resolveDir: resolve(componentPath, '..') },
    bundle: true, write: false, format: 'cjs', platform: 'node', external: ['vue'],
    plugins: [{ name: 'overlay-target', setup(builder) {
        builder.onResolve({ filter: /themes\/overlayTarget$/ }, () => ({ path: 'overlay-target', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export const useJsonToolOverlayTarget = () => 'body';" }));
    } }],
});

function mountControls(context, initialProps) {
    const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null });
    const body = node('body'), root = node('root');
    body.children.push(root); root.parent = body;
    const renderer = vue.createRenderer({
        createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
        insert(child, parent, anchor = null) {
            if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
            child.parent = parent;
            const index = anchor ? parent.children.indexOf(anchor) : -1;
            parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
        },
        remove(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
        setText: (n, text) => { n.text = text; },
        setElementText: (n, text) => { n.text = text; n.children = []; },
        parentNode: n => n.parent,
        nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
        patchProp: (n, key, previous, value) => { n.props[key] = value; },
        querySelector: () => body,
    });
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports,
        require: name => { assert.equal(name, 'vue'); return vue; },
        ResizeObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        window: { addEventListener() {}, removeEventListener() {} },
    });
    const events = [], props = vue.reactive({ active: true, step: 0, busy: false, done: false, ...initialProps });
    const app = renderer.createApp({ setup: () => () => vue.h(module.exports.default, {
        ...props, onNext: () => events.push('next'), onClose: () => events.push('close'),
    }) });
    app.mount(root); context.after(() => app.unmount());
    const all = n => [n, ...n.children.flatMap(all)];
    const button = className => all(body).find(n => n.type === 'button' && n.props.class?.split(' ').includes(className));
    return { props, events, button };
}

test('intermediate steps retain separate next and exit actions', context => {
    const view = mountControls(context, { step: 1 });
    assert.equal(view.button('walkthrough-next').text, '下一步');
    assert.equal(view.button('walkthrough-exit').text, '退出');
    view.button('walkthrough-next').props.onClick();
    view.button('walkthrough-exit').props.onClick();
    assert.deepEqual(view.events, ['next', 'close']);
});

for (const [extension, lastStep] of [[false, 4], [true, 3]]) {
    test(`${extension ? 'extension' : 'web'} final step has a single end action and stays cancellable during replay`, async context => {
        const view = mountControls(context, { extension, step: lastStep, done: true });
        assert.equal(view.button('walkthrough-exit'), undefined);
        assert.equal(view.button('walkthrough-next').text, '完成');
        assert.equal(view.button('walkthrough-next').props.disabled, false);
        view.button('walkthrough-next').props.onClick();
        assert.deepEqual(view.events, ['next']);

        view.props.busy = true;
        await vue.nextTick();
        assert.equal(view.button('walkthrough-next'), undefined);
        const exit = view.button('walkthrough-exit');
        assert.equal(exit.text, '退出');
        assert.notEqual(exit.props.disabled, true);
        exit.props.onClick();
        assert.deepEqual(view.events, ['next', 'close']);

        view.props.busy = false;
        view.props.error = 'Replay failed';
        await vue.nextTick();
        assert.equal(view.button('walkthrough-exit'), undefined);
        assert.equal(view.button('walkthrough-next').text, '完成');
        assert.equal(view.button('walkthrough-next').props.disabled, false);
    });
}
