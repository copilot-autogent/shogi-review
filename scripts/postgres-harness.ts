import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { parseBackup } from "../src/backup.js";
import { parseGame } from "../src/parser.js";
import { canonicalData, payloadHash } from "../src/sync.js";

const connection = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "shogi_review",
};
const migration = await readFile(new URL("../supabase/migrations/202608180001_normalized_storage_v1.sql", import.meta.url), "utf8");
const alice = "00000000-0000-0000-0000-000000000001";
const bob = "00000000-0000-0000-0000-000000000002";

const sourceText = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
`;
const parsedGame = parseGame(sourceText, "KIF", "Unicode 測試");
const source = {
  schemaVersion: 3,
  exportedAt: "2026-08-18T00:00:00.000Z",
  data: { games: [{
    ...parsedGame, id: "game-1", title: "Unicode 測試", sourceText,
    createdAt: "2026-08-17T12:34:56.789+09:00",
    reviewPoints: [{
      id: "point-1", ply: 0,
      sfen: parsedGame.sfens[0],
      reason: "其他", issueTags: ["序盤"], note: "保留 null 與時間格式",
      createdAt: "2026-08-17T12:34:56.789+09:00",
      recommendedMoves: [{ id: "rec-1", move: "７六歩", comment: "候選", }],
    }],
    perspective: "sente",
  }, {
    ...parsedGame, id: "game-2", title: "No perspective / no recommendations",
    createdAt: "2026-08-18T01:02:03.004-04:00",
    reviewPoints: [{ id: "point-2", ply: 1, sfen: parsedGame.sfens[1], reason: "計算錯誤", issueTags: [], recommendedMoves: [], createdAt: "2026-08-18T01:02:03.004-04:00" }],
  }] },
};
const sourceJson = JSON.stringify(source);
const sourceHash = await payloadHash(parseBackup(sourceJson));
const legacyPoint = {
  id: "point-legacy", ply: 0, sfen: parsedGame.sfens[0], category: "戰術",
  thinking: "先看候選手", nextConsideration: "保留下一步", issueTags: [],
  createdAt: "2026-08-17T12:34:56.789+09:00", recommendedMoves: [{ id: "legacy-rec", move: " ７六歩 ", comment: " 候選 " }],
};
const legacyGame = { ...parsedGame, id: "legacy-game", title: "Legacy v1/v2", sourceText, createdAt: "2026-08-18T01:02:03.004-04:00", reviewPoints: [legacyPoint] };
const v1Json = JSON.stringify({ schemaVersion: 1, data: { games: [legacyGame] } });
const v2Json = JSON.stringify({ schemaVersion: 2, data: { games: [legacyGame] } });
for (const [version, json] of [[1, v1Json], [2, v2Json]] as const) {
  const migrated = parseBackup(json);
  if (migrated.games[0].reviewPoints[0].reason !== "計算錯誤"
    || migrated.games[0].reviewPoints[0].note !== "保留下一步"
    || migrated.games[0].reviewPoints[0].legacyNotes !== "當時想法：先看候選手"
    || migrated.games[0].reviewPoints[0].recommendedMoves?.[0].comment !== "候選") {
    throw new Error(`schema-v${version} JS fixture did not migrate`);
  }
}

const admin = new Client(connection);
await admin.connect();
await admin.query("create schema if not exists auth");
await admin.query(`create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
await admin.query("do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$");
await admin.query("do $$ begin create role anon nologin; exception when duplicate_object then null; end $$");
await admin.query("grant usage on schema auth to authenticated, anon");
await admin.query("grant execute on function auth.uid() to authenticated, anon");
await admin.query(`create table if not exists public.user_state (
  user_id uuid primary key, payload jsonb not null, revision integer not null default 1,
  updated_at timestamptz not null default now()
)`);
await admin.query("insert into public.user_state(user_id, payload) values ($1, $2), ($3, $2) on conflict (user_id) do nothing", [alice, sourceJson, bob]);
await admin.query("grant usage on schema public to authenticated, anon");
await admin.query("grant select, insert, update, delete on public.user_state to authenticated, anon");
await admin.query("drop policy if exists user_state_owner on public.user_state");
await admin.query("alter table public.user_state enable row level security");
await admin.query("create policy user_state_owner on public.user_state for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)");
await admin.query(migration);
await admin.query(migration);
const preserved = await admin.query("select count(*)::int as count from public.user_state");
if (preserved.rows[0].count !== 2) throw new Error("DDL rerun changed legacy data");
await admin.query("grant usage on schema public to authenticated, anon");
await admin.query("grant select, insert, update, delete on public.games, public.review_points, public.recommended_moves, public.user_migrations to authenticated, anon");
await admin.query("grant select on public.games, public.review_points, public.recommended_moves, public.user_migrations to authenticated, anon");
await admin.query("grant execute on function public.normalized_v1_json_has_nul(jsonb), public.normalized_v1_payload_games(jsonb) to authenticated, anon");
await admin.end();

function session(uid: string): Client {
  return new Client(connection);
}
async function as(uid: string): Promise<Client> {
  const client = session(uid);
  await client.connect();
  await client.query("set role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
  await client.query("set statement_timeout = '10s'");
  return client;
}
async function anonymous(): Promise<Client> {
  const client = new Client(connection);
  await client.connect();
  await client.query("set role anon");
  await client.query("set statement_timeout = '10s'");
  return client;
}
const a = await as(alice);
const b = await as(bob);
const a2 = await as(alice);
const anon = await anonymous();
for (const [version, json] of [[1, v1Json], [2, v2Json]] as const) {
  const legacyHash = await payloadHash(parseBackup(json));
  await a.query("update public.user_state set payload = $1, revision = revision + 1 where user_id = $2", [json, alice]);
  const legacyAudit = await a.query("select public.audit_my_state_v1() as result");
  if (!legacyAudit.rows[0].result.ok) throw new Error(`schema-v${version} SQL audit rejected JS-valid fixture`);
  await a.query("select public.migrate_my_state_v1($1)", [legacyHash]);
  const legacyExport = (await a.query("select public.export_my_state_v3() as payload")).rows[0].payload;
  if (canonicalData(parseBackup(JSON.stringify(legacyExport))) !== canonicalData(parseBackup(json))) {
    throw new Error(`schema-v${version} SQL/JS parity mismatch`);
  }
}
await a.query("update public.user_state set payload = $1, revision = revision + 1 where user_id = $2", [sourceJson, alice]);
await a.query("update public.user_state set payload = jsonb_set(payload, '{data,games,0,reviewPoints,0,reason}', '\"未知\"'::jsonb) where user_id = $1", [alice]);
const malformedAudit = await a.query("select public.audit_my_state_v1() as result");
if (malformedAudit.rows[0].result.ok || !malformedAudit.rows[0].result.issues.includes("invalid_reason")) throw new Error("malformed enum audit was not diagnosed");
await a.query("update public.user_state set payload = $1 where user_id = $2", [sourceJson, alice]);
const audit = await a.query("select public.audit_my_state_v1() as result");
if (!audit.rows[0].result.ok) throw new Error(`valid fixture failed audit: ${JSON.stringify(audit.rows[0].result)}`);
await a.query("select public.migrate_my_state_v1($1)", [sourceHash]);
await expectFailure(a, "select public.finalize_my_cutover()", "finalize before verified", "migration must be verified");
const exported = (await a.query("select public.export_my_state_v3() as payload")).rows[0].payload;
const exportedData = parseBackup(JSON.stringify(exported));
if (canonicalData(exportedData) !== canonicalData(parseBackup(sourceJson))) throw new Error("SQL export is not JS semantic-parity exact");
const targetHash = await payloadHash(exportedData);
await a.query("select public.verify_my_migration($1, $2)", [sourceHash, targetHash]);
await a.query("select public.finalize_my_cutover()");
const own = await a.query("select count(*)::int as count from public.games");
const cross = await b.query("select count(*)::int as count from public.games");
if (own.rows[0].count !== 2 || cross.rows[0].count !== 0) throw new Error("owner RLS matrix failed");
await expectFailure(b, "insert into public.games(user_id,id,title,source_format,source_text,initial_sfen,sfens,moves,canonical_hash,created_at_text) values ($1,'cross','x','KIF','x','x',array['x'],array[]::text[],'x','x')", "cross-user insert", "row-level security", [alice]);
const anonymousRows = await anon.query("select * from public.games");
if (anonymousRows.rowCount !== 0) throw new Error("anonymous RLS select exposed normalized rows");
await expectFailure(anon, "insert into public.games(user_id,id,title,source_format,source_text,initial_sfen,sfens,moves,canonical_hash,created_at_text) values ($1,'anon','x','KIF','x','x',array['x'],array[]::text[],'x','x')", "anonymous insert", "row-level security", [alice]);

// A writer holding the legacy row lock must serialize before finalize and be observed.
const snapshot = await a.query("select revision, payload from public.user_state where user_id = $1", [alice]);
const snapshotRevision = snapshot.rows[0].revision as number;
await a.query("select public.rollback_my_cutover($1::jsonb, $2, $3)", [sourceJson, sourceHash, snapshotRevision]);
await a.query("select public.migrate_my_state_v1($1)", [sourceHash]);
await a.query("select public.verify_my_migration($1, $2)", [sourceHash, targetHash]);
await a.query("begin");
await a.query("update public.user_state set payload = payload || jsonb_build_object('writer', true) where user_id = $1", [alice]);
const blockedFinalize = a2.query("select public.finalize_my_cutover()");
await new Promise((resolve) => setTimeout(resolve, 100));
await a.query("commit");
const blockedResult = (await blockedFinalize).rows[0].finalize_my_cutover;
if (blockedResult.status !== "failed") throw new Error("concurrent finalize did not return failed status");
const failedStatus = await a.query("select status, error from public.user_migrations where user_id = $1", [alice]);
if (failedStatus.rows[0].status !== "failed" || !failedStatus.rows[0].error) throw new Error("finalize failure was not persisted");

const restored = JSON.stringify(source);
await a.query("update public.user_state set payload = $1 where user_id = $2", [restored, alice]);
await a.query("select public.migrate_my_state_v1($1)", [sourceHash]);
await a.query("select public.verify_my_migration($1, $2)", [sourceHash, targetHash]);
const rollbackSnapshot = await a.query("select revision from public.user_state where user_id = $1", [alice]);
await a.query("select public.rollback_my_cutover($1::jsonb, $2, $3)", [restored, sourceHash, rollbackSnapshot.rows[0].revision]);
const status = await a.query("select status from public.user_migrations where user_id = $1", [alice]);
if (status.rows[0].status !== "rolled_back") throw new Error("rollback status not recorded");

await a.query("select public.migrate_my_state_v1($1)", [sourceHash]);
await a.query("select public.verify_my_migration($1, $2)", [sourceHash, targetHash]);
const guarded = await a.query("select revision from public.user_state where user_id = $1", [alice]);
const guardedRevision = guarded.rows[0].revision as number;
await a.query("update public.user_state set payload = payload || jsonb_build_object('newer', true), revision = revision + 1 where user_id = $1", [alice]);
const stale = await a.query("select public.rollback_my_cutover($1::jsonb, $2, $3) as result", [restored, sourceHash, guardedRevision]);
if (stale.rows[0].result.status !== "failed") throw new Error("stale rollback unexpectedly succeeded");
const newer = await a.query("select payload->>'newer' as newer, revision from public.user_state where user_id = $1", [alice]);
if (newer.rows[0].newer !== "true" || newer.rows[0].revision !== guardedRevision + 1) throw new Error("stale rollback overwrote newer legacy data");
await expectFailure(a, "select public.rollback_my_cutover($1::jsonb, $2)", "missing rollback guard", "guard is required", [restored, sourceHash]);

const crossMigration = await b.query("select count(*)::int as count from public.user_migrations");
if (crossMigration.rows[0].count !== 0) throw new Error("cross-user migration read exposed a row");
await a.end();
await b.end();
await a2.end();
await anon.end();
console.log("PostgreSQL Phase A harness passed: DDL idempotency, RLS, audit, migrate/export parity, versioned verification/finalize locking, concurrent writer serialization, rollback.");

async function expectFailure(client: Client, sql: string, label: string, expected: string, values: unknown[] = []): Promise<void> {
  try {
    await client.query(sql, values);
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} unexpectedly succeeded`) throw error;
    if (!(error instanceof Error) || !error.message.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`${label} failed for an unexpected reason: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
