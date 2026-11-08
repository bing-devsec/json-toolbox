import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

let generation = 0;
async function setup(t, stores = ['archivesByTab', 'diffDraftByTab', 'tabHeartbeats']) {
    const requests = [];
    const transactions = [];
    let deletes = 0;
    const db = {
        objectStoreNames: { contains: name => stores.includes(name) },
        closed: 0, close() { this.closed++; },
        createObjectStore(name) { stores.push(name); },
        transaction(name, mode) {
            const request = {};
            const tx = { name, mode, request, objectStore: () => ({ put: () => request, delete: () => request, get: () => request }) };
            transactions.push(tx);
            return tx;
        },
    };
    globalThis.window = {};
    globalThis.indexedDB = {
        open() { const request = { result: db }; requests.push(request); return request; },
        deleteDatabase() { deletes++; return {}; },
    };
    t.after(() => { delete globalThis.window; delete globalThis.indexedDB; });
    const source = await readFile('src/components/utils/idb.ts', 'utf8');
    const compiled = await transform(source, { loader: 'ts', format: 'esm' });
    const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.code + `\n// instance ${generation++}`).toString('base64')}`);
    return { api, db, requests, transactions, get deletes() { return deletes; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('missing stores fail without deleting existing archives or recursively reopening', async t => {
    const fixture = await setup(t, ['archivesByTab']);
    const opened = fixture.api.openJsonToolDb();
    const result = opened.then(() => 'resolved', error => error.message);
    fixture.requests[0].onsuccess();
    await turn();
    assert.equal(fixture.deletes, 0);
    assert.equal(fixture.requests.length, 1);
    assert.match(await result, /stores|仓库/i);
    assert.equal(fixture.db.closed, 1);
});

test('new databases create required stores without deleting anything', async t => {
    const fixture = await setup(t, []);
    const opened = fixture.api.openJsonToolDb();
    fixture.requests[0].onupgradeneeded();
    fixture.requests[0].onsuccess();
    assert.equal(await opened, fixture.db);
    assert.equal(fixture.deletes, 0);
    for (const name of ['archivesByTab', 'diffDraftByTab', 'tabHeartbeats']) assert(fixture.db.objectStoreNames.contains(name));
});

test('put and delete do not report success before their transaction commits', async t => {
    const fixture = await setup(t);
    const opened = fixture.api.openJsonToolDb();
    fixture.requests[0].onsuccess();
    await opened;
    for (const operation of [() => fixture.api.idbPut('archivesByTab', { tabId: 'test' }), () => fixture.api.idbDelete('archivesByTab', 'test')]) {
        let settled = false;
        const promise = operation().then(() => { settled = true; });
        await turn();
        const tx = fixture.transactions.at(-1);
        tx.request.onsuccess?.();
        await turn();
        assert.equal(settled, false);
        tx.oncomplete();
        await promise;
        assert.equal(settled, true);
    }
});

test('an abort after request success rejects instead of claiming saved data', async t => {
    const fixture = await setup(t);
    const opened = fixture.api.openJsonToolDb();
    fixture.requests[0].onsuccess();
    await opened;
    for (const operation of [() => fixture.api.idbPut('archivesByTab', { tabId: 'test' }), () => fixture.api.idbDelete('archivesByTab', 'test')]) {
        const promise = operation();
        const rejection = assert.rejects(promise, /disk quota/);
        await turn();
        const tx = fixture.transactions.at(-1);
        tx.request.onsuccess?.();
        tx.error = new Error('disk quota');
        tx.onabort?.();
        await rejection;
    }
});

test('blocked open rejects, closes late success, and allows a fresh retry', async t => {
    const fixture = await setup(t);
    const blocked = fixture.api.openJsonToolDb();
    const rejection = assert.rejects(blocked, /blocked/);
    fixture.requests[0].onblocked();
    await rejection;
    const retried = fixture.api.openJsonToolDb();
    assert.equal(fixture.requests.length, 2);
    fixture.requests[0].onsuccess();
    assert.equal(fixture.db.closed, 1, 'late success from abandoned open must close its connection');
    fixture.requests[1].onsuccess();
    assert.equal(await retried, fixture.db);
});

test('request and transaction errors reject writes without invalidating a healthy connection', async t => {
    const fixture = await setup(t);
    const opened = fixture.api.openJsonToolDb();
    fixture.requests[0].onsuccess();
    await opened;
    for (const failure of ['request', 'transaction']) {
        const promise = fixture.api.idbPut('archivesByTab', { tabId: 'test' });
        const rejection = assert.rejects(promise, /injected failure/);
        await turn();
        const tx = fixture.transactions.at(-1);
        if (failure === 'request') {
            tx.request.error = new Error('injected failure');
            tx.request.onerror();
        } else {
            tx.error = new Error('injected failure');
            tx.onerror();
        }
        await rejection;
    }
    assert.equal(await fixture.api.openJsonToolDb(), fixture.db);
    assert.equal(fixture.requests.length, 1);
});

test('a stale close event never invalidates a newer successful connection', async t => {
    const fixture = await setup(t);
    const first = fixture.api.openJsonToolDb();
    fixture.requests[0].onsuccess();
    await first;
    fixture.db.onversionchange();
    const secondDb = { ...fixture.db, closed: 0 };
    const second = fixture.api.openJsonToolDb();
    fixture.requests[1].result = secondDb;
    fixture.requests[1].onsuccess();
    assert.equal(await second, secondDb);
    fixture.db.onclose();
    assert.equal(await fixture.api.openJsonToolDb(), secondDb);
    assert.equal(fixture.requests.length, 2);
});

test('ordinary reads still return their result without changing stored data', async t => {
    const fixture = await setup(t);
    const promise = fixture.api.idbGet('archivesByTab', 'test');
    fixture.requests[0].onsuccess();
    await turn();
    const tx = fixture.transactions.at(-1);
    tx.request.result = { tabId: 'test', archives: ['unchanged'] };
    tx.request.onsuccess();
    assert.deepEqual(await promise, { tabId: 'test', archives: ['unchanged'] });
    assert.equal(tx.mode, 'readonly');
    assert.equal(fixture.deletes, 0);
});
