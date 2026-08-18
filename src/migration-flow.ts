import { parseBackup, type Backup } from "./backup.js";
import type { AppData } from "./model.js";
import {
  type AuditResult,
  type MigrationStatus,
  type NormalizedMigrationClient,
  semanticSource,
} from "./normalized.js";
import { payloadHash } from "./sync.js";

export interface MigrationCounts {
  games: number;
  points: number;
  recommendations: number;
}
export interface MigrationPreparation {
  sourceHash: string;
  legacyBackup: string;
  data: AppData;
  audit: AuditResult;
}
export interface MigrationProof extends MigrationCounts {
  sourceHash: string;
  targetHash: string;
  status: "verified";
}

export class MigrationFlowError extends Error {
  constructor(public readonly code: string, public readonly issues: string[] = []) {
    super(code);
  }
}

export function countData(data: AppData): MigrationCounts {
  return data.games.reduce((counts, game) => {
    counts.games += 1;
    for (const point of game.reviewPoints) {
      counts.points += 1;
      counts.recommendations += point.recommendedMoves?.length ?? 0;
    }
    return counts;
  }, { games: 0, points: 0, recommendations: 0 });
}

function countsOf(value: Record<string, number> | undefined): MigrationCounts {
  return {
    games: value?.games ?? 0,
    points: value?.points ?? value?.review_points ?? value?.reviewPoints ?? 0,
    recommendations: value?.recommendations ?? value?.recommended_moves ?? value?.recommendedMoves ?? 0,
  };
}

function sameCounts(expected: MigrationCounts, actual: Record<string, number> | undefined, code: string): void {
  const got = countsOf(actual);
  if (expected.games !== got.games) throw new MigrationFlowError(`${code}:games`);
  if (expected.points !== got.points) throw new MigrationFlowError(`${code}:points`);
  if (expected.recommendations !== got.recommendations) throw new MigrationFlowError(`${code}:recommendations`);
}

export async function prepareMigration(client: NormalizedMigrationClient): Promise<MigrationPreparation> {
  const legacy = await client.readLegacy();
  if (!legacy) throw new MigrationFlowError("missing_legacy_state");
  let data: AppData;
  try {
    data = semanticSource(legacy.payload);
  } catch {
    throw new MigrationFlowError("legacy_parse_failed");
  }
  const audit = await client.audit();
  if (audit.ok !== true || audit.issues.length !== 0) throw new MigrationFlowError("audit_rejected", audit.issues);
  const sourceHash = await payloadHash(data);
  return { sourceHash, data, audit, legacyBackup: JSON.stringify({ schemaVersion: 3, exportedAt: new Date().toISOString(), data }) };
}

async function validateExport(
  exported: Backup,
  expected: MigrationCounts,
  sourceHash: string,
): Promise<{ targetHash: string; data: AppData }> {
  let data: AppData;
  try {
    data = parseBackup(JSON.stringify(exported));
  } catch {
    throw new MigrationFlowError("export_parse_failed");
  }
  const targetHash = await payloadHash(data);
  if (targetHash !== sourceHash) throw new MigrationFlowError("target_hash_mismatch");
  const counts = countData(data);
  if (counts.games !== expected.games) throw new MigrationFlowError("target_count_mismatch:games");
  if (counts.points !== expected.points) throw new MigrationFlowError("target_count_mismatch:points");
  if (counts.recommendations !== expected.recommendations) throw new MigrationFlowError("target_count_mismatch:recommendations");
  return { targetHash, data };
}

export async function executeMigration(
  client: NormalizedMigrationClient,
  preparation: MigrationPreparation,
  confirmed: boolean,
): Promise<MigrationProof> {
  if (!confirmed) throw new MigrationFlowError("confirmation_required");
  const expected = countData(preparation.data);
  const migration = await client.migrate(preparation.sourceHash);
  if (migration.source_hash !== preparation.sourceHash) throw new MigrationFlowError("migrate_source_hash_mismatch");
  sameCounts(expected, migration.counts, "migrate_count_mismatch");
  const exported = await client.export();
  const target = await validateExport(exported, expected, preparation.sourceHash);
  const verified = await client.verify(preparation.sourceHash, target.targetHash);
  if (verified.status !== "verified" || verified.target_hash !== target.targetHash) throw new MigrationFlowError("verify_failed");
  return { ...expected, sourceHash: preparation.sourceHash, targetHash: target.targetHash, status: "verified" };
}

export async function reenterVerifiedMigration(
  client: NormalizedMigrationClient,
  status: MigrationStatus,
): Promise<MigrationProof> {
  if (status.status !== "verified") throw new MigrationFlowError("migration_not_verified");
  if (!status.source_hash || !status.target_hash) throw new MigrationFlowError("verified_proof_incomplete");
  const exported = await client.export();
  let data: AppData;
  try {
    data = parseBackup(JSON.stringify(exported));
  } catch {
    throw new MigrationFlowError("export_parse_failed");
  }
  const counts = countData(data);
  const targetHash = await payloadHash(data);
  if (targetHash !== status.target_hash || status.source_hash !== targetHash) throw new MigrationFlowError("verified_proof_mismatch");
  sameCounts(counts, status.counts, "verified_count_mismatch");
  return { ...counts, sourceHash: status.source_hash, targetHash, status: "verified" };
}
