import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { loadRepairSnapshot, saveRepairSnapshot } from '../src/components/utils/repairSnapshots.ts';

function useSnapshotEnvironment(t, cryptoApi) {
    const records = new Map();
    const calls = { opened: 0, closed: 0 };
    const request = (result) => {
        const req = { result };
        queueMicrotask(() => req.onsuccess?.());
        return req;
    };
    const db = {
        transaction() {
            const tx = {
                objectStore: () => ({
                    index: () => ({ openKeyCursor: () => request(null) }),
                    put(record) {
                        records.set(record.id, record);
                        queueMicrotask(() => tx.oncomplete?.());
                    },
                    get: (id) => request(records.get(id)),
                }),
            };
            return tx;
        },
        close() { calls.closed++; },
    };
    const globals = {
        crypto: cryptoApi,
        indexedDB: { open() { calls.opened++; return request(db); } },
        IDBKeyRange: { upperBound: (value) => value },
    };
    for (const [key, value] of Object.entries(globals)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        t.after(() => {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        });
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    return { records, calls };
}

const original = '{"payload":"{\\"ok\\":true}" "stats":{"count":1}}';
const repaired = '{"payload":"{\\"ok\\":true}","stats":{"count":1}}';
const formatted = '{\n  "payload": "{\\"ok\\":true}",\n  "stats": { "count": 1 }\n}';

test('repair comparisons retain native UUIDs and round-trip original, repaired and formatted text', async t => {
    const id = '00112233-4455-4677-8899-aabbccddeeff';
    const env = useSnapshotEnvironment(t, {
        randomUUID() { return id; },
        getRandomValues() { assert.fail('native UUID environments should keep their existing path'); },
    });
    assert.equal(await saveRepairSnapshot(original, repaired, formatted), id);
    assert.deepEqual(await loadRepairSnapshot(id, 'repair'), { original, result: repaired });
    assert.deepEqual(await loadRepairSnapshot(id, 'formatted'), { original, result: formatted });
    assert.equal(env.records.size, 1);
    assert.equal(env.calls.opened, env.calls.closed);
});

test('HTTP LAN environments without randomUUID can save and reopen independent repair comparisons', async t => {
    let randomCalls = 0;
    const env = useSnapshotEnvironment(t, {
        getRandomValues(bytes) { randomCalls++; return webcrypto.getRandomValues(bytes); },
    });
    const first = await saveRepairSnapshot(original, repaired, formatted);
    const second = await saveRepairSnapshot('other input', 'other repair', 'other format');
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, second);
    assert.equal(randomCalls, 2);
    assert.equal(env.records.size, 2);
    assert.deepEqual(await loadRepairSnapshot(first, 'repair'), { original, result: repaired });
    assert.deepEqual(await loadRepairSnapshot(second, 'formatted'), { original: 'other input', result: 'other format' });
    assert.equal(env.calls.opened, env.calls.closed);
});

test('an ID generation failure does not leave an opened comparison database', async t => {
    const env = useSnapshotEnvironment(t, {
        getRandomValues() { throw new Error('random source unavailable'); },
    });
    await assert.rejects(saveRepairSnapshot(original, repaired, formatted), /random source unavailable/);
    assert.equal(env.calls.opened, 0);
    assert.equal(env.records.size, 0);
});
