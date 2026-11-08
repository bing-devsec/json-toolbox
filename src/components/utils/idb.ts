// IndexedDB 原语与常量
// 对外暴露 openJsonToolDb / idbGet / idbPut / idbCount / idbDelete / idbGetAll / idbGetAllKeys，
// 以及数据库/对象仓库名、Tab 心跳记录类型等常量。
// 模块级 idbOpenPromise 单例保证整个应用只打开一次数据库连接。

export const IDB_DB_NAME = 'json-tool-db';
export const IDB_DB_VERSION = 2;
export const IDB_STORE_ARCHIVES = 'archivesByTab';
export const IDB_STORE_DIFF_DRAFTS = 'diffDraftByTab';
export const IDB_STORE_TAB_HEARTBEATS = 'tabHeartbeats';

// 大小/数量限制（被归档与 diff 草稿模块复用）
export const MAX_SINGLE_ARCHIVE_SIZE = 30 * 1024 * 1024; // 30MB（硬限制）
export const MAX_DIFF_SIDE_SIZE = 30 * 1024 * 1024; // 30MB（硬限制）
export const MAX_DIFF_TAB_COUNT = 30; // Diff 草稿最多保留 30 个标签页（tabId）

export interface TabHeartbeatRecord {
    tabId: string;
    updatedAt: number;
}

let idbOpenPromise: Promise<IDBDatabase> | null = null;
let activeConnection: IDBDatabase | null = null;

const REQUIRED_STORES = [IDB_STORE_ARCHIVES, IDB_STORE_DIFF_DRAFTS, IDB_STORE_TAB_HEARTBEATS] as const;

const hasAllRequiredStores = (db: IDBDatabase): boolean => REQUIRED_STORES.every((name) => db.objectStoreNames.contains(name));

const doOpenJsonToolDb = (): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
        let abandoned = false;
        const fail = (error: Error | DOMException) => {
            abandoned = true;
            reject(error);
        };
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE_ARCHIVES)) {
                db.createObjectStore(IDB_STORE_ARCHIVES, { keyPath: 'tabId' });
            }
            if (!db.objectStoreNames.contains(IDB_STORE_DIFF_DRAFTS)) {
                db.createObjectStore(IDB_STORE_DIFF_DRAFTS, { keyPath: 'tabId' });
            }
            if (!db.objectStoreNames.contains(IDB_STORE_TAB_HEARTBEATS)) {
                db.createObjectStore(IDB_STORE_TAB_HEARTBEATS, { keyPath: 'tabId' });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // A blocked open can eventually succeed after its promise was rejected.
            // Do not leak that connection or let it replace a newer retry.
            if (abandoned) { db.close(); return; }
            if (!hasAllRequiredStores(db)) {
                db.close();
                fail(new Error('IndexedDB stores are missing. Existing data was preserved; close other tabs and retry. If the problem persists, recovery is required.'));
                return;
            }
            activeConnection = db;
            const invalidateConnection = () => {
                if (activeConnection !== db) return;
                activeConnection = null;
                idbOpenPromise = null;
            };
            // Yield to another tab's upgrade without clearing a newer connection.
            db.onversionchange = () => { db.close(); invalidateConnection(); };
            db.onclose = invalidateConnection;
            resolve(db);
        };
        req.onerror = () => fail(req.error ?? new Error('Failed to open IndexedDB'));
        req.onblocked = () => fail(new Error('Opening IndexedDB was blocked'));
    });

export const openJsonToolDb = (): Promise<IDBDatabase> => {
    if (typeof window === 'undefined') return Promise.reject(new Error('IndexedDB not available'));
    if (idbOpenPromise) return idbOpenPromise;
    const opening = doOpenJsonToolDb().catch((err) => {
        // Do not clear a newer retry when an old request finishes late.
        if (idbOpenPromise === opening) idbOpenPromise = null;
        throw err;
    });
    idbOpenPromise = opening;
    return opening;
};

export const idbGet = async <T>(storeName: string, key: IDBValidKey): Promise<T | undefined> => {
    const db = await openJsonToolDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
    });
};

// Request success only means the write was queued successfully, not committed.
const writeTransaction = async (storeName: string, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> => {
    const db = await openJsonToolDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const req = operation(tx.objectStore(storeName));
        req.onerror = () => reject(req.error ?? new Error('IndexedDB write failed'));
    });
};

export const idbPut = (storeName: string, value: any): Promise<void> =>
    writeTransaction(storeName, (store) => store.put(value));

export const idbCount = async (storeName: string): Promise<number> => {
    const db = await openJsonToolDb();
    return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB count failed'));
    });
};

export const idbDelete = (storeName: string, key: IDBValidKey): Promise<void> =>
    writeTransaction(storeName, (store) => store.delete(key));

export const idbGetAll = async <T>(storeName: string): Promise<T[]> => {
    const db = await openJsonToolDb();
    return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result ?? []) as T[]);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed'));
    });
};

/** GC 只需标签页键，避免把每个存档桶和 Diff 草稿的正文克隆到主线程。 */
export const idbGetAllKeys = async (storeName: string): Promise<IDBValidKey[]> => {
    const db = await openJsonToolDb();
    return await new Promise<IDBValidKey[]>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAllKeys();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB getAllKeys failed'));
    });
};
