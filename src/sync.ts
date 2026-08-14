import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createBackup, parseBackup } from "./backup.js";
import type { AppData } from "./model.js";
import type { ProfileKey } from "./repository.js";

export const SUPABASE_URL = "https://yuymtghhqszcfbhhhhyq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_n2OiqY7tvxchr2rnhObTlA_uGUG7z1E";
export const HASH_VERSION = 1;
export const GOOGLE_REDIRECT_URL = "https://copilot-autogent.github.io/shogi-review/";
export const PKCE_PENDING_KEY = "shogi-review-pkce-pending";
export function googleRedirectUrl(origin: string): string {
  return origin === "https://copilot-autogent.github.io" ? GOOGLE_REDIRECT_URL : `${origin}/shogi-review/`;
}

export interface SyncMetadata {
  ownerUid?: string;
  lastSyncedRevision?: number;
  lastSyncedPayloadHash?: string;
  hashVersion: number;
}
export interface CloudState {
  user_id: string;
  payload: unknown;
  revision: number;
  updated_at?: string;
}
export type SyncStatus = "僅本機" | "同步中" | "尚未同步" | "已同步" | "衝突" | "離線／同步失敗";
export interface SyncIdentity { uid: string; profile: ProfileKey; generation: number; }
export interface SyncSnapshot {
  ownerUid?: string;
  lastSyncedRevision?: number;
  lastSyncedPayloadHash?: string;
  hashVersion: number;
  lastSyncedAt?: string;
}
export interface SyncEngineOptions {
  identity: () => SyncIdentity | null;
  load: () => Promise<AppData>;
  save: (data: AppData) => Promise<void>;
  getMetadata: (uid: string) => SyncSnapshot;
  setMetadata: (uid: string, metadata: SyncSnapshot) => Promise<void> | void;
  cloud: SyncRepository;
  onStatus?: (status: SyncStatus, message?: string) => void;
  onConflict?: (conflict: { userId: string; rowRevision: number; cloudData: AppData }) => void;
}
export type SyncResult = "synced" | "conflict" | "aborted";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: false },
});

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, ordered((value as Record<string, unknown>)[key])]));
  }
  return value;
}
export function canonicalData(data: AppData): string {
  return JSON.stringify(ordered(data));
}
export async function payloadHash(data: AppData): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalData(data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function validateCloudPayload(payload: unknown): AppData {
  if (!payload || typeof payload !== "object" || !("schemaVersion" in payload)) throw new Error("雲端資料格式無效，未套用任何變更。");
  return parseBackup(JSON.stringify(payload));
}
export function createCloudPayload(data: AppData): ReturnType<typeof createBackup> {
  return createBackup(data);
}
export function downloadKifu(sourceText: string, format: "KIF" | "KI2" | "CSA", title: string): void {
  const extension = format.toLowerCase();
  const safe = title.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 80) || "shogi-game";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([sourceText], { type: "text/plain;charset=utf-8" }));
  link.download = `${safe}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export interface SyncRepository {
  read(userId: string): Promise<CloudState | null>;
  insert(userId: string, payload: unknown, revision: number): Promise<CloudState>;
  casUpdate(userId: string, revision: number, payload: unknown): Promise<CloudState>;
}
export class SupabaseSyncRepository implements SyncRepository {
  constructor(private readonly client: SupabaseClient = supabase) {}
  async read(userId: string): Promise<CloudState | null> {
    const { data, error } = await this.client.from("user_state").select("user_id,payload,revision,updated_at").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data as CloudState | null;
  }

  async insert(userId: string, payload: unknown, revision: number): Promise<CloudState> {
    const { data, error } = await this.client.from("user_state").insert({ user_id: userId, payload, revision }).select("user_id,payload,revision,updated_at");
    if (error) throw error;
    if (!data || data.length !== 1) throw new Error("雲端初始化未確認單筆寫入。");
    return data[0] as CloudState;
  }
  async casUpdate(userId: string, revision: number, payload: unknown): Promise<CloudState> {
    const { data, error } = await this.client.from("user_state").update({ payload, revision: revision + 1 }).eq("user_id", userId).eq("revision", revision).select("user_id,payload,revision,updated_at");
    if (error) throw error;
    if (!data || data.length !== 1) throw new Error("雲端版本已變更，請重新載入並選擇衝突處理方式。");
    return data[0] as CloudState;
  }
}

export class AutoSyncEngine {
  private running = false;
  private trailing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private readonly options: SyncEngineOptions) {}
  invalidate(): void {
    this.trailing = false;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }
  schedule(delay = 1000): void {
    if (this.disposed) return;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile(); }, delay);
  }
  dispose(): void { this.disposed = true; this.invalidate(); }
  async reconcile(): Promise<SyncResult> {
    if (this.disposed) return "aborted";
    if (this.running) { this.trailing = true; return "aborted"; }
    const identity = this.options.identity();
    if (!identity) { this.options.onStatus?.("僅本機"); return "aborted"; }
    this.running = true;
    try { return await this.run(identity); }
    catch (error) {
      this.options.onStatus?.("離線／同步失敗", error instanceof Error ? error.message : "同步失敗，未套用任何變更。");
      return "aborted";
    }
    finally {
      this.running = false;
      if (this.trailing) { this.trailing = false; this.schedule(0); }
    }
  }
  private valid(identity: SyncIdentity): boolean {
    const current = this.options.identity();
    return !this.disposed && current?.uid === identity.uid && current.profile === identity.profile && current.generation === identity.generation;
  }
  private async currentHash(): Promise<string> { return payloadHash(await this.options.load()); }
  private async run(identity: SyncIdentity): Promise<SyncResult> {
    this.options.onStatus?.("同步中");
    const local = await this.options.load();
    const localHash = await payloadHash(local);
    if (!this.valid(identity)) return "aborted";
    const metadata = this.options.getMetadata(identity.uid);
    const baseline = metadata.ownerUid === identity.uid && metadata.lastSyncedRevision !== undefined && metadata.lastSyncedPayloadHash !== undefined;
    const row = await this.options.cloud.read(identity.uid);
    if (!this.valid(identity)) return "aborted";
    const cloudData = row ? validateCloudPayload(row.payload) : null;
    const cloudHash = cloudData ? await payloadHash(cloudData) : undefined;
    const localChanged = baseline ? localHash !== metadata.lastSyncedPayloadHash : local.games.length > 0;
    const cloudChanged = baseline ? !row || row.revision !== metadata.lastSyncedRevision || cloudHash !== metadata.lastSyncedPayloadHash : Boolean(row);
    const decision = decideSync({ baseline, local, cloud: cloudData, localHash, cloudHash, localChanged, cloudChanged });
    if (baseline && !row) {
      this.options.onStatus?.("離線／同步失敗", "雲端資料已不存在；未覆蓋本機資料。");
      return "aborted";
    }
    if (decision === "conflict" || decision === "initialize-local") {
      if (row && cloudData) this.options.onConflict?.({ userId: identity.uid, rowRevision: row.revision, cloudData });
      this.options.onStatus?.("衝突", "本機與雲端都有資料，請選擇保留哪一份。");
      return "conflict";
    }
    if (decision === "download-cloud" && row && cloudData && cloudHash) {
      if (await this.currentHash() !== localHash || !this.valid(identity)) {
        this.options.onStatus?.("衝突", "同步期間本機資料有新變更，未覆蓋本機。");
        return "conflict";
      }
      await this.options.save(cloudData);
      if (!this.valid(identity)) return "aborted";
      await this.options.setMetadata(identity.uid, { ownerUid: identity.uid, lastSyncedRevision: row.revision, lastSyncedPayloadHash: cloudHash, hashVersion: HASH_VERSION, lastSyncedAt: row.updated_at ?? new Date().toISOString() });
    } else if (decision === "initialize-empty") {
      const saved = await this.options.cloud.insert(identity.uid, createCloudPayload(local), 1);
      if (!this.valid(identity)) return "aborted";
      await this.options.setMetadata(identity.uid, { ownerUid: identity.uid, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: localHash, hashVersion: HASH_VERSION, lastSyncedAt: saved.updated_at ?? new Date().toISOString() });
    } else if (decision === "push-local" && row) {
      if (await this.currentHash() !== localHash || !this.valid(identity)) return "aborted";
      try {
        const saved = await this.options.cloud.casUpdate(identity.uid, row.revision, createCloudPayload(local));
        if (!this.valid(identity)) return "aborted";
        await this.options.setMetadata(identity.uid, { ownerUid: identity.uid, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: localHash, hashVersion: HASH_VERSION, lastSyncedAt: saved.updated_at ?? new Date().toISOString() });
      } catch {
        const latest = await this.options.cloud.read(identity.uid);
        const latestData = latest ? validateCloudPayload(latest.payload) : null;
        const latestHash = latestData ? await payloadHash(latestData) : undefined;
        if (!latestHash || latestHash !== localHash || !latest || !this.valid(identity)) {
          if (latest && latestData) this.options.onConflict?.({ userId: identity.uid, rowRevision: latest.revision, cloudData: latestData });
          this.options.onStatus?.("衝突", "雲端版本已變更，未覆蓋資料。");
          return "conflict";
        }
        await this.options.setMetadata(identity.uid, { ownerUid: identity.uid, lastSyncedRevision: latest.revision, lastSyncedPayloadHash: latestHash, hashVersion: HASH_VERSION, lastSyncedAt: latest.updated_at ?? new Date().toISOString() });
      }
    }
    if (!this.valid(identity)) return "aborted";
    this.options.onStatus?.("已同步");
    return "synced";
  }
}

export interface BrowserAuthContext {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: Pick<History, "replaceState">;
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const browserAuthContext = (): BrowserAuthContext => ({
  location: window.location,
  history: window.history,
  localStorage: window.localStorage,
});

function clearCallbackQuery(browser: BrowserAuthContext): void {
  browser.history.replaceState(null, "", `${browser.location.pathname}${browser.location.hash}`);
}

export async function startGoogleLogin(
  client: SupabaseClient = supabase,
  storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage,
  redirectTo: string = GOOGLE_REDIRECT_URL,
): Promise<string | null> {
  storage.setItem(PKCE_PENDING_KEY, "1");
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (!error) return null;
    storage.removeItem(PKCE_PENDING_KEY);
    return `Google 登入啟動失敗：${error.message}`;
  } catch (error) {
    storage.removeItem(PKCE_PENDING_KEY);
    return `Google 登入啟動失敗：${error instanceof Error ? error.message : "請重試。"}`;
  }
}

export async function finishPkceCallback(
  client: SupabaseClient = supabase,
  browser: BrowserAuthContext = browserAuthContext(),
): Promise<string | null> {
  const params = new URLSearchParams(browser.location.search);
  const hasCode = params.has("code");
  const hasError = browser.localStorage.getItem(PKCE_PENDING_KEY) === "1"
    && (params.has("error") || params.has("error_code") || params.has("error_description"));
  if (!hasCode && !hasError) return null;
  if (hasError) {
    browser.localStorage.removeItem(PKCE_PENDING_KEY);
    clearCallbackQuery(browser);
    return params.get("error") === "access_denied"
      ? "Google 登入已取消，請重試"
      : `Google 登入失敗：${params.get("error_description") ?? params.get("error") ?? "請重試。"}`;
  }
  if (browser.localStorage.getItem(PKCE_PENDING_KEY) !== "1") {
    browser.localStorage.removeItem(PKCE_PENDING_KEY);
    clearCallbackQuery(browser);
    return "Google 登入缺少本機驗證狀態，請在同一個瀏覽器重新嘗試。";
  }
  try {
    const { error } = await client.auth.exchangeCodeForSession(params.get("code")!);
    if (error) throw error;
    browser.localStorage.removeItem(PKCE_PENDING_KEY);
    clearCallbackQuery(browser);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google 登入驗證無法使用。";
    browser.localStorage.removeItem(PKCE_PENDING_KEY);
    clearCallbackQuery(browser);
    return `Google 登入驗證失敗：${message} 請在同一個瀏覽器重新嘗試。`;
  }
}
export async function currentUser(client: SupabaseClient = supabase): Promise<User | null> {
  const { data, error } = await client.auth.getUser();
  if (error && error.message !== "Auth session missing!") throw error;
  return data.user;
}

export interface SyncDecisionInput {
  baseline: boolean;
  local: AppData;
  cloud: AppData | null;
  localHash: string;
  cloudHash?: string;
  localChanged: boolean;
  cloudChanged: boolean;
}
export type SyncDecision = "initialize-empty" | "initialize-local" | "download-cloud" | "conflict" | "push-local" | "synced";
export function decideSync(input: SyncDecisionInput): SyncDecision {
  if (!input.baseline) {
    if (!input.cloud && input.local.games.length === 0) return "initialize-empty";
    if (!input.cloud && input.local.games.length > 0) return "initialize-local";
    if (input.cloud && input.local.games.length === 0) return "download-cloud";
    return "conflict";
  }
  if (!input.localChanged && !input.cloudChanged) return "synced";
  if (input.localChanged && !input.cloudChanged) return "push-local";
  if (!input.localChanged && input.cloudChanged) return "download-cloud";
  return "conflict";
}
