import type { SupabaseClient } from "@supabase/supabase-js";
import { parseBackup, type Backup } from "./backup.js";
import type { AppData, Game, IssueTag, Perspective, Reason, ReviewPoint } from "./model.js";
import { canonicalData, payloadHash } from "./sync.js";

/** Phase A is intentionally dormant; main.ts does not import this module. */
export const NORMALIZED_STORAGE = false;

export interface NormalizedGame extends Omit<Game, "reviewPoints" | "perspective"> {
  perspective: Perspective | null;
  perspectivePresent: boolean;
  version: number;
}
export interface NormalizedReviewPoint extends Omit<ReviewPoint, "recommendedMoves" | "note"> {
  gameId: string;
  notes: string | null;
  recommendedMoves: NormalizedRecommendation[];
  version: number;
}
export interface NormalizedRecommendation {
  id: string;
  pointId: string;
  move: string;
  comment: string | null;
  sortOrder: number;
  version: number;
}
export interface NormalizedMutation<T> {
  value: T;
  expectedVersion: number;
}
export interface NormalizedRepository {
  replaceGame(input: NormalizedMutation<NormalizedGame>): Promise<NormalizedGame>;
  replaceReviewPoint(input: NormalizedMutation<NormalizedReviewPoint>): Promise<NormalizedReviewPoint>;
  replaceRecommendation(input: NormalizedMutation<NormalizedRecommendation>): Promise<NormalizedRecommendation>;
}

export interface LegacyStateRow { user_id: string; payload: unknown; revision: number; updated_at?: string; }
export interface AuditResult { ok: boolean; issues: string[]; counts?: Record<string, number>; }
export interface MigrationResult { status: string; counts: Record<string, number>; source_hash: string; }
export interface NormalizedMigrationClient {
  readLegacy(): Promise<LegacyStateRow | null>;
  audit(): Promise<AuditResult>;
  migrate(sourceHash: string): Promise<MigrationResult>;
  export(): Promise<Backup>;
  verify(sourceHash: string, targetHash: string): Promise<{ status: string; target_hash: string }>;
  finalize(): Promise<{ status: string }>;
  rollback(payload: unknown, sourceHash: string): Promise<{ status: string }>;
}

export function normalizedStorageEnabled(): boolean {
  return NORMALIZED_STORAGE;
}

export async function semanticSourceHash(payload: string): Promise<string> {
  return payloadHash(parseBackup(payload));
}

export function semanticSource(payload: unknown): AppData {
  return parseBackup(JSON.stringify(payload));
}

export function canonicalNormalizedData(data: AppData): string {
  return canonicalData(data);
}

export function createNormalizedMigrationClient(client: SupabaseClient, userId: string): NormalizedMigrationClient {
  const rpc = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const result = await client.rpc(fn, args);
    if (result.error) throw result.error;
    return result.data as T;
  };
  return {
    async readLegacy() {
      const { data, error } = await client.from("user_state").select("user_id,payload,revision,updated_at").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data as LegacyStateRow | null;
    },
    audit: () => rpc<AuditResult>("audit_my_state_v1"),
    migrate: (sourceHash) => rpc<MigrationResult>("migrate_my_state_v1", { source_hash: sourceHash }),
    export: () => rpc<Backup>("export_my_state_v3"),
    verify: (sourceHash, targetHash) => rpc("verify_my_migration", { source_hash: sourceHash, target_hash: targetHash }),
    finalize: () => rpc("finalize_my_cutover"),
    rollback: (payload, sourceHash) => rpc("rollback_my_cutover", { payload, target_hash: sourceHash }),
  };
}

export async function prepareNormalizedMigration(client: NormalizedMigrationClient): Promise<{
  legacy: LegacyStateRow;
  data: AppData;
  sourceHash: string;
}> {
  const legacy = await client.readLegacy();
  if (!legacy) throw new Error("legacy user_state row is missing");
  const data = semanticSource(legacy.payload);
  return { legacy, data, sourceHash: await payloadHash(data) };
}

export class SupabaseNormalizedRepository implements NormalizedRepository {
  constructor(private readonly client: SupabaseClient, private readonly userId: string) {}

  async replaceGame(input: NormalizedMutation<NormalizedGame>): Promise<NormalizedGame> {
    const { data, error } = await this.client.from("games").update({
      title: input.value.title, source_format: input.value.sourceFormat, source_text: input.value.sourceText,
      initial_sfen: input.value.initialSfen, sfens: input.value.sfens, moves: input.value.moves,
      canonical_hash: input.value.canonicalHash, created_at_text: input.value.createdAt,
      perspective: input.value.perspective, perspective_present: input.value.perspectivePresent, version: input.expectedVersion + 1,
    }).eq("user_id", this.userId).eq("id", input.value.id).eq("version", input.expectedVersion).select("*");
    if (error) throw error;
    const row = assertExactlyOneVersionedRow(data, input.expectedVersion);
    return {
      id: row.id, title: row.title, sourceFormat: row.source_format, sourceText: row.source_text,
      initialSfen: row.initial_sfen, sfens: row.sfens, moves: row.moves, canonicalHash: row.canonical_hash,
      createdAt: row.created_at_text, perspective: row.perspective, perspectivePresent: row.perspective_present,
      version: row.version,
    };
  }

  async replaceReviewPoint(input: NormalizedMutation<NormalizedReviewPoint>): Promise<NormalizedReviewPoint> {
    const { data, error } = await this.client.from("review_points").update({
      game_id: input.value.gameId, ply: input.value.ply, sfen: input.value.sfen, reason: input.value.reason,
      issue_tags: input.value.issueTags, notes: input.value.notes, external_notes: input.value.externalNotes ?? null,
      legacy_notes: input.value.legacyNotes ?? null, created_at_text: input.value.createdAt,
      version: input.expectedVersion + 1,
    }).eq("user_id", this.userId).eq("id", input.value.id).eq("version", input.expectedVersion).select("*");
    if (error) throw error;
    const row = assertExactlyOneVersionedRow(data, input.expectedVersion);
    const recommendations = await this.client.from("recommended_moves").select("*")
      .eq("user_id", this.userId).eq("point_id", input.value.id).order("sort_order").order("id");
    if (recommendations.error) throw recommendations.error;
    return {
      id: row.id, gameId: row.game_id, ply: row.ply, sfen: row.sfen, reason: row.reason,
      issueTags: row.issue_tags, notes: row.notes, createdAt: row.created_at_text,
      externalNotes: row.external_notes, legacyNotes: row.legacy_notes,
      recommendedMoves: recommendations.data.map((recommendation) => ({
        id: recommendation.id, pointId: recommendation.point_id, move: recommendation.move,
        comment: recommendation.comment, sortOrder: recommendation.sort_order, version: recommendation.version,
      })),
      version: row.version,
    };
  }

  async replaceRecommendation(input: NormalizedMutation<NormalizedRecommendation>): Promise<NormalizedRecommendation> {
    const { data, error } = await this.client.from("recommended_moves").update({
      point_id: input.value.pointId, move: input.value.move, comment: input.value.comment,
      sort_order: input.value.sortOrder, version: input.expectedVersion + 1,
    }).eq("user_id", this.userId).eq("id", input.value.id).eq("version", input.expectedVersion).select("*");
    if (error) throw error;
    const row = assertExactlyOneVersionedRow(data, input.expectedVersion);
    return {
      id: row.id, pointId: row.point_id, move: row.move, comment: row.comment,
      sortOrder: row.sort_order, version: row.version,
    };
  }
}

export type NormalizedRow = { user_id: string; id: string; version: number };
export function assertExactlyOneVersionedRow<T extends NormalizedRow>(
  rows: readonly T[] | null,
  expectedVersion: number,
): T {
  if (!rows || rows.length !== 1) throw new Error("normalized mutation conflict: expected exactly one returned row");
  if (rows[0].version !== expectedVersion + 1) throw new Error("normalized mutation conflict: unexpected returned version");
  return rows[0];
}

export type NormalizedField = "issueTags" | "reason";
export type NormalizedReason = Reason;
export type NormalizedTag = IssueTag;
