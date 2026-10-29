export interface ExternalJsonImport { id: string; text: string }
export type ImportApplyResult = 'pending' | 'applied' | 'already-applied' | 'occupied';

/** A response may arrive before Monaco; it must be applied once, to an untouched editor. */
export const createExternalImportGate = () => {
    const applied = new Set<string>();
    return {
        apply(request: ExternalJsonImport | null | undefined, editor: {
            ready: boolean;
            hasContent: () => boolean;
            setText: (text: string) => boolean;
        }): ImportApplyResult {
            if (!request || !editor.ready) return 'pending';
            if (applied.has(request.id)) return 'already-applied';
            if (editor.hasContent()) return 'occupied';
            if (!editor.setText(request.text)) return 'pending';
            applied.add(request.id);
            return 'applied';
        },
    };
};
