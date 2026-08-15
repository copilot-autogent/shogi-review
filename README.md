# Shogi Review

Traditional Chinese, client-only post-game review for KIF, KI2, and CSA records.

## Development

```sh
npm install
npm run lint
npm run test:coverage
npm run build
npm run test:e2e
```

`test:e2e` starts `vite preview` and runs real Chromium layout checks. The PR
workflow installs Chromium and uploads Playwright screenshots, traces, and
reports on failure. The responsive audit covers 320, 360, 390, 768, and 1280
CSS pixels, including import, replay, review reveal/continuation, settings, and
invalid review routes. Primary, secondary, destructive, navigation, dialog,
account, and import controls are at least 44px; dense move-list rows are
intentionally documented at a keyboard-accessible 36px minimum. Physical
devices and authenticated Google/Supabase sessions remain outside CI.

The app is deployed at `/shogi-review/` with UTC date bucketing. It uses
[tsshogi](https://github.com/sunfish-shogi/tsshogi) (MIT) for notation parsing,
legal replay, captures, drops, promotions, and nonstandard initial positions.
Data stays in IndexedDB; JSON backups are complete replacements after
confirmation. Backup schema version 2 stores the corrected invariant that ply 0
is the initial position and ply N is after N playable moves. Schema 1 backups
are still structurally and source-validated; backups containing the former
one-ply offset are rejected with an explicit re-import message.
IndexedDB records are versioned on the next save; legacy raw records are
validated as schema 1 on load so correctly structured data remains usable.

Cloud sync is optional and manual. The browser uses Supabase's public
`sb_publishable_` key only; it never contains a service-role credential. RLS
must enforce `auth.uid() = user_id` for SELECT/UPDATE/DELETE and
`WITH CHECK (auth.uid() = user_id)` for INSERT. An unauthenticated REST select
with the publishable key must return no rows. A two-account authenticated RLS
matrix remains a follow-up requiring two real sessions; authenticated live
Google OAuth return and sync E2E require a real Google session and are not claimed by local or CI tests.
