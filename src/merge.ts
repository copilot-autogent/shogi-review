import { ISSUE_TAGS, type AppData, type Game, type IssueTag, type ReviewPoint } from "./model.js";

export type MergeEntity = "game" | "review";
export interface MergeConflict {
  entity: MergeEntity;
  entityId: string;
  field: string;
  path: string;
  base: unknown;
  local: unknown;
  cloud: unknown;
  reason: "field" | "identity" | "membership" | "duplicate-ply";
}
export interface MergeResult {
  data: AppData;
  conflicts: MergeConflict[];
  changed: boolean;
}

const clone = <T>(value: T): T => globalThis.structuredClone(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}
function tags(value: IssueTag[] | undefined): IssueTag[] {
  const set = new Set(value ?? []);
  return ISSUE_TAGS.filter((tag) => set.has(tag));
}
function normalizePoint(point: ReviewPoint): ReviewPoint {
  const result = clone(point);
  result.issueTags = tags(result.issueTags);
  result.note = optional(result.note);
  result.externalNotes = optional(result.externalNotes);
  result.legacyNotes = optional(result.legacyNotes);
  if (result.note === undefined) delete result.note;
  if (result.externalNotes === undefined) delete result.externalNotes;
  if (result.legacyNotes === undefined) delete result.legacyNotes;
  return result;
}
function normalizeGame(game: Game): Game {
  const result = clone(game);
  result.reviewPoints = result.reviewPoints.map(normalizePoint).sort(reviewOrder);
  if (result.perspective === undefined) delete result.perspective;
  return result;
}
function reviewOrder(a: ReviewPoint, b: ReviewPoint): number {
  return a.ply - b.ply || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
function gameOrder(a: Game, b: Game): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
function validateSide(data: AppData, label: string): void {
  const gameIds = new Set<string>();
  for (const game of data.games) {
    if (gameIds.has(game.id)) throw new Error(`${label} 含有重複棋局 ID。`);
    gameIds.add(game.id);
    const plies = new Set<number>();
    for (const point of game.reviewPoints) {
      if (plies.has(point.ply)) throw new Error(`${label} 的棋局 ${game.id} 每回合只能有一個複盤局面。`);
      plies.add(point.ply);
    }
  }
}
function validRepresentation(game: Game): boolean {
  return Boolean(game.canonicalHash && game.initialSfen && game.sfens.length === game.moves.length + 1 && game.sfens[0] === game.initialSfen);
}
function sameIdentity(a: Game, b: Game): boolean {
  return a.canonicalHash === b.canonicalHash && a.initialSfen === b.initialSfen
    && stable(a.sfens) === stable(b.sfens) && stable(a.moves) === stable(b.moves);
}
function representationRank(game: Game): [number, string, string] {
  const format = { KIF: 0, KI2: 1, CSA: 2 }[game.sourceFormat];
  return [format, game.sourceText, game.id];
}
function chooseRepresentation(...games: Game[]): Game {
  return games.filter(validRepresentation).sort((a, b) => {
    const ar = representationRank(a); const br = representationRank(b);
    return ar[0] - br[0] || ar[1].localeCompare(br[1]) || ar[2].localeCompare(br[2]);
  })[0] ?? games[0]!;
}
function conflict(conflicts: MergeConflict[], entity: MergeEntity, id: string, field: string, base: unknown, local: unknown, cloud: unknown, reason: MergeConflict["reason"] = "field"): void {
  conflicts.push({ entity, entityId: id, field, path: `${entity}:${id}:${field}`, base, local, cloud, reason });
}
function mergeScalar<T>(entity: MergeEntity, id: string, field: string, base: T, local: T, cloud: T, conflicts: MergeConflict[]): T {
  const b = typeof base === "string" ? optional(base) : base;
  const l = typeof local === "string" ? optional(local) : local;
  const c = typeof cloud === "string" ? optional(cloud) : cloud;
  if (stable(l) === stable(c)) return l as T;
  if (stable(l) === stable(b)) return c as T;
  if (stable(c) === stable(b)) return l as T;
  conflict(conflicts, entity, id, field, b, l, c);
  return stable(l) <= stable(c) ? l as T : c as T;
}
function mergeTags(id: string, base: IssueTag[], local: IssueTag[], cloud: IssueTag[], conflicts: MergeConflict[]): IssueTag[] {
  const result: IssueTag[] = [];
  for (const tag of ISSUE_TAGS) {
    const merged = mergeScalar("review", id, `issueTags.${tag}`, base.includes(tag), local.includes(tag), cloud.includes(tag), conflicts);
    if (merged) result.push(tag);
  }
  return result;
}
function coreGame(base: Game | undefined, local: Game, cloud: Game, conflicts: MergeConflict[]): Game {
  if (!sameIdentity(local, cloud)) {
    conflict(conflicts, "game", local.id, "identity", base && { canonicalHash: base.canonicalHash, initialSfen: base.initialSfen, sfens: base.sfens, moves: base.moves }, local, cloud, "identity");
  }
  const representation = base ? clone(base) : chooseRepresentation(local, cloud);
  const result = normalizeGame(representation);
  result.title = mergeScalar("game", local.id, "title", base?.title, local.title, cloud.title, conflicts) ?? local.title;
  result.perspective = mergeScalar("game", local.id, "perspective", base?.perspective, local.perspective, cloud.perspective, conflicts);
  result.createdAt = base?.createdAt ?? [local.createdAt, cloud.createdAt].sort()[0]!;
  return result;
}
function mergeReviews(base: ReviewPoint | undefined, local: ReviewPoint, cloud: ReviewPoint, conflicts: MergeConflict[]): ReviewPoint {
  const identity = base?.id ?? [local.id, cloud.id].sort()[0]!;
  if (local.sfen !== cloud.sfen || local.createdAt !== cloud.createdAt) {
    conflict(conflicts, "review", identity, "anchor", base && { sfen: base.sfen, createdAt: base.createdAt }, local, cloud, "identity");
  }
  const result = normalizePoint(base ?? (stable(local) <= stable(cloud) ? local : cloud));
  result.id = identity;
  result.ply = local.ply;
  result.sfen = base?.sfen ?? local.sfen;
  result.createdAt = base?.createdAt ?? [local.createdAt, cloud.createdAt].sort()[0]!;
  result.reason = mergeScalar("review", identity, "reason", base?.reason, local.reason, cloud.reason, conflicts) ?? local.reason;
  result.note = mergeScalar("review", identity, "note", base?.note, local.note, cloud.note, conflicts);
  result.externalNotes = mergeScalar("review", identity, "externalNotes", base?.externalNotes, local.externalNotes, cloud.externalNotes, conflicts);
  result.legacyNotes = mergeScalar("review", identity, "legacyNotes", base?.legacyNotes, local.legacyNotes, cloud.legacyNotes, conflicts);
  result.issueTags = mergeTags(identity, tags(base?.issueTags), tags(local.issueTags), tags(cloud.issueTags), conflicts);
  return normalizePoint(result);
}
function mergeMembership<T extends { id: string }>(
  entity: MergeEntity, id: string, base: T | undefined, local: T | undefined, cloud: T | undefined,
  mergeBoth: (base: T | undefined, local: T, cloud: T) => T, conflicts: MergeConflict[],
): T | undefined {
  if (!base) {
    if (local && cloud) return mergeBoth(undefined, local, cloud);
    return clone(local ?? cloud);
  }
  if (!local && !cloud) return undefined;
  if (!local && cloud) {
    if (stable(cloud) === stable(base)) return undefined;
    conflict(conflicts, entity, id, "__membership", base, local, cloud, "membership");
    return clone(cloud);
  }
  if (local && !cloud) {
    if (stable(local) === stable(base)) return undefined;
    conflict(conflicts, entity, id, "__membership", base, local, cloud, "membership");
    return clone(local);
  }
  return mergeBoth(base, local!, cloud!);
}
function mergeGame(base: Game | undefined, local: Game | undefined, cloud: Game | undefined, conflicts: MergeConflict[]): Game | undefined {
  const id = base?.id ?? local?.id ?? cloud?.id;
  if (!id) return undefined;
  const game = mergeMembership("game", id, base, local, cloud, (ancestor, left, right) => coreGame(ancestor, left, right, conflicts), conflicts);
  if (!game) return undefined;
  const basePoints = new Map((base?.reviewPoints ?? []).map((point) => [point.ply, point]));
  const localPoints = new Map((local?.reviewPoints ?? []).map((point) => [point.ply, point]));
  const cloudPoints = new Map((cloud?.reviewPoints ?? []).map((point) => [point.ply, point]));
  const plies = [...new Set([...basePoints.keys(), ...localPoints.keys(), ...cloudPoints.keys()])].sort((a, b) => a - b);
  game.reviewPoints = plies.flatMap((ply) => {
    const point = mergeMembership("review", `${id}:${ply}`, basePoints.get(ply), localPoints.get(ply), cloudPoints.get(ply), (ancestor, left, right) => mergeReviews(ancestor, left, right, conflicts), conflicts);
    return point ? [point] : [];
  }).sort(reviewOrder);
  return normalizeGame(game);
}
export function canonicalizeAppData(data: AppData): AppData {
  validateSide(data, "資料");
  return { games: clone(data.games).map(normalizeGame).sort(gameOrder) };
}
export function validateMergeInput(data: AppData, label = "資料"): AppData {
  validateSide(data, label);
  for (const game of data.games) if (!validRepresentation(game)) throw new Error(`${label} 的棋局 ${game.id} 代表資料無法重建身分。`);
  return canonicalizeAppData(data);
}
export function mergeAppData(base: AppData, local: AppData, cloud: AppData): MergeResult {
  const ancestor = validateMergeInput(base, "基準");
  const left = validateMergeInput(local, "本機");
  const right = validateMergeInput(cloud, "雲端");
  const conflicts: MergeConflict[] = [];
  const baseGames = new Map(ancestor.games.map((game) => [game.id, game]));
  const localGames = new Map(left.games.map((game) => [game.id, game]));
  const cloudGames = new Map(right.games.map((game) => [game.id, game]));
  const ids = [...new Set([...baseGames.keys(), ...localGames.keys(), ...cloudGames.keys()])].sort();
  const games = ids.flatMap((id) => {
    const game = mergeGame(baseGames.get(id), localGames.get(id), cloudGames.get(id), conflicts);
    return game ? [game] : [];
  }).sort(gameOrder);
  const data = canonicalizeAppData({ games });
  return { data, conflicts, changed: stable(data) !== stable(canonicalizeAppData(left)) };
}
