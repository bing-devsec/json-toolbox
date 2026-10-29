import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

type Model = Monaco.editor.ITextModel;
type Disposable = { dispose(): void };
type ModelEvents = Pick<typeof Monaco.editor, 'getModels' | 'onDidCreateModel' | 'onWillDisposeModel' | 'onDidChangeModelLanguage'>;

/**
 * Empty editors need tokenization and explicit completion, but have nothing to
 * validate, fold or outline. Enable automatic language services on the first
 * nonempty JSON model, including models restored directly into Diff mode.
 *
 * Activation is one-way: clearing content must not restart providers or Workers.
 * Only getValueLength() is read; no text copies, parsing or ongoing edit scans.
 */
export function createJsonLanguageActivation(
    editor: ModelEvents,
    configure: (configuration: Monaco.languages.json.ModeConfiguration) => void,
    initialDiagnostics: boolean,
) {
    let active = false;
    let disposed = false;
    let diagnostics = initialDiagnostics;
    let previousConfiguration = '';
    const subscriptions: Disposable[] = [];
    const models = new Map<Model, Disposable>();

    const apply = () => {
        const configurationKey = `${active}:${active && diagnostics}`;
        if (disposed || previousConfiguration === configurationKey) return;
        previousConfiguration = configurationKey;
        configure({
            documentFormattingEdits: false,
            documentRangeFormattingEdits: false,
            completionItems: true,
            hovers: true,
            tokens: true,
            selectionRanges: true,
            documentSymbols: active,
            colors: active,
            foldingRanges: active,
            diagnostics: active && diagnostics,
        });
    };
    const stopWatching = () => {
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
        for (const subscription of models.values()) subscription.dispose();
        models.clear();
    };
    const activateFor = (model: Model) => {
        if (disposed || active || model.getLanguageId() !== 'json' || model.getValueLength() === 0) return;
        active = true;
        apply();
        stopWatching();
    };
    const watchModel = (model: Model) => {
        if (disposed || active || models.has(model)) return;
        activateFor(model);
        if (!active) models.set(model, model.onDidChangeContent(() => activateFor(model)));
    };

    apply();
    subscriptions.push(
        editor.onDidCreateModel(watchModel),
        editor.onDidChangeModelLanguage(event => activateFor(event.model)),
        editor.onWillDisposeModel(model => {
            models.get(model)?.dispose();
            models.delete(model);
        }),
    );
    for (const model of editor.getModels()) watchModel(model);

    return {
        setDiagnosticsEnabled(enabled: boolean) {
            diagnostics = enabled;
            apply();
        },
        dispose() {
            disposed = true;
            stopWatching();
        },
    };
}
