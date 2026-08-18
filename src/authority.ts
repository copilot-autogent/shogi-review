import type { MigrationStatus } from "./normalized.js";

export type RuntimeAuthority = "legacy" | "normalized" | "unknown";

export interface AuthoritySnapshot {
  userId: string;
  authority: RuntimeAuthority;
  online: boolean;
  readOnly: boolean;
  status: MigrationStatus | null;
}

export interface AuthorityCache {
  read(userId: string): MigrationStatus | null;
  write(userId: string, status: MigrationStatus): void;
}

export interface AuthorityResolutionOptions {
  userId: string;
  online: boolean;
  readStatus: () => Promise<MigrationStatus | null>;
  cache: AuthorityCache;
}

function authorityFor(status: MigrationStatus | null, online: boolean): RuntimeAuthority {
  if (status?.status === "finalized") return "normalized";
  if (status && ["migrated", "verified", "failed", "rolled_back"].includes(status.status)) return "legacy";
  return online ? "legacy" : "unknown";
}

export async function resolveAuthority(options: AuthorityResolutionOptions): Promise<AuthoritySnapshot> {
  let status: MigrationStatus | null;
  if (options.online) {
    status = await options.readStatus();
    options.cache.write(options.userId, status ?? { status: "migrated" });
  } else {
    status = options.cache.read(options.userId);
  }
  const authority = authorityFor(status, options.online);
  return {
    userId: options.userId,
    authority,
    online: options.online,
    readOnly: !options.online && authority !== "unknown",
    status,
  };
}

export function assertKnownWritableAuthority(snapshot: AuthoritySnapshot): void {
  if (snapshot.authority === "unknown") throw new Error("無法確認帳號資料來源；目前僅能檢視，請重新連線後再修改。");
  if (snapshot.readOnly) throw new Error("目前離線；已停用雲端資料修改，重新連線後再試。");
}

export class MemoryAuthorityCache implements AuthorityCache {
  private readonly statuses = new Map<string, MigrationStatus>();
  read(userId: string): MigrationStatus | null {
    const status = this.statuses.get(userId);
    return status ? globalThis.structuredClone(status) : null;
  }
  write(userId: string, status: MigrationStatus): void {
    this.statuses.set(userId, globalThis.structuredClone(status));
  }
}

export class LocalStorageAuthorityCache implements AuthorityCache {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage) {}
  read(userId: string): MigrationStatus | null {
    const value = this.storage.getItem(`shogi-review-authority:${userId}`);
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { status?: unknown }).status !== "string") return null;
      return parsed as MigrationStatus;
    } catch {
      this.storage.removeItem(`shogi-review-authority:${userId}`);
      return null;
    }
  }
  write(userId: string, status: MigrationStatus): void {
    this.storage.setItem(`shogi-review-authority:${userId}`, JSON.stringify(status));
  }
}
