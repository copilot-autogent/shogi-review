import type { AppData } from "./model.js";
import { parseBackup, createBackup } from "./backup.js";

export interface Repository { load(): Promise<AppData>; save(data: AppData): Promise<void>; }
export type ProfileKey = "guest" | `user:${string}`;
export interface ProfileLoad { data: AppData; profile: ProfileKey; migrated: boolean; }
export interface ProfileRepository {
  loadProfile(profile: ProfileKey): Promise<ProfileLoad>;
  saveProfile(profile: ProfileKey, data: AppData): Promise<void>;
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
  constructor(initial: AppData = globalThis.structuredClone(empty)) { this.profiles.set("guest", globalThis.structuredClone(initial)); }
  async load(): Promise<AppData> { return globalThis.structuredClone(this.profiles.get("guest") ?? empty); }
  async save(data: AppData): Promise<void> { this.profiles.set("guest", globalThis.structuredClone(data)); }
  async loadProfile(profile: ProfileKey): Promise<ProfileLoad> {
    return { profile, data: globalThis.structuredClone(this.profiles.get(profile) ?? empty), migrated: false };
  }
  async saveProfile(profile: ProfileKey, data: AppData): Promise<void> { this.profiles.set(profile, globalThis.structuredClone(data)); }
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase>;
  constructor(private name = "shogi-review") {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 3);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state");
        if (!request.result.objectStoreNames.contains("profiles")) request.result.createObjectStore("profiles");
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
}
