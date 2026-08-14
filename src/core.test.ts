import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { decodeRecordBytes, fnv1a, parseGame } from "./parser.js";
import { MemoryProfileRepository, MemoryRepository, parseStoredData } from "./repository.js";
import { AutoSyncEngine, decideSync, finishPkceCallback, googleRedirectUrl, GOOGLE_REDIRECT_URL, PKCE_PENDING_KEY, payloadHash, startGoogleLogin, validateCloudPayload, type CloudState, type SyncRepository, type SyncSnapshot } from "./sync.js";
import { dialogInitialFocus } from "./dialog-focus.js";

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
   3 ２六歩(27)
`;
const expectedMoves = ["☗７六歩", "☖３四歩", "☗２六歩"];

describe("record parsing and canonical identity", () => {
  it.each(["KIF", "KI2", "CSA"] as const)("keeps the corrected %s ply invariant", (format) => {
    const source = format === "KIF" ? kif : format === "KI2" ? kif.replace(/ {3}\d /g, "▲") : "V2.2\nPI\n+\n+7776FU\n-3334FU\n+2726FU\n%TORYO\n";
    const game = parseGame(source, format, "測試");
    expect(game.moves).toEqual(expectedMoves);
    expect(game.sfens).toHaveLength(4);
    expect(game.sfens[0]).toBe(game.initialSfen);
  });

  describe("dialog initial focus policy", () => {
    it.each(["delete-point", "delete-game", "clear-guest", "remove-profile", "restore"] as const)("focuses cancel for %s", (kind) => {
      expect(dialogInitialFocus(kind)).toBe("cancel");
    });
    it("focuses the first meaningful control for non-destructive dialogs", () => {
      expect(dialogInitialFocus("rename-game")).toBe("input");
      expect(dialogInitialFocus("conflict")).toBe("backup");
      expect(dialogInitialFocus("guest-import")).toBe("guest-copy");
    });
  });
  it("decodes UTF-8 and Shift-JIS explicitly", () => {
    expect(decodeRecordBytes(new TextEncoder().encode("手合割：平手"))).toContain("平手");
    expect(decodeRecordBytes(Uint8Array.from([0x8e, 0x71]))).toBe("子");
  });
  it("hashes canonical values deterministically", () => { expect(fnv1a("a|b")).toBe(fnv1a("a|b")); expect(fnv1a("a|b")).not.toBe(fnv1a("a|c")); });
});

describe("schema v3 data", () => {
  it("round-trips reason-only data and rejects unknown versions", () => {
    const game = parseGame(kif, "KIF");
    game.reviewPoints.push({ id: "p", ply: 1, sfen: game.sfens[1]!, reason: "其他", issueTags: [], createdAt: "2026-08-12T00:00:00.000Z" });
    const data = parseBackup(JSON.stringify(createBackup({ games: [game] })));
    expect(data.games[0]?.reviewPoints[0]?.reason).toBe("其他");
    expect(() => parseBackup(JSON.stringify({ schemaVersion: 99, data }))).toThrow("不支援");
  });

  describe("manual cloud sync safety", () => {
    it("uses baseline presence before empty-local decisions and distinguishes delete-all", async () => {
      const game = parseGame(kif, "KIF");
      const hash = await payloadHash({ games: [game] });
      expect(decideSync({ baseline: false, local: { games: [] }, cloud: null, localHash: await payloadHash({ games: [] }), localChanged: true, cloudChanged: true })).toBe("initialize-empty");
      expect(decideSync({ baseline: true, local: { games: [] }, cloud: { games: [game] }, localHash: await payloadHash({ games: [] }), cloudHash: hash, localChanged: true, cloudChanged: false })).toBe("push-local");
    });
    it("validates the full migration envelope before use", () => {
      const game = parseGame(kif, "KIF");
      expect(validateCloudPayload(createBackup({ games: [game] })).games).toHaveLength(1);
      expect(() => validateCloudPayload({ schemaVersion: 99 })).toThrow("不支援");
    });
  });
  describe("Google-only PKCE auth", () => {
    const storage = () => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        has: (key: string) => values.has(key),
      };
    };
    const client = (
      signInWithOAuth: (request: { provider: string; options?: { redirectTo?: string } }) => Promise<{ error: null | Error }>,
      exchangeCodeForSession: (code: string) => Promise<{ error: null | Error }> = async () => ({ error: null }),
    ) => ({
      auth: { signInWithOAuth, exchangeCodeForSession },
    }) as never;

    it("sets pending before exact Google OAuth and clears it on immediate error", async () => {
      const local = storage();
      let pendingAtCall = false;
      const oauth = async (request: { provider: string; options?: { redirectTo?: string } }) => {
        pendingAtCall = local.has(PKCE_PENDING_KEY);
        expect(request).toEqual({ provider: "google", options: { redirectTo: GOOGLE_REDIRECT_URL } });
        return { error: new Error("provider unavailable") };
      };
      await expect(startGoogleLogin(client(oauth), local)).resolves.toContain("Google");
      expect(pendingAtCall).toBe(true);
      expect(local.has(PKCE_PENDING_KEY)).toBe(false);
      expect(googleRedirectUrl("http://localhost:5173")).toBe("http://localhost:5173/shogi-review/");
    });

    it("exchanges code before routing and preserves the hash", async () => {
      const local = storage();
      local.setItem(PKCE_PENDING_KEY, "1");
      const replaced: string[] = [];
      let exchanged = "";
      const browser = {
        location: { pathname: "/shogi-review/", search: "?code=abc&state=xyz", hash: "#/game/1" },
        history: { replaceState: (_: unknown, _title: string, url: string) => replaced.push(url) },
        localStorage: local,
      };
      const result = await finishPkceCallback(client(async () => ({ error: null }), async (code: string) => {
        exchanged = code;
        return { error: null };
      }), browser);
      expect(result).toBeNull();
      expect(exchanged).toBe("abc");
      expect(replaced).toEqual(["/shogi-review/#/game/1"]);
      expect(local.has(PKCE_PENDING_KEY)).toBe(false);
    });

    it("recovers from denial and missing verifier without stale state", async () => {
      const local = storage();
      local.setItem(PKCE_PENDING_KEY, "1");
      const replaced: string[] = [];
      const denied = await finishPkceCallback(client(async () => ({ error: null })), {
        location: { pathname: "/shogi-review/", search: "?error=access_denied&error_description=cancelled", hash: "#/" },
        history: { replaceState: (_: unknown, _title: string, url: string) => replaced.push(url) },
        localStorage: local,
      });
      expect(denied).toBe("Google 登入已取消，請重試");
      expect(local.has(PKCE_PENDING_KEY)).toBe(false);
      expect(replaced.at(-1)).toBe("/shogi-review/#/");

      const missing = storage();
      const missingResult = await finishPkceCallback(client(async () => ({ error: null })), {
        location: { pathname: "/shogi-review/", search: "?code=expired", hash: "#/" },
        history: { replaceState: (_: unknown, _title: string, url: string) => replaced.push(url) },
        localStorage: missing,
      });
      expect(missingResult).toContain("Google 登入缺少本機驗證狀態");
      expect(replaced.at(-1)).toBe("/shogi-review/#/");

      const providerStorage = storage();
      providerStorage.setItem(PKCE_PENDING_KEY, "1");
      const providerFailure = await finishPkceCallback(client(async () => ({ error: null })), {
        location: { pathname: "/shogi-review/", search: "?error=server_error&error_description=temporarily_unavailable", hash: "#/" },
        history: { replaceState: (_: unknown, _title: string, url: string) => replaced.push(url) },
        localStorage: providerStorage,
      });
      expect(providerFailure).toBe("Google 登入失敗：temporarily_unavailable");
    });
  });
  it("maps v1 legacy prose and unknown category without loss", () => {
    const game = parseGame(kif, "KIF");
    const legacy = { ...game, reviewPoints: [{ id: "p", ply: 1, sfen: game.sfens[1], thinking: "想法", nextConsideration: "下次", category: "新分類", tag: "自訂", candidates: "候選", opponentResponse: "應手", externalNotes: "外部", createdAt: "2026-08-12T00:00:00.000Z" }], cards: [{ id: "c", reviewPointId: "p", dueDate: "2026-08-12", interval: 1, createdAt: "2026-08-12" }] };
    const migrated = parseBackup(JSON.stringify({ schemaVersion: 1, data: { games: [legacy] } }));
    const point = migrated.games[0]!.reviewPoints[0]!;
    expect(point.reason).toBe("其他");
    expect(point.note).toBe("下次");
    expect(point.legacyNotes).toContain("舊分類：新分類");
    expect(point.legacyNotes).toContain("當時想法：想法");
    expect(migrated.games[0]!.reviewPoints).toHaveLength(1);
  });
  it("repository preserves a load failure without replacing data", async () => {
    const game = parseGame(kif, "KIF");
    const repository = new MemoryRepository({ games: [game] });
    expect((await repository.load()).games).toHaveLength(1);
    expect(() => parseStoredData({ schemaVersion: 99, data: { games: [] } })).toThrow("不支援");
  });

  describe("account-scoped automatic sync", () => {
    class FakeCloud implements SyncRepository {
      rows = new Map<string, CloudState>();
      async read(userId: string): Promise<CloudState | null> { return this.rows.get(userId) ?? null; }
      async insert(userId: string, payload: unknown, revision: number): Promise<CloudState> {
        if (this.rows.has(userId)) throw new Error("duplicate");
        const row = { user_id: userId, payload, revision, updated_at: new Date().toISOString() };
        this.rows.set(userId, row); return row;
      }
      async casUpdate(userId: string, revision: number, payload: unknown): Promise<CloudState> {
        const row = this.rows.get(userId);
        if (!row || row.revision !== revision) throw new Error("CAS");
        const next = { ...row, payload, revision: revision + 1, updated_at: new Date().toISOString() };
        this.rows.set(userId, next); return next;
      }
    }
    const engine = (repo: MemoryProfileRepository, cloud: FakeCloud, uid: string, generation = 1) => {
      let identity = { uid, profile: `user:${uid}` as const, generation };
      const metadata = new Map<string, SyncSnapshot>();
      return {
        repo,
        metadata,
        setIdentity(next: typeof identity | null) { identity = next as typeof identity; },
        value: new AutoSyncEngine({
          identity: () => identity,
          load: () => repo.loadProfile(`user:${uid}`).then((result) => result.data),
          save: (next) => repo.saveProfile(`user:${uid}`, next),
          getMetadata: (id) => metadata.get(id) ?? { hashVersion: 1 },
          setMetadata: (id, next) => { metadata.set(id, next); },
          cloud,
        }),
      };
    };
    it("device B empty profile logs in and pulls device A cloud data without confirmation", async () => {
      const game = parseGame(kif, "KIF");
      const cloud = new FakeCloud();
      const deviceA = new MemoryProfileRepository();
      await deviceA.saveProfile("user:same-user", { games: [game] });
      await cloud.insert("same-user", createBackup((await deviceA.loadProfile("user:same-user")).data), 3);
      const deviceB = engine(new MemoryProfileRepository(), cloud, "same-user");
      expect(await deviceB.value.reconcile()).toBe("synced");
      expect((await deviceB.repo.loadProfile("user:same-user")).data.games.map((item) => item.id)).toEqual([game.id]);
    });
    it("keeps guest and accounts isolated and aborts stale work after identity switch", async () => {
      const cloud = new FakeCloud();
      const repo = new MemoryProfileRepository();
      const device = engine(repo, cloud, "account-a");
      const game = parseGame(kif, "KIF");
      await repo.saveProfile("guest", { games: [game] });
      await repo.saveProfile("user:account-b", { games: [] });
      device.setIdentity(null);
      expect(await device.value.reconcile()).toBe("aborted");
      expect((await repo.loadProfile("guest")).data.games).toHaveLength(1);
      expect((await repo.loadProfile("user:account-b")).data.games).toHaveLength(0);
    });
    it("does not overwrite a local edit made while fetching cloud", async () => {
      const game = parseGame(kif, "KIF");
      const cloud = new FakeCloud();
      await cloud.insert("race-user", createBackup({ games: [game] }), 1);
      const repo = new MemoryProfileRepository();
      const metadata = new Map<string, SyncSnapshot>();
      let local = { games: [] as typeof game[] };
      let changed = false;
      const raceCloud: SyncRepository = {
        read: async (id) => { const row = await cloud.read(id); local = { games: [game] }; changed = true; return row; },
        insert: (...args) => cloud.insert(...args),
        casUpdate: (...args) => cloud.casUpdate(...args),
      };
      const sync = new AutoSyncEngine({
        identity: () => ({ uid: "race-user", profile: "user:race-user", generation: 1 }),
        load: async () => changed ? local : (await repo.loadProfile("user:race-user")).data,
        save: (next) => repo.saveProfile("user:race-user", next),
        getMetadata: (id) => metadata.get(id) ?? { hashVersion: 1 },
        setMetadata: (id, next) => { metadata.set(id, next); },
        cloud: raceCloud,
      });
      expect(await sync.reconcile()).toBe("conflict");
      expect((await repo.loadProfile("user:race-user")).data.games).toHaveLength(0);
    });
  });
});
