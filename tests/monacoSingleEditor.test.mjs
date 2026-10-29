import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { pruneUnusedMonacoDiffWidgets } from '../scripts/vite/monaco-single-editor.mjs';

const root = path.dirname(import.meta.dirname);
const sourcePath = name => path.join(root, 'node_modules/monaco-editor/esm/vs/editor/standalone/browser', name);

function functions(code) {
    const source = ts.createSourceFile('editor.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return new Map(source.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node.getText(source)]));
}

test('single-editor adapter preserves normal API implementations and excludes only native Diff construction', () => {
    const file = sourcePath('standaloneEditor.js'), original = fs.readFileSync(file, 'utf8');
    const patched = pruneUnusedMonacoDiffWidgets(original, file);
    const before = functions(original), after = functions(patched);
    for (const [name, code] of before) {
        if (['createDiffEditor', 'createMultiFileDiffEditor'].includes(name)) assert(!after.has(name));
        else if (name !== 'createMonacoEditorAPI') assert.equal(after.get(name), code, name);
    }
    const beforeApi = before.get('createMonacoEditorAPI');
    assert.equal(after.get('createMonacoEditorAPI'), beforeApi
        .replace('        createDiffEditor: createDiffEditor,\n', '')
        .replace('        createMultiFileDiffEditor: createMultiFileDiffEditor,\n', ''));
    const editorFile = sourcePath('standaloneCodeEditor.js');
    const editorOriginal = fs.readFileSync(editorFile, 'utf8');
    const editorPatched = pruneUnusedMonacoDiffWidgets(editorOriginal, editorFile);
    const start = editorOriginal.indexOf('let StandaloneCodeEditor = class');
    const end = editorOriginal.indexOf('export { StandaloneEditor };') + 'export { StandaloneEditor };'.length;
    assert(editorPatched.includes(editorOriginal.slice(start, end)), 'normal editor classes and decorators stay byte-for-byte identical');
    assert(!editorPatched.includes('DiffEditorWidget'));
    for (const [name, body] of functions(editorOriginal)) assert.equal(functions(editorPatched).get(name), body, name);
});

test('adapter refuses changed Monaco sources and handles unrelated / queried / Windows paths safely', () => {
    const file = sourcePath('standaloneEditor.js'), original = fs.readFileSync(file, 'utf8');
    assert.throws(() => pruneUnusedMonacoDiffWidgets(original + '\n', file), /Review the installed Monaco/);
    assert.equal(pruneUnusedMonacoDiffWidgets('unrelated', '/application/editor.js'), null);
    assert.equal(pruneUnusedMonacoDiffWidgets(original, file + '?v=1'), pruneUnusedMonacoDiffWidgets(original, file.replaceAll('/', '\\')));
});

test('production bundle retains the public editor entry and languages without native Diff widget dependencies', async () => {
    const result = await build({
        entryPoints: ['monaco-editor/esm/vs/editor/editor.api.js'],
        bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true,
        loader: { '.css': 'empty' },
        plugins: [{ name: 'single-editor-test', setup(builder) {
            builder.onLoad({ filter: /standalone(?:Code)?Editor\.js$/ }, args => {
                const original = fs.readFileSync(args.path, 'utf8');
                return { contents: pruneUnusedMonacoDiffWidgets(original, args.path) ?? original, loader: 'js' };
            });
        } }],
    });
    const dependencies = Object.keys(result.metafile.inputs);
    assert(dependencies.some(name => name.includes('/widget/codeEditor/')));
    assert(!dependencies.some(name => /\/widget\/(?:diffEditor|multiDiffEditor)\//.test(name)));
    const apiExports = Object.values(result.metafile.outputs)[0].exports;
    for (const name of ['editor', 'languages', 'Range', 'Position', 'KeyCode', 'KeyMod', 'Selection', 'MarkerSeverity']) assert(apiExports.includes(name), name);
});

test('application Diff uses ordinary editors and never calls the pruned native factories', () => {
    const visit = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? visit(file) : /\.(?:ts|vue)$/.test(entry.name) ? [file] : [];
    });
    for (const file of visit(path.join(root, 'src/components'))) {
        assert(!/\b(?:monaco|Monaco)\.editor\.(?:createDiffEditor|createMultiFileDiffEditor)\b/.test(fs.readFileSync(file, 'utf8')), file);
    }
    const diff = fs.readFileSync(path.join(root, 'src/components/composables/useDiffEditors.ts'), 'utf8');
    assert(diff.includes('diffLeftEditor = monaco.editor.create('));
    assert(diff.includes('diffRightEditor = monaco.editor.create('));
});
