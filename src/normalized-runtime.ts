import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppData, Game, RecommendedMove, ReviewPoint } from "./model.js";
import type { NormalizedGame, NormalizedReviewPoint } from "./normalized.js";

type Row = Record<string, unknown>;
type NormalizedRecommendationRow = { id: string; pointId: string; move: string; comment: string | null; sortOrder: number; version: number };
type NormalizedGameWithPoints = NormalizedGame & { reviewPoints: NormalizedReviewPoint[] };

export interface NormalizedCache {
  read(userId: string): Promise<AppData | null>;
  write(userId: string, data: AppData): Promise<void>;
}

export class MemoryNormalizedCache implements NormalizedCache {
  private readonly values = new Map<string, AppData>();
  async read(userId: string): Promise<AppData | null> {
    const value = this.values.get(userId);
    return value ? globalThis.structuredClone(value) : null;
  }
  async write(userId: string, data: AppData): Promise<void> {
    this.values.set(userId, globalThis.structuredClone(data));
  }
}

export class IndexedDbNormalizedCache implements NormalizedCache {
    private readonly dbPromise: Promise<IDBDatabase>;
    constructor(name = "shogi-review-normalized-cache") {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("accounts")) request.result.createObjectStore("accounts");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("本機雲端快取開啟失敗。"));
      });
    }
    async read(userId: string): Promise<AppData | null> {
      const db = await this.dbPromise;
      return new Promise((resolve, reject) => {
        const request = db.transaction("accounts").objectStore("accounts").get(userId);
        request.onsuccess = () => {
          try {
            resolve(request.result === undefined ? null : request.result as AppData);
          } catch (error) {
            reject(error instanceof Error ? error : new Error("本機雲端快取格式無效。"));
          }
        };
        request.onerror = () => reject(request.error ?? new Error("讀取本機雲端快取失敗。"));
      });
    }
    async write(userId: string, data: AppData): Promise<void> {
      const db = await this.dbPromise;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("accounts", "readwrite");
        transaction.objectStore("accounts").put(globalThis.structuredClone(data), userId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("更新本機雲端快取失敗。"));
        transaction.onabort = () => reject(transaction.error ?? new Error("本機雲端快取交易已取消。"));
      });
    }
  }
function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`normalized row is missing ${key}`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`normalized row is missing ${key}`);
  return value;
}

function mapRecommendation(row: Row): NormalizedRecommendationRow {
  return {
    id: rowString(row, "id"),
    pointId: rowString(row, "point_id"),
    move: rowString(row, "move"),
    comment: typeof row.comment === "string" ? row.comment : null,
    sortOrder: rowNumber(row, "sort_order"),
    version: rowNumber(row, "version"),
  };
}

function mapPoint(row: Row, recommendations: Map<string, NormalizedRecommendationRow[]>): NormalizedReviewPoint {
  const point: NormalizedReviewPoint = {
    id: rowString(row, "id"),
    gameId: rowString(row, "game_id"),
    ply: rowNumber(row, "ply"),
    sfen: rowString(row, "sfen"),
    reason: rowString(row, "reason") as ReviewPoint["reason"],
    issueTags: Array.isArray(row.issue_tags) ? row.issue_tags.filter((tag): tag is ReviewPoint["issueTags"][number] => typeof tag === "string") : [],
    notes: typeof row.notes === "string" ? row.notes : null,
    ...(typeof row.external_notes === "string" ? { externalNotes: row.external_notes } : {}),
    ...(typeof row.legacy_notes === "string" ? { legacyNotes: row.legacy_notes } : {}),
    recommendedMoves: recommendations.get(rowString(row, "id")) ?? [],
    createdAt: rowString(row, "created_at_text"),
    sourceOrder: rowNumber(row, "source_order"),
    version: rowNumber(row, "version"),
  };
  return point;
}

function mapGame(row: Row, points: Map<string, NormalizedReviewPoint[]>): NormalizedGameWithPoints {
  const perspective = row.perspective;
  return {
    id: rowString(row, "id"),
    title: rowString(row, "title"),
    sourceFormat: rowString(row, "source_format") as Game["sourceFormat"],
    sourceText: rowString(row, "source_text"),
    initialSfen: rowString(row, "initial_sfen"),
    sfens: Array.isArray(row.sfens) ? row.sfens.filter((item): item is string => typeof item === "string") : [],
    moves: Array.isArray(row.moves) ? row.moves.filter((item): item is string => typeof item === "string") : [],
    canonicalHash: rowString(row, "canonical_hash"),
    createdAt: rowString(row, "created_at_text"),
    perspective: typeof perspective === "string" ? perspective as NonNullable<Game["perspective"]> : null,
    perspectivePresent: row.perspective_present === true,
    sourceOrder: rowNumber(row, "source_order"),
    version: rowNumber(row, "version"),
    reviewPoints: points.get(rowString(row, "id")) ?? [],
  };
}

function assertOne<T>(rows: readonly T[] | null, message: string): T {
  if (!rows || rows.length !== 1) throw new Error(message);
  return rows[0]!;
}

export class SupabaseNormalizedRuntime {
  private readonly versions = new Map<string, number>();
  constructor(private readonly client: SupabaseClient, private readonly userId: string, private readonly cache?: NormalizedCache) {}

  private async rows(table: string): Promise<Row[]> {
    const result = await this.client.from(table).select("*").eq("user_id", this.userId);
    if (result.error) throw result.error;
    return (result.data ?? []) as Row[];
  }

  async load(): Promise<AppData> {
    const [games, points, recommendations] = await Promise.all([
      this.rows("games"),
      this.rows("review_points"),
      this.rows("recommended_moves"),
    ]);
    const recommendationMap = new Map<string, ReturnType<typeof mapRecommendation>[]>();
    for (const row of recommendations) {
      const item = mapRecommendation(row);
      const current = recommendationMap.get(item.pointId) ?? [];
      current.push(item);
      recommendationMap.set(item.pointId, current);
    }
    for (const items of recommendationMap.values()) items.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    const pointMap = new Map<string, NormalizedReviewPoint[]>();
    for (const row of points) {
      const point = mapPoint(row, recommendationMap);
      const current = pointMap.get(point.gameId) ?? [];
      current.push(point);
      pointMap.set(point.gameId, current);
    }
    for (const items of pointMap.values()) items.sort((a, b) => a.sourceOrder - b.sourceOrder || a.ply - b.ply || a.id.localeCompare(b.id));
    const mapped = games.map((row) => mapGame(row, pointMap)).sort((a, b) => a.sourceOrder - b.sourceOrder || a.id.localeCompare(b.id));
    for (const row of games) this.versions.set(`games:${rowString(row, "id")}`, rowNumber(row, "version"));
    for (const row of points) this.versions.set(`review_points:${rowString(row, "id")}`, rowNumber(row, "version"));
    for (const row of recommendations) this.versions.set(`recommended_moves:${rowString(row, "id")}`, rowNumber(row, "version"));
    const data: AppData = {
      games: mapped.map(({ version: _version, sourceOrder: _sourceOrder, perspectivePresent, perspective, reviewPoints, ...game }) => ({
        ...game,
        reviewPoints: reviewPoints.map(({ version: _version, sourceOrder: _sourceOrder, gameId: _gameId, notes, ...point }) => ({
          ...point,
          ...(notes ? { note: notes } : {}),
          recommendedMoves: point.recommendedMoves.map(({ pointId: _pointId, sortOrder: _sortOrder, version: _version, comment, ...item }) => ({
            ...item,
            ...(comment === null ? {} : { comment }),
          })),
        })),
        ...(perspectivePresent && perspective ? { perspective } : {}),
      })),
    };
    if (this.cache) await this.cache.write(this.userId, data);
    return data;
  }

  async loadCached(): Promise<AppData | null> {
    return this.cache?.read(this.userId) ?? null;
  }

  async createGame(game: Game): Promise<void> {
    const result = await this.client.from("games").insert({
      user_id: this.userId, id: game.id, title: game.title, source_format: game.sourceFormat, source_text: game.sourceText,
      initial_sfen: game.initialSfen, sfens: game.sfens, moves: game.moves, canonical_hash: game.canonicalHash,
      created_at_text: game.createdAt, perspective: game.perspective ?? null, perspective_present: game.perspective !== undefined,
      source_order: Number.isFinite(Date.parse(game.createdAt)) ? Date.parse(game.createdAt) : 0,
    }).select("*");
    if (result.error) throw result.error;
    assertOne(result.data as Row[] | null, "normalized game insert was not confirmed");
    try {
      for (const point of game.reviewPoints) await this.createPoint(game.id, point);
    } catch (error) {
      try {
        await this.deleteGame(game.id, 1);
      } catch (cleanupError) {
        throw new Error("棋局匯入失敗，且清理部分資料也失敗。", { cause: cleanupError });
      }
      throw error;
    }
  }

  async updateGame(game: Game, expectedVersion = this.version("games", game.id)): Promise<void> {
    await this.cas("games", game.id, expectedVersion, {
      title: game.title, perspective: game.perspective ?? null, perspective_present: game.perspective !== undefined,
    });
  }

  async deleteGame(gameId: string, expectedVersion = this.version("games", gameId)): Promise<void> {
    await this.cas("games", gameId, expectedVersion, undefined, "delete");
  }

  async createPoint(gameId: string, point: ReviewPoint): Promise<void> {
    const result = await this.client.from("review_points").insert({
      user_id: this.userId, id: point.id, game_id: gameId, ply: point.ply, sfen: point.sfen, reason: point.reason,
      issue_tags: point.issueTags, notes: point.note ?? null, external_notes: point.externalNotes ?? null,
      legacy_notes: point.legacyNotes ?? null, created_at_text: point.createdAt, source_order: point.ply,
    }).select("*");
    if (result.error) throw result.error;
    assertOne(result.data as Row[] | null, "normalized review point insert was not confirmed");
    try {
      for (const [sortOrder, recommendation] of (point.recommendedMoves ?? []).entries()) await this.createRecommendation(point.id, recommendation, sortOrder);
    } catch (error) {
      try {
        await this.deletePoint(point.id, 1);
      } catch (cleanupError) {
        throw new Error("複盤局面匯入失敗，且清理部分資料也失敗。", { cause: cleanupError });
      }
      throw error;
    }
  }

  async updatePoint(point: ReviewPoint, gameId: string, expectedVersion = this.version("review_points", point.id)): Promise<void> {
    await this.cas("review_points", point.id, expectedVersion, {
      game_id: gameId, ply: point.ply, sfen: point.sfen, reason: point.reason, issue_tags: point.issueTags,
      notes: point.note ?? null, external_notes: point.externalNotes ?? null, legacy_notes: point.legacyNotes ?? null,
    });
  }

  async deletePoint(pointId: string, expectedVersion = this.version("review_points", pointId)): Promise<void> {
    await this.cas("review_points", pointId, expectedVersion, undefined, "delete");
  }

  async createRecommendation(pointId: string, recommendation: RecommendedMove, sortOrder: number): Promise<void> {
    const result = await this.client.from("recommended_moves").insert({
      user_id: this.userId, id: recommendation.id, point_id: pointId, move: recommendation.move,
      comment: recommendation.comment ?? null, sort_order: sortOrder,
    }).select("*");
    if (result.error) throw result.error;
    assertOne(result.data as Row[] | null, "normalized recommendation insert was not confirmed");
  }

  async updateRecommendation(recommendation: RecommendedMove, pointId: string, sortOrder: number, expectedVersion = this.version("recommended_moves", recommendation.id)): Promise<void> {
    await this.cas("recommended_moves", recommendation.id, expectedVersion, {
      point_id: pointId, move: recommendation.move, comment: recommendation.comment ?? null, sort_order: sortOrder,
    });
  }

  async deleteRecommendation(id: string, expectedVersion = this.version("recommended_moves", id)): Promise<void> {
    await this.cas("recommended_moves", id, expectedVersion, undefined, "delete");
  }

  async syncRecommendations(pointId: string, previous: readonly RecommendedMove[], next: readonly RecommendedMove[]): Promise<void> {
    const nextIds = new Set(next.map((item) => item.id));
    try {
      for (const item of previous) {
        if (!nextIds.has(item.id)) await this.deleteRecommendation(item.id);
      }
      for (const [sortOrder, item] of next.entries()) {
        const old = previous.find((candidate) => candidate.id === item.id);
        if (!old) await this.createRecommendation(pointId, item, sortOrder);
        else await this.updateRecommendation(item, pointId, sortOrder);
      }
    } catch (error) {
      throw new Error("推薦手更新未完整套用；已停止後續修改，請重新載入確認目前狀態。", { cause: error });
    }
  }

  private async cas(table: string, id: string, expectedVersion: number, values?: Row, operation: "update" | "delete" = "update"): Promise<void> {
    const query = operation === "delete"
      ? this.client.from(table).delete().eq("user_id", this.userId).eq("id", id).eq("version", expectedVersion).select("id,version")
      : this.client.from(table).update({ ...values, version: expectedVersion + 1 }).eq("user_id", this.userId).eq("id", id).eq("version", expectedVersion).select("id,version");
    const result = await query;
    if (result.error) throw result.error;
    const rows = result.data as Row[] | null;
    if (!rows || rows.length !== 1) throw new Error("資料版本已變更或已刪除，請重新載入後再試。");
    if (operation === "update") this.versions.set(`${table}:${id}`, expectedVersion + 1);
  }
  private version(table: string, id: string): number {
    const version = this.versions.get(`${table}:${id}`);
    if (version === undefined) throw new Error("資料版本未載入，請重新載入後再試。");
    return version;
  }
}

export async function refreshNormalizedCache(runtime: SupabaseNormalizedRuntime): Promise<AppData> {
  return runtime.load();
}
