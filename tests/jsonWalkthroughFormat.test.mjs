import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

// Exercise the actual workbench flow and real cancellable playback. The fake
// editors expose independent folding completion, as Monaco does after transfer.
const source = await readFile('src/components/JsonToolWorkbench.vue', 'utf8');
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('workbench.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let expression;
function find(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useJsonToolFirstUseGuide') {
        const property = node.arguments[0].properties.find(item => item.name?.getText(ast) === 'performStep');
        expression = property?.initializer.getText(ast);
    }
    ts.forEachChild(node, find);
}
find(ast); assert.ok(expression);
const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents:
        "import { createWalkthroughPlayback } from './src/components/utils/walkthroughPlayback';\n"
        + 'export const walkthroughPlayback = createWalkthroughPlayback(() => {});\n'
        + 'const clearWalkthroughPlayback = () => walkthroughPlayback.cancel();\n'
        + 'export const perform = ' + expression + ';' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const formatted = '{\n  "users": [\n    {\n      "id": 1\n    }\n  ]\n}';
const ranges = [{ startLineNumber: 2, endLineNumber: 6 }, { startLineNumber: 3, endLineNumber: 5 }];
function setup(context) {
    const pendingFormat = deferred(), timers = new Map(), events = [];
    let clock = 0, timerId = 0;
    const state = { current: true, input: 'unformatted input', output: '', outputRanges: [], inputRanges: [],
        dropdownVisible: false, done: false, failure: null, completedInvocations: 0, result: undefined };
    const selectedLevel = { value: 1 };
    const editor = pane => ({ getValue: () => state[pane], saveViewState: () => ({
        contributionsState: { 'editor.contrib.folding': { lineCount: 7, collapsedRegions: state[`${pane}Ranges`] } },
    }) });
    const element = (name, onClick) => ({
        name, disabled: false, textContent: name, isConnected: true,
        getBoundingClientRect: () => ({ left: 50, top: 50, width: 80, height: 30 }),
        getClientRects: () => [{}], scrollIntoView() {},
        click() { events.push(name); onClick?.(); },
        getAttribute: () => null, classList: { contains: () => false },
    });
    const format = element('format');
    const select = element('select', () => { state.dropdownVisible = true; });
    const option = element('level-2', () => { selectedLevel.value = 2; state.dropdownVisible = false; });
    const fold = element('fold', () => { ctx.isFoldOperationLocked = true; });
    const transfer = element('transfer', () => { state.input = state.output; state.output = ''; state.outputRanges = []; });
    const outputPanel = element('preview'), inputPanel = element('input');
    const query = selector => {
        if (selector === '[data-guide-tool="format"]') return format;
        if (selector === '[data-guide-tool="fold"] .el-select__wrapper') return select;
        if (selector === '.level-select-dropdown [data-guide-fold-level="2"]') return state.dropdownVisible ? option : null;
        if (selector === '[data-guide-tool="fold"] .level-action-button') return fold;
        if (selector === '[data-guide-tool="transfer"]') return transfer;
        if (selector === '.editor-panel-output') return outputPanel;
        if (selector === '.editor-panel-input') return inputPanel;
        assert.fail(`Unexpected selector: ${selector}`);
    };
    const module = { exports: {} };
    const ctx = {
        module, exports: module.exports, AbortController,
        props: { locale: 'zh' }, walkthroughTopics: { value: [{ action: 'format', target: '[data-guide-tool="format"]' }] },
        walkthroughLiveTarget: { value: null }, walkthroughCaption: { value: '' }, walkthroughAwaitingFold: { value: false },
        loadWalkthroughSource: () => { state.input = 'unformatted input'; state.output = ''; state.outputRanges = []; state.inputRanges = []; },
        selectedLevel, isFoldOperationLocked: false,
        inputEditor: editor('input'), outputEditor: editor('output'),
        formatJSON: async () => { events.push('format'); await pendingFormat.promise; if (state.current) state.output = formatted; },
        document: { querySelector: query }, window: { matchMedia: () => ({ matches: true }) },
        nextTick: async () => {}, Date: { now: () => clock },
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, due: clock + delay }); return timerId; },
        clearTimeout: token => timers.delete(token),
    };
    runInNewContext(bundle.outputFiles[0].text, ctx);
    let action;
    const run = () => {
        state.failure = null;
        action = module.exports.perform(0, () => state.current).then(result => {
            state.result = result; state.done = result !== false; state.completedInvocations++; return result;
        }, error => { state.failure = error; throw error; });
        void action.catch(() => {});
        return action;
    };
    run();
    const nextTimer = () => [...timers].sort((a, b) => a[1].due - b[1].due)[0];
    const fire = async () => { const next = nextTimer(); assert.ok(next, 'the action should have a pending animation or polling wait');
        timers.delete(next[0]); clock = next[1].due; next[1].callback(); await flush(); };
    const until = async predicate => { await flush(); for (let i = 0; i < 200 && !predicate(); i++) {
        if (state.failure) throw state.failure;
        await fire();
    } assert.ok(predicate(), 'the expected stage should be reached'); };
    const advance = async duration => { const end = clock + duration; await flush();
        while (nextTimer() && nextTimer()[1].due <= end) await fire();
        clock = end; await flush();
    };
    const cancel = () => { state.current = false; module.exports.walkthroughPlayback.cancel(); };
    context.after(cancel);
    return { state, events, timers, ctx, get action() { return action; }, run, until, advance, cancel,
        completeFormat: () => pendingFormat.resolve(),
        completeFold: () => { state.outputRanges = ranges.map(range => ({ ...range })); ctx.isFoldOperationLocked = false; },
        completeTransfer: () => { state.inputRanges = ranges.map(range => ({ ...range })); },
    };
}

async function reachComparison(f) {
    await f.until(() => f.events.includes('format')); f.completeFormat();
    await f.until(() => f.state.completedInvocations === 1); await f.action;
    assert.equal(f.ctx.walkthroughAwaitingFold.value, true);
    assert.equal(f.state.done, false);
}
async function reachFold(f) {
    await reachComparison(f); f.run();
    await f.until(() => f.events.includes('fold'));
}
async function reachTransfer(f) {
    await reachFold(f); f.completeFold(); await f.until(() => f.events.includes('transfer'));
}

test('format demonstration selects level 2, folds, then transfers content and the actual fold state', async context => {
    const f = setup(context);
    await f.until(() => f.events.includes('format'));
    await f.advance(600); assert.deepEqual(f.events, ['format']);
    f.completeFormat(); await f.until(() => f.state.completedInvocations === 1);
    assert.equal(await f.action, false); f.run(); await f.until(() => f.events.includes('fold'));
    assert.equal(f.ctx.selectedLevel.value, 2);
    f.completeFold(); await f.until(() => f.events.includes('transfer'));
    f.completeTransfer(); await f.until(() => f.state.done); await f.action;
    assert.deepEqual(f.events, ['format', 'select', 'level-2', 'fold', 'transfer']);
    assert.equal(f.state.input, formatted); assert.equal(f.state.output, '');
    assert.deepEqual(f.state.inputRanges, ranges); assert.equal(f.timers.size, 0);
});

test('folding must finish with real collapsed regions before the transfer can begin', async context => {
    const f = setup(context); await reachFold(f);
    await f.advance(600); assert.equal(f.events.includes('transfer'), false);
    f.ctx.isFoldOperationLocked = false; // Failure also releases this lock.
    await f.advance(600); assert.equal(f.events.includes('transfer'), false);
    f.state.outputRanges = ranges; f.ctx.isFoldOperationLocked = true;
    await f.advance(600); assert.equal(f.events.includes('transfer'), false);
    f.completeFold(); await f.until(() => f.events.includes('transfer'));
    f.completeTransfer(); await f.until(() => f.state.done); await f.action;
});

test('moving the text and clearing preview does not finish until every transferred fold is restored', async context => {
    const f = setup(context); await reachTransfer(f);
    assert.equal(f.state.input, formatted); assert.equal(f.state.output, '');
    await f.advance(600); assert.equal(f.state.done, false);
    f.state.inputRanges = [ranges[0]];
    await f.advance(600); assert.equal(f.state.done, false);
    f.state.inputRanges = [ranges[0], { startLineNumber: 3, endLineNumber: 4 }];
    await f.advance(600); assert.equal(f.state.done, false);
    f.completeTransfer(); await f.until(() => f.state.done); await f.action;
});

test('cancelling while format, folding, or transfer is pending prevents later clicks and completion', async context => {
    for (const stage of ['format', 'fold', 'transfer']) {
        const f = setup(context);
        if (stage === 'format') await f.until(() => f.events.includes('format'));
        else if (stage === 'fold') await reachFold(f);
        else await reachTransfer(f);
        await f.advance(400); // Finish the press animation; cancel the operation's actual wait.
        const before = [...f.events];
        const cancelled = assert.rejects(f.action, /playback cancelled/);
        f.cancel(); f.completeFormat(); f.completeFold(); f.completeTransfer();
        await cancelled; await f.advance(600);
        assert.deepEqual(f.events, before, stage); assert.equal(f.state.done, false, stage);
        assert.equal(f.timers.size, 0, stage);
    }
});

test('formatting pauses indefinitely for comparison until the user explicitly continues', async context => {
    const f = setup(context); await reachComparison(f);
    assert.equal(f.state.input, 'unformatted input'); assert.equal(f.state.output, formatted);
    assert.deepEqual(f.state.outputRanges, []);
    await f.advance(60_000);
    assert.deepEqual(f.events, ['format']); assert.equal(f.state.done, false);
    assert.equal(f.state.completedInvocations, 1); assert.equal(f.timers.size, 0);
    f.run(); await f.until(() => f.events.includes('fold')); f.completeFold();
    await f.until(() => f.events.includes('transfer')); f.completeTransfer();
    await f.until(() => f.state.done); await f.action;
    assert.equal(f.ctx.walkthroughAwaitingFold.value, false);
    assert.deepEqual(f.events, ['format', 'select', 'level-2', 'fold', 'transfer']);
});

test('leaving the comparison pause never schedules delayed folding or transfer', async context => {
    const f = setup(context); await reachComparison(f);
    f.cancel(); f.state.input = 'restored user input'; f.state.output = 'restored user preview';
    await f.advance(60_000);
    assert.deepEqual(f.events, ['format']); assert.equal(f.state.input, 'restored user input');
    assert.equal(f.state.output, 'restored user preview'); assert.equal(f.timers.size, 0);
});
