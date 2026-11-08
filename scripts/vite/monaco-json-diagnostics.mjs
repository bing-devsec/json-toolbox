import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const SUFFIX = '/monaco-editor/esm/vs/language/json/jsonMode.js';
// Run after monacoJsonModeTypesPlugin: it independently verifies upstream source.
const PRUNED_SOURCE_SHA256 = '1b0c141126284ba9bc59fe44be7c979f896eca76105fffb4c66d41d0616afa20';
const WEB_WORKER_SHA256 = '1faa026a86e4fdb27b865a8ae11e072ae5dc1ef5678a5e480146a8908df4a718';
const require = createRequire(import.meta.url);
const START = 'var DiagnosticsAdapter = class {';
const END = '\nfunction toSeverity(';
/** @param {import('node:crypto').BinaryLike} value */
const hash = value => createHash('sha256').update(value).digest('hex');

/** Verify the native stable foreign-proxy identity used to recognize replaced Workers. */
export function verifyMonacoDiagnosticsWorkerContract() {
    const file = require.resolve('monaco-editor/esm/vs/editor/standalone/browser/standaloneWebWorker.js');
    if (hash(readFileSync(file, 'utf8')) !== WEB_WORKER_SHA256) {
        throw new Error('[monaco-json-diagnostics] Review the installed Monaco worker proxy identity contract.');
    }
}

// Adapts Monaco 0.52.2 DiagnosticsAdapter (Microsoft, MIT). Keep every JSON
// diagnostic and the native debounce, but allow one validation per live model
// and worker plus its latest request. This cannot interrupt a running parse.
const DIAGNOSTICS_ADAPTER_SOURCE = String.raw`
var DiagnosticsAdapter = class {
  constructor(_languageId, _worker, configChangeEvent) {
    this._languageId = _languageId;
    this._worker = _worker;
    this._disposables = [];
    this._states = new Map();
    this._disposed = false;
    const onModelAdd = model => {
      if (this._disposed || model.getLanguageId() !== this._languageId) return;
      const key = model.uri.toString();
      let state = this._states.get(key);
      if (!state) {
        state = { key, model: null, revision: 0, timer: null, running: null, pending: null, acquisition: 0, listener: null };
        this._states.set(key, state);
      }
      state.listener?.dispose();
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
      state.model = model;
      state.revision++;
      state.listener = model.onDidChangeContent(() => {
        if (state.timer !== null) window.clearTimeout(state.timer);
        // A newer edit restarts debounce even if the previous edit was already queued.
        state.pending = null;
        state.timer = window.setTimeout(() => {
          state.timer = null;
          this._request(state);
        }, 500);
      });
      this._request(state);
    };
    const onModelRemoved = model => {
      monaco_editor_core_exports.editor.setModelMarkers(model, this._languageId, []);
      const state = this._states.get(model.uri.toString());
      if (!state || state.model !== model) return;
      state.listener?.dispose();
      state.listener = null;
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
      state.model = null;
      state.revision++;
      state.pending = null;
      // Removed models end their lifecycle. Do not retain an obsolete worker,
      // model, or unresolved RPC through this map while waiting for completion.
      state.running = null;
      this._states.delete(state.key);
    };
    this._disposables.push(monaco_editor_core_exports.editor.onDidCreateModel(onModelAdd));
    this._disposables.push(monaco_editor_core_exports.editor.onWillDisposeModel(onModelRemoved));
    this._disposables.push(monaco_editor_core_exports.editor.onDidChangeModelLanguage(event => {
      onModelRemoved(event.model);
      onModelAdd(event.model);
    }));
    this._disposables.push(configChangeEvent(() => {
      // Reacquire the proxy after configuration changes. Its identity identifies
      // replacement workers, including workers stopped while requests were pending.
      for (const state of this._states.values()) {
        state.revision++;
        if (state.timer !== null) window.clearTimeout(state.timer);
        state.timer = null;
        if (state.model) {
          monaco_editor_core_exports.editor.setModelMarkers(state.model, this._languageId, []);
          this._request(state);
        } else {
          this._states.delete(state.key);
        }
      }
    }));
    this._disposables.push({ dispose: () => {
      for (const state of this._states.values()) {
        if (state.timer !== null) window.clearTimeout(state.timer);
        state.listener?.dispose();
        if (state.model) monaco_editor_core_exports.editor.setModelMarkers(state.model, this._languageId, []);
        state.model = null;
        state.pending = null;
        state.revision++;
      }
      this._states.clear();
    }});
    monaco_editor_core_exports.editor.getModels().forEach(onModelAdd);
  }
  dispose() {
    this._disposed = true;
    this._disposables.forEach(d => d && d.dispose());
    this._disposables.length = 0;
  }
  _request(state) {
    if (this._disposed || !state.model) return;
    state.pending = null;
    const model = state.model;
    const job = { model, revision: state.revision, version: model.getVersionId(), acquisition: ++state.acquisition, worker: null };
    const isLatestAcquisition = () => this._isCurrent(state, job) && state.acquisition === job.acquisition;
    // Acquire on each debounced request, even if validation is busy. The native
    // accessor returns the same foreign proxy for one worker, and a new proxy
    // after either defaults or idle termination. Never wait forever on a dead
    // worker's unresolved RPC before discovering its replacement.
    Promise.resolve().then(() => isLatestAcquisition() ? this._worker(model.uri) : null).then(worker => {
      if (!worker || !isLatestAcquisition()) return;
      job.worker = worker;
      if (state.running && state.running.worker === worker) state.pending = job;
      else {
        state.pending = null;
        this._validate(state, job);
      }
    }).catch(error => { if (isLatestAcquisition()) console.error(error); });
  }
  _isCurrent(state, job) {
    return !this._disposed && state.model === job.model && state.revision === job.revision
      && job.model.getVersionId() === job.version && job.model.getLanguageId() === this._languageId
      && monaco_editor_core_exports.editor.getModel(job.model.uri) === job.model;
  }
  _validate(state, job) {
    if (!this._isCurrent(state, job)) return;
    state.running = job;
    const isCurrent = () => state.running === job && this._isCurrent(state, job);
    Promise.resolve().then(() => {
      if (isCurrent()) return job.worker.doValidation(job.model.uri.toString());
    }).then(diagnostics => {
      if (!diagnostics || !isCurrent()) return;
      const markers = diagnostics.map(d => toDiagnostics(job.model.uri, d));
      if (isCurrent()) monaco_editor_core_exports.editor.setModelMarkers(job.model, this._languageId, markers);
    }).catch(error => { if (isCurrent()) console.error(error); }).finally(() => {
      if (state.running !== job) return;
      state.running = null;
      if (this._disposed) return;
      if (!state.model) this._states.delete(state.key);
      else if (state.pending) {
        const pending = state.pending;
        state.pending = null;
        this._validate(state, pending);
      }
    });
  }
};
`;

/** Replace only the reviewed diagnostic adapter after private-type pruning. */
/** @param {string} code @param {string} id */
export function patchMonacoJsonDiagnostics(code, id) {
    if (!id.replaceAll('\\', '/').split('?')[0].endsWith(SUFFIX)) return null;
    if (hash(code) !== PRUNED_SOURCE_SHA256) {
        throw new Error('[monaco-json-diagnostics] Review the installed Monaco JSON mode source and transform order.');
    }
    const start = code.indexOf(START), end = code.indexOf(END, start);
    if (start < 0 || end <= start) {
        throw new Error('[monaco-json-diagnostics] Review the installed Monaco diagnostics adapter boundary.');
    }
    return code.slice(0, start) + DIAGNOSTICS_ADAPTER_SOURCE.trim() + code.slice(end);
}

/** @returns {import('vite').Plugin} */
export const monacoJsonDiagnosticsPlugin = () => ({
    name: 'monaco-json-diagnostics',
    enforce: 'pre',
    buildStart() { verifyMonacoDiagnosticsWorkerContract(); },
    transform(code, id) {
        const result = patchMonacoJsonDiagnostics(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
