import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { collectMonacoIconScope } from '../collect-monaco-icon-scope.mjs';

/** @typedef {Awaited<ReturnType<typeof collectMonacoIconScope>>} MonacoIconInventory */
/**
 * @typedef {Pick<MonacoIconInventory, 'files' | 'glyphCodepoints' | 'ids' | 'dynamicImports' | 'skippedWorkerImports' | 'unresolvedIds'> & {
 *   applicationFiles: Record<string, string>,
 *   adapter: {file: string, sha256: string},
 *   moduleCount: number,
 *   scope: string,
 *   boundary: string
 * }} MonacoSvgScope
 */
/** @param {import('node:crypto').BinaryLike} bytes */
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** @returns {MonacoSvgScope} */
export const readMonacoSvgScope = () => JSON.parse(readFileSync(resolve('reports/monaco-svg-scope.json'), 'utf8'));

/** Current product audit boundary, not a general-purpose Monaco icon subset. */
export async function assertMonacoSvgScope(root = process.cwd(), expected = readMonacoSvgScope()) {
    /** @param {string} file */
    const changed = file => new Error(`[monaco-svg-scope] Review icon reachability after changing ${file}`);
    for (const [file, sha] of Object.entries(expected.applicationFiles)) {
        if (hash(readFileSync(resolve(root, file))) !== sha) throw changed(file);
    }
    if (hash(readFileSync(resolve(root, expected.adapter.file))) !== expected.adapter.sha256) throw changed(expected.adapter.file);
    const actual = await collectMonacoIconScope(root);
    const fields = /** @type {const} */ (['files', 'glyphCodepoints', 'ids', 'dynamicImports', 'skippedWorkerImports', 'unresolvedIds']);
    for (const field of fields) {
        if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) throw changed('the Monaco module graph or ' + field);
    }
    if (actual.missingImports.length) throw changed('unresolved Monaco imports');
}

// An additional application entry must not pull an unreviewed UI module into
// production without revisiting the same graph/label audit.
/** @param {Iterable<string>} moduleIds @param {MonacoSvgScope} [expected] */
export function assertMonacoSvgBundleScope(moduleIds, expected = readMonacoSvgScope()) {
    const reviewed = new Set(expected.files.map(item => item.file));
    for (const id of moduleIds) {
        const file = id.split('?')[0].replaceAll('\\', '/');
        const match = file.match(/\/monaco-editor\/esm\/(vs\/(?:base\/browser|editor\/(?:browser|contrib|standalone)|platform)\/.*\.(?:js|css))$/);
        if (match && !reviewed.has('node_modules/monaco-editor/esm/' + match[1])) {
            throw new Error('[monaco-svg-scope] Review newly bundled Monaco UI module: ' + match[1]);
        }
    }
}
