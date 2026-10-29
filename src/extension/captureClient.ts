/** Extension-only bridge. Bodies stay local and are never fetched again by this client. */
export const CAPTURE_LIMIT_BYTES = 20 * 1024 * 1024;
export const CAPTURE_MAX_CHUNK_CHARS = 65_536;
const COMMAND_TIMEOUT_MS = 15_000;
interface CallbackOptions { signal?: AbortSignal; timeoutMs?: number }

interface ChromeRuntime {
    id?: string;
    lastError?: { message?: string };
    sendMessage(message: unknown, callback: (response: unknown) => void): void;
}
interface CaptureChrome { runtime: ChromeRuntime }
export interface CaptureStatus { enabled: boolean; origins: string[]; limitBytes: number; maxChunkChars: number }
export interface CapturedImport { text: string; sourceDisplayUrl: string; createdAt: number }
export interface ReadImportOptions extends CallbackOptions { onProgress?: (loaded: number, total: number) => void }

export class CaptureClientError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'CaptureClientError'; }
}

const getChrome = (): CaptureChrome => {
    const chrome = (globalThis as typeof globalThis & { chrome?: CaptureChrome }).chrome;
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
        throw new CaptureClientError('unavailable', 'JSON response capture is available only in the installed extension.');
    }
    return chrome;
};
export const isCaptureAvailable = (): boolean => {
    try { getChrome(); return true; } catch { return false; }
};

const callbackResult = <T>(chrome: CaptureChrome, invoke: (done: (result: T) => void) => void, options: CallbackOptions = {}): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(new DOMException('Import was cancelled.', 'AbortError'));
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) {
        fail(new CaptureClientError('invalid-timeout', 'The import timeout must be between 1 and 120000 milliseconds.')); return;
    }
    timer = setTimeout(() => fail(new CaptureClientError('timeout', 'The extension did not respond in time. Please retry.')), timeout);
    try {
        invoke(result => {
            // Read lastError even after cancellation so a late Chrome callback is handled.
            const error = chrome.runtime.lastError;
            if (settled) return;
            if (error) { fail(new CaptureClientError('browser-error', error.message || 'The browser could not complete the operation.')); return; }
            settled = true; cleanup(); resolve(result);
        });
    } catch (error) { fail(error); }
});
const objectResult = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureClientError('invalid-response', 'The extension did not return a valid response.');
    return value as Record<string, unknown>;
};
const sendCommand = async (action: string, details: Record<string, unknown> = {}, options: CallbackOptions = {}): Promise<Record<string, unknown>> => {
    const chrome = getChrome();
    const result = objectResult(await callbackResult<unknown>(chrome, done => chrome.runtime.sendMessage({ type: 'json-tool-capture', action, ...details }, done), options));
    if (result.ok !== true) throw new CaptureClientError(typeof result.code === 'string' ? result.code : 'operation-failed', typeof result.error === 'string' ? result.error : 'The extension could not complete the operation.');
    return result;
};
const parseStatus = (value: Record<string, unknown>): CaptureStatus => {
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.origins) || value.origins.some(origin => typeof origin !== 'string')
        || !Number.isSafeInteger(value.limitBytes) || Number(value.limitBytes) <= 0 || !Number.isSafeInteger(value.maxChunkChars) || Number(value.maxChunkChars) <= 0) {
        throw new CaptureClientError('invalid-response', 'The extension returned invalid capture settings.');
    }
    return { enabled: value.enabled, origins: [...value.origins] as string[], limitBytes: Number(value.limitBytes), maxChunkChars: Number(value.maxChunkChars) };
};
export const getCaptureStatus = async (): Promise<CaptureStatus> => parseStatus(await sendCommand('status'));

/** Website access is confirmed by the browser at installation; the switch only controls capture. */
export const setCaptureEnabled = async (enabled: boolean): Promise<CaptureStatus> => {
    if (typeof enabled !== 'boolean') throw new CaptureClientError('invalid-setting', 'Capture must be enabled or disabled.');
    return parseStatus(await sendCommand(enabled ? 'enable' : 'disable'));
};

const ensureNotAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new DOMException('Import was cancelled.', 'AbortError');
};
export const readImport = async (id: string, options: ReadImportOptions = {}): Promise<CapturedImport> => {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new CaptureClientError('invalid-id', 'Invalid import identifier.');
    const parts: string[] = [];
    let offset = 0;
    let total: number | undefined;
    let sourceDisplayUrl = '';
    let createdAt = 0;
    let receivedBytes = 0;
    let pendingHighSurrogate = '';
    const encoder = new TextEncoder();
    while (true) {
        ensureNotAborted(options.signal);
        const part = await sendCommand('read', { id, offset }, options);
        ensureNotAborted(options.signal);
        if (typeof part.text !== 'string' || part.text.length > CAPTURE_MAX_CHUNK_CHARS || !Number.isSafeInteger(part.totalChars)
            || Number(part.totalChars) < 0 || Number(part.totalChars) > CAPTURE_LIMIT_BYTES || !Number.isSafeInteger(part.nextOffset)
            || part.nextOffset !== offset + part.text.length || typeof part.done !== 'boolean' || typeof part.sourceDisplayUrl !== 'string'
            || !Number.isFinite(part.createdAt) || Number(part.createdAt) <= 0) {
            throw new CaptureClientError('invalid-response', 'The extension returned an invalid import chunk.');
        }
        if (total === undefined) {
            total = Number(part.totalChars); sourceDisplayUrl = part.sourceDisplayUrl; createdAt = Number(part.createdAt);
            let url: URL;
            try { url = new URL(sourceDisplayUrl); } catch { throw new CaptureClientError('invalid-response', 'The extension returned an invalid source URL.'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CaptureClientError('invalid-response', 'The extension returned an invalid source URL.');
        } else if (part.totalChars !== total || part.sourceDisplayUrl !== sourceDisplayUrl || part.createdAt !== createdAt) {
            throw new CaptureClientError('invalid-response', 'The imported document changed during transfer.');
        }
        if (Number(part.nextOffset) > total || part.done !== (part.nextOffset === total) || (!part.done && !part.text.length)) throw new CaptureClientError('invalid-response', 'The extension returned an incomplete import chunk.');
        // A sender may split a surrogate pair; count UTF-8 as if the raw text were joined.
        let byteText = pendingHighSurrogate + part.text;
        const lastCodeUnit = byteText.charCodeAt(byteText.length - 1);
        pendingHighSurrogate = !part.done && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? byteText.slice(-1) : '';
        if (pendingHighSurrogate) byteText = byteText.slice(0, -1);
        receivedBytes += encoder.encode(byteText).length;
        if (receivedBytes > CAPTURE_LIMIT_BYTES) throw new CaptureClientError('too-large', 'The imported JSON response exceeds 20 MiB.');
        parts.push(part.text); offset = Number(part.nextOffset); options.onProgress?.(offset, total);
        if (part.done) return { text: parts.join(''), sourceDisplayUrl, createdAt };
    }
};
export const ackImport = async (id: string): Promise<void> => { await sendCommand('ack', { id }); };
export const discardImport = async (id: string): Promise<void> => { await sendCommand('discard', { id }); };
export const returnToSource = async (id: string): Promise<void> => { await sendCommand('return-source', { id }); };

export const captureErrorMessage = (error: unknown, locale: 'zh' | 'en'): string => {
    const code = error instanceof CaptureClientError ? error.code : '';
    if (locale === 'en') return error instanceof Error ? error.message : 'The operation could not be completed. Please try again.';
    const messages: Record<string, string> = {
        unavailable: '请在已安装的浏览器插件中使用此功能。',
        'invalid-response': '插件返回的数据不完整，请重试或重新加载插件。',
        'invalid-id': '导入标识无效，请从 JSON 响应页面重新打开。',
        'browser-error': '浏览器未能完成操作，请重试或检查插件权限。',
        timeout: '插件响应超时，请重试。原文尚未确认导入，不会因此被删除。',
        'invalid-timeout': '导入等待时间设置无效，请重新打开插件。',
        'too-large': '响应超过 20 MiB 的自动导入上限，请保存原文后使用文件导入。',
        PERMISSION: '浏览器尚未允许网站访问，请在扩展管理页面检查网站访问设置。',
        'invalid-setting': '自动打开 JSON 响应的开关值无效，请重新打开设置。',
        NOT_CONFIGURED: '当前插件尚未启用网页接收所需权限，本地编辑功能不受影响。',
        SOURCE: '该导入不属于当前页面，或原响应页面已发生跳转，请从原页面重试。',
        EXPIRED: '该响应已导入或临时记录已过期，请从原响应页面重新打开。',
        TOO_LARGE: '响应超过 20 MiB 的自动导入上限，请保存原文后使用文件导入。',
        STORAGE: '本地响应记录不完整，请从原响应页面重新打开。',
        DISABLED: '自动接收已停用，或该站点的访问授权已被撤销。',
        SIZE: '响应传输不完整，请从原响应页面重新打开。',
    };
    return messages[code] ?? (error instanceof Error ? `操作失败：${error.message}` : '操作未完成，请重试。');
};
