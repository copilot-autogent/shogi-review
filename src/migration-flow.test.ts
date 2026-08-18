import { describe, expect, it } from "vitest";
import { createBackup } from "./backup.js";
import { parseGame } from "./parser.js";
import { executeMigration, prepareMigration, reenterVerifiedMigration } from "./migration-flow.js";
import type { AuditResult, LegacyStateRow, MigrationResult, MigrationStatus, NormalizedMigrationClient } from "./normalized.js";

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
`;
const game = parseGame(kif, "KIF", "測試");
const data = { games: [{ ...game, perspective: undefined }] };
const legacyPayload = createBackup(data, new Date("2026-01-01T00:00:00.000Z"));

class FakeClient implements NormalizedMigrationClient {
  legacy: LegacyStateRow = { user_id: "ignored", payload: legacyPayload, revision: 1 };
  auditResult: AuditResult = { ok: true, issues: [], counts: { games: 1, points: 0, recommendations: 0 } };
  migration: MigrationStatus | null = null;
  migrateResult?: MigrationResult;
  exported = legacyPayload;
  verifyResult = { status: "verified", target_hash: "" };
  finalizeCalls = 0;
  verifyCalls = 0;
  async readLegacy() { return this.legacy; }
  async audit() { return this.auditResult; }
  async migrate(sourceHash: string) {
    return this.migrateResult ?? { status: "migrated", source_hash: sourceHash, counts: { games: 1, points: 0, recommendations: 0 } };
  }
  async export() { return this.exported; }
  async readMigration() { return this.migration; }
  async verify(_sourceHash: string, targetHash: string) { this.verifyCalls += 1; return { ...this.verifyResult, target_hash: this.verifyResult.target_hash || targetHash }; }
  async finalize() { this.finalizeCalls += 1; return { status: "finalized" }; }
  async rollback() { return { status: "rolled_back" }; }
}

async function prepared(client = new FakeClient()) {
  return { client, preparation: await prepareMigration(client) };
}

describe("Phase B migration flow", () => {
  it("rejects audit issues without exposing payload", async () => {
    const client = new FakeClient();
    client.auditResult = { ok: false, issues: ["invalid_reason"], counts: { games: 1 } };
    await expect(prepareMigration(client)).rejects.toThrow("audit_rejected");
  });

  it("requires explicit confirmation", async () => {
    const { client, preparation } = await prepared();
    await expect(executeMigration(client, preparation, false)).rejects.toThrow("confirmation_required");
    expect(client.verifyCalls).toBe(0);
  });

  it("enforces hash/count parity and verifies without finalizing", async () => {
    const { client, preparation } = await prepared();
    const proof = await executeMigration(client, preparation, true);
    expect(proof.status).toBe("verified");
    expect(proof.sourceHash).toBe(proof.targetHash);
    expect(client.finalizeCalls).toBe(0);
  });

  it("rejects server source hash mismatch", async () => {
    const { client, preparation } = await prepared();
    client.migrateResult = { status: "migrated", source_hash: "wrong", counts: { games: 1, points: 0, recommendations: 0 } };
    await expect(executeMigration(client, preparation, true)).rejects.toThrow("migrate_source_hash_mismatch");
  });

  it("rejects export parse and target hash failures", async () => {
    const { client, preparation } = await prepared();
    client.exported = { schemaVersion: 3, exportedAt: "", data: {} } as never;
    await expect(executeMigration(client, preparation, true)).rejects.toThrow("export_parse_failed");
    client.exported = createBackup({ games: [] });
    await expect(executeMigration(client, preparation, true)).rejects.toThrow("target_hash_mismatch");
  });

  it.each([
    ["games", { games: 0, points: 0, recommendations: 0 }],
    ["points", { games: 1, points: 1, recommendations: 0 }],
    ["recommendations", { games: 1, points: 0, recommendations: 1 }],
  ])("rejects migrate %s count mismatch", async (_key, counts) => {
    const { client, preparation } = await prepared();
    client.migrateResult = { status: "migrated", source_hash: preparation.sourceHash, counts };
    await expect(executeMigration(client, preparation, true)).rejects.toThrow(`migrate_count_mismatch:${_key}`);
    expect(client.verifyCalls).toBe(0);
  });

  it("rejects verify failure", async () => {
    const { client, preparation } = await prepared();
    client.verifyResult = { status: "failed", target_hash: "" };
    await expect(executeMigration(client, preparation, true)).rejects.toThrow("verify_failed");
  });

  it("validates already-verified re-entry without mutating status", async () => {
    const { client, preparation } = await prepared();
    const proof = await executeMigration(client, preparation, true);
    client.migration = { status: "verified", source_hash: proof.sourceHash, target_hash: proof.targetHash, counts: { games: proof.games, points: proof.points, recommendations: proof.recommendations } };
    client.verifyCalls = 0;
    const again = await reenterVerifiedMigration(client, client.migration!);
    expect(again).toEqual(proof);
    expect(client.verifyCalls).toBe(0);
  });
});
