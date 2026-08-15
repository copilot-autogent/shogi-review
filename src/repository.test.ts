import { describe, expect, it } from "vitest";
import { saveProfileAndBaseTransaction } from "./repository.js";

const base = { data: { games: [] }, revision: 1, payloadHash: "hash", hashVersion: 1 };

function transactionHarness() {
  const writes: string[] = [];
  const committed = new Map<string, unknown>();
  let aborted = false;
  const transaction = {
    error: null,
    oncomplete: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    abort: () => { aborted = true; },
    objectStore(name: string) { return { put: (value: unknown, key: string) => { writes.push(name); committed.set(`${name}:${key}`, value); } }; },
  } as unknown as IDBTransaction;
  return { transaction, writes, committed, wasAborted: () => aborted };
}

describe("profile/base transaction terminal semantics", () => {
  it("waits for onabort when cancellation happens before commit", async () => {
    const { transaction } = transactionHarness();
    const controller = new AbortController();
    const operation = saveProfileAndBaseTransaction(transaction, "user:u", { games: [] }, base, () => true, controller.signal);
    controller.abort();
    let settled = false;
    void operation.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    transaction.onabort?.(new Event("abort"));
    await expect(operation).rejects.toThrow("同步資料交易已取消");
  });

  it("resolves oncomplete even when the guard changes after writes are committed", async () => {
    const { transaction, writes, committed } = transactionHarness();
    let canCommit = true;
    const operation = saveProfileAndBaseTransaction(transaction, "user:u", { games: [] }, base, () => canCommit, new AbortController().signal);
    expect(writes).toEqual(["profiles", "syncBases"]);
    canCommit = false;
    transaction.oncomplete?.(new Event("complete"));
    expect(committed.has("profiles:user:u")).toBe(true);
    expect(committed.has("syncBases:user:u")).toBe(true);
    await expect(operation).resolves.toBeUndefined();
  });
});
