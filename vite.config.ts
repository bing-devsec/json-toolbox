import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { getJsonToolManualChunk } from './scripts/vite/monaco-chunks.mjs';
import { monacoLargeFoldingPlugin } from './scripts/vite/monaco-large-folding.mjs';
import { monacoSingleEditorPlugin } from './scripts/vite/monaco-single-editor.mjs';

import { monacoSchemaDocumentationPlugin } from './scripts/vite/monaco-schema-documentation.mjs';
import { monacoColorDocumentationPlugin } from './scripts/vite/monaco-color-documentation.mjs';
import { monacoFontPlugin } from './scripts/vite/monaco-font.mjs';
import { monacoJsonModeTypesPlugin } from './scripts/vite/monaco-json-mode-types.mjs';
import { monacoJsonDiagnosticsPlugin } from './scripts/vite/monaco-json-diagnostics.mjs';
import { monacoJsonFoldingPlugin } from './scripts/vite/monaco-json-folding.mjs';
import { monacoWorkerResourcesPlugin } from './scripts/vite/monaco-worker-resources.mjs';
import { elementButtonColorsPlugin } from './scripts/vite/element-button-colors.mjs';

export default defineConfig({
    base: './',
    // Source verification precedes folding limits; JSON transforms form a checked chain.
    plugins: [vue(), monacoSchemaDocumentationPlugin(), monacoColorDocumentationPlugin(), monacoLargeFoldingPlugin(), monacoSingleEditorPlugin(), monacoFontPlugin(), monacoJsonModeTypesPlugin(), monacoJsonDiagnosticsPlugin(), monacoJsonFoldingPlugin(), elementButtonColorsPlugin()],
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
        dedupe: ['vue'],
    },
    // Keep Monaco's original ESM modules available to the large-folding patch.
    optimizeDeps: { exclude: ['monaco-editor'] },
    worker: { format: 'es', plugins: () => [monacoWorkerResourcesPlugin()] },
    build: {
        target: 'es2022',
        assetsInlineLimit: 0,
        chunkSizeWarningLimit: 1800,
        rollupOptions: {
            output: {
                manualChunks: getJsonToolManualChunk,
            },
        },
    },
});

