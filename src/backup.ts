import type { AppData } from "./model.js";

export interface Backup { schemaVersion: 1; exportedAt: string; data: AppData; }

export function createBackup(data: AppData, now = new Date()): Backup {
  return { schemaVersion: 1, exportedAt: now.toISOString(), data: globalThis.structuredClone(data) };
}

export function parseBackup(input: string): AppData {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("備份不是有效的 JSON。"); }
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("不支援的備份版本；需要 schemaVersion: 1。");
  }
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !Array.isArray((data as { games?: unknown }).games)) {
    throw new Error("備份資料結構不完整，未套用任何變更。");
  }
  for (const game of (data as { games: unknown[] }).games) {
    if (!game || typeof game !== "object" || typeof (game as { id?: unknown }).id !== "string" ||
        !Array.isArray((game as { sfens?: unknown }).sfens) || !Array.isArray((game as { reviewPoints?: unknown }).reviewPoints) ||
        !Array.isArray((game as { cards?: unknown }).cards)) {
      throw new Error("備份含有無效棋局，未套用任何變更。");
    }
  }
  return globalThis.structuredClone(data as AppData);
}
