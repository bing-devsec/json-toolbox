// Separate database: repair comparisons never overwrite normal Diff drafts or archives.
const DB_NAME = 'json-tool-repair-comparisons';
const STORE = 'snapshots';
const TTL = 24 * 60 * 60 * 1000;
interface Snapshot { id: string; createdAt: number; original: Blob; repaired: Blob; formatted: Blob }

function createSnapshotId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // HTTP LAN origins lack randomUUID, but still expose cryptographic random bytes.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Repair comparison storage is blocked'));
    });
}
export async function saveRepairSnapshot(original: string, repaired: string, formatted: string): Promise<string> {
    const id = createSnapshotId();
    const db = await openDb();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            // Read only keys when expiring large records; never clone their bodies for GC.
            const expired = store.index('createdAt').openKeyCursor(IDBKeyRange.upperBound(Date.now() - TTL));
            expired.onsuccess = () => { const cursor = expired.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
            store.put({ id, createdAt: Date.now(), original: new Blob([original]), repaired: new Blob([repaired]), formatted: new Blob([formatted]) } satisfies Snapshot);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('Repair comparison storage failed'));
        });
        return id;
    } finally { db.close(); }
}
export async function loadRepairSnapshot(id: string, view: 'repair' | 'formatted'): Promise<{ original: string; result: string }> {
    const db = await openDb();
    try {
        const record = await new Promise<Snapshot | undefined>((resolve, reject) => {
            const req = db.transaction(STORE).objectStore(STORE).get(id);
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        if (!record || Date.now() - record.createdAt > TTL) throw new Error('Repair comparison has expired or was removed');
        const [original, result] = await Promise.all([record.original.text(), record[view === 'repair' ? 'repaired' : 'formatted'].text()]);
        return { original, result };
    } finally { db.close(); }
}
