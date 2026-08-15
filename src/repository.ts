import type { AppData } from "./model.js";
import { parseBackup, createBackup } from "./backup.js";

export interface Repository { load(): Promise<AppData>; save(data: AppData): Promise<void>; }
export type ProfileKey = "guest" | `user:${string}`;
export interface ProfileLoad { data: AppData; profile: ProfileKey; migrated: boolean; }
export interface SyncBaseRecord {
  data: AppData;
  revision: number;
  payloadHash: string;
  hashVersion: number;
}
export interface ProfileRepository {
  loadProfile(profile: ProfileKey): Promise<ProfileLoad>;
  saveProfile(profile: ProfileKey, data: AppData): Promise<void>;
  deleteProfile(profile: ProfileKey): Promise<void>;
  loadSyncBase(profile: ProfileKey): Promise<SyncBaseRecord | null>;
  saveSyncBase(profile: ProfileKey, base: SyncBaseRecord): Promise<void>;
  saveProfileAndBase(profile: ProfileKey, data: AppData, base: SyncBaseRecord, canCommit?: () => boolean, signal?: AbortSignal): Promise<void>;
  deleteSyncBase(profile: ProfileKey): Promise<void>;
}
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

export class MemoryProfileRepository implements ProfileRepository {
  private profiles = new Map<ProfileKey, AppData>();
  private bases = new Map<ProfileKey, SyncBaseRecord>();
  constructor(initial: AppData = globalThis.structuredClone(empty)) { this.profiles.set("guest", globalThis.structuredClone(initial)); }
  async load(): Promise<AppData> { return globalThis.structuredClone(this.profiles.get("guest") ?? empty); }
  async save(data: AppData): Promise<void> { this.profiles.set("guest", globalThis.structuredClone(data)); }
  async loadProfile(profile: ProfileKey): Promise<ProfileLoad> {
    return { profile, data: globalThis.structuredClone(this.profiles.get(profile) ?? empty), migrated: false };
  }
  async saveProfile(profile: ProfileKey, data: AppData): Promise<void> { this.profiles.set(profile, globalThis.structuredClone(data)); }
  async deleteProfile(profile: ProfileKey): Promise<void> { this.profiles.delete(profile); }
  async loadSyncBase(profile: ProfileKey): Promise<SyncBaseRecord | null> {
    const base = this.bases.get(profile);
    return base ? globalThis.structuredClone(base) : null;
  }
  async saveSyncBase(profile: ProfileKey, base: SyncBaseRecord): Promise<void> { this.bases.set(profile, globalThis.structuredClone(base)); }
  async saveProfileAndBase(profile: ProfileKey, data: AppData, base: SyncBaseRecord, canCommit = () => true, signal?: AbortSignal): Promise<void> {
    if (!canCommit() || signal?.aborted) throw new Error("同步身分已變更。");
    this.profiles.set(profile, globalThis.structuredClone(data));
    this.bases.set(profile, globalThis.structuredClone(base));
  }
  async deleteSyncBase(profile: ProfileKey): Promise<void> { this.bases.delete(profile); }
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase>;
  constructor(private name = "shogi-review") {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 5);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state");
        if (!request.result.objectStoreNames.contains("profiles")) request.result.createObjectStore("profiles");
        if (!request.result.objectStoreNames.contains("syncBases")) request.result.createObjectStore("syncBases");
      };
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
  async replace(data: AppData): Promise<void> {
    await this.save(data);
  }
  async loadProfile(profile: ProfileKey): Promise<ProfileLoad> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["state", "profiles"]);
      const profiles = transaction.objectStore("profiles").get(profile);
      const legacy = transaction.objectStore("state").get("app");
      transaction.onerror = () => reject(transaction.error ?? new Error("讀取本機資料失敗。"));
      transaction.oncomplete = () => {
        try {
          if (profiles.result !== undefined) {
            resolve({ profile, data: parseStoredData(profiles.result), migrated: false });
            return;
          }
          if (profile === "guest" && legacy.result !== undefined) {
            resolve({ profile, data: parseStoredData(legacy.result), migrated: true });
            return;
          }
          resolve({ profile, data: globalThis.structuredClone(empty), migrated: false });
        } catch (error) { reject(error instanceof Error ? error : new Error("本機資料格式無效。")); }
      };
    });
  }
  async saveProfile(profile: ProfileKey, data: AppData): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("profiles", "readwrite");
      transaction.objectStore("profiles").put(createBackup(data), profile);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("儲存本機資料失敗。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本機儲存交易已取消。"));
    });
  }
  async deleteProfile(profile: ProfileKey): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("profiles", "readwrite");
      transaction.objectStore("profiles").delete(profile);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("刪除本機資料失敗。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本機刪除交易已取消。"));
    });
  }
  async loadSyncBase(profile: ProfileKey): Promise<SyncBaseRecord | null> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction("syncBases").objectStore("syncBases").get(profile);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) { resolve(null); return; }
          const record = request.result as { data: unknown; revision: number; payloadHash: string; hashVersion: number };
          resolve({ data: parseStoredData(record.data), revision: record.revision, payloadHash: record.payloadHash, hashVersion: record.hashVersion });
        } catch (error) { reject(error instanceof Error ? error : new Error("同步基準格式無效。")); }
      };
      request.onerror = () => reject(request.error ?? new Error("讀取同步基準失敗。"));
    });
  }
  async saveSyncBase(profile: ProfileKey, base: SyncBaseRecord): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("syncBases", "readwrite");
      transaction.objectStore("syncBases").put({ ...base, data: createBackup(base.data) }, profile);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("儲存同步基準失敗。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("同步基準交易已取消。"));
    });
  }
  async saveProfileAndBase(profile: ProfileKey, data: AppData, base: SyncBaseRecord, canCommit = () => true, signal?: AbortSignal): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["profiles", "syncBases"], "readwrite");
      let settled = false;
      const abort = () => { if (!settled) transaction.abort(); };
      if (!canCommit() || signal?.aborted) { abort(); reject(new Error("同步身分已變更。")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      transaction.objectStore("profiles").put(createBackup(data), profile);
      transaction.objectStore("syncBases").put({ ...base, data: createBackup(base.data) }, profile);
      transaction.oncomplete = () => { settled = true; signal?.removeEventListener("abort", abort); resolve(); };
      transaction.onerror = () => { settled = true; signal?.removeEventListener("abort", abort); reject(transaction.error ?? new Error("本機同步資料儲存失敗。")); };
      transaction.onabort = () => { settled = true; signal?.removeEventListener("abort", abort); reject(transaction.error ?? new Error("本機同步資料交易已取消。")); };
    });
  }
  async deleteSyncBase(profile: ProfileKey): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("syncBases", "readwrite");
      transaction.objectStore("syncBases").delete(profile);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("刪除同步基準失敗。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("同步基準刪除交易已取消。"));
    });
  }
}
