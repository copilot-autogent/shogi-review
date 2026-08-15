import type { AppData, IssueTag } from "./model.js";
import { mergeAppData, type MergeConflict } from "./merge.js";
import { createCloudPayload, payloadHash, validateCloudPayload, type PendingConflict, type SyncIdentity, type SyncRepository, type SyncSnapshot } from "./sync.js";
import type { ProfileRepository, SyncBaseRecord } from "./repository.js";
import { ISSUE_TAGS } from "./model.js";

export interface ConflictResolutionDependencies {
  identity: () => SyncIdentity | null;
  pending: () => PendingConflict | undefined;
  setPending: (conflict: PendingConflict | undefined) => void;
  data: () => AppData;
  setData: (data: AppData) => void;
  repository: Pick<ProfileRepository, "saveProfile" | "saveSyncBase">;
  cloud: SyncRepository;
  metadata: (uid: string, value: SyncSnapshot) => Promise<void> | void;
  onResolved: () => void;
}

export type ConflictResolutionResult = "resolved" | "aborted";

export async function resolveConflict(
  choices: Record<string, "cloud" | "local">,
  deps: ConflictResolutionDependencies,
): Promise<ConflictResolutionResult> {
  const initialIdentity = deps.identity();
  const initialConflict = deps.pending();
  if (!initialIdentity || !initialConflict || !sameConflictIdentity(initialIdentity, initialConflict)) return "aborted";
  const identity = { ...initialIdentity };
  const conflict = initialConflict;
  const valid = (): boolean => {
    const current = deps.identity();
    const pending = deps.pending();
    return Boolean(current
      && current.uid === identity.uid
      && current.profile === identity.profile
      && current.generation === identity.generation
      && pending
      && pending === conflict
      && sameConflictIdentity(identity, pending)
      && pending.rowRevision === conflict.rowRevision);
  };
  const ensureValid = (): boolean => valid();
  const readLocal = (): AppData => globalThis.structuredClone(deps.data());
  const latest = await deps.cloud.read(identity.uid);
  if (!ensureValid()) return "aborted";
  if (!latest) throw new Error("雲端資料已不存在，未覆蓋本機資料。");
  const local = readLocal();
  const latestCloud = validateCloudPayload(latest.payload);
  if (latest.revision !== conflict.rowRevision) {
    const currentHash = await payloadHash(local);
    if (!ensureValid()) return "aborted";
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, local, latestCloud)
      : { data: local, conflicts: conflict.conflicts };
    if (!ensureValid()) return "aborted";
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
  if (!ensureValid()) return "aborted";
  if (localHash !== conflict.localHash) {
    const refreshed = conflict.baseData
      ? mergeAppData(conflict.baseData, local, conflict.cloudData)
      : { data: local, conflicts: conflict.conflicts };
    if (!ensureValid()) return "aborted";
    deps.setPending({ ...conflict, localHash, mergedData: refreshed.data, conflicts: refreshed.conflicts });
    throw new Error("本機資料已更新，請重新確認目前資料。");
  }
  const next = globalThis.structuredClone(conflict.mergedData);
  for (const [index, selected] of Object.entries(choices)) {
    const item = conflict.conflicts[Number(index)];
    if (item) applyConflictChoice(next, local, conflict.cloudData, item, selected);
  }
  const nextHash = await payloadHash(next);
  if (!ensureValid()) return "aborted";
  const saved = await deps.cloud.casUpdate(identity.uid, latest.revision, createCloudPayload(next));
  // CAS may win immediately before logout; the post-CAS guard prevents that result
  // from crossing into the next profile's local, base, metadata, or UI state.
  if (!ensureValid()) return "aborted";
  await deps.repository.saveProfile(identity.profile, next);
  if (!ensureValid()) return "aborted";
  const base: SyncBaseRecord = { data: next, revision: saved.revision, payloadHash: nextHash, hashVersion: 1 };
  await deps.repository.saveSyncBase(identity.profile, base);
  if (!ensureValid()) return "aborted";
  const metadata: SyncSnapshot = { ownerUid: identity.uid, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: nextHash, hashVersion: 1 };
  await deps.metadata(identity.uid, metadata);
  if (!ensureValid()) return "aborted";
  deps.setData(next);
  if (!ensureValid()) return "aborted";
  deps.setPending(undefined);
  deps.onResolved();
  return "resolved";
}

function sameConflictIdentity(identity: SyncIdentity, conflict: PendingConflict): boolean {
  return conflict.userId === identity.uid && conflict.profile === identity.profile && conflict.generation === identity.generation;
}

function applyConflictChoice(target: AppData, local: AppData, cloud: AppData, item: MergeConflict, selected: "local" | "cloud"): void {
  const source = selected === "local" ? local : cloud;
  if (item.entityId === "*") {
    target.games = globalThis.structuredClone(source.games);
    return;
  }
  const gameId = item.entity === "review" ? item.entityId.slice(0, item.entityId.lastIndexOf(":")) : item.entityId;
  const game = target.games.find((candidate) => candidate.id === gameId);
  const sourceGame = source.games.find((candidate) => candidate.id === item.entityId || item.entityId.startsWith(`${candidate.id}:`));
  if (item.entity === "game") {
    if (!sourceGame) {
      if (item.field === "__membership" || item.field === "identity") target.games = target.games.filter((candidate) => candidate.id !== gameId);
      return;
    }
    if (!game) {
      target.games.push(globalThis.structuredClone(sourceGame));
      return;
    }
    if (item.field === "__membership" || item.field === "identity") Object.assign(game, globalThis.structuredClone(sourceGame));
    else if (item.field === "title" || item.field === "perspective") (game as unknown as Record<string, unknown>)[item.field] = globalThis.structuredClone((sourceGame as unknown as Record<string, unknown>)[item.field]);
    return;
  }
  if (!game || !sourceGame) return;
  const ply = Number(item.entityId.split(":").at(-1));
  const point = game.reviewPoints.find((candidate) => candidate.ply === ply);
  const sourcePoint = sourceGame.reviewPoints.find((candidate) => candidate.ply === ply);
  if (!sourcePoint) {
    if (item.field === "__membership" || item.field === "anchor") game.reviewPoints = game.reviewPoints.filter((candidate) => candidate.ply !== ply);
    return;
  }
  if (!point) {
    game.reviewPoints.push(globalThis.structuredClone(sourcePoint));
    return;
  }
  if (item.field === "__membership" || item.field === "anchor") Object.assign(point, globalThis.structuredClone(sourcePoint));
  else if (item.field.startsWith("issueTags.")) {
    const tag = item.field.slice("issueTags.".length) as IssueTag;
    point.issueTags = point.issueTags.filter((candidate) => candidate !== tag);
    if (sourcePoint.issueTags.includes(tag)) point.issueTags.push(tag);
    point.issueTags = ISSUE_TAGS.filter((tagValue) => point.issueTags.includes(tagValue));
  } else (point as unknown as Record<string, unknown>)[item.field] = globalThis.structuredClone((sourcePoint as unknown as Record<string, unknown>)[item.field]);
}
