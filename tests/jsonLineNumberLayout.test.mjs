import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { runInNewContext } from 'node:vm';

const source = readFileSync('src/components/JsonToolWorkbench.vue', 'utf8');
const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `actual workbench section exists: ${start}`);
    return source.slice(from, to);
};
// Execute the actual helper, constructor options and initialization, rather than
// copying the optimized implementation into the test.
const code = (await transform([
    section('const getLineNumbersMinChars =', '// 更新编辑器高度'),
    section('const getEditorOptions =', 'const syncEditorLargeFileOptions ='),
    section('const initializeEditorLayout =', '// 设置窗口resize监听器'),
    'globalThis.api = { getEditorOptions, updateLineNumberWidth, initializeEditorLayout };',
].join('\n'), { loader: 'ts', format: 'cjs' })).code;

function fixture() {
    const marks = [], calls = { height: 0, scroll: 0, gc: 0 };
    const context = {
        isLargeEditorContent: () => false,
        getJsonToolThemeForLanguage: () => 'json-tool-light-theme',
        themeMode: { value: 'light' }, props: { locale: 'en' },
        showMinimap: { value: false }, stickyScroll: { value: false },
        effectiveWordWrap: { value: false }, fontSize: { value: 12 },
        getFoldingStrategyForLanguage: () => 'auto',
        getLargeFileOptions: () => ({}),
        getJsonToolLongLineViewOptions: () => ({}),
        getJsonToolEditorTypography: () => ({}),
        getEditorGuideOptions: () => ({}),
        JSON_TOOL_EDITOR_SCROLLBAR_THICKNESS: 10,
        JSON_TOOL_EDITOR_HORIZONTAL_SCROLLBAR_THICKNESS: 10,
        inputEditor: null, outputEditor: null, editorsInitialized: { value: false },
        updateEditorHeight: () => calls.height++,
        setupSyncScroll: () => calls.scroll++,
        scheduleStartupGc: () => calls.gc++,
        performance: {
            getEntriesByName: name => marks.filter(mark => mark === name),
            mark: name => marks.push(name),
        },
    };
    runInNewContext(code, context);
    return { ...context.api, context, marks, calls };
}

function editor(rawOptions, initialLineCount = 1) {
    let options = { ...rawOptions }, model = { getLineCount: () => initialLineCount };
    const updates = [], layouts = [];
    return {
        updates, layouts,
        getModel: () => model,
        // Monaco's public getter returns the current raw configuration, including
        // constructor options and later updates, not its normalized render enum.
        getRawOptions: () => options,
        updateOptions(next) { updates.push({ ...next }); options = { ...options, ...next }; },
        layout(...args) { layouts.push(args); },
        replaceModel(lineCount) { model = lineCount === null ? null : { getLineCount: () => lineCount }; },
        changeOptions(next) { options = { ...options, ...next }; },
    };
}

test('normal editor construction uses the same gutter width as initialization and later content', () => {
    const f = fixture();
    for (const count of [0, 1, 9, 10, 98, 99, 100, 999, 1000, 999999, 2000000]) {
        for (const readOnly of [false, true]) {
            const options = f.getEditorOptions(2, readOnly, 'json', true, count);
            // Preserve the prior digit-width rule at every relevant boundary.
            assert.equal(options.lineNumbersMinChars, (count < 99 ? 2 : String(count).length) + 1);
            const instance = editor(options, count);
            f.updateLineNumberWidth(instance);
            assert.equal(instance.updates.length, 0);
            assert.equal(instance.layouts.length, 0);
        }
    }
});

test('empty startup retains readiness and size initialization without redundant gutter renders', () => {
    const f = fixture();
    f.context.inputEditor = editor(f.getEditorOptions(2));
    f.context.outputEditor = editor(f.getEditorOptions(2, true));
    f.initializeEditorLayout();
    assert.equal(f.context.editorsInitialized.value, true);
    assert.deepEqual(f.marks, ['json-tool:editor-ready']);
    assert.deepEqual(f.calls, { height: 2, scroll: 1, gc: 1 });
    for (const instance of [f.context.inputEditor, f.context.outputEditor]) {
        assert.equal(instance.updates.length, 0);
        assert.equal(instance.layouts.length, 0);
    }
});

test('repeated normal and Diff edits avoid redundant layout but digit transitions still render', () => {
    const { updateLineNumberWidth } = fixture();
    const instance = editor({ lineNumbers: 'on', lineNumbersMinChars: 2 });
    updateLineNumberWidth(instance); // Diff starts at two characters, retaining its existing correction.
    assert.deepEqual(instance.updates, [{ lineNumbers: 'on', lineNumbersMinChars: 3 }]);
    assert.equal(instance.layouts.length, 1);
    for (let i = 0; i < 100; i++) updateLineNumberWidth(instance);
    assert.equal(instance.updates.length, 1);
    assert.equal(instance.layouts.length, 1);

    for (const [count, expected] of [[99, 3], [100, 4], [999, 4], [1000, 5], [2000000, 8], [1, 3], [2000000, 8]]) {
        const changed = instance.getRawOptions().lineNumbersMinChars !== expected;
        const before = instance.layouts.length;
        instance.replaceModel(count);
        updateLineNumberWidth(instance);
        assert.equal(instance.getRawOptions().lineNumbersMinChars, expected);
        assert.equal(instance.layouts.length, before + Number(changed));
    }
    assert.equal(instance.layouts.length, 6, 'initial Diff correction plus five real width changes');
});

test('current raw options preserve forced on semantics, defaults and external changes', () => {
    const { updateLineNumberWidth } = fixture();
    for (const lineNumbers of [undefined, 'off', 'relative', 'interval', () => 'custom']) {
        const instance = editor({ lineNumbers, lineNumbersMinChars: 3 });
        updateLineNumberWidth(instance);
        assert.deepEqual(instance.updates, [{ lineNumbers: 'on', lineNumbersMinChars: 3 }]);
        assert.equal(instance.layouts.length, 1);
        instance.changeOptions({ lineNumbers: 'relative' });
        updateLineNumberWidth(instance);
        assert.equal(instance.layouts.length, 2, 'another caller cannot leave a cached width valid');
    }
    for (const minChars of [undefined, 5, '3']) {
        const instance = editor({ lineNumbers: 'on', lineNumbersMinChars: minChars });
        updateLineNumberWidth(instance);
        assert.equal(instance.getRawOptions().lineNumbersMinChars, 3);
        assert.equal(instance.layouts.length, 1);
    }
});

test('missing editors and detached models preserve the existing empty-width behavior', () => {
    const { updateLineNumberWidth } = fixture();
    assert.doesNotThrow(() => updateLineNumberWidth(null));
    const instance = editor({ lineNumbers: 'on', lineNumbersMinChars: 8 }, 2000000);
    instance.replaceModel(null);
    updateLineNumberWidth(instance);
    assert.equal(instance.getRawOptions().lineNumbersMinChars, 3);
    assert.equal(instance.layouts.length, 1);
    updateLineNumberWidth(instance);
    assert.equal(instance.layouts.length, 1);
});
