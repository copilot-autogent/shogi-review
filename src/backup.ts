import type { AppData } from "./model.js";
import { Position } from "tsshogi";

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
    if (!isRecord(game) || typeof game.id !== "string" || typeof game.title !== "string" ||
        !["KIF", "KI2", "CSA"].includes(String(game.sourceFormat)) || typeof game.sourceText !== "string" ||
        typeof game.initialSfen !== "string" || !Position.isValidSFEN(game.initialSfen) ||
        !arrayOfStrings(game.sfens) || !arrayOfStrings(game.moves) || typeof game.canonicalHash !== "string" ||
        typeof game.createdAt !== "string" || !Array.isArray(game.reviewPoints) || !Array.isArray(game.cards) ||
        game.sfens[0] !== game.initialSfen || game.sfens.length !== game.moves.length + 1 ||
        !game.sfens.every((sfen) => Position.isValidSFEN(sfen)) ||
        !game.reviewPoints.every(validReviewPoint) || !game.cards.every(validCard)) {
      throw new Error("備份含有無效棋局，未套用任何變更。");
    }
    const sfens = game.sfens as string[];
    const reviewPoints = game.reviewPoints as unknown[];
    const pointIds = new Set<string>();
    if (reviewPoints.some((point) => {
      if (!isRecord(point) || typeof point.ply !== "number" || point.ply < 0 || point.ply >= sfens.length ||
        (typeof point.category !== "undefined" && (typeof point.category !== "string" || !["序盤知識", "候選手不足", "漏算對手強手", "戰術", "終盤", "時間管理", "其他"].includes(point.category as string))) ||
        ["tag", "candidates", "opponentResponse", "externalNotes"].some((key) => typeof point[key] !== "undefined" && typeof point[key] !== "string") ||
        typeof point.id !== "string" || pointIds.has(point.id) || point.sfen !== sfens[point.ply]) return true;
      pointIds.add(point.id);
      return false;
    })) {
      throw new Error("備份含有無效複盤欄位，未套用任何變更。");
    }
    const cardIds = new Set<string>();
    if ((game.cards as unknown[]).some((card) => {
      if (!isRecord(card) || typeof card.reviewPointId !== "string" || !pointIds.has(card.reviewPointId) ||
        typeof card.id !== "string" || cardIds.has(card.id) || !/^\d{4}-\d{2}-\d{2}$/.test(String(card.dueDate)) ||
        Number.isNaN(Date.parse(`${card.dueDate}T00:00:00Z`)) ||
        new Date(`${card.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== card.dueDate) return true;
      cardIds.add(card.id);
      return false;
    })) {
      throw new Error("備份含有找不到複盤點的卡片，未套用任何變更。");
    }
  }
  return globalThis.structuredClone(data as AppData);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function arrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function validReviewPoint(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && Number.isInteger(value.ply) &&
    typeof value.sfen === "string" && Position.isValidSFEN(value.sfen) && typeof value.thinking === "string" &&
    typeof value.nextConsideration === "string" && typeof value.createdAt === "string";
}
function validCard(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.reviewPointId === "string" &&
    typeof value.dueDate === "string" && typeof value.interval === "number" && [1, 3, 7, 14].includes(value.interval) && typeof value.createdAt === "string";
}
