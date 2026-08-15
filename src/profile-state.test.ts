import { describe, expect, it } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { AuthTransitionGate, drainLatestAuthTransitions, isCurrentProfileActivation, loadGuestSafely, loadProfileIfCurrent, settleAccountCleanup } from "./profile-state.js";

describe("profile transition state", () => {
  it("coalesces same-UID token refresh until account removal finishes", () => {
    const gate = new AuthTransitionGate();
    const token = gate.beginRemoval();
    const session = {
      access_token: "token",
      refresh_token: "refresh",
      expires_in: 3600,
      expires_at: 1,
      token_type: "bearer",
      user: { id: "same-user", email: "same@example.com", user_metadata: {}, app_metadata: {}, aud: "authenticated", created_at: "", role: "authenticated" },
    } as Session;
    expect(gate.queueDuringRemoval(session)).toBe(true);
    expect(gate.isCurrentRemoval(token)).toBe(true);
    expect(gate.finishRemoval(token)).toBe(session);
    expect(gate.isCurrentRemoval(token)).toBe(false);
  });

  it("rejects an older activation after a newer identity generation wins", () => {
    expect(isCurrentProfileActivation("user:old", 1, 2, "new")).toBe(false);
    expect(isCurrentProfileActivation("user:new", 2, 2, "new")).toBe(true);
    expect(isCurrentProfileActivation("guest", 3, 3, undefined)).toBe(true);
  });

  it("does not expose a stale load after a newer activation takes ownership", async () => {
    let release!: (value: string) => void;
    let generation = 1;
    const oldLoad = loadProfileIfCurrent(() => new Promise<string>((resolve) => { release = resolve; }), () => generation === 1);
    generation = 2;
    release("old profile");
    await expect(oldLoad).resolves.toBeUndefined();
  });

  it("drains a queued same-identity transition after an earlier activation rejects", async () => {
    let queued: string | undefined = "A";
    let releaseA!: () => void;
    const first = new Promise<void>((resolve) => { releaseA = resolve; });
    const activated: string[] = [];
    const operation = drainLatestAuthTransitions(
      () => queued !== undefined,
      () => { const next = queued; queued = undefined; return next; },
      async (next) => {
        if (next === "A") {
          releaseA();
          queued = "B";
          await first;
          throw new Error("A failed");
        }
        activated.push(next);
      },
    );
    await operation;
    expect(activated).toEqual(["B"]);
  });

  it("drains a queued different-identity transition after an earlier activation rejects", async () => {
    let queued: string | undefined = "old";
    const activated: string[] = [];
    await drainLatestAuthTransitions(
      () => queued !== undefined,
      () => { const next = queued; queued = undefined; return next; },
      async (next) => {
        if (next === "old") {
          queued = "new";
          throw new Error("old failed");
        }
        activated.push(next);
      },
    );
    expect(activated).toEqual(["new"]);
  });

  it("settles profile cleanup when profile deletion fails", async () => {
    const errors = await settleAccountCleanup([
      async () => { throw new Error("profile delete failed"); },
      async () => undefined,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "profile delete failed" });
  });

  it("settles profile cleanup when metadata deletion fails", async () => {
    const errors = await settleAccountCleanup([
      async () => undefined,
      async () => { throw new Error("metadata delete failed"); },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "metadata delete failed" });
  });

  it("preserves both independent cleanup failures", async () => {
    const errors = await settleAccountCleanup([
      async () => { throw new Error("profile delete failed"); },
      async () => { throw new Error("metadata delete failed"); },
    ]);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "profile delete failed",
      "metadata delete failed",
    ]);
  });

  it("completes normal cleanup without errors", async () => {
    await expect(settleAccountCleanup([async () => undefined, async () => undefined])).resolves.toEqual([]);
  });

  it("keeps guest data empty when guest loading fails", async () => {
    const guestLoad = await loadGuestSafely(async () => { throw new Error("guest load failed"); });
    expect("error" in guestLoad).toBe(true);
    expect((guestLoad as { error: Error }).error.message).toBe("guest load failed");
  });
});
