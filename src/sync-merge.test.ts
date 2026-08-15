import { describe, expect, it } from "vitest";
import { parseGame } from "./parser.js";
import { MemoryProfileRepository } from "./repository.js";
import { AutoSyncEngine, type CloudState, type SyncRepository, type SyncSnapshot } from "./sync.js";

const source = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
`;
class FakeCloud implements SyncRepository {
  rows = new Map<string, CloudState>();
  casCount = 0;
  async read(uid: string): Promise<CloudState | null> { return this.rows.get(uid) ?? null; }
  async insert(uid: string, payload: unknown, revision: number): Promise<CloudState> {
    if (this.rows.has(uid)) throw new Error("duplicate");
    const row = { user_id: uid, payload, revision, updated_at: "2026-01-01T00:00:00.000Z" };
    this.rows.set(uid, row); return row;
  }
  async casUpdate(uid: string, revision: number, payload: unknown): Promise<CloudState> {
    this.casCount += 1;
    const row = this.rows.get(uid);
    if (!row || row.revision !== revision) throw new Error("CAS");
    const next = { ...row, payload, revision: revision + 1 };
    this.rows.set(uid, next); return next;
  }
}
function device(repo: MemoryProfileRepository, cloud: FakeCloud, uid: string) {
  const identity = { uid, profile: `user:${uid}` as const, generation: 1 };
  const metadata = new Map<string, SyncSnapshot>();
  return {
    repo,
    sync: new AutoSyncEngine({
      identity: () => identity,
      load: () => repo.loadProfile(identity.profile).then((result) => result.data),
      save: (value) => repo.saveProfile(identity.profile, value),
      getMetadata: (id) => metadata.get(id) ?? { hashVersion: 1 },
      setMetadata: (id, value) => { metadata.set(id, value); },
      loadBase: (id) => repo.loadSyncBase(`user:${id}`),
      saveBase: (id, value) => repo.saveSyncBase(`user:${id}`, value),
      cloud,
    }),
  };
}
describe("sync base durability and CAS fixpoint", () => {
  it("converges two independent devices and performs no CAS after the fixpoint", async () => {
    const original = parseGame(source, "KIF", "A");
    const repoA = new MemoryProfileRepository({ games: [original] });
    const repoB = new MemoryProfileRepository({ games: [original] });
    await repoA.saveProfile("user:u", { games: [original] });
    await repoB.saveProfile("user:u", { games: [original] });
    const cloud = new FakeCloud();
    const a = device(repoA, cloud, "u");
    const b = device(repoB, cloud, "u");
    expect(await a.sync.reconcile()).toBe("synced");
    const base = await repoA.loadSyncBase("user:u");
    expect(base?.data.games).toHaveLength(1);
    await repoB.saveSyncBase("user:u", base!);
    const phone = { ...original, reviewPoints: [{ id: "p", ply: 1, sfen: original.sfens[1]!, reason: "其他" as const, issueTags: [], createdAt: "2026-01-01T00:00:00.000Z" }] };
    await repoA.saveProfile("user:u", { games: [phone] });
    await a.sync.reconcile();
    const desktopGame = { ...original, id: "desktop-game", title: "B" };
    await repoB.saveProfile("user:u", { games: [original, desktopGame] });
    expect(await b.sync.reconcile()).toBe("synced");
    expect(await a.sync.reconcile()).toBe("synced");
    const afterMerge = cloud.casCount;
    expect(await a.sync.reconcile()).toBe("synced");
    expect(await b.sync.reconcile()).toBe("synced");
    expect(cloud.casCount).toBe(afterMerge);
    const aData = (await repoA.loadProfile("user:u")).data;
    const bData = (await repoB.loadProfile("user:u")).data;
    expect(aData).toEqual(bData);
    expect(aData.games.flatMap((game) => game.reviewPoints).map((point) => point.id)).toEqual(["p"]);
  });
  it("stores validated full ancestor payload in the profile base, separate from browser metadata", async () => {
    const repo = new MemoryProfileRepository();
    const game = parseGame(source, "KIF");
    await repo.saveProfile("user:one", { games: [game] });
    await repo.saveSyncBase("user:one", { data: { games: [game] }, revision: 4, payloadHash: "hash", hashVersion: 1 });
    expect((await repo.loadSyncBase("user:one"))?.data.games[0]?.id).toBe(game.id);
    expect(await repo.loadSyncBase("user:two")).toBeNull();
  });
});
