import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const CSS_SUFFIX = '/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
const TTF_SHA256 = '0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9';
const WOFF2_SHA256 = '90245a4bad9152143aca864cf3afa67f85c485871ad650b6a957f8ad6b027971';
/** @param {import('node:crypto').BinaryLike} bytes */
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Complete glyph set/metrics; only duplicate BMP cmap representations removed. */
/** @returns {import('vite').Plugin} */
export function monacoFontPlugin() {
    const font = resolve('assets/fonts/codicon-0.52.2.woff2');
    return {
        name: 'json-tool-monaco-font', enforce: 'pre',
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: 'assets/LICENSE.codicon.txt',
                source: readFileSync(resolve('assets/fonts/LICENSE.codicon.txt')) });
        },
        transform(source, id) {
            const normalized = id.split('?')[0].replaceAll('\\', '/');
            if (!normalized.endsWith(CSS_SUFFIX)) return null;
            if (hash(readFileSync(resolve(dirname(id.split('?')[0]), 'codicon.ttf'))) !== TTF_SHA256
                || hash(readFileSync(font)) !== WOFF2_SHA256) {
                throw new Error('[monaco-font] Regenerate and validate the complete WOFF2 font for this Monaco release.');
            }
            const expected = 'url(./codicon.ttf) format("truetype")';
            if (!source.includes(expected)) throw new Error('[monaco-font] Unexpected codicon stylesheet layout.');
            return { code: source.replace(expected, `url(${JSON.stringify(font.replaceAll('\\', '/'))}) format("woff2")`), map: null };
        },
    };
}
