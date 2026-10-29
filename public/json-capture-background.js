import {
    CAPTURE_TYPE, CAPTURE_LIMIT_BYTES, CAPTURE_CHUNK_CHARS, CAPTURE_TTL_MS,
    CAPTURE_UPLOAD_TTL_MS, CAPTURE_SETTINGS_KEY, CAPTURE_SCRIPT_ID,
    normalizeJsonMime, isHttpUrl, displaySource, isTicketId, extensionPage, captureError,
} from './json-capture-core.js';

const TRANSIENT_KEY = 'json-tool-capture-transient-v1';
const withoutHash = value => { const url = new URL(value); url.hash = ''; return url.href; };
const webOriginPatterns = value => {
    if (value === '<all_urls>') return ['http://*/*', 'https://*/*'];
    const match = typeof value === 'string' && /^(\*|https?):\/\/([^/]+)\/\*$/.exec(value);
    if (!match) return [];
    return (match[1] === '*' ? ['http', 'https'] : [match[1]]).map(scheme => `${scheme}://${match[2]}/*`);
};
const originPattern = value => { const url = new URL(value); return `${url.protocol}//${url.hostname}/*`; };

export function createCaptureController({ chrome: api, store, now = Date.now, randomId = () => crypto.randomUUID() }) {
    let queue = Promise.resolve();
    const serialized = task => {
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result;
    };
    async function configuration() {
        const value = (await api.storage.local.get(CAPTURE_SETTINGS_KEY))[CAPTURE_SETTINGS_KEY];
        // Absence or invalid legacy values use the default; preserve an explicit user opt-out.
        return { enabled: value?.enabled !== false };
    }
    async function grants() {
        const result = await api.permissions.getAll();
        // Normalize Chrome's combined scheme grants without registering non-web documents.
        return [...new Set((result.origins ?? []).flatMap(webOriginPatterns))].sort();
    }
    async function state() {
        const [config, origins] = await Promise.all([configuration(), grants()]);
        return { enabled: config.enabled && origins.length > 0, origins, limitBytes: CAPTURE_LIMIT_BYTES, maxChunkChars: CAPTURE_CHUNK_CHARS };
    }
    async function synchronize() {
        const current = await state();
        const registered = await api.scripting.getRegisteredContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
        const spec = { id: CAPTURE_SCRIPT_ID, matches: current.origins, js: ['json-capture-content.js'], runAt: 'document_end', allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' };
        const expected = current.enabled;
        const existing = registered[0];
        const matches = existing && JSON.stringify([...existing.matches].sort()) === JSON.stringify(spec.matches)
            && JSON.stringify(existing.js) === JSON.stringify(spec.js) && existing.runAt === spec.runAt;
        if (existing && (!expected || !matches)) await api.scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
        if (expected && !matches) await api.scripting.registerContentScripts([spec]);
        await store.cleanup(now());
        return current;
    }
    async function transient() { return (await api.storage.session.get(TRANSIENT_KEY))[TRANSIENT_KEY] ?? { manual: {}, skips: {} }; }
    const saveTransient = value => api.storage.session.set({ [TRANSIENT_KEY]: value });
    async function allowedAuto(url) {
        return (await configuration()).enabled && api.permissions.contains({ origins: [originPattern(url)] });
    }
    function validateDocument(sender) {
        if (sender?.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0
            || !isHttpUrl(sender.url) || typeof sender.documentId !== 'string' || !sender.documentId
            || (sender.documentLifecycle && sender.documentLifecycle !== 'active'))
            throw captureError('SOURCE', 'The source JSON document is no longer active.');
    }
    function validateTicketOwner(ticket, sender) {
        validateDocument(sender);
        if (!ticket || ticket.tabId !== sender.tab.id || ticket.documentId !== sender.documentId
            || withoutHash(ticket.sourceUrl) !== withoutHash(sender.url))
            throw captureError('SOURCE', 'This JSON import belongs to a different document.');
    }
    async function validateUpload(message, sender, checkPermission = true) {
        if (!isTicketId(message.id) || !isTicketId(message.token)) throw captureError('SOURCE', 'Invalid JSON import.');
        const ticket = await store.get(message.id);
        validateTicketOwner(ticket, sender);
        if (ticket.token !== message.token || ticket.stage !== 'uploading' || ticket.expiresAt <= now())
            throw captureError('EXPIRED', 'JSON import expired. Please retry from the original page.');
        if (checkPermission && ticket.mode === 'auto' && !await allowedAuto(sender.url))
            throw captureError('DISABLED', 'Automatic JSON import was disabled or its site permission was removed.');
        return ticket;
    }
    async function pageTicket(message, sender) {
        if (!extensionPage(sender, api) || !Number.isInteger(sender.tab?.id) || !isTicketId(message.id))
            throw captureError('SOURCE', 'This operation is only available in the imported tool tab.');
        const ticket = await store.get(message.id);
        if (!ticket || !['auto', 'manual'].includes(ticket.mode) || ticket.tabId !== sender.tab.id || ticket.expiresAt <= now())
            throw captureError('EXPIRED', 'JSON import expired or was removed. Please reopen the original response.');
        return ticket;
    }
    async function badge(tabId, error) {
        try {
            await api.action.setBadgeText({ tabId, text: error ? '!' : '' });
            if (error) await api.action.setBadgeBackgroundColor({ tabId, color: '#d97706' });
            await api.action.setTitle({ tabId, title: error ? `JSON 工具箱 / JSON Toolbox: ${error}` : '打开 JSON 工具箱 / Open JSON Toolbox' });
        } catch { /* The source tab may have closed. */ }
    }
    async function dispatch(message, sender) {
        if (message?.type !== CAPTURE_TYPE) return undefined;
        if (['status', 'enable', 'disable'].includes(message.action)) {
            if (!extensionPage(sender, api)) throw captureError('SOURCE', 'Settings are only available in JSON Toolbox.');
            if (message.action === 'enable') {
                if (!(await grants()).length) throw captureError('PERMISSION', 'Website access is unavailable. Check the extension site access in browser settings.');
                await api.storage.local.set({ [CAPTURE_SETTINGS_KEY]: { enabled: true } });
            } else if (message.action === 'disable') {
                await api.storage.local.set({ [CAPTURE_SETTINGS_KEY]: { enabled: false } });
            }
            return { ok: true, ...await synchronize() };
        }
        if (message.action === 'begin') {
            validateDocument(sender);
            if (!normalizeJsonMime(message.mimeType)) throw captureError('MIME', 'This page is not a JSON response document.');
            if (!Number.isSafeInteger(message.totalChars) || message.totalChars <= 0 || message.totalChars > CAPTURE_LIMIT_BYTES
                || !Number.isSafeInteger(message.totalBytes) || message.totalBytes <= 0 || message.totalBytes > CAPTURE_LIMIT_BYTES)
                throw captureError('TOO_LARGE', 'Automatic import supports JSON responses up to 20 MiB. Save the response and use file import for larger data.');
            const t = await transient();
            const key = String(sender.tab.id);
            const skip = t.skips[key];
            if (skip) {
                delete t.skips[key]; await saveTransient(t);
                if (skip.expiresAt > now() && withoutHash(skip.url) === withoutHash(sender.url) && !message.manualToken)
                    throw captureError('SKIP_ONCE', 'Original response view.');
            }
            const pendingManual = t.manual[key];
            const manual = typeof message.manualToken === 'string' && pendingManual?.token === message.manualToken
                && pendingManual.expiresAt > now() && withoutHash(pendingManual.url) === withoutHash(sender.url);
            if (message.manualToken && !manual) throw captureError('SOURCE', 'Manual import authorization expired. Click the extension icon to retry.');
            if (!manual && !await allowedAuto(sender.url)) throw captureError('DISABLED', 'Automatic JSON import is not enabled for this site.');
            if (manual) { delete t.manual[key]; await saveTransient(t); }
            const existing = await store.findByDocument?.(sender.tab.id, sender.documentId, now());
            if (existing) {
                // Returning through browser history may restore the same source document from BFCache.
                // A deliberate icon click may replace its abandoned ready ticket, never an active upload.
                if (manual && existing.stage === 'ready') await store.remove(existing.id);
                else throw captureError('BUSY', 'This JSON response is already being imported.');
            }
            const id = randomId(); const token = randomId();
            await store.create({ id, token, tabId: sender.tab.id, documentId: sender.documentId,
                sourceUrl: sender.url, sourceDisplayUrl: displaySource(sender.url), mimeType: normalizeJsonMime(message.mimeType),
                mode: manual ? 'manual' : 'auto', stage: 'uploading', createdAt: now(), expiresAt: now() + CAPTURE_UPLOAD_TTL_MS,
                totalChars: message.totalChars, totalBytes: message.totalBytes, receivedChars: 0, receivedBytes: 0, chunkSizes: [],
            }, now());
            await badge(sender.tab.id);
            return { ok: true, id, token, maxChunkChars: CAPTURE_CHUNK_CHARS };
        }
        if (message.action === 'chunk') {
            await validateUpload(message, sender);
            if (!Number.isSafeInteger(message.index) || message.index < 0 || typeof message.text !== 'string'
                || !message.text.length || message.text.length > CAPTURE_CHUNK_CHARS)
                throw captureError('SIZE', 'Invalid JSON import chunk.');
            await store.append(message.id, message.token, message.index, message.text, new TextEncoder().encode(message.text).length, now());
            return { ok: true };
        }
        if (message.action === 'abort') {
            await validateUpload(message, sender, false);
            await store.remove(message.id);
            return { ok: true };
        }
        if (message.action === 'commit') {
            const ticket = await validateUpload(message, sender);
            if (ticket.receivedChars !== ticket.totalChars || ticket.receivedBytes !== ticket.totalBytes)
                throw captureError('SIZE', 'JSON import did not receive the complete response.');
            const tab = await api.tabs.get(ticket.tabId);
            if (tab.pendingUrl || !isHttpUrl(tab.url) || withoutHash(tab.url) !== withoutHash(ticket.sourceUrl))
                throw captureError('SOURCE', 'The source tab navigated before import completed.');
            // A same-URL reload has a different documentId. URL equality alone is insufficient.
            const documents = await api.scripting.executeScript({
                target: { tabId: ticket.tabId, documentIds: [ticket.documentId] },
                func: () => ({ top: window.top === window, url: location.href, mime: document.contentType }),
            });
            const current = documents[0];
            if (documents.length !== 1 || current?.documentId !== ticket.documentId || current.frameId !== 0
                || !current.result?.top || !normalizeJsonMime(current.result?.mime)
                || withoutHash(current.result.url) !== withoutHash(ticket.sourceUrl))
                throw captureError('SOURCE', 'The source JSON document changed before import completed.');
            await store.update(ticket.id, { stage: 'ready', expiresAt: now() + CAPTURE_TTL_MS });
            try { await api.tabs.update(ticket.tabId, { url: api.runtime.getURL(`index.html?capture=${ticket.id}`) }); }
            catch (error) { await store.remove(ticket.id); throw error; }
            return { ok: true, id: ticket.id };
        }
        if (message.action === 'read') {
            const ticket = await pageTicket(message, sender);
            if (ticket.stage !== 'ready') throw captureError('EXPIRED', 'The imported response has already been consumed.');
            const offset = message.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > ticket.totalChars)
                throw captureError('SIZE', 'Invalid JSON import read position.');
            let start = 0; let index = 0;
            while (index < ticket.chunkSizes.length && start + ticket.chunkSizes[index] <= offset) start += ticket.chunkSizes[index++];
            const chunk = index < ticket.chunkSizes.length ? await store.read(ticket.id, index) : null;
            if (index < ticket.chunkSizes.length && (!chunk || typeof chunk.text !== 'string' || chunk.text.length !== ticket.chunkSizes[index]))
                throw captureError('STORAGE', 'Stored JSON response is incomplete. Please reopen the original response.');
            const text = chunk?.text.slice(offset - start) ?? '';
            const nextOffset = offset + text.length;
            return { ok: true, text, nextOffset, done: nextOffset === ticket.totalChars, totalChars: ticket.totalChars,
                sourceDisplayUrl: ticket.sourceDisplayUrl, createdAt: ticket.createdAt };
        }
        if (message.action === 'ack') {
            const ticket = await pageTicket(message, sender);
            if (!['ready', 'consumed'].includes(ticket.stage)) throw captureError('STATE', 'JSON response is not ready.');
            await store.consume(ticket.id);
            return { ok: true };
        }
        if (message.action === 'discard') {
            const ticket = await pageTicket(message, sender);
            await store.remove(ticket.id);
            return { ok: true };
        }
        if (message.action === 'return-source') {
            const ticket = await pageTicket(message, sender);
            if (!isHttpUrl(ticket.sourceUrl)) throw captureError('SOURCE', 'Original response URL is unavailable.');
            const t = await transient();
            t.skips[String(ticket.tabId)] = { url: ticket.sourceUrl, expiresAt: now() + 2 * 60 * 1000 };
            await saveTransient(t);
            await api.tabs.update(ticket.tabId, { url: ticket.sourceUrl });
            await store.remove(ticket.id);
            return { ok: true };
        }
        throw captureError('ACTION', 'Unsupported JSON import operation.');
    }
    return {
        handle: (message, sender) => serialized(async () => {
            try { return await dispatch(message, sender); }
            catch (error) {
                if (['begin', 'chunk', 'commit'].includes(message?.action) && sender?.id === api.runtime.id && Number.isInteger(sender.tab?.id)
                    && !['DISABLED', 'SKIP_ONCE', 'BUSY'].includes(error.code)) await badge(sender.tab.id, error.message);
                return { ok: false, code: typeof error.code === 'string' ? error.code : 'FAILED', error: error.message || 'JSON import failed.' };
            }
        }),
        synchronize: () => serialized(synchronize),
        removeTab: tabId => serialized(async () => {
            const t = await transient(); delete t.manual[String(tabId)]; delete t.skips[String(tabId)]; await saveTransient(t);
            await store.cleanup(now(), tabId);
        }),
        actionClicked: tab => serialized(async () => {
            if (!Number.isInteger(tab?.id) || !isHttpUrl(tab.url)) return api.tabs.create({ url: api.runtime.getURL('index.html') });
            try {
                const inspected = await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ mime: document.contentType, top: window.top === window }) });
                if (!inspected[0]?.result?.top || !normalizeJsonMime(inspected[0]?.result?.mime))
                    return api.tabs.create({ url: api.runtime.getURL('index.html') });
                const token = randomId();
                const t = await transient();
                t.manual[String(tab.id)] = { token, url: tab.url, expiresAt: now() + CAPTURE_UPLOAD_TTL_MS };
                await saveTransient(t);
                await api.scripting.executeScript({ target: { tabId: tab.id }, func: token => { globalThis.__JSON_TOOL_CAPTURE_REQUEST__ = { mode: 'manual', manualToken: token }; }, args: [token] });
                await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['json-capture-content.js'] });
            } catch (error) {
                await badge(tab.id, '无法读取此页面 / Cannot read this page. Open JSON Toolbox and use file import.');
                // A rapid successful automatic navigation also invalidates the activeTab injection.
                const current = await api.tabs.get(tab.id).catch(() => null);
                if (current?.url?.startsWith(api.runtime.getURL('index.html'))) return;
                await api.tabs.create({ url: api.runtime.getURL('index.html') });
            }
        }),
    };
}
