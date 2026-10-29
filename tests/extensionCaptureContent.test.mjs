import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../public/json-capture-content.js', import.meta.url), 'utf8');
const CHUNK = 65_536;
function fixture({ text = '{"ok":true}', mime = 'application/json', url = 'https://example.com/data', top = true, preCount = 1, fail, manualToken } = {}) {
    const calls = []; const notices = []; const chunks = [];
    const node = tag => ({ tag, children: [], attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener() {}, append(...values) { this.children.push(...values); }, remove() { this.removed = true; },
        attachShadow() { this.shadow = node('shadow'); return this.shadow; } });
    const document = { contentType: mime, body: { querySelectorAll: value => { assert.equal(value, 'pre'); return Array.from({ length: preCount }, () => ({ textContent: text })); } },
        getElementById: id => notices.find(n => n.id === id && !n.removed), createElement: node,
        documentElement: { append(value) { notices.push(value); } } };
    Object.defineProperty(document.body, 'innerText', { get() { throw new Error('The complete body must not be used as the JSON source'); } });
    const window = {}; window.top = top ? window : {};
    const chrome = { runtime: { sendMessage(message, callback) {
        calls.push(message);
        const failure = fail?.(message);
        if (failure) return queueMicrotask(() => callback({ ok: false, ...failure }));
        if (message.action === 'chunk') chunks.push(message.text);
        const response = message.action === 'begin' ? { ok: true, id: '0da6b3e8-910f-404c-848c-159cd2297e18', token: '0da6b3e8-910f-404c-848c-159cd2297e19', maxChunkChars: CHUNK } : { ok: true };
        queueMicrotask(() => callback(response));
    } } };
    const context = { document, window, chrome, location: new URL(url), navigator: { language: 'zh-CN' }, TextEncoder, URL, console, setTimeout, clearTimeout };
    if (manualToken) context.__JSON_TOOL_CAPTURE_REQUEST__ = { mode: 'manual', manualToken };
    return { context, calls, notices, chunks, run() { runInNewContext(source, context); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('JSON reader extracts only raw PRE text and preserves original numeric and string spellings', async () => {
    const text = String.raw` {"id":9007199254740993,"n":-0,"price":2.00,"same":1,"same":2,"text":"\n\u4e2d\\"} ` + '\n';
    const f = fixture({ text, mime: 'Application/Problem+JSON; charset=utf-8' });
    f.run(); await settle();
    assert.equal(f.chunks.join(''), text);
    assert.equal(f.calls[0].mimeType, 'application/problem+json');
    assert.equal(f.calls[0].totalChars, text.length);
    assert.equal(f.calls[0].totalBytes, new TextEncoder().encode(text).length);
    assert.equal(f.calls.at(-1).action, 'commit'); assert.equal(f.notices.length, 0);
});
test('ordinary HTML, plain text, iframe and privileged documents never send capture messages', async () => {
    for (const options of [{ mime: 'text/html' }, { mime: 'text/plain' }, { top: false }, { url: 'file:///tmp/example.json' }, { url: 'chrome://extensions' }]) {
        const f = fixture(options); f.run(); await settle(); assert.deepEqual(f.calls, [], JSON.stringify(options));
    }
});
test('repeated injection cannot start a second upload, including a manual request during automatic capture', async () => {
    const f = fixture(); f.run(); f.context.__JSON_TOOL_CAPTURE_REQUEST__ = { mode: 'manual', manualToken: 'manual' }; f.run();
    await settle(); f.run(); await settle();
    assert.equal(f.calls.filter(m => m.action === 'begin').length, 1);
    assert.equal(f.calls.filter(m => m.action === 'commit').length, 1);
    assert.equal(f.context.__JSON_TOOL_CAPTURE_REQUEST__, undefined);
});
test('large Unicode responses use bounded ordered chunks without separating surrogate pairs', async () => {
    const text = 'a'.repeat(CHUNK - 1) + '😀' + '中文'.repeat(CHUNK) + String.raw`\n`;
    const f = fixture({ text, manualToken: 'manual-authorized-token' }); f.run(); await settle();
    const chunks = f.calls.filter(m => m.action === 'chunk');
    assert.ok(chunks.length > 2); assert.equal(f.chunks.join(''), text);
    assert.deepEqual(chunks.map(m => m.index), chunks.map((_, i) => i));
    assert.ok(chunks.every(m => m.text.length <= CHUNK));
    assert.equal(chunks.reduce((sum, m) => sum + new TextEncoder().encode(m.text).length, 0), f.calls[0].totalBytes);
    assert.equal(chunks[0].text.length, CHUNK - 1);
    assert.equal(f.calls[0].manualToken, 'manual-authorized-token');
});
test('UTF8 size limit leaves the source page intact and reports a visible notice before upload', async () => {
    const f = fixture({ text: '中'.repeat(Math.floor(20 * 1024 * 1024 / 3) + 1) }); f.run(); await settle();
    assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].attrs.role, 'status');
    assert.ok(f.notices[0].shadow.children.some(n => n.textContent?.includes('20 MiB')));
});
test('missing or ambiguous raw response nodes fail without importing UI controls as data', async () => {
    for (const preCount of [0, 2]) {
        const f = fixture({ preCount }); f.run(); await settle();
        assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 1);
    }
});
test('failed uploads abort their ticket and never commit partial data', async () => {
    const f = fixture({ text: 'a'.repeat(CHUNK + 1), fail: m => m.action === 'chunk' && m.index === 1 ? { code: 'STORAGE', error: 'Storage full' } : null });
    f.run(); await settle();
    assert.equal(f.calls.some(m => m.action === 'commit'), false);
    assert.equal(f.calls.at(-1).action, 'abort'); assert.equal(f.notices.length, 1);
    assert.equal(f.context.__JSON_TOOL_CAPTURE_STATE_V1__.busy, false);
});
test('disabled capture and the return-to-source skip leave JSON untouched without warning spam', async () => {
    for (const code of ['DISABLED', 'SKIP_ONCE', 'BUSY']) {
        const f = fixture({ fail: () => ({ code, error: code }) }); f.run(); await settle();
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'begin'); assert.equal(f.notices.length, 0);
    }
});

test('a manual icon request can retry a completed document restored from browser history', async () => {
    const f = fixture(); f.run(); await settle();
    assert.equal(f.calls.filter(m => m.action === 'commit').length, 1);
    f.context.__JSON_TOOL_CAPTURE_REQUEST__ = { mode: 'manual', manualToken: 'new-explicit-click' };
    f.run(); await settle();
    assert.equal(f.calls.filter(m => m.action === 'commit').length, 2);
    assert.equal(f.calls.filter(m => m.action === 'begin').at(-1).manualToken, 'new-explicit-click');
});

test('a stalled background reply times out and releases the document for retry', async () => {
    const f = fixture(); const timers = new Map(); let next = 0;
    f.context.setTimeout = fn => { timers.set(++next, fn); return next; };
    f.context.clearTimeout = id => timers.delete(id);
    const send = f.context.chrome.runtime.sendMessage;
    f.context.chrome.runtime.sendMessage = () => {};
    f.run(); await settle(); assert.equal(f.context.__JSON_TOOL_CAPTURE_STATE_V1__.busy, true);
    [...timers.values()][0](); await settle();
    assert.equal(f.context.__JSON_TOOL_CAPTURE_STATE_V1__.busy, false); assert.equal(f.notices.length, 1); assert.equal(timers.size, 0);
    f.context.chrome.runtime.sendMessage = send; f.run(); await settle();
    assert.equal(f.calls.at(-1).action, 'commit'); assert.equal(timers.size, 0);
});
test('a deliberate manual click reports a pending-import budget failure instead of silently doing nothing', async () => {
    const f = fixture({ manualToken: 'explicit', fail: () => ({ code: 'BUSY', error: 'Pending limit' }) }); f.run(); await settle();
    assert.equal(f.notices.length, 1); assert.ok(f.notices[0].shadow.children.some(n => n.textContent?.includes('待处理响应')));
});
