# Phase A normalized-storage runbook

This bundle is dormant. Do not execute it against production until the Phase A
PR is merged, independently reviewed, and the application migration client has
been exercised against a disposable Supabase project.

## Future Jacky action

After those gates, create a Supabase migration backup and run
`supabase/migrations/202608180001_normalized_storage_v1.sql` once in the
project SQL editor. The script is idempotent: rerunning it recreates policies
and functions without dropping data tables or rows. Do not enable a cutover
flag or change the existing `user_state` policy in this phase.

For each authenticated user, the future migration client must:

1. Read and parse the legacy payload in JavaScript and compute the authoritative
   `canonicalData(parseBackup(payload))` SHA-256.
2. Call `audit_my_state_v1()`, then `migrate_my_state_v1(source_hash)`.
3. Call `export_my_state_v3()`, parse it with the current JavaScript
   `parseBackup`, and compare the JavaScript semantic hash.
4. Call `verify_my_migration(source_hash, target_hash)` only after parity passes.
5. Call `finalize_my_cutover()` only after a fresh legacy read confirms the
   exact `source_payload` snapshot is unchanged.

`rollback_my_cutover(payload, source_hash)` is a guarded rollback-window
operation. It restores the supplied legacy payload and records `rolled_back`;
after normalized writes exist, use an export/manual migration instead of
assuming automated rollback is safe. Never use `service_role`, inspect user
data, or execute this bundle as part of application bootstrap.
