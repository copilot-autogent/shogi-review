# Shogi Review

Traditional Chinese, client-only post-game review for KIF, KI2, and CSA records.

## Development

```sh
npm install
npm run lint
npm run test:coverage
npm run build
```

The app is deployed at `/shogi-review/` with UTC date bucketing. It uses
[tsshogi](https://github.com/sunfish-shogi/tsshogi) (MIT) for notation parsing,
legal replay, captures, drops, promotions, and nonstandard initial positions.
Data stays in IndexedDB; JSON backups are complete replacements after
confirmation.
