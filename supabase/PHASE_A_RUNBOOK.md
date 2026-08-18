# Phase A normalized-storage runbook

This bundle is dormant. Do not execute it against production until the Phase A
PR is merged, independently reviewed, and the application migration client has
been exercised against a disposable Supabase project.

## Phase B authenticated verification UI

The deployed application exposes **設定 → 驗證資料遷移** (also at `#/migration`).
It is authenticated-only and keeps `NORMALIZED_STORAGE=false`: legacy
`user_state` remains the read/write authority. The screen reads the exact
authenticated row, creates a local downloadable schema-v3 safety backup, then
shows only audit issue codes and aggregate counts. It never uploads the backup.

After a clean audit, the user must explicitly confirm the backup before the
client calls migrate. JavaScript `parseBackup` plus `payloadHash` is the
authority: source hash, server source hash, exported target hash, and games /
review points / recommendations counts must all match before `verify_my_migration`
is called. `finalize_my_cutover` is not called in Phase B. A verified re-entry
validates the stored proof and export without repeating migration.

## Future Jacky action

After those gates, create a Supabase migration backup and run
`supabase/migrations/202608180001_normalized_storage_v1.sql` once in the
project SQL editor. The script is idempotent: rerunning it recreates policies
and functions without dropping data tables or rows. Do not enable a cutover
flag or change the existing `user_state` policy in this phase.

For each authenticated user, the migration UI performs:

1. Read and parse the legacy payload in JavaScript and compute the authoritative
   `canonicalData(parseBackup(payload))` SHA-256.
2. Call `audit_my_state_v1()`, then `migrate_my_state_v1(source_hash)`.
3. Call `export_my_state_v3()`, parse it with the current JavaScript
   `parseBackup`, and compare the JavaScript semantic hash.
4. Call `verify_my_migration(source_hash, target_hash)` only after parity passes.
5. Stop on any mismatch; never finalize or switch storage authority.

The SQL migration uses the same smallest authoritative boundary as the client:
its immutable canonicalization helper translates v1/v2 legacy review fields
(category, legacy text, optional notes, and recommendation normalization) into
the schema-v3 semantic shape before inserting normalized rows. JavaScript remains
the authoritative parity check; malformed values are rejected rather than
silently weakened.

`rollback_my_cutover(payload, source_hash, expected_revision)` is a guarded
rollback-window CAS operation. The expected revision captured with the migration
snapshot is required; a missing/stale guard returns `failed` without changing
the newer legacy row and the two-argument legacy signature fails closed. It
restores the supplied legacy payload and records `rolled_back`;
after normalized writes exist, use an export/manual migration instead of
assuming automated rollback is safe. Never use `service_role`, inspect user
data, or execute this bundle as part of application bootstrap.
