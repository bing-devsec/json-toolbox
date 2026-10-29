import { CAPTURE_MAX_PENDING, CAPTURE_LIMIT_BYTES, captureError } from './json-capture-core.js';

const DB_NAME = 'json-tool-document-imports-v1';
const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Import storage failed'));
});
const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Import storage failed'));
});

/** Independent extension-origin storage; no website storage or normal editor drafts. */
export function createCaptureStore(factory = globalThis.indexedDB) {
    async function open() {
        const request = factory.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('tickets', { keyPath: 'id' });
            request.result.createObjectStore('chunks', { keyPath: 'key' }).createIndex('ticketId', 'ticketId');
        };
        const db = await requestValue(request);
        db.onversionchange = () => db.close();
        return db;
    }
    async function run(mode, task) {
        const db = await open();
        try {
            const tx = db.transaction(['tickets', 'chunks'], mode);
            const done = transactionDone(tx);
            try { const result = await task(tx); await done; return result; }
            catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
        } finally { db.close(); }
    }
    function deleteChunks(tx, id) {
        const request = tx.objectStore('chunks').index('ticketId').openKeyCursor(IDBKeyRange.only(id));
        request.onsuccess = () => { const cursor = request.result; if (cursor) { tx.objectStore('chunks').delete(cursor.primaryKey); cursor.continue(); } };
    }
    return {
        async get(id) { return run('readonly', tx => requestValue(tx.objectStore('tickets').get(id))); },
        async findByDocument(tabId, documentId, now) {
            return run('readonly', async tx => (await requestValue(tx.objectStore('tickets').getAll()))
                .find(ticket => ticket.tabId === tabId && ticket.documentId === documentId && ticket.expiresAt > now && ticket.stage !== 'consumed'));
        },
        async create(ticket, now) {
            return run('readwrite', async tx => {
                const store = tx.objectStore('tickets');
                const all = await requestValue(store.getAll());
                let pending = 0;
                let bytes = 0;
                for (const item of all) {
                    if (item.expiresAt <= now) { store.delete(item.id); deleteChunks(tx, item.id); }
                    else if (item.stage !== 'consumed') { pending++; bytes += item.totalBytes; }
                }
                if (pending >= CAPTURE_MAX_PENDING || bytes + ticket.totalBytes > CAPTURE_MAX_PENDING * CAPTURE_LIMIT_BYTES)
                    throw captureError('BUSY', 'Too many pending JSON imports. Please finish or close an imported tab first.');
                store.add(ticket);
            });
        },
        async append(id, token, index, text, bytes, now) {
            return run('readwrite', async tx => {
                const store = tx.objectStore('tickets');
                const ticket = await requestValue(store.get(id));
                if (!ticket || ticket.token !== token || ticket.stage !== 'uploading' || ticket.expiresAt <= now)
                    throw captureError('EXPIRED', 'JSON import expired. Please retry from the original page.');
                if (index !== ticket.chunkSizes.length) throw captureError('SEQUENCE', 'JSON import chunks arrived out of order.');
                if (ticket.receivedChars + text.length > ticket.totalChars || ticket.receivedBytes + bytes > ticket.totalBytes)
                    throw captureError('SIZE', 'JSON import exceeded its declared size.');
                tx.objectStore('chunks').put({ key: `${id}:${index}`, ticketId: id, index, text });
                ticket.chunkSizes.push(text.length);
                ticket.receivedChars += text.length;
                ticket.receivedBytes += bytes;
                store.put(ticket);
            });
        },
        async update(id, update) {
            return run('readwrite', async tx => {
                const store = tx.objectStore('tickets');
                const ticket = await requestValue(store.get(id));
                if (!ticket) throw captureError('EXPIRED', 'JSON import expired or was removed.');
                Object.assign(ticket, update);
                store.put(ticket);
            });
        },
        async read(id, index) {
            return run('readonly', tx => requestValue(tx.objectStore('chunks').get(`${id}:${index}`)));
        },
        async consume(id) {
            return run('readwrite', async tx => {
                const store = tx.objectStore('tickets');
                const ticket = await requestValue(store.get(id));
                if (!ticket) return;
                ticket.stage = 'consumed'; ticket.chunkSizes = []; delete ticket.token;
                store.put(ticket); deleteChunks(tx, id);
            });
        },
        async remove(id) { return run('readwrite', tx => { tx.objectStore('tickets').delete(id); deleteChunks(tx, id); }); },
        async cleanup(now, tabId) {
            return run('readwrite', async tx => {
                const tickets = tx.objectStore('tickets');
                for (const ticket of await requestValue(tickets.getAll())) {
                    if (ticket.expiresAt <= now || ticket.tabId === tabId) { tickets.delete(ticket.id); deleteChunks(tx, ticket.id); }
                }
            });
        },
    };
}
