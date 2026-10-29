import assert from 'node:assert/strict';
import test from 'node:test';
import { createExternalImportGate } from '../src/extension/externalImport.ts';
import { createCaptureImportSession } from '../src/extension/importSession.ts';

const id = 'import-ticket-001';
const raw = String.raw`{"id":9223372036854775807,"value":2.00,"negative":-0,"text":"first\nsecond","duplicate":1,"duplicate":2}`;
const record = { text: raw, sourceDisplayUrl: 'https://example.com/orders', createdAt: 100 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const setup = (overrides = {}) => {
    const states = []; const acknowledged = []; let urlCleaned = 0;
    const session = createCaptureImportSession({ id, read: async () => record,
        acknowledge: async token => { acknowledged.push(token); },
        onChange: state => states.push(state), onAcknowledged: () => { urlCleaned++; }, ...overrides });
    return { session, states, acknowledged, get urlCleaned() { return urlCleaned; } };
};

test('external import waits for Monaco and preserves exact text before applying once', () => {
    const gate = createExternalImportGate(); const writes = []; let ready = false;
    const editor = { get ready() { return ready; }, hasContent: () => writes.length > 0, setText: text => { writes.push(text); return true; } };
    const request = { id, text: raw };
    assert.equal(gate.apply(request, editor), 'pending'); assert.deepEqual(writes, []);
    ready = true;
    assert.equal(gate.apply(request, editor), 'applied'); assert.equal(writes[0], raw);
    assert.equal(gate.apply(request, editor), 'already-applied'); assert.equal(writes.length, 1);
});

test('late imported text never overwrites a user edit or another response', () => {
    const gate = createExternalImportGate(); let text = 'user text';
    const editor = { ready: true, hasContent: () => text.length > 0, setText: value => { text = value; return true; } };
    assert.equal(gate.apply({ id, text: raw }, editor), 'occupied'); assert.equal(text, 'user text');
    text = '';
    assert.equal(gate.apply({ id, text: raw }, editor), 'applied');
    assert.equal(gate.apply({ id: 'second-ticket', text: 'different' }, editor), 'occupied'); assert.equal(text, raw);
});

test('a failed editor write remains retryable and is not marked as consumed', () => {
    const gate = createExternalImportGate(); let accepted = false; let writes = 0;
    const editor = { ready: true, hasContent: () => false, setText: () => { writes++; return accepted; } };
    assert.equal(gate.apply({ id, text: raw }, editor), 'pending'); accepted = true;
    assert.equal(gate.apply({ id, text: raw }, editor), 'applied'); assert.equal(writes, 2);
});

test('reading a complete ticket does not acknowledge or erase it before the editor accepts it', async () => {
    const run = setup(); await run.session.load();
    assert.equal(run.states.at(-1).phase, 'ready'); assert.equal(run.states.at(-1).request.text, raw);
    assert.deepEqual(run.acknowledged, []); assert.equal(run.urlCleaned, 0);
    await run.session.confirmImported('wrong-ticket'); assert.deepEqual(run.acknowledged, []);
    await run.session.confirmImported(id);
    assert.equal(run.states.at(-1).phase, 'imported'); assert.equal(run.states.at(-1).request, null);
    assert.deepEqual(run.acknowledged, [id]); assert.equal(run.urlCleaned, 1);
    await run.session.confirmImported(id); await run.session.load();
    assert.deepEqual(run.acknowledged, [id]);
});

test('failed reads retain the ticket for retry without acknowledging partial text', async () => {
    let reads = 0;
    const run = setup({ read: async () => { if (!reads++) throw new Error('interrupted'); return record; } });
    await run.session.load(); assert.equal(run.states.at(-1).phase, 'error'); assert.equal(run.states.at(-1).request, null);
    assert.deepEqual(run.acknowledged, []);
    await run.session.load(); assert.equal(run.states.at(-1).request.text, raw);
});

test('retry aborts the older reader and ignores its late response', async () => {
    const first = deferred(), second = deferred(); const signals = [];
    const run = setup({ read: (_id, options) => { signals.push(options.signal); return signals.length === 1 ? first.promise : second.promise; } });
    const old = run.session.load(); const current = run.session.load();
    assert.equal(signals[0].aborted, true); second.resolve(record); await current;
    first.resolve({ ...record, text: 'stale' }); await old;
    assert.equal(run.states.at(-1).request.text, raw);
});

test('unmount cancels transfer and prevents late UI updates or acknowledgement', async () => {
    const wait = deferred(); let signal;
    const run = setup({ read: (_id, options) => { signal = options.signal; return wait.promise; } });
    const loading = run.session.load(); run.session.dispose(); const count = run.states.length;
    assert.equal(signal.aborted, true); wait.resolve(record); await loading;
    assert.equal(run.states.length, count); await run.session.confirmImported(id); assert.deepEqual(run.acknowledged, []);
});

test('editor rejection preserves the unread ticket and allows a safe explicit retry', async () => {
    const run = setup(); await run.session.load(); run.session.rejectImport(id, 'EDITOR_HAS_CONTENT');
    assert.equal(run.states.at(-1).phase, 'error'); assert.equal(run.states.at(-1).error, 'EDITOR_HAS_CONTENT');
    assert.deepEqual(run.acknowledged, []); await run.session.load(); assert.equal(run.states.at(-1).phase, 'ready');
});

test('cleanup failure is reported separately and never deletes the accepted editor model', async () => {
    const cleanupError = new Error('storage busy');
    const run = setup({ acknowledge: async () => { throw cleanupError; } });
    await run.session.load(); await run.session.confirmImported(id);
    assert.equal(run.states.at(-1).phase, 'imported'); assert.equal(run.states.at(-1).cleanupError, cleanupError);
    assert.equal(run.states.at(-1).request, null); assert.equal(run.urlCleaned, 0);
});


for (const warning of ['FORMAT_FAILED', 'FORMAT_TOO_LARGE']) {
    test(`a successfully imported original response can be acknowledged with ${warning} without claiming formatting succeeded`, async () => {
        const run = setup(); await run.session.load();
        await run.session.confirmImported(id, warning);
        assert.equal(run.states.at(-1).phase, 'imported');
        assert.equal(run.states.at(-1).formatWarning, warning);
        assert.equal(run.states.at(-1).request, null);
        assert.deepEqual(run.acknowledged, [id]);
        assert.equal(run.urlCleaned, 1);
    });
}
