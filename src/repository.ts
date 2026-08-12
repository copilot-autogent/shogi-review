import type { AppData } from "./model.js";
import { parseBackup, createBackup } from "./backup.js";

export interface Repository { load(): Promise<AppData>; save(data: AppData): Promise<void>; }
const empty: AppData = { games: [] };

export function parseStoredData(value: unknown): AppData {
  if (value && typeof value === "object" && "schemaVersion" in value) {
    return parseBackup(JSON.stringify(value));
  }
  return parseBackup(JSON.stringify({ schemaVersion: 1, data: value }));
}

export class MemoryRepository implements Repository {
  constructor(private data: AppData = globalThis.structuredClone(empty)) {}
  async load(): Promise<AppData> { return globalThis.structuredClone(this.data); }
  async save(data: AppData): Promise<void> { this.data = globalThis.structuredClone(data); }
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase>;
  constructor(private name = "shogi-review") {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 3);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state"); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB 開啟失敗。"));
    });
    void this.dbPromise.catch(() => undefined);
  }
  async load(): Promise<AppData> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction("state").objectStore("state").get("app");
      request.onsuccess = () => {
        try { resolve(request.result === undefined ? globalThis.structuredClone(empty) : parseStoredData(request.result)); }
        catch (error) { reject(error instanceof Error ? error : new Error("本機資料格式無效。")); }
      };
      request.onerror = () => reject(request.error ?? new Error("讀取資料失敗。"));
    });
  }
  async save(data: AppData): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").put(createBackup(data), "app");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("儲存資料失敗。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("儲存交易已取消。"));
    });
  }
}
