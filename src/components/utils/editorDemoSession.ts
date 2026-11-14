import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

type Editor = monaco.editor.IStandaloneCodeEditor;
type Model = monaco.editor.ITextModel;

export interface EditorDemoSessionOptions {
    getInputEditor: () => Editor | null | undefined;
    getOutputEditor: () => Editor | null | undefined;
    createModel: (value: string, language: string) => Model;
}

interface EditorSnapshot {
    editor: Editor;
    model: Model;
    originalContent: string;
    originalLanguage: string;
    temporaryModel: Model;
    viewState: monaco.editor.ICodeEditorViewState | null;
    readOnly: boolean;
    options: monaco.editor.IEditorOptions;
}

/** Keep the user's actual models detached while a demo owns the editor panes.
 * Restoring their identities preserves undo history, language and model options.
 * Call restore before the workbench destroys editors or enters Diff mode.
 */
export function createEditorDemoSession(options: EditorDemoSessionOptions) {
    let snapshots: EditorSnapshot[] = [];

    const restore = () => {
        const saved = snapshots;
        snapshots = [];
        for (const snapshot of saved) {
            const { editor, model, temporaryModel, viewState, readOnly } = snapshot;
            const currentModel = editor.getModel();
            try {
                // Recover content before reporting a violated model-ownership
                // contract; never leave a pane attached to a disposed demo model.
                const restoredModel = model.isDisposed()
                    ? options.createModel(snapshot.originalContent, snapshot.originalLanguage)
                    : model;
                editor.setModel(restoredModel);
                editor.updateOptions({ ...snapshot.options, readOnly });
                editor.restoreViewState(viewState);
            } finally {
                // Demo operations may replace their temporary model. Dispose that
                // replacement too, but never another pane's retained user model.
                if (currentModel && !saved.some(item => item.model === currentModel) && !currentModel.isDisposed()) {
                    currentModel.dispose();
                }
                if (temporaryModel !== currentModel && !saved.some(item => item.model === temporaryModel) && !temporaryModel.isDisposed()) {
                    temporaryModel.dispose();
                }
            }
        }
    };

    const begin = ({ readOnly = true, language }: { readOnly?: boolean; language?: string } = {}) => {
        if (snapshots.length) return true;
        const editors = [options.getInputEditor(), options.getOutputEditor()];
        if (editors.some(editor => !editor?.getModel())) return false;
        try {
            // Capture both original models before changing either editor.
            for (const editor of editors as Editor[]) {
                const model = editor.getModel()!;
                const originalContent = model.getValue(), originalLanguage = model.getLanguageId();
                snapshots.push({
                    editor, model, originalContent, originalLanguage,
                    temporaryModel: options.createModel(originalContent, language ?? originalLanguage),
                    viewState: editor.saveViewState(),
                    readOnly: editor.getRawOptions().readOnly ?? false,
                    options: { ...editor.getRawOptions() },
                });
            }
            for (const snapshot of snapshots) {
                snapshot.editor.setModel(snapshot.temporaryModel);
                if (snapshot.model.isDisposed()) {
                    throw new Error('Demo requires caller-owned editor models. Initialize the editor with an explicit model.');
                }
                snapshot.editor.updateOptions({ readOnly });
            }
            return true;
        } catch (error) {
            restore();
            throw error;
        }
    };

    return { begin, restore, get active() { return snapshots.length > 0; } };
}
