import type { AppData, IssueTag } from "./model.js";
import { mergeAppData, type MergeConflict } from "./merge.js";
import { createCloudPayload, payloadHash, validateCloudPayload, type PendingConflict, type SyncIdentity, type SyncRepository, type SyncSnapshot } from "./sync.js";
import type { ProfileKey, SyncBaseRecord } from "./repository.js";
import { ISSUE_TAGS } from "./model.js";

export interface ConflictResolutionDependencies {
  identity: () => SyncIdentity | null;
  pending: () => PendingConflict | undefined;
  setPending: (conflict: PendingConflict | undefined) => void;
  data: () => AppData;
  setData: (data: AppData) => void;
  repository: { saveProfileAndBase: (profile: ProfileKey, data: AppData, base: SyncBaseRecord, canCommit: () => boolean, signal: AbortSignal) => Promise<void> };
  cloud: SyncRepository;
  metadata: (uid: string, value: SyncSnapshot) => Promise<void> | void;
  onResolved: () => void;
  signal: AbortSignal;
  localVersion: () => number;
}

export type ConflictResolutionResult = "resolved" | "aborted";

export async function resolveConflict(
  choices: Record<string, "cloud" | "local">,
  deps: ConflictResolutionDependencies,
): Promise<ConflictResolutionResult> {
  const initialIdentity = deps.identity();
  const initialConflict = deps.pending();
  if (!initialIdentity || !initialConflict || !sameConflictIdentity(initialIdentity, initialConflict)) {
    if (initialConflict && deps.pending() === initialConflict) deps.setPending(undefined);
    return "aborted";
  }
  const identity = { ...initialIdentity };
  const conflict = initialConflict;
  const localVersion = deps.localVersion();
  const valid = (): boolean => {
    const current = deps.identity();
    const pending = deps.pending();
    return Boolean(current
      && current.uid === identity.uid
      && current.profile === identity.profile
      && current.generation === identity.generation
      && !deps.signal?.aborted
      && pending
      && pending === conflict
      && sameConflictIdentity(identity, pending)
      && pending.rowRevision === conflict.rowRevision);
  };
  const ensureValid = (): boolean => valid();
  const abort = (): ConflictResolutionResult => {
    const current = deps.identity();
    if (deps.pending() === conflict && (!current || !sameConflictIdentity(current, conflict))) deps.setPending(undefined);
    return "aborted";
  };
  const readLocal = (): AppData => globalThis.structuredClone(deps.data());
  let latest: Awaited<ReturnType<SyncRepository["read"]>>;
  try {
    latest = await withAbort(deps.cloud.readWithSignal?.(identity.uid, deps.signal) ?? deps.cloud.read(identity.uid), deps.signal);
  } catch (error) {
    if (!ensureValid()) return abort();
    throw error;
  }
  if (!ensureValid()) return abort();
  if (!latest) {
    if (!ensureValid()) return abort();
    throw new Error("雲端資料已不存在，未覆蓋本機資料。");
  }
  const local = readLocal();
  const latestCloud = validateCloudPayload(latest.payload);
  if (latest.revision !== conflict.rowRevision) {
    const currentHash = await payloadHash(local);
    if (!ensureValid()) return abort();
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, local, latestCloud)
      : { data: local, conflicts: conflict.conflicts.slice(0, 1).map((item) => ({ ...item, entity: "game" as const, entityId: "*", field: "*", path: "library", base: undefined, local, cloud: latestCloud, reason: "membership" as const })) };
    if (!ensureValid()) return abort();
    deps.setPending({
      ...conflict,
      rowRevision: latest.revision,
      localHash: currentHash,
      cloudData: latestCloud,
      mergedData: refreshed.data,
      conflicts: refreshed.conflicts,
    });
    throw new Error("雲端已更新，請重新確認目前資料。");
  }
  const localHash = await payloadHash(local);
  if (!ensureValid()) return abort();
  if (localHash !== conflict.localHash) {
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, local, conflict.cloudData)
    : { data: local, conflicts: conflict.conflicts.map((item) => ({ ...item, local, cloud: conflict.cloudData })) };
    if (!ensureValid()) return abort();
    deps.setPending({ ...conflict, localHash, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  const next = globalThis.structuredClone(conflict.mergedData);
  const selectedChoices = Object.entries(choices).sort(([left], [right]) => {
    const leftItem = conflict.conflicts[Number(left)];
    const rightItem = conflict.conflicts[Number(right)];
    return Number(leftItem?.entity === "review") - Number(rightItem?.entity === "review");
  });
  for (const [index, selected] of selectedChoices) {
    const item = conflict.conflicts[Number(index)];
    if (item) applyConflictChoice(next, local, conflict.cloudData, item, selected);
  }
  const nextHash = await payloadHash(next);
  if (!ensureValid()) return abort();
  const latestLocal = readLocal();
  const latestLocalHash = await payloadHash(latestLocal);
  if (!ensureValid()) return abort();
  if (latestLocalHash !== localHash) {
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, latestLocal, conflict.cloudData)
      : { data: latestLocal, conflicts: conflict.conflicts.slice(0, 1).map((item) => ({ ...item, entity: "game" as const, entityId: "*", field: "*", path: "library", base: undefined, local: latestLocal, cloud: conflict.cloudData, reason: "membership" as const })) };
    if (!ensureValid()) return abort();
    deps.setPending({ ...conflict, localHash: latestLocalHash, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  let saved: Awaited<ReturnType<SyncRepository["casUpdate"]>>;
  try {
    saved = await withAbort(deps.cloud.casUpdateWithSignal?.(identity.uid, latest.revision, createCloudPayload(next), deps.signal) ?? deps.cloud.casUpdate(identity.uid, latest.revision, createCloudPayload(next)), deps.signal);
  } catch (error) {
    if (!ensureValid()) return abort();
    throw error;
  }
  // CAS may win immediately before logout; the post-CAS guard prevents that result
  // from crossing into the next profile's local, base, metadata, or UI state.
  if (!ensureValid()) return abort();
  const afterCasLocalHash = await payloadHash(readLocal());
  if (!ensureValid()) return abort();
  if (afterCasLocalHash !== localHash) {
    const latestLocal = readLocal();
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, latestLocal, next)
      : { data: latestLocal, conflicts: conflict.conflicts.slice(0, 1).map((item) => ({ ...item, entity: "game" as const, entityId: "*", field: "*", path: "library", base: undefined, local: latestLocal, cloud: next, reason: "membership" as const })) };
    if (!ensureValid()) return abort();
    deps.setPending({ ...conflict, baseData: next, rowRevision: saved.revision, localHash: afterCasLocalHash, cloudData: next, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  const base: SyncBaseRecord = { data: next, revision: saved.revision, payloadHash: nextHash, hashVersion: 1 };
  try {
    await deps.repository.saveProfileAndBase(identity.profile, next, base, ensureValid, deps.signal);
  } catch (error) {
    if (!ensureValid()) return abort();
    deps.setPending({ ...conflict, baseData: next, rowRevision: saved.revision, localHash: nextHash, cloudData: next, mergedData: next, conflicts: [] });
    throw error;
  }
  if (!ensureValid()) return abort();
  const savedLocal = readLocal();
  const savedLocalHash = await payloadHash(savedLocal);
  if (!ensureValid()) return abort();
  if (savedLocalHash !== nextHash) {
    const refreshed = mergeAppData(next, savedLocal, next);
    deps.setPending({ ...conflict, baseData: next, rowRevision: saved.revision, localHash: savedLocalHash, cloudData: next, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  if (deps.localVersion() !== localVersion) return abort();
  deps.setData(next);
  if (!ensureValid()) return abort();
  const metadata: SyncSnapshot = { ownerUid: identity.uid, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: nextHash, hashVersion: 1 };
  try {
    await deps.metadata(identity.uid, metadata);
  } catch (error) {
    if (!ensureValid()) return abort();
    deps.setPending({ ...conflict, baseData: next, rowRevision: saved.revision, localHash: nextHash, cloudData: next, mergedData: next, conflicts: [] });
    throw error;
  }
  if (!ensureValid()) return abort();
  const finalLocal = readLocal();
  const finalLocalHash = await payloadHash(finalLocal);
  if (!ensureValid()) return abort();
  if (finalLocalHash !== nextHash) {
    const refreshed = mergeAppData(next, finalLocal, next);
    deps.setPending({ ...conflict, baseData: next, rowRevision: saved.revision, localHash: finalLocalHash, cloudData: next, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  deps.setPending(undefined);
  deps.onResolved();
  return "resolved";
}

function sameConflictIdentity(identity: SyncIdentity, conflict: PendingConflict): boolean {
  return conflict.userId === identity.uid && conflict.profile === identity.profile && conflict.generation === identity.generation;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("同步身分已變更。"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      promise.then(() => undefined, () => undefined);
      reject(new Error("同步身分已變更。"));
      return;
    }
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function applyConflictChoice(target: AppData, local: AppData, cloud: AppData, item: MergeConflict, selected: "local" | "cloud"): void {
  const source = selected === "local" ? local : cloud;
  if (item.entityId === "*") {
    target.games = globalThis.structuredClone(source.games);
    return;
  }
  const separator = item.entityId.lastIndexOf(":");
  const gameId = item.entity === "review" && separator > 0 ? item.entityId.slice(0, separator) : item.entityId;
  const game = target.games.find((candidate) => candidate.id === gameId);
  const sourceGame = source.games.find((candidate) => candidate.id === gameId);
  if (item.entity === "game") {
    if (!sourceGame) {
      if (item.field === "__membership" || item.field === "identity") target.games = target.games.filter((candidate) => candidate.id !== gameId);
      return;
    }
    if (!game) {
      target.games.push(globalThis.structuredClone(sourceGame));
      return;
    }
    if (item.field === "__membership" || item.field === "identity") {
      const existingReviewPoints = Array.isArray(game.reviewPoints) ? game.reviewPoints : [];
      const sourceReviewPoints = Array.isArray(sourceGame.reviewPoints) ? sourceGame.reviewPoints : [];
      for (const key of Object.keys(game)) delete (game as unknown as Record<string, unknown>)[key];
      Object.assign(game, globalThis.structuredClone(sourceGame));
      game.reviewPoints = [
        ...globalThis.structuredClone(sourceReviewPoints),
        ...existingReviewPoints.filter((point) => !sourceReviewPoints.some((sourcePoint) => sourcePoint.ply === point.ply)),
      ].sort((left, right) => left.ply - right.ply);
    }
    else (game as unknown as Record<string, unknown>)[item.field] = cloneValue((sourceGame as unknown as Record<string, unknown>)[item.field]);
    return;
  }
  if (!game || !sourceGame) return;
  const ply = Number(item.entityId.split(":").at(-1));
  if (!Number.isInteger(ply)) return;
  if (!Array.isArray(game.reviewPoints)) game.reviewPoints = [];
  const point = game.reviewPoints.find((candidate) => candidate.ply === ply);
  const sourceReviewPoint = (Array.isArray(sourceGame.reviewPoints) ? sourceGame.reviewPoints : []).find((candidate) => candidate.ply === ply);
  if (!sourceReviewPoint) {
    game.reviewPoints = game.reviewPoints.filter((candidate) => candidate.ply !== ply);
    return;
  }
  if (!point) {
    game.reviewPoints.push(globalThis.structuredClone(sourceReviewPoint));
    game.reviewPoints.sort((left, right) => left.ply - right.ply);
    return;
  }
  if (item.field === "__membership" || item.field === "anchor") Object.assign(point, globalThis.structuredClone(sourceReviewPoint));
  else if (item.field.startsWith("issueTags.")) {
    const tag = item.field.slice("issueTags.".length) as IssueTag;
    point.issueTags = (Array.isArray(point.issueTags) ? point.issueTags : []).filter((candidate) => candidate !== tag);
    if (Array.isArray(sourceReviewPoint.issueTags) && sourceReviewPoint.issueTags.includes(tag)) point.issueTags.push(tag);
    point.issueTags = ISSUE_TAGS.filter((tagValue) => point.issueTags.includes(tagValue));
  } else {
    const sourceValue = (sourceReviewPoint as unknown as Record<string, unknown>)[item.field];
    (point as unknown as Record<string, unknown>)[item.field] = cloneValue(sourceValue);
  }
}

function cloneValue(value: unknown): unknown {
  return value === undefined ? undefined : globalThis.structuredClone(value);
}
