(() => {
    'use strict';
    const TYPE = 'json-tool-capture';
    const LIMIT = 20 * 1024 * 1024;
    const CHUNK = 65_536;
    const request = globalThis.__JSON_TOOL_CAPTURE_REQUEST__;
    delete globalThis.__JSON_TOOL_CAPTURE_REQUEST__;
    const manualToken = request?.mode === 'manual' && typeof request.manualToken === 'string' ? request.manualToken : undefined;
    const stateKey = '__JSON_TOOL_CAPTURE_STATE_V1__';
    if (globalThis[stateKey]?.busy || (globalThis[stateKey]?.completed && !manualToken)) return;
    if (window.top !== window || !['http:', 'https:'].includes(location.protocol)) return;
    const mime = String(document.contentType || '').split(';', 1)[0].trim().toLowerCase();
    if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mime)) return;
    const state = globalThis[stateKey] ?? (globalThis[stateKey] = { busy: false, completed: false });
    state.busy = true;
    const send = (details, timeout = 15_000) => new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return; settled = true; clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(Object.assign(new Error('JSON import timed out.'), { code: 'TIMEOUT' })), timeout);
        try {
            chrome.runtime.sendMessage({ type: TYPE, ...details }, response => {
                const lastError = chrome.runtime.lastError;
                if (lastError) finish(Object.assign(new Error(lastError.message || 'Import connection closed.'), { code: 'CONNECTION' }));
                else if (response?.ok !== true) finish(Object.assign(new Error(response?.error || 'JSON import failed.'), { code: response?.code || 'FAILED' }));
                else finish(null, response);
            });
        } catch (error) { finish(error); }
    });
    function notice(error) {
        if (['DISABLED', 'SKIP_ONCE'].includes(error?.code) || (error?.code === 'BUSY' && !manualToken)) return;
        const previous = document.getElementById('json-tool-capture-notice');
        previous?.remove();
        const aside = document.createElement('aside');
        aside.id = 'json-tool-capture-notice';
        aside.setAttribute('role', 'status');
        const root = aside.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:min(460px,calc(100vw - 32px));font:13px/1.6 system-ui,sans-serif;color:#333;background:#fff;border:1px solid #d9dfe8;border-radius:4px;box-shadow:0 4px 18px #0002;padding:12px 36px 12px 14px}p{margin:0;white-space:normal;overflow-wrap:anywhere}button{position:absolute;right:8px;top:6px;border:0;background:none;color:#666;font:20px system-ui;cursor:pointer}';
        const text = document.createElement('p');
        const zh = String(navigator.language || '').toLowerCase().startsWith('zh');
        text.textContent = zh ? 'JSON 工具箱未能自动导入，原响应仍保留。' : 'JSON Toolbox could not import this response. The original response is still available.';
        const detail = document.createElement('p');
        detail.textContent = error?.code === 'BUSY'
            ? (zh ? '已有响应正在导入，或待处理响应过多。请先完成或关闭其它导入标签页后重试。' : 'A response is already importing or too many imports are pending. Finish or close another imported tab and retry.')
            : error?.code === 'TOO_LARGE'
            ? (zh ? '自动导入上限为 20 MiB。请保存响应后通过工具中的文件上传导入。' : 'Automatic import supports up to 20 MiB. Save the response and import the file in the toolbox.')
            : (zh ? '可重试点击扩展图标，或复制原文后粘贴到工具中。' : 'Click the extension icon to retry, or copy the raw response into the toolbox.');
        const close = document.createElement('button');
        close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', zh ? '关闭提示' : 'Dismiss notice');
        close.addEventListener('click', () => aside.remove());
        root.append(style, text, detail, close); document.documentElement.append(aside);
    }
    const chunkEnd = (text, start, size) => {
        let end = Math.min(start + size, text.length);
        if (end < text.length && end > start && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF
            && text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end--;
        return end;
    };
    void (async () => {
        let upload;
        try {
            // Chrome's JSON document may contain formatting controls next to the raw PRE.
            const nodes = document.body?.querySelectorAll('pre');
            if (!nodes || nodes.length !== 1) throw Object.assign(new Error('Raw JSON response node is unavailable.'), { code: 'DOCUMENT' });
            const text = nodes[0].textContent;
            if (typeof text !== 'string' || !text.length) throw Object.assign(new Error('JSON response is empty.'), { code: 'DOCUMENT' });
            if (text.length > LIMIT) throw Object.assign(new Error('Response too large.'), { code: 'TOO_LARGE' });
            const encoder = new TextEncoder();
            let bytes = 0;
            for (let start = 0; start < text.length;) {
                const end = chunkEnd(text, start, CHUNK);
                bytes += encoder.encode(text.slice(start, end)).length;
                if (bytes > LIMIT) throw Object.assign(new Error('Response too large.'), { code: 'TOO_LARGE' });
                start = end;
            }
            upload = await send({ action: 'begin', totalChars: text.length, totalBytes: bytes, mimeType: mime, ...(manualToken ? { manualToken } : {}) });
            if (typeof upload.id !== 'string' || typeof upload.token !== 'string' || !Number.isSafeInteger(upload.maxChunkChars)
                || upload.maxChunkChars < 2 || upload.maxChunkChars > CHUNK) throw Object.assign(new Error('Invalid import configuration.'), { code: 'PROTOCOL' });
            let index = 0;
            for (let start = 0; start < text.length;) {
                const end = chunkEnd(text, start, upload.maxChunkChars);
                await send({ action: 'chunk', id: upload.id, token: upload.token, index: index++, text: text.slice(start, end) });
                start = end;
            }
            await send({ action: 'commit', id: upload.id, token: upload.token });
            state.completed = true;
        } catch (error) {
            if (upload?.id && upload?.token) {
                try { await send({ action: 'abort', id: upload.id, token: upload.token }, 2_000); } catch { /* Source tab may already have navigated. */ }
            }
            notice(error);
        } finally { state.busy = false; }
    })();
})();
