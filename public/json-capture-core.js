export const CAPTURE_TYPE = 'json-tool-capture';
export const CAPTURE_LIMIT_BYTES = 20 * 1024 * 1024;
export const CAPTURE_CHUNK_CHARS = 64 * 1024;
export const CAPTURE_TTL_MS = 30 * 60 * 1000;
export const CAPTURE_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const CAPTURE_MAX_PENDING = 4;
export const CAPTURE_SETTINGS_KEY = 'json-tool-capture-settings-v1';
export const CAPTURE_SCRIPT_ID = 'json-tool-json-document-capture-v1';

export function normalizeJsonMime(value) {
    const mime = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
    return /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mime) ? mime : null;
}
export function isHttpUrl(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
}
export function displaySource(value) {
    const url = new URL(value);
    return url.origin + url.pathname;
}
export function isTicketId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
export function extensionPage(sender, chromeApi) {
    try {
        const url = new URL(sender?.url); const own = new URL(chromeApi.runtime.getURL('index.html'));
        return sender?.id === chromeApi.runtime.id && url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
    } catch { return false; }
}
export function captureError(code, message = code) {
    return Object.assign(new Error(message), { code });
}
