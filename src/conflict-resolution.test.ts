import { describe, expect, it } from "vitest";
import { createBackup } from "./backup.js";
import { resolveConflict, type ConflictResolutionDependencies } from "./conflict-resolution.js";
import type { AppData } from "./model.js";
import type { PendingConflict, SyncIdentity } from "./sync.js";

const empty: AppData = { games: [] };
const saved = { user_id: "old", payload: createBackup(empty), revision: 1 };
const casSaved = { ...saved, revision: 2 };
const conflict = (identity: SyncIdentity): PendingConflict => ({
  userId: identity.uid,
  profile: identity.profile,
  generation: identity.generation,
  rowRevision: 1,
  localHash: "",
  cloudData: empty,
  mergedData: empty,
  conflicts: [],
});

async function hashEmpty(): Promise<string> {
  const { payloadHash } = await import("./sync.js");
  return payloadHash(empty);
}

function harness(overrides: Partial<ConflictResolutionDependencies> = {}) {
  let identity: SyncIdentity | null = { uid: "old", profile: "user:old", generation: 1 };
  let pending: PendingConflict | undefined;
  let data = globalThis.structuredClone(empty);
  const writes: string[] = [];
  const initial = conflict(identity);
  return {
    setIdentity(next: SyncIdentity | null) { identity = next; },
    writes,
    deps: {
      identity: () => identity,
      pending: () => pending,
      setPending: (next) => { pending = next; },
      data: () => data,
      setData: (next) => { data = next; writes.push("data"); },
      repository: {
        saveProfileAndBase: async (profile: string) => { writes.push(`profile-base:${profile}`); },
      },
      cloud: {
        read: async () => saved,
        insert: async () => saved,
        casUpdate: async () => saved,
      },
      metadata: async () => { writes.push("metadata"); },
      onResolved: () => { writes.push("resolved"); },
      ...overrides,
    } satisfies ConflictResolutionDependencies,
    start() {
      pending = initial;
    },
  };
}

describe("identity-scoped conflict resolution", () => {
  it("resolves normally using the captured profile and advances the base", async () => {
    const state = harness();
    state.start();
    const localHash = await hashEmpty();
    state.deps.setPending({ ...state.deps.pending()!, localHash });
    expect(await resolveConflict({}, state.deps)).toBe("resolved");
    expect(state.writes).toEqual(["profile-base:user:old", "metadata", "data", "resolved"]);
  });

  it("abandons before any write when logout races the cloud read", async () => {
    let release!: (value: typeof saved) => void;
    const read = new Promise<typeof saved>((resolve) => { release = resolve; });
    const state = harness({ cloud: { read: async () => read, insert: async () => saved, casUpdate: async () => casSaved } });
    state.start();
    state.deps.setPending({ ...state.deps.pending()!, localHash: await hashEmpty() });
    const operation = resolveConflict({}, state.deps);
    state.setIdentity(null);
    release(saved);
    expect(await operation).toBe("aborted");
    expect(state.writes).toEqual([]);
  });

  it("abandons when auth expires at the payload-hash await boundary", async () => {
    const state = harness();
    state.start();
    const localHash = await hashEmpty();
    state.deps.setPending({ ...state.deps.pending()!, localHash });
    let calls = 0;
    state.deps.identity = () => {
      calls += 1;
      return calls >= 3 ? null : { uid: "old", profile: "user:old", generation: 1 };
    };
    expect(await resolveConflict({}, state.deps)).toBe("aborted");
    expect(state.writes).toEqual([]);
  });

  it("does not save old data after CAS completes across an account switch", async () => {
    const state = harness({
      cloud: {
        read: async () => saved,
        insert: async () => saved,
        casUpdate: async () => { state.setIdentity({ uid: "new", profile: "user:new", generation: 2 }); return casSaved; },
      },
    });
    state.start();
    state.deps.setPending({ ...state.deps.pending()!, localHash: await hashEmpty() });
    expect(await resolveConflict({}, state.deps)).toBe("aborted");
    expect(state.writes).toEqual([]);
  });

  it("stops the remaining commits when identity changes at each durable boundary", async () => {
    for (const boundary of ["profile-base", "metadata"] as const) {
      const state = harness();
      state.start();
      state.deps.setPending({ ...state.deps.pending()!, localHash: await hashEmpty() });
      if (boundary === "metadata") {
        state.deps.metadata = async () => { state.writes.push("metadata"); state.setIdentity(null); };
      } else {
        const repository = state.deps.repository;
        repository.saveProfileAndBase = async (profile: string) => {
          state.writes.push(`${boundary}:${profile}`);
          state.setIdentity(null);
        };
      }
      expect(await resolveConflict({}, state.deps)).toBe("aborted");
      expect(state.writes).not.toContain("data");
    }
  });
});
