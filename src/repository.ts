import type { AppData } from "./model.js";

export interface Repository {
  load(): Promise<AppData>;
  save(_data: AppData): Promise<void>;
}

const empty: AppData = { games: [] };

export class MemoryRepository implements Repository {
  constructor(private data: AppData = globalThis.structuredClone(empty)) {}
  async load(): Promise<AppData> { return globalThis.structuredClone(this.data); }
  async save(_data: AppData): Promise<void> { this.data = globalThis.structuredClone(_data); }
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase>;
  constructor(private name = "shogi-review") {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB 開啟失敗。"));
    });
    void this.dbPromise.catch(() => undefined);
  }
  async load(): Promise<AppData> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction("state").objectStore("state").get("app");
      request.onsuccess = () => resolve(request.result ?? globalThis.structuredClone(empty));
      request.onerror = () => reject(request.error ?? new Error("讀取資料失敗。"));
    });
  }
  async save(data: AppData): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction("state", "readwrite").objectStore("state").put(globalThis.structuredClone(data), "app");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("儲存資料失敗。"));
    });
  }
}
