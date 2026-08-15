import { describe, expect, it } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { AuthTransitionGate, isCurrentProfileActivation, loadProfileIfCurrent } from "./profile-state.js";

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
});
