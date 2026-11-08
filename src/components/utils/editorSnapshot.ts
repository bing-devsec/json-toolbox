interface SnapshotModel {
    getVersionId(): number;
    isDisposed(): boolean;
}
interface SnapshotEditor {
    getModel(): SnapshotModel | null;
}

/** O(1) freshness check: no repeated getValue() copies for large editor documents. */
export function captureEditorSnapshot(getEditor: () => SnapshotEditor | null | undefined): () => boolean {
    const editor = getEditor();
    const model = editor?.getModel();
    const version = model?.getVersionId();
    return () => getEditor() === editor && editor?.getModel() === model
        && (!model || (!model.isDisposed() && model.getVersionId() === version));
}
