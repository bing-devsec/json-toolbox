import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CAPTURE_LIMIT_BYTES, CAPTURE_MAX_CHUNK_CHARS, CaptureClientError, ackImport, captureErrorMessage,
    setCaptureEnabled, getCaptureStatus, isCaptureAvailable, readImport, returnToSource,
} from '../src/extension/captureClient.ts';

function mockChrome(overrides = {}) {
    const calls = [];
    const state = { enabled: true, origins: ['http://*/*', 'https://*/*'], limitBytes: CAPTURE_LIMIT_BYTES, maxChunkChars: CAPTURE_MAX_CHUNK_CHARS };
    const api = {
        runtime: {
            id: 'test-extension',
            sendMessage(message, callback) {
                calls.push(['message', message]);
                if (message.action === 'enable') state.enabled = true;
                if (message.action === 'disable') state.enabled = false;
                callback({ ok: true, ...state });
            },
        },
    };
    Object.assign(api.runtime, overrides.runtime);
    return { api, calls, state };
}
async function withChrome(fixture, action) {
    const old = globalThis.chrome;
    globalThis.chrome = fixture.api;
    try { await action(fixture); }
    finally { if (old === undefined) delete globalThis.chrome; else globalThis.chrome = old; }
}

test('capture bridge reads enabled status without a runtime permissions API or extra prompt', async () => {
    await withChrome(mockChrome(), async ({ calls }) => {
        assert.equal(isCaptureAvailable(), true);
        const state = await getCaptureStatus();
        assert.equal(state.enabled, true);
        assert.deepEqual(state.origins, ['http://*/*', 'https://*/*']);
        assert.deepEqual(calls.map(value => value[1].action), ['status']);
    });
});

test('general switch enables and disables capture without revoking install-time website access', async () => {
    const fixture = mockChrome();
    Object.defineProperty(fixture.api, 'permissions', { get() { throw new Error('Do not request or remove install-time permissions'); } });
    await withChrome(fixture, async ({ calls, state }) => {
        assert.equal((await setCaptureEnabled(false)).enabled, false);
        assert.equal(state.enabled, false);
        assert.deepEqual(state.origins, ['http://*/*', 'https://*/*']);
        assert.equal((await setCaptureEnabled(true)).enabled, true);
        assert.deepEqual(calls.map(value => value[1].action), ['disable', 'enable']);
    });
});

test('a failed switch change surfaces the backend error instead of claiming the desired state', async () => {
    const fixture = mockChrome({ runtime: { sendMessage(_message, callback) { callback({ ok: false, code: 'PERMISSION', error: 'Website access is restricted' }); } } });
    await withChrome(fixture, async ({ state }) => {
        await assert.rejects(setCaptureEnabled(false), error => error.code === 'PERMISSION');
        assert.equal(state.enabled, true);
    });
});

test('invalid switch values fail locally without changing capture or prompting for permissions', async () => {
    await withChrome(mockChrome(), async ({ calls }) => {
        for (const value of [undefined, null, 'false', 0, 1, {}]) {
            await assert.rejects(setCaptureEnabled(value), error => error.code === 'invalid-setting');
        }
        assert.deepEqual(calls, []);
    });
});

function importFixture(text, alter = value => value) {
    const fixture = mockChrome();
    fixture.api.runtime.sendMessage = (message, callback) => {
        fixture.calls.push(['message', message]);
        if (message.action !== 'read') return callback({ ok: true });
        const chunk = text.slice(message.offset, message.offset + CAPTURE_MAX_CHUNK_CHARS);
        const nextOffset = message.offset + chunk.length;
        callback(alter({ ok: true, text: chunk, nextOffset, done: nextOffset === text.length, totalChars: text.length,
            sourceDisplayUrl: 'https://example.com/orders', createdAt: 123456789 }, message));
    };
    return fixture;
}
const importId = '0da6b3e8-910f-404c-848c-159cd2297e18';

test('chunked import preserves raw numeric literals, escaping, whitespace and split surrogate pairs', async () => {
    const prefix = '{"id":9007199254740993,"price":2.00,"negative":-0,"text":"';
    const text = prefix + 'a'.repeat(CAPTURE_MAX_CHUNK_CHARS - prefix.length - 1) + '😀' + String.raw`\n\u4e2d\"` + '"}\n';
    await withChrome(importFixture(text), async ({ calls }) => {
        const progress = [];
        const result = await readImport(importId, { onProgress: (...values) => progress.push(values) });
        assert.equal(result.text, text);
        assert.equal(result.sourceDisplayUrl, 'https://example.com/orders');
        assert.deepEqual(progress.at(-1), [text.length, text.length]);
        assert.equal(calls.length, 2);
        assert.equal(calls.every(call => call[1].action === 'read'), true, 'reading does not acknowledge or delete before editor import');
        await ackImport(importId);
        assert.equal(calls.at(-1)[1].action, 'ack');
        await returnToSource(importId);
        assert.deepEqual(calls.at(-1)[1], { type: 'json-tool-capture', action: 'return-source', id: importId });
    });
});

test('invalid import chunks cannot produce a partial document or an acknowledgement', async () => {
    for (const alter of [value => ({ ...value, nextOffset: 500 }), value => ({ ...value, done: false }),
        value => ({ ...value, totalChars: 999999999 }), value => ({ ...value, sourceDisplayUrl: 'https://example.com/orders?token=secret' })]) {
        await withChrome(importFixture('{"id":1}', alter), async ({ calls }) => {
            await assert.rejects(readImport(importId), error => error.code === 'invalid-response');
            assert.equal(calls.some(call => call[1].action === 'ack'), false);
        });
    }
});

test('import detects metadata changes and supports cancellation between chunks', async () => {
    const text = 'a'.repeat(CAPTURE_MAX_CHUNK_CHARS + 1);
    await withChrome(importFixture(text, (value, message) => ({ ...value, createdAt: message.offset ? 1 : value.createdAt })), async () => {
        await assert.rejects(readImport(importId), error => error.code === 'invalid-response');
    });
    await withChrome(importFixture(text), async ({ calls }) => {
        const controller = new AbortController();
        await assert.rejects(readImport(importId, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
        assert.equal(calls.length, 1);
    });
});

test('browser callback errors and malformed settings are surfaced without assuming success', async () => {
    const fixture = mockChrome();
    fixture.api.runtime.sendMessage = (_message, callback) => { fixture.api.runtime.lastError = { message: 'Extension context invalidated.' }; callback(undefined); delete fixture.api.runtime.lastError; };
    await withChrome(fixture, async () => {
        await assert.rejects(getCaptureStatus(), error => error.code === 'browser-error');
    });
    await withChrome(mockChrome({ runtime: { sendMessage(_message, callback) { callback({ ok: true, enabled: true, origins: ['https://example.com/*'] }); } } }), async () => {
        await assert.rejects(getCaptureStatus(), error => error.code === 'invalid-response');
    });
});

test('regular previews remain detectable and Chinese copy explains unavailable capture', async () => {
    const previous = globalThis.chrome; delete globalThis.chrome;
    try {
        assert.equal(isCaptureAvailable(), false);
        await assert.rejects(getCaptureStatus(), error => error.code === 'unavailable');
        assert.match(captureErrorMessage(new CaptureClientError('NOT_CONFIGURED', 'unavailable'), 'zh'), /本地编辑功能不受影响/);
    } finally { if (previous !== undefined) globalThis.chrome = previous; }
});


test('an in-flight read aborts immediately even when its browser callback never arrives', async () => {
    const fixture = mockChrome(); let lateCallback;
    fixture.api.runtime.sendMessage = (message, callback) => { fixture.calls.push(['message', message]); lateCallback = callback; };
    await withChrome(fixture, async ({ calls }) => {
        const controller = new AbortController();
        const pending = readImport(importId, { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        lateCallback({ ok: true, text: '{}', nextOffset: 2, totalChars: 2, done: true, sourceDisplayUrl: 'https://example.com/', createdAt: 1 });
        assert.equal(calls.length, 1);
        assert.equal(calls.some(call => call[1].action === 'ack'), false);
    });
});

test('a stalled read has a bounded timeout and never acknowledges an incomplete import', async () => {
    const fixture = mockChrome();
    fixture.api.runtime.sendMessage = message => { fixture.calls.push(['message', message]); };
    await withChrome(fixture, async ({ calls }) => {
        await assert.rejects(readImport(importId, { timeoutMs: 5 }), error => error.code === 'timeout');
        assert.equal(calls.length, 1);
        assert.match(captureErrorMessage(new CaptureClientError('timeout', 'timeout'), 'zh'), /响应超时/);
    });
});

test('an already-cancelled import sends no browser message and invalid timeout values fail locally', async () => {
    await withChrome(importFixture('{}'), async ({ calls }) => {
        const controller = new AbortController(); controller.abort();
        await assert.rejects(readImport(importId, { signal: controller.signal }), { name: 'AbortError' });
        for (const timeoutMs of [0, -1, 0.5, Infinity, 120001]) {
            await assert.rejects(readImport(importId, { timeoutMs }), error => error.code === 'invalid-timeout');
        }
        assert.equal(calls.length, 0);
    });
});

test('UTF-8 byte limits reject oversized multibyte text even when character counts fit', async () => {
    const text = '中'.repeat(Math.floor(CAPTURE_LIMIT_BYTES / 3) + 1);
    assert.ok(text.length < CAPTURE_LIMIT_BYTES);
    await withChrome(importFixture(text), async ({ calls }) => {
        await assert.rejects(readImport(importId), error => error.code === 'too-large');
        assert.equal(calls.some(call => call[1].action === 'ack'), false);
    });
});

test('a response exactly at the UTF-8 limit is accepted without altering the raw document', async () => {
    const text = '中'.repeat(Math.floor(CAPTURE_LIMIT_BYTES / 3)) + 'ab';
    assert.equal(new TextEncoder().encode(text).length, CAPTURE_LIMIT_BYTES);
    await withChrome(importFixture(text), async () => {
        const result = await readImport(importId);
        assert.equal(result.text, text);
    });
});
