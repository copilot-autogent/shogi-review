import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createBackup, parseBackup } from "./backup.js";
import type { AppData } from "./model.js";

export const SUPABASE_URL = "https://yuymtghhqszcfbhhhhyq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_n2OiqY7tvxchr2rnhObTlA_uGUG7z1E";
export const HASH_VERSION = 1;
export const GOOGLE_REDIRECT_URL = "https://copilot-autogent.github.io/shogi-review/";
export const PKCE_PENDING_KEY = "shogi-review-pkce-pending";

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
export type SyncStatus = "僅本機" | "尚未同步" | "已同步" | "衝突" | "離線／同步失敗";

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
): Promise<string | null> {
  storage.setItem(PKCE_PENDING_KEY, "1");
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: GOOGLE_REDIRECT_URL },
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
  const hasError = params.has("error") || params.has("error_code") || params.has("error_description");
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
