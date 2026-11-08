import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';

const bundle = await build({
    stdin: { contents: `
        export { countSelectionMatches, countLargeOrMultiline } from './src/components/utils/selectionMatchCount';
        export { TextModel } from 'monaco-editor/esm/vs/editor/common/model/textModel.js';
        export { Range } from 'monaco-editor/esm/vs/editor/common/core/range.js';
        export { Selection } from 'monaco-editor/esm/vs/editor/common/core/selection.js';
        export { UndoRedoService } from 'monaco-editor/esm/vs/platform/undoRedo/common/undoRedoService.js';`,
        resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    // Expose the actual private search core only in this test bundle. Small
    // differential cases exercise it without changing production dispatch.
    plugins: [{ name: 'selection-count-test-core', setup(build) {
        build.onLoad({ filter: /\/selectionMatchCount\.ts$/ }, async ({ path }) => ({
            contents: await readFile(path, 'utf8') + '\nexport { countLargeOrMultiline };', loader: 'ts',
        }));
    } }],
});
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, process, console, URL, performance, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, queueMicrotask,
});
export const api = module.exports;
const subscribe = () => ({ dispose() {} });
export const createModel = text => new api.TextModel(text, 'json', {
    ...api.TextModel.DEFAULT_CREATION_OPTIONS,
    bracketPairColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
}, null, new api.UndoRedoService({}, {}), { requestRichLanguageFeatures() {} }, { onDidChange: subscribe }, {
    createInstance: () => ({
        onDidChangeLanguage: subscribe, onDidChangeLanguageConfiguration: subscribe, onDidChangeTokens: subscribe,
        getLanguageId: () => 'json', handleDidChangeContent() {}, dispose() {},
    }),
});
export const nativeCount = (model, text) => model.findMatches(text, false, false, true, null, false, 1073741824).length;
