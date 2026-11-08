import { pruneUnusedJsonWorkerTypes } from './monaco-json-worker-types.mjs';
import { assertNoNativeMonacoDiffConsumers, pruneUnusedMonacoWorkerDiff } from './monaco-worker-diff.mjs';

/**
 * Worker builds have their own plugin list; main-thread adapters do not apply.
 * Keep the existing entry points, initialization, model synchronization, foreign
 * JSON service and every live RPC. The product does not use native Monaco Diff.
 * No lazy import or new fallback dependency is introduced by these transforms.
 */
/** @returns {import('vite').Plugin} */
export const monacoWorkerResourcesPlugin = () => ({
    name: 'monaco-worker-resources',
    enforce: 'pre',
    transform(code, id) {
        const result = pruneUnusedJsonWorkerTypes(code, id) ?? pruneUnusedMonacoWorkerDiff(code, id);
        return result === null ? null : { code: result, map: null };
    },
    generateBundle(_options, bundle) {
        // Retain the same fail-closed known-consumer contract as the main graph.
        assertNoNativeMonacoDiffConsumers(bundle);
    },
});
