import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createCaptureController } from '../public/json-capture-background.js';
import { CAPTURE_TYPE, CAPTURE_SETTINGS_KEY, CAPTURE_SCRIPT_ID, CAPTURE_LIMIT_BYTES } from '../public/json-capture-core.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
function memoryStore() {
    const tickets = new Map(); const chunks = new Map();
    return { tickets, chunks,
        async get(id) { return clone(tickets.get(id)); },
        async findByDocument(tabId, documentId, now) { return clone([...tickets.values()].find(t => t.tabId === tabId && t.documentId === documentId && t.expiresAt > now && t.stage !== 'consumed')); },
        async create(ticket) { tickets.set(ticket.id, clone(ticket)); },
        async append(id, token, index, text, bytes, now) {
            const t = tickets.get(id);
            if (!t || t.token !== token || t.stage !== 'uploading' || t.expiresAt <= now) throw Object.assign(new Error('Expired'), { code: 'EXPIRED' });
            if (index !== t.chunkSizes.length) throw Object.assign(new Error('Sequence'), { code: 'SEQUENCE' });
            if (t.receivedChars + text.length > t.totalChars || t.receivedBytes + bytes > t.totalBytes) throw Object.assign(new Error('Size'), { code: 'SIZE' });
            chunks.set(`${id}:${index}`, { text }); t.chunkSizes.push(text.length); t.receivedChars += text.length; t.receivedBytes += bytes;
        },
        async update(id, update) { Object.assign(tickets.get(id), clone(update)); },
        async read(id, index) { return clone(chunks.get(`${id}:${index}`)); },
        async consume(id) { const t = tickets.get(id); t.stage = 'consumed'; t.chunkSizes = []; delete t.token; for (const key of chunks.keys()) if (key.startsWith(id + ':')) chunks.delete(key); },
        async remove(id) { tickets.delete(id); for (const key of chunks.keys()) if (key.startsWith(id + ':')) chunks.delete(key); },
        async cleanup(now, tabId) { for (const t of tickets.values()) if (t.expiresAt <= now || t.tabId === tabId) await this.remove(t.id); },
    };
}
function fixture({ enabled = true, origins = ['https://example.com/*'] } = {}) {
    let sequence = 0; let time = 1_700_000_000_000;
    const updates = []; const created = []; const scripts = []; const badges = []; const registered = [];
    const local = { [CAPTURE_SETTINGS_KEY]: { enabled } }; const session = {};
    const tabs = new Map([[101, { id: 101, url: 'https://example.com/orders?token=secret', documentId: 'document-a', mime: 'application/json' }]]);
    const area = values => ({ async get(key) { return { [key]: clone(values[key]) }; }, async set(value) { Object.assign(values, clone(value)); } });
    const api = { runtime: { id: 'test-extension', getURL: value => 'chrome-extension://test-extension/' + value },
        storage: { local: area(local), session: area(session) },
        permissions: { async getAll() { return { origins }; }, async contains(value) {
            scripts.push({ permissionCheck: value });
            return value.origins.every(v => origins.includes(v) || origins.includes('<all_urls>') || origins.includes('*://*/*')
                || origins.includes(v.replace(/^https?:/, '*:')) || origins.includes(v.startsWith('https:') ? 'https://*/*' : 'http://*/*'));
        } },
        scripting: { async getRegisteredContentScripts() { return clone(registered); },
            async unregisterContentScripts() { registered.length = 0; }, async registerContentScripts(values) { registered.push(...clone(values)); },
            async executeScript(details) { scripts.push(details); const tab = tabs.get(details.target.tabId);
                if (details.target.documentIds && !details.target.documentIds.includes(tab.documentId)) return [];
                return [{ frameId: 0, documentId: tab.documentId, result: { top: true, url: tab.url, mime: tab.mime } }];
            } },
        tabs: { async get(id) { return clone(tabs.get(id)); }, async update(id, value) { updates.push({ id, ...value }); Object.assign(tabs.get(id), value); return clone(tabs.get(id)); },
            async create(value) { created.push(value); return value; } },
        action: { async setBadgeText(value) { badges.push(value); }, async setBadgeBackgroundColor() {}, async setTitle() {} },
    };
    const store = memoryStore();
    const controller = createCaptureController({ chrome: api, store, now: () => time, randomId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
    const sender = (tabId = 101) => { const tab = tabs.get(tabId); return { id: api.runtime.id, tab: { id: tabId }, frameId: 0, documentId: tab.documentId, documentLifecycle: 'active', url: tab.url }; };
    const tool = (tabId = 101) => ({ id: api.runtime.id, tab: { id: tabId }, frameId: 0, url: api.runtime.getURL('index.html') });
    const call = (action, details = {}, from = sender()) => controller.handle({ type: CAPTURE_TYPE, action, ...details }, from);
    return { api, store, controller, tabs, local, session, updates, created, scripts, badges, registered, sender, tool, call,
        advance(ms) { time += ms; }, setOrigins(value) { origins = value; } };
}
const bytes = text => new TextEncoder().encode(text).length;
async function begin(f, text = '{"ok":true}', extra = {}, sender = f.sender()) {
    const result = await f.call('begin', { totalChars: text.length, totalBytes: bytes(text), mimeType: 'application/json', ...extra }, sender);
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
async function upload(f, text = '{"ok":true}', tabId = 101) {
    const sender = f.sender(tabId); const ticket = await begin(f, text, {}, sender);
    assert.equal((await f.call('chunk', { ...ticket, index: 0, text }, sender)).ok, true);
    assert.equal((await f.call('commit', ticket, sender)).ok, true); return ticket;
}

test('an explicit off setting stays off until enabled and registers only available HTTP(S) sites', async () => {
    const f = fixture({ enabled: false }); assert.equal((await f.controller.synchronize()).enabled, false); assert.deepEqual(f.registered, []);
    assert.equal((await f.call('begin', { totalChars: 2, totalBytes: 2, mimeType: 'application/json' })).code, 'DISABLED');
    const enabled = await f.call('enable', {}, f.tool()); assert.equal(enabled.enabled, true);
    assert.equal(f.registered[0].id, CAPTURE_SCRIPT_ID); assert.deepEqual(f.registered[0].matches, ['https://example.com/*']);
    assert.deepEqual(f.registered[0].js, ['json-capture-content.js']); assert.equal(f.registered[0].allFrames, false);
    f.setOrigins([]); await f.controller.synchronize(); assert.deepEqual(f.registered, []);
});
test('only extension settings pages can enable or disable capture', async () => {
    const f = fixture({ enabled: false });
    assert.equal((await f.call('enable')).code, 'SOURCE');
    assert.equal(f.local[CAPTURE_SETTINGS_KEY].enabled, false);
    assert.equal((await f.call('enable', {}, { ...f.tool(), id: 'other-extension' })).code, 'SOURCE');
});
test('raw import uses a private ticket, same-tab navigation, bounded reads, and acknowledgement cleanup', async () => {
    const f = fixture(); const text = String.raw` {"id":9007199254740993,"n":-0,"price":2.00,"text":"\n\u4e2d"} `;
    const ticket = await upload(f, text);
    assert.deepEqual(f.updates, [{ id: 101, url: `chrome-extension://test-extension/index.html?capture=${ticket.id}` }]);
    assert.equal(f.created.length, 0);
    const data = await f.call('read', { id: ticket.id, offset: 0 }, f.tool());
    assert.equal(data.text, text); assert.equal(data.done, true); assert.equal(data.sourceDisplayUrl, 'https://example.com/orders');
    assert.equal((await f.call('ack', { id: ticket.id }, f.tool())).ok, true);
    assert.equal(f.store.chunks.size, 0); assert.equal(f.store.tickets.get(ticket.id).stage, 'consumed');
    assert.equal((await f.call('read', { id: ticket.id }, f.tool())).code, 'EXPIRED');
});
test('same-URL reload and pending navigation reject the old document before redirecting', async () => {
    for (const mutate of [tab => { tab.documentId = 'replacement-document'; }, tab => { tab.pendingUrl = 'https://example.com/orders?token=secret'; }]) {
        const f = fixture(); const sender = f.sender(); const ticket = await begin(f);
        await f.call('chunk', { ...ticket, index: 0, text: '{"ok":true}' }, sender);
        mutate(f.tabs.get(101));
        assert.equal((await f.call('commit', ticket, sender)).code, 'SOURCE'); assert.equal(f.updates.length, 0);
    }
});
test('foreign documents, frames, extension IDs and tokens cannot write or read another import', async () => {
    const f = fixture(); const sender = f.sender(); const ticket = await begin(f);
    for (const altered of [{ ...sender, documentId: 'different' }, { ...sender, frameId: 1 }, { ...sender, id: 'foreign' }, { ...sender, documentLifecycle: 'cached' }]) {
        assert.equal((await f.call('chunk', { ...ticket, index: 0, text: '{"ok":true}' }, altered)).code, 'SOURCE');
    }
    assert.equal((await f.call('chunk', { ...ticket, token: '00000000-0000-4000-8000-000000009999', index: 0, text: '{"ok":true}' })).code, 'EXPIRED');
    assert.equal((await f.call('read', ticket, sender)).code, 'SOURCE');
    assert.equal((await f.call('read', ticket, f.tool(202))).code, 'EXPIRED');
    assert.equal(f.store.chunks.size, 0);
});
test('disabled capture or revoked permissions reject an already started automatic transfer', async () => {
    for (const change of [async f => { await f.call('disable', {}, f.tool()); }, async f => { f.setOrigins([]); }]) {
        const f = fixture(); const ticket = await begin(f); await change(f);
        assert.equal((await f.call('chunk', { ...ticket, index: 0, text: '{"ok":true}' })).code, 'DISABLED'); assert.equal(f.updates.length, 0);
    }
});
test('incomplete, reordered, oversized and expired transfers cannot be committed', async () => {
    const f = fixture(); const ticket = await begin(f);
    assert.equal((await f.call('commit', ticket)).code, 'SIZE');
    assert.equal((await f.call('chunk', { ...ticket, index: 1, text: 'x' })).code, 'SEQUENCE');
    assert.equal((await f.call('chunk', { ...ticket, index: 0, text: 'x'.repeat(65_537) })).code, 'SIZE');
    f.advance(5 * 60 * 1000 + 1); assert.equal((await f.call('commit', ticket)).code, 'EXPIRED'); assert.equal(f.updates.length, 0);
    const tooBig = await f.call('begin', { totalChars: CAPTURE_LIMIT_BYTES + 1, totalBytes: CAPTURE_LIMIT_BYTES + 1, mimeType: 'application/json' }); assert.equal(tooBig.code, 'TOO_LARGE');
});
test('localhost access checks do not include the response port in the host permission pattern', async () => {
    const f = fixture({ origins: ['http://127.0.0.1/*'] }); f.tabs.get(101).url = 'http://127.0.0.1:3210/data';
    await begin(f); assert.deepEqual(f.scripts.find(x => x.permissionCheck).permissionCheck, { origins: ['http://127.0.0.1/*'] });
});
test('parallel JSON tabs retain separate imports and cannot consume each other', async () => {
    const f = fixture(); f.tabs.set(202, { id: 202, url: 'https://example.com/users', documentId: 'document-b', mime: 'application/json' });
    const [a, b] = await Promise.all([upload(f, '{"orders":1}', 101), upload(f, '{"users":2}', 202)]);
    assert.notEqual(a.id, b.id);
    assert.equal((await f.call('read', a, f.tool(101))).text, '{"orders":1}');
    assert.equal((await f.call('read', b, f.tool(202))).text, '{"users":2}');
    assert.equal((await f.call('ack', a, f.tool(202))).code, 'EXPIRED');
});
test('return-to-source works after ACK and skips exactly one automatic reload without losing the query', async () => {
    const f = fixture(); const sourceUrl = f.tabs.get(101).url; const ticket = await upload(f);
    await f.call('ack', ticket, f.tool()); assert.equal((await f.call('return-source', ticket, f.tool())).ok, true);
    assert.equal(f.tabs.get(101).url, sourceUrl); assert.equal(f.store.tickets.has(ticket.id), false);
    f.tabs.get(101).documentId = 'returned-document';
    const details = { totalChars: 2, totalBytes: 2, mimeType: 'application/json' };
    assert.equal((await f.call('begin', details)).code, 'SKIP_ONCE'); assert.equal((await f.call('begin', details)).ok, true);
});
test('pending import data survives worker-controller replacement and closed tabs are cleaned', async () => {
    const f = fixture(); const ticket = await upload(f);
    const restarted = createCaptureController({ chrome: f.api, store: f.store, now: () => 1_700_000_000_100 });
    const result = await restarted.handle({ type: CAPTURE_TYPE, action: 'read', id: ticket.id, offset: 0 }, f.tool());
    assert.equal(result.text, '{"ok":true}'); await restarted.removeTab(101); assert.equal(f.store.tickets.size, 0); assert.equal(f.store.chunks.size, 0);
});
test('manual icon capture uses a one-time token while an ordinary HTML page opens a blank workbench', async () => {
    const f = fixture({ enabled: false, origins: [] });
    await f.controller.actionClicked(clone(f.tabs.get(101)));
    const token = Object.values(f.session)[0].manual['101'].token;
    const ticket = await begin(f, '{"ok":true}', { manualToken: token });
    assert.equal(f.store.tickets.get(ticket.id).mode, 'manual');
    assert.equal((await f.call('begin', { totalChars: 2, totalBytes: 2, mimeType: 'application/json', manualToken: token })).code, 'SOURCE');
    f.tabs.get(101).mime = 'text/html'; await f.controller.actionClicked(clone(f.tabs.get(101)));
    assert.deepEqual(f.created, [{ url: 'chrome-extension://test-extension/index.html' }]);
});
test('unconfigured module background preserves ordinary action behavior without touching capture APIs', async () => {
    const bundle = await build({ entryPoints: ['public/background.js'], bundle: true, write: false, platform: 'browser', format: 'iife' });
    let clicked; let listener; const urls = [];
    const chrome = { runtime: { getManifest: () => ({ permissions: [] }), getURL: name => 'chrome-extension://test/' + name, onMessage: { addListener(fn) { listener = fn; } } },
        action: { onClicked: { addListener(fn) { clicked = fn; } } }, tabs: { create(value) { urls.push(value.url); return Promise.resolve(); } } };
    runInNewContext(bundle.outputFiles[0].text, { chrome, console }); clicked();
    assert.deepEqual(urls, ['chrome-extension://test/index.html']);
    let reply; listener({ type: CAPTURE_TYPE, action: 'status' }, {}, value => { reply = value; }); assert.equal(reply.code, 'NOT_CONFIGURED');
});

test('manual retry can replace an abandoned ready ticket after browser history restores its source document', async () => {
    const f = fixture(); const original = clone(f.tabs.get(101)); const ticket = await upload(f);
    Object.assign(f.tabs.get(101), original); await f.controller.actionClicked(clone(original));
    const token = Object.values(f.session)[0].manual['101'].token;
    const retry = await begin(f, '{"retry":true}', { manualToken: token });
    assert.notEqual(retry.id, ticket.id); assert.equal(f.store.tickets.has(ticket.id), false);
    assert.equal(f.store.tickets.get(retry.id).mode, 'manual');
});

test('simultaneous icon clicks keep both one-time authorizations without overwriting session state', async () => {
    const f = fixture({ enabled: false, origins: [] });
    f.tabs.set(202, { id: 202, url: 'https://example.com/users', documentId: 'document-b', mime: 'application/json' });
    await Promise.all([f.controller.actionClicked(clone(f.tabs.get(101))), f.controller.actionClicked(clone(f.tabs.get(202)))]);
    const transient = Object.values(f.session)[0]; assert.ok(transient.manual['101']); assert.ok(transient.manual['202']);
    const results = await Promise.all([begin(f, '{"first":1}', { manualToken: transient.manual['101'].token }, f.sender(101)),
        begin(f, '{"second":2}', { manualToken: transient.manual['202'].token }, f.sender(202))]);
    assert.notEqual(results[0].id, results[1].id);
});
test('return-to-source skip and another tab manual authorization cannot overwrite one another', async () => {
    const f = fixture(); const ticket = await upload(f); await f.call('ack', ticket, f.tool());
    f.tabs.set(202, { id: 202, url: 'https://example.com/users', documentId: 'document-b', mime: 'application/json' });
    await Promise.all([f.controller.actionClicked(clone(f.tabs.get(202))), f.call('return-source', ticket, f.tool(101))]);
    const transient = Object.values(f.session)[0]; assert.ok(transient.manual['202']); assert.ok(transient.skips['101']);
});


test('new installations and invalid legacy settings enable capture by default on available web sites', async () => {
    for (const stored of [undefined, null, {}, { enabled: 'false' }, { enabled: null }, { enabled: 0 }, false, 'invalid']) {
        const f = fixture({ origins: ['https://*/*', 'http://*/*'] });
        if (stored === undefined) delete f.local[CAPTURE_SETTINGS_KEY];
        else f.local[CAPTURE_SETTINGS_KEY] = stored;
        const result = await f.controller.synchronize();
        assert.equal(result.enabled, true, JSON.stringify(stored));
        assert.deepEqual(result.origins, ['http://*/*', 'https://*/*']);
        assert.deepEqual(f.registered[0].matches, ['http://*/*', 'https://*/*']);
        // Merely reading defaults must not create or overwrite the user's saved preference.
        assert.deepEqual(f.local[CAPTURE_SETTINGS_KEY], stored);
    }
});

test('combined browser web grants are normalized to HTTP(S), never file or internal schemes', async () => {
    for (const [origins, expected] of [
        [['*://*/*'], ['http://*/*', 'https://*/*']],
        [['*://example.com/*', 'https://example.com/*'], ['http://example.com/*', 'https://example.com/*']],
        [['<all_urls>'], ['http://*/*', 'https://*/*']],
        [['file:///*', 'chrome://settings/*', 'https://example.com/*'], ['https://example.com/*']],
    ]) {
        const f = fixture({ origins });
        delete f.local[CAPTURE_SETTINGS_KEY];
        const result = await f.controller.synchronize();
        assert.equal(result.enabled, true);
        assert.deepEqual(result.origins, expected);
        assert.deepEqual(f.registered[0].matches, expected);
        assert.equal((await begin(f)).ok, true);
    }
    const restricted = fixture({ origins: ['file:///*', 'chrome://settings/*'] });
    delete restricted.local[CAPTURE_SETTINGS_KEY];
    assert.equal((await restricted.controller.synchronize()).enabled, false);
    assert.deepEqual(restricted.registered, []);
});

test('switch state survives worker restart and turning off leaves install-time site access intact', async () => {
    const f = fixture({ origins: ['http://*/*', 'https://*/*'] });
    delete f.local[CAPTURE_SETTINGS_KEY];
    await f.controller.synchronize();
    const disabled = await f.call('disable', {}, f.tool());
    assert.equal(disabled.ok, true); assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.origins, ['http://*/*', 'https://*/*']);
    assert.deepEqual(f.registered, []);
    const restarted = createCaptureController({ chrome: f.api, store: f.store });
    assert.equal((await restarted.synchronize()).enabled, false);
    const enabled = await restarted.handle({ type: CAPTURE_TYPE, action: 'enable' }, f.tool());
    assert.equal(enabled.ok, true); assert.equal(enabled.enabled, true);
    assert.deepEqual(f.local[CAPTURE_SETTINGS_KEY], { enabled: true });
    const again = createCaptureController({ chrome: f.api, store: f.store });
    assert.equal((await again.synchronize()).enabled, true);
});

test('saving failures are returned as failures and never claim the switch changed', async () => {
    for (const enabled of [false, true]) {
        const f = fixture({ enabled, origins: ['http://*/*', 'https://*/*'] });
        await f.controller.synchronize();
        f.api.storage.local.set = async () => { throw new Error('storage is not writable'); };
        const result = await f.call(enabled ? 'disable' : 'enable', {}, f.tool());
        assert.equal(result.ok, false); assert.match(result.error, /storage is not writable/);
        assert.deepEqual(f.local[CAPTURE_SETTINGS_KEY], { enabled });
        assert.equal(f.registered.length, enabled ? 1 : 0);
    }
});

test('failed script registration is reported instead of claiming capture is active', async () => {
    const f = fixture({ enabled: false, origins: ['http://*/*', 'https://*/*'] });
    f.api.scripting.registerContentScripts = async () => { throw new Error('browser registration failed'); };
    const result = await f.call('enable', {}, f.tool());
    assert.equal(result.ok, false); assert.match(result.error, /browser registration failed/);
    assert.deepEqual(f.registered, []);
});

test('switch commands from several extension tabs persist the last queued setting', async () => {
    const f = fixture({ origins: ['http://*/*', 'https://*/*'] });
    await f.controller.synchronize();
    const replies = await Promise.all(['disable', 'enable', 'disable'].map(action => f.call(action, {}, f.tool())));
    assert.deepEqual(replies.map(reply => reply.enabled), [false, true, false]);
    assert.ok(replies.every(reply => reply.ok));
    assert.deepEqual(f.local[CAPTURE_SETTINGS_KEY], { enabled: false });
    assert.deepEqual(f.registered, []);
    assert.deepEqual((await f.api.permissions.getAll()).origins, ['http://*/*', 'https://*/*']);
});


test('editor operations reject unsupported ticket modes without reading, consuming or navigating', async () => {
    for (const mode of [undefined, 'obsolete-import-mode']) {
        const f = fixture(); const ticket = await upload(f);
        f.store.tickets.get(ticket.id).mode = mode;
        const navigations = f.updates.length;
        for (const action of ['read', 'ack', 'discard', 'return-source']) {
            const result = await f.call(action, { id: ticket.id }, f.tool());
            assert.equal(result.code, 'EXPIRED');
        }
        assert.equal(f.updates.length, navigations);
        assert.equal(f.store.tickets.get(ticket.id).stage, 'ready');
    }
});
