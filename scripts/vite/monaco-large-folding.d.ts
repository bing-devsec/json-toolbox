import type { Plugin } from 'vite';

export declare const patchMonacoEditorOptions: (code: string) => string;
export declare const patchMonacoFoldingRanges: (code: string) => string;
export declare const monacoLargeFoldingPlugin: () => Plugin;
