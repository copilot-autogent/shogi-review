import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createBackup, parseBackup } from "./backup.js";
import type { AppData } from "./model.js";

export const SUPABASE_URL = "https://yuymtghhqszcfbhhhhyq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_n2OiqY7tvxchr2rnhObTlA_uGUG7z1E";
export const HASH_VERSION = 1;

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

export async function finishPkceCallback(client: SupabaseClient = supabase): Promise<string | null> {
  if (!location.search.includes("code=")) return null;
  if (window.localStorage.getItem("shogi-review-pkce-pending") !== "1") {
    window.history.replaceState(null, "", location.pathname);
    return "登入連結缺少本機驗證狀態，請在同一個瀏覽器重新寄送登入連結。";
  }
  try {
    const { error } = await client.auth.exchangeCodeForSession(new URLSearchParams(location.search).get("code")!);
    if (error) throw error;
    window.localStorage.removeItem("shogi-review-pkce-pending");
    window.history.replaceState(null, "", `${location.pathname}${location.hash}`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "登入連結無法使用。";
    window.history.replaceState(null, "", location.pathname);
    return `登入驗證失敗：${message} 請在同一個瀏覽器重新寄送登入連結。`;
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
