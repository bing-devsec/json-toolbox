import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { vueDeclarations } from './helpers/vueDeclarations.mjs';

const file = 'src/components/JsonToolWorkbench.vue';
const source = readFileSync(file, 'utf8');
const declarations = ['inputFilePicker', 'openInputFilePicker', 'handleFileUpload'];
async function fixture(process = async () => {}) {
    const ctx = { ref: value => ({ value }), repair: { repairing: { value: false } }, isTabPageClosing: { value: false }, processInputFileUpload: process };
    return { ctx, ...await vueDeclarations(file, declarations, ctx) };
}

test('actual file-picker click resets the value and opens synchronously within the user gesture', async () => {
    const f = await fixture();
    let clicks = 0;
    const input = { value: 'previous.json', click() { assert.equal(this.value, ''); clicks++; } };
    f.inputFilePicker.value = input;
    assert.equal(f.openInputFilePicker(), undefined);
    assert.equal(clicks, 1, 'no promise, nextTick, or timer may precede input.click');
    input.value = 'previous.json';
    f.openInputFilePicker();
    assert.equal(clicks, 2);
});

test('actual file picker cannot open while repair is running, after unmount, or without a mounted input', async () => {
    const f = await fixture();
    f.openInputFilePicker();
    f.inputFilePicker.value = { value: 'unchanged', click() { assert.fail('must not open'); } };
    f.ctx.repair.repairing.value = true;
    f.openInputFilePicker();
    f.ctx.repair.repairing.value = false;
    f.ctx.isTabPageClosing.value = true;
    f.openInputFilePicker();
    assert.equal(f.inputFilePicker.value.value, 'unchanged');
});

test('actual change adapter forwards one original File, releases input immediately, and accepts the same file again', async () => {
    const calls = [];
    let resolve;
    const waiting = new Promise(yes => { resolve = yes; });
    const f = await fixture(value => { calls.push(value); return waiting; });
    const first = new File(['{}'], 'sample.json', { type: 'application/json' });
    const second = new File(['[]'], 'ignored.json', { type: 'application/json' });
    const input = { files: [first, second], value: 'sample.json' };
    const pending = f.handleFileUpload({ currentTarget: input });
    assert.equal(input.value, '', 'reset before awaiting file processing');
    assert.deepEqual(calls, [first], 'preserve identity and single-file behavior');
    input.value = 'sample.json';
    const repeated = f.handleFileUpload({ currentTarget: input });
    assert.equal(input.value, '');
    assert.deepEqual(calls, [first, first]);
    resolve();
    await Promise.all([pending, repeated]);
});

test('actual change adapter treats cancellation as no-op and rejects files selected after repair/closing', async () => {
    const f = await fixture(() => assert.fail('must not process this selection'));
    for (const files of [null, []]) {
        const input = { files, value: 'old.json' };
        await f.handleFileUpload({ currentTarget: input });
        assert.equal(input.value, '');
    }
    await f.handleFileUpload({ currentTarget: null });
    for (const state of [f.ctx.repair.repairing, f.ctx.isTabPageClosing]) {
        state.value = true;
        const input = { files: [new File(['{}'], 'sample.json')], value: 'sample.json' };
        await f.handleFileUpload({ currentTarget: input });
        assert.equal(input.value, '');
        state.value = false;
    }
});

test('actual change adapter resets the input even when processing rejects', async () => {
    const failure = new Error('read failure');
    const f = await fixture(() => Promise.reject(failure));
    const input = { files: [new File(['{}'], 'sample.json')], value: 'sample.json' };
    await assert.rejects(f.handleFileUpload({ currentTarget: input }), error => error === failure);
    assert.equal(input.value, '');
});

test('real workbench template compiles with a native single-file input and the existing styled keyboard button', () => {
    const { descriptor, errors } = parse(source, { filename: file });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: 'file-picker-test' });
    const result = compileTemplate({ source: descriptor.template.content, filename: file, id: 'file-picker-test', compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(result.errors, []);
    const inputs = [];
    const buttons = [];
    const visit = node => {
        if (node.type === 1 && node.tag === 'input') inputs.push(node);
        if (node.type === 1 && node.tag === 'el-button') buttons.push(node);
        for (const child of node.children || []) visit(child);
    };
    visit(descriptor.template.ast);
    const picker = inputs.find(node => node.props.some(prop => prop.type === 6 && prop.name === 'ref' && prop.value?.content === 'inputFilePicker'));
    assert.ok(picker);
    const attribute = name => picker.props.find(prop => prop.type === 6 && prop.name === name);
    const directive = name => picker.props.find(prop => prop.type === 7 && prop.arg?.content === name);
    assert.equal(attribute('type')?.value?.content, 'file');
    assert.equal(attribute('accept')?.value?.content, '.json');
    assert.ok(attribute('hidden'));
    assert.equal(attribute('multiple'), undefined);
    assert.equal(directive('multiple'), undefined);
    assert.equal(directive('disabled')?.exp?.content, 'repair.repairing.value');
    assert.equal(directive('change')?.exp?.content, 'handleFileUpload');
    const button = buttons.find(node => node.props.some(prop => prop.type === 7 && prop.arg?.content === 'click' && prop.exp?.content === 'openInputFilePicker'));
    assert.ok(button, 'native ElButton click handles mouse, Enter and Space');
    assert.ok(button.props.some(prop => prop.type === 7 && prop.arg?.content === 'disabled' && prop.exp?.content === 'repair.repairing.value'));
    assert.match(source, /\.json-file-picker\s*\{\s*display: inline-flex;\s*align-items: center;\s*justify-content: center;/);
    assert.doesNotMatch(descriptor.scriptSetup.content, /\bElUpload\b|\bUploadFile\b|element-plus\/es\/components\/upload/);
});
