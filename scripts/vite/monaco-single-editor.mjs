import { createHash } from 'node:crypto';

const MODULE_ROOT = '/monaco-editor/esm/vs/editor/standalone/browser/';
/** @type {Record<string, string>} */
const reviewedSources = {
    'standaloneEditor.js': '9b01c590ba788251527458faeb9fa3d6072fc7133c70cefa3eb823efd40817c4',
    'standaloneCodeEditor.js': '6f065e29e3983d05f120b4b1a7bd3bf9e9546d95ae7f06aba72f4b09bc8c9996',
};

/**
 * This tool builds its Diff view from two normal editors and its own diff Worker.
 * Monaco's native DiffEditor / multi-file DiffEditor are never instantiated.
 * Their decorated classes have side effects, so normal tree shaking keeps both
 * widget trees even though the application only calls editor.create().
 *
 * Remove only those two factory exports and the native Diff subclass. The normal
 * editor, services, language API and contributions retain their original source.
 * Refuse unreviewed Monaco releases instead of guessing at changed internals.
 * @param {string} code
 * @param {string} id
 * @returns {string | null}
 */
export function pruneUnusedMonacoDiffWidgets(code, id) {
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    const name = Object.keys(reviewedSources).find(name => normalized.endsWith(MODULE_ROOT + name));
    if (!name) return null;
    if (createHash('sha256').update(code).digest('hex') !== reviewedSources[name]) {
        throw new Error(`[monaco-single-editor] Review the installed Monaco ${name} before changing this build adapter.`);
    }

    if (name === 'standaloneCodeEditor.js') {
        const start = code.indexOf('let StandaloneDiffEditor2 = class');
        const end = code.indexOf('export { StandaloneDiffEditor2 };', start) + 'export { StandaloneDiffEditor2 };'.length;
        return (code.slice(0, start) + code.slice(end)).replace(
            "import { DiffEditorWidget } from '../../browser/widget/diffEditor/diffEditorWidget.js';\n", '',
        );
    }

    const start = code.indexOf('export function createDiffEditor(');
    const end = code.indexOf('/**\n * Add a command.', start);
    return (code.slice(0, start) + code.slice(end))
        .replace('StandaloneDiffEditor2, StandaloneEditor, createTextModel', 'StandaloneEditor, createTextModel')
        .replace("import { MultiDiffEditorWidget } from '../../browser/widget/multiDiffEditor/multiDiffEditorWidget.js';\n", '')
        .replace('        createDiffEditor: createDiffEditor,\n', '')
        .replace('        createMultiFileDiffEditor: createMultiFileDiffEditor,\n', '');
}

/** @returns {import('vite').Plugin} */
export const monacoSingleEditorPlugin = () => ({
    name: 'monaco-single-editor',
    enforce: 'pre',
    transform(code, id) {
        const result = pruneUnusedMonacoDiffWidgets(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
