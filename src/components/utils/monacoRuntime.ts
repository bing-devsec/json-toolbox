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
    const runtime = await import('./monacoRuntimeImpl');
    monacoApi = runtime.monacoApi;
    createMonacoWorker = runtime.createMonacoWorker;
    optimizeLargeEditorLineMapping = runtime.optimizeLargeEditorLineMapping;
    clearEditorContent = runtime.clearEditorContent;
    return monacoApi;
});
