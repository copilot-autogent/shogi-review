import type { AppData, Game, IssueTag, Perspective, Reason, ReviewPoint } from "./model.js";
import { CATEGORY_MIGRATION, ISSUE_TAGS, PERSPECTIVES, REASONS } from "./model.js";
import { Position } from "tsshogi";
import { parseGame } from "./parser.js";

export interface Backup { schemaVersion: 3; exportedAt: string; data: AppData; }
type RecordValue = Record<string, unknown>;

export function createBackup(data: AppData, now = new Date()): Backup {
  return { schemaVersion: 3, exportedAt: now.toISOString(), data: globalThis.structuredClone(data) };
}

export function parseBackup(input: string): AppData {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("備份不是有效的 JSON。"); }
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)) {
    throw new Error("不支援的備份版本；需要 schemaVersion: 1、2 或 3。");
  }
  const data = migrateData(value.data, value.schemaVersion);
  validateData(data);
  return globalThis.structuredClone(data);
}

export function migrateData(value: unknown, version: number): AppData {
  if (!isRecord(value) || !Array.isArray(value.games)) throw new Error("備份資料結構不完整，未套用任何變更。");
  if (version === 3) return value as unknown as AppData;
  return { games: value.games.map((raw) => migrateGame(raw)) };
}

function migrateGame(raw: unknown): Game {
  if (!isRecord(raw)) throw new Error("備份含有無效棋局，未套用任何變更。");
  if (!Array.isArray(raw.reviewPoints)) throw new Error("備份缺少複盤資料，未套用任何變更。");
  const points = raw.reviewPoints.map((point) => migratePoint(point));
  return {
    id: string(raw.id), title: string(raw.title), sourceFormat: raw.sourceFormat as Game["sourceFormat"],
    sourceText: string(raw.sourceText), initialSfen: string(raw.initialSfen), sfens: requiredStrings(raw.sfens),
    moves: requiredStrings(raw.moves), canonicalHash: string(raw.canonicalHash), createdAt: string(raw.createdAt),
    reviewPoints: points,
    perspective: validPerspective(raw.perspective),
  };
}

function migratePoint(raw: unknown): ReviewPoint {
  if (!isRecord(raw)) throw new Error("備份含有無效複盤欄位，未套用任何變更。");
  for (const key of ["thinking", "tag", "candidates", "opponentResponse", "nextConsideration", "externalNotes", "legacyNotes"]) {
    if (typeof raw[key] !== "undefined" && typeof raw[key] !== "string") throw new Error("備份含有無效複盤文字，未套用任何變更。");
  }
    if (typeof raw.note !== "undefined" && typeof raw.note !== "string") throw new Error("備份含有無效複盤文字，未套用任何變更。");
  const legacy: string[] = [];
  const add = (label: string, key: string) => { const value = raw[key]; if (typeof value === "string" && value.trim()) legacy.push(`${label}：${value}`); };
  add("當時想法", "thinking"); add("標籤", "tag"); add("候選手", "candidates"); add("對手應手", "opponentResponse");
  const category = typeof raw.category === "string" ? raw.category : "";
  const mapped = CATEGORY_MIGRATION[category] ?? { reason: "其他" as const };
  if (category && !CATEGORY_MIGRATION[category]) legacy.push(`舊分類：${category}`);
  const reason = REASONS.includes(raw.reason as Reason) ? raw.reason as Reason : mapped.reason;
  if (typeof raw.issueTags !== "undefined" && (!Array.isArray(raw.issueTags) || raw.issueTags.some((tag) => !ISSUE_TAGS.includes(tag as IssueTag)))) {
    throw new Error("備份含有無效問題標籤，未套用任何變更。");
  }
  const tags = Array.isArray(raw.issueTags) ? raw.issueTags.filter((tag): tag is IssueTag => ISSUE_TAGS.includes(tag as IssueTag)) : [];
  if (mapped.tag && !tags.includes(mapped.tag)) tags.push(mapped.tag);
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note : (typeof raw.nextConsideration === "string" && raw.nextConsideration.trim() ? raw.nextConsideration : undefined);
  return {
    id: string(raw.id), ply: number(raw.ply), sfen: string(raw.sfen), reason, issueTags: tags,
    note, externalNotes: text(raw.externalNotes), legacyNotes: legacy.length ? legacy.join("\n") : text(raw.legacyNotes),
    createdAt: string(raw.createdAt),
  };
}

function validateData(data: AppData): void {
  if (!isRecord(data) || !Array.isArray(data.games)) throw new Error("備份資料結構不完整，未套用任何變更。");
  const ids = new Set<string>();
  const pointIds = new Set<string>();
  for (const game of data.games) {
    if (!isRecord(game) || typeof game.id !== "string" || typeof game.title !== "string" || typeof game.createdAt !== "string" ||
      ids.has(game.id) || !["KIF", "KI2", "CSA"].includes(game.sourceFormat as string) ||
      typeof game.sourceText !== "string" || typeof game.initialSfen !== "string" || !Position.isValidSFEN(game.initialSfen) ||
      !strings(game.sfens) || !strings(game.moves) || game.sfens.length !== game.moves.length + 1 ||
      game.sfens[0] !== game.initialSfen || !game.sfens.every((sfen) => Position.isValidSFEN(sfen)) || !Array.isArray(game.reviewPoints)) {
      throw new Error("備份含有無效棋局或重複 ID，未套用任何變更。");
    }
    if (typeof game.perspective !== "undefined" && !PERSPECTIVES.includes(game.perspective as Perspective)) {
      throw new Error("備份含有無效執棋方，未套用任何變更。");
    }
    ids.add(game.id);
    try {
      const reconstructed = parseGame(game.sourceText, game.sourceFormat, game.title);
      if (reconstructed.canonicalHash !== game.canonicalHash || reconstructed.moves.join("|") !== game.moves.join("|") ||
        reconstructed.sfens.join("|") !== game.sfens.join("|")) throw new Error("棋譜與局面快照不一致；請重新匯入原始棋譜。");
    } catch (error) { throw new Error(`備份棋譜驗證失敗：${error instanceof Error ? error.message : "內容不一致"}。`); }
    for (const point of game.reviewPoints) {
      if (!isRecord(point) || typeof point.id !== "string" || pointIds.has(point.id) || !Number.isInteger(point.ply) ||
        point.ply < 0 || point.ply >= game.sfens.length || point.sfen !== game.sfens[point.ply] || !REASONS.includes(point.reason as Reason) ||
        !Array.isArray(point.issueTags) || point.issueTags.some((tag) => !ISSUE_TAGS.includes(tag as IssueTag)) ||
        (typeof point.note !== "undefined" && typeof point.note !== "string") ||
        (typeof point.externalNotes !== "undefined" && typeof point.externalNotes !== "string") ||
        (typeof point.legacyNotes !== "undefined" && typeof point.legacyNotes !== "string") ||
        typeof point.createdAt !== "string") {
        throw new Error("備份含有無效複盤欄位，未套用任何變更。");
      }
      pointIds.add(point.id);
    }
  }
}

function validPerspective(value: unknown): Perspective | undefined {
  if (typeof value === "undefined") return undefined;
  if (PERSPECTIVES.includes(value as Perspective)) return value as Perspective;
  throw new Error("備份含有無效執棋方，未套用任何變更。");
}

function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null; }
function string(value: unknown): string { if (typeof value !== "string") throw new Error("備份含有無效文字，未套用任何變更。"); return value; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("備份含有無效數字，未套用任何變更。"); return value; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function requiredStrings(value: unknown): string[] { if (!strings(value)) throw new Error("備份含有無效文字，未套用任何變更。"); return value; }
