import { describe, expect, it } from "vitest";
import { assertKnownWritableAuthority, MemoryAuthorityCache, resolveAuthority } from "./authority.js";

const finalized = { status: "finalized", source_hash: "source", target_hash: "target" };
const verified = { status: "verified", source_hash: "source", target_hash: "target" };

describe("per-account authority resolution", () => {
  it.each([
    [true, null, "legacy", false],
    [true, verified, "legacy", false],
    [true, finalized, "normalized", false],
  ])("resolves online status %s", async (online, status, authority, readOnly) => {
    const cache = new MemoryAuthorityCache();
    const result = await resolveAuthority({ userId: "u1", online, readStatus: async () => status, cache });
    expect(result.authority).toBe(authority);
    expect(result.readOnly).toBe(readOnly);
  });

  it("uses only the account-scoped cached status offline", async () => {
    const cache = new MemoryAuthorityCache();
    cache.write("u1", finalized);
    const result = await resolveAuthority({ userId: "u1", online: false, readStatus: async () => { throw new Error("offline"); }, cache });
    expect(result.authority).toBe("normalized");
    expect(result.readOnly).toBe(true);
    const unknown = await resolveAuthority({ userId: "u2", online: false, readStatus: async () => { throw new Error("offline"); }, cache });
    expect(unknown.authority).toBe("unknown");
    expect(() => assertKnownWritableAuthority(unknown)).toThrow("無法確認");
  });

  it("does not use stale cached legacy status as a normalized write authority", async () => {
    const cache = new MemoryAuthorityCache();
    cache.write("u1", verified);
    const result = await resolveAuthority({ userId: "u1", online: false, readStatus: async () => { throw new Error("offline"); }, cache });
    expect(result.authority).toBe("legacy");
    expect(result.readOnly).toBe(true);
    expect(() => assertKnownWritableAuthority(result)).toThrow("離線");
  });
});
