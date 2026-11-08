import { createHash } from 'node:crypto';

const SUFFIX = '/monaco-editor/esm/vs/language/json/jsonMode.js';
// Run after private-type pruning and the independently checked diagnostics adapter.
const DIAGNOSTICS_SOURCE_SHA256 = '28d9fb2320f4c8123af2c5403cd5299494bbfbe6953fd40c7486d765a7bfeb5e';
const START = 'var FoldingRangeAdapter = class {';
const END = '\nfunction toFoldingRangeKind(';

// Adapts Monaco 0.52.2 FoldingRangeAdapter (Microsoft, MIT). Cancellation can
// arrive while worker acquisition waits for another JSON service operation.
// Do not queue those obsolete scans or allocate mapped copies of stale ranges.
// An already dispatched worker scan still completes; this is not RPC cancellation.
const FOLDING_ADAPTER_SOURCE = String.raw`
var FoldingRangeAdapter = class {
  constructor(_worker) {
    this._worker = _worker;
  }
  provideFoldingRanges(model, context, token) {
    if (token.isCancellationRequested || model.isDisposed()) return Promise.resolve(void 0);
    const resource = model.uri;
    const version = model.getVersionId();
    const language = model.getLanguageId();
    const isCurrent = () => !token.isCancellationRequested && !model.isDisposed()
      && model.getVersionId() === version && model.getLanguageId() === language
      && monaco_editor_core_exports.editor.getModel(resource) === model;
    if (!isCurrent()) return Promise.resolve(void 0);
    return this._worker(resource).then(worker2 => {
      if (isCurrent()) return worker2.getFoldingRanges(resource.toString(), context);
    }).then(ranges => {
      if (!ranges || !isCurrent()) return;
      return ranges.map(range => {
        const result = {
          start: range.startLine + 1,
          end: range.endLine + 1
        };
        if (typeof range.kind !== "undefined") {
          result.kind = toFoldingRangeKind(range.kind);
        }
        return result;
      });
    });
  }
};
`;

/** Replace only the reviewed folding adapter after the diagnostics transform. */
/** @param {string} code @param {string} id */
export function patchMonacoJsonFolding(code, id) {
    if (!id.replaceAll('\\', '/').split('?')[0].endsWith(SUFFIX)) return null;
    if (createHash('sha256').update(code).digest('hex') !== DIAGNOSTICS_SOURCE_SHA256) {
        throw new Error('[monaco-json-folding] Review the installed Monaco JSON mode source and transform order.');
    }
    const start = code.indexOf(START), end = code.indexOf(END, start);
    if (start < 0 || end <= start) {
        throw new Error('[monaco-json-folding] Review the installed Monaco folding adapter boundary.');
    }
    return code.slice(0, start) + FOLDING_ADAPTER_SOURCE.trim() + code.slice(end);
}

/** @returns {import('vite').Plugin} */
export const monacoJsonFoldingPlugin = () => ({
    name: 'monaco-json-folding',
    enforce: 'pre',
    transform(code, id) {
        const result = patchMonacoJsonFolding(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
