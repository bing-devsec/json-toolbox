import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createCaptureStore } from '../public/json-capture-store.js';
import { CAPTURE_LIMIT_BYTES } from '../public/json-capture-core.js';

// Minimal IndexedDB request/transaction implementation, independent of import-ticket logic.
// It commits only on transaction completion and rolls back writes on abort.
function indexedDbFixture() {
    let tables = new Map(); let upgraded = false; let closed = 0;
    const copy = value => value === undefined ? undefined : structuredClone(value);
    const factory = { open() {
        const request = {};
        queueMicrotask(() => {
            const db = { createObjectStore(name, options) {
                tables.set(name, { keyPath: options.keyPath, values: new Map() });
                return { createIndex() {} };
            }, close() { closed++; }, transaction(names, mode) {
                const snapshots = new Map(names.map(name => [name, { keyPath: tables.get(name).keyPath, values: copy(tables.get(name).values) }]));
                let pending = 0; let finished = false;
                const tx = { error: null, abort() {
                    if (finished) throw new Error('Transaction inactive'); finished = true;
                    queueMicrotask(() => tx.onabort?.());
                }, objectStore(name) {
                    const table = snapshots.get(name);
                    const run = operation => {
                        if (finished) throw new Error('Transaction inactive');
                        const req = {}; pending++;
                        queueMicrotask(() => {
                            if (!finished) {
                                try { req.result = copy(operation()); req.onsuccess?.(); }
                                catch (error) { req.error = error; tx.error = error; req.onerror?.(); tx.abort(); }
                            }
                            pending--; check();
                        });
                        return req;
                    };
                    return {
                        get(key) { return run(() => table.values.get(key)); },
                        getAll() { return run(() => [...table.values.values()]); },
                        put(value) { return run(() => table.values.set(value[table.keyPath], copy(value))); },
                        add(value) { return run(() => { if (table.values.has(value[table.keyPath])) throw new Error('ConstraintError'); table.values.set(value[table.keyPath], copy(value)); }); },
                        delete(key) { return run(() => table.values.delete(key)); },
                        index(indexName) { return { openKeyCursor(range) {
                            const req = {}; pending++;
                            const entries = [...table.values.entries()].filter(([, value]) => value[indexName] === range.value);
                            let offset = 0;
                            const step = () => queueMicrotask(() => {
                                if (finished) { pending--; return; }
                                const next = entries[offset++];
                                if (next) req.result = { primaryKey: next[0], continue: step };
                                else { req.result = null; pending--; }
                                req.onsuccess?.(); check();
                            });
                            step(); return req;
                        } }; },
                    };
                } };
                const check = () => setImmediate(() => {
                    if (finished || pending) return;
                    finished = true;
                    if (mode === 'readwrite') for (const [name, value] of snapshots) tables.set(name, value);
                    tx.oncomplete?.();
                });
                check(); return tx;
            } };
            request.result = db;
            if (!upgraded) { upgraded = true; request.onupgradeneeded?.(); }
            request.onsuccess?.();
        });
        return request;
    } };
    return { factory, table: name => tables.get(name)?.values, get closed() { return closed; } };
}
const previousRange = globalThis.IDBKeyRange;
globalThis.IDBKeyRange = { only: value => ({ value }) };
after(() => { if (previousRange === undefined) delete globalThis.IDBKeyRange; else globalThis.IDBKeyRange = previousRange; });
const baseTime = 1_700_000_000_000;
const makeTicket = (id, text = '原文😀', overrides = {}) => ({ id, token: 'token', tabId: 1, documentId: 'doc',
    sourceUrl: 'https://example.com/data?secret=kept-local', sourceDisplayUrl: 'https://example.com/data', mode: 'auto',
    stage: 'uploading', createdAt: baseTime, expiresAt: baseTime + 300_000, totalChars: text.length,
    totalBytes: new TextEncoder().encode(text).length, receivedChars: 0, receivedBytes: 0, chunkSizes: [], ...overrides });
const append = (store, id, text, index = 0, token = 'token') => store.append(id, token, index, text, new TextEncoder().encode(text).length, baseTime + 1);

test('real import store persists exact chunks and metadata across independently opened instances', async () => {
    const db = indexedDbFixture(); const store = createCaptureStore(db.factory); const text = String.raw` {"id":9007199254740993,"p":2.00,"z":-0,"s":"\n中文😀"} `;
    await store.create(makeTicket('one', text), baseTime); await append(store, 'one', text);
    const restarted = createCaptureStore(db.factory);
    assert.equal((await restarted.read('one', 0)).text, text);
    assert.equal((await restarted.get('one')).receivedBytes, new TextEncoder().encode(text).length);
    assert.equal((await restarted.findByDocument(1, 'doc', baseTime)).id, 'one');
    assert.equal(await restarted.findByDocument(2, 'doc', baseTime), undefined);
    assert.ok(db.closed >= 5, 'every completed transaction closes its database handle');
});
test('store rejects wrong tokens, out-of-order chunks, overlong bodies and expired uploads without partial writes', async () => {
    const db = indexedDbFixture(); const store = createCaptureStore(db.factory);
    await store.create(makeTicket('one', 'abc'), baseTime);
    await assert.rejects(append(store, 'one', 'a', 0, 'wrong'), error => error.code === 'EXPIRED');
    await assert.rejects(append(store, 'one', 'a', 1), error => error.code === 'SEQUENCE');
    await assert.rejects(append(store, 'one', 'abcd'), error => error.code === 'SIZE');
    assert.equal(db.table('chunks').size, 0); assert.equal((await store.get('one')).receivedChars, 0);
    await append(store, 'one', 'abc');
    await assert.rejects(store.append('one', 'token', 1, 'x', 1, baseTime + 300_001), error => error.code === 'EXPIRED');
    assert.equal(db.table('chunks').size, 1);
});
test('budget caps unconsumed responses and ACK deletes bodies while retaining return metadata', async () => {
    const db = indexedDbFixture(); const store = createCaptureStore(db.factory);
    for (let i = 0; i < 4; i++) await store.create(makeTicket('id-' + i, 'x', { totalBytes: CAPTURE_LIMIT_BYTES }), baseTime);
    await assert.rejects(store.create(makeTicket('fifth'), baseTime), error => error.code === 'BUSY');
    await append(store, 'id-0', 'x'); await store.update('id-0', { stage: 'ready' }); await store.consume('id-0');
    assert.equal(db.table('chunks').size, 0);
    const consumed = await store.get('id-0'); assert.equal(consumed.stage, 'consumed'); assert.equal(consumed.token, undefined); assert.deepEqual(consumed.chunkSizes, []);
    assert.equal(consumed.sourceUrl, 'https://example.com/data?secret=kept-local');
    await store.create(makeTicket('fifth'), baseTime); assert.equal(db.table('tickets').size, 5);
});
test('expired records and removed tabs delete both ticket metadata and all body chunks', async () => {
    const db = indexedDbFixture(); const store = createCaptureStore(db.factory);
    await store.create(makeTicket('expired', 'abc', { expiresAt: baseTime + 10 }), baseTime); await append(store, 'expired', 'abc');
    await store.create(makeTicket('closed', 'abc', { tabId: 2 }), baseTime); await append(store, 'closed', 'abc');
    await store.create(makeTicket('live', 'abc', { tabId: 3 }), baseTime); await append(store, 'live', 'abc');
    await store.cleanup(baseTime + 11, 2);
    assert.deepEqual([...db.table('tickets').keys()], ['live']); assert.deepEqual([...db.table('chunks').keys()], ['live:0']);
    await store.remove('live'); assert.equal(db.table('tickets').size, 0); assert.equal(db.table('chunks').size, 0);
});
test('duplicate ticket creation aborts instead of replacing another response', async () => {
    const db = indexedDbFixture(); const store = createCaptureStore(db.factory);
    await store.create(makeTicket('same', 'first'), baseTime); await append(store, 'same', 'first');
    await assert.rejects(store.create(makeTicket('same', 'second'), baseTime), /ConstraintError/);
    assert.equal((await store.read('same', 0)).text, 'first'); assert.equal((await store.get('same')).totalChars, 5);
});
