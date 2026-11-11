import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { createRetryableModuleLoader } from './jsonToolLoadController';

type Runtime = typeof import('./monacoRuntimeImpl');

// Live bindings are published together after the full runtime and contributions load.
// Consumers may use these only after loadMonacoRuntime() resolves.
export let monacoApi: typeof Monaco;
export let createMonacoWorker: Runtime['createMonacoWorker'];
export let optimizeLargeEditorLineMapping: Runtime['optimizeLargeEditorLineMapping'];
export let clearEditorContent: Runtime['clearEditorContent'];

export const loadMonacoRuntime = createRetryableModuleLoader(async () => {
    // Keep fallback fonts usable while the local font loads; refresh cached glyph widths afterwards.
    const fontReady = typeof document !== 'undefined' && document.fonts
        ? document.fonts.load('12px "JetBrains Mono"').catch(() => [])
        : Promise.resolve([]);
    const runtime = await import('./monacoRuntimeImpl');
    monacoApi = runtime.monacoApi;
    createMonacoWorker = runtime.createMonacoWorker;
    optimizeLargeEditorLineMapping = runtime.optimizeLargeEditorLineMapping;
    clearEditorContent = runtime.clearEditorContent;
    void fontReady.then(faces => {
        if (faces.length) runtime.monacoApi.editor.remeasureFonts();
    });
    return monacoApi;
});
