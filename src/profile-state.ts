import type { Session } from "@supabase/supabase-js";
import type { ProfileKey } from "./repository.js";

const NO_QUEUED_SESSION = Symbol("no queued auth session");

export class AuthTransitionGate {
  private removalToken: object | undefined;
  private queuedSession: Session | null | typeof NO_QUEUED_SESSION = NO_QUEUED_SESSION;

  beginRemoval(): object {
    const token = {};
    this.removalToken = token;
    this.queuedSession = NO_QUEUED_SESSION;
    return token;
  }

  isCurrentRemoval(token: object): boolean {
    return this.removalToken === token;
  }

  queueDuringRemoval(session: Session | null): boolean {
    if (!this.removalToken) return false;
    this.queuedSession = session;
    return true;
  }

  finishRemoval(token: object): Session | null | undefined {
    if (this.removalToken !== token) return undefined;
    const queued = this.queuedSession;
    this.removalToken = undefined;
    this.queuedSession = NO_QUEUED_SESSION;
    return queued === NO_QUEUED_SESSION ? undefined : queued;
  }
}

export function isCurrentProfileActivation(
  profile: ProfileKey,
  generation: number,
  currentGeneration: number,
  activeUserId: string | undefined,
): boolean {
  if (generation !== currentGeneration) return false;
  return profile === "guest" ? activeUserId === undefined : profile === `user:${activeUserId ?? ""}`;
}

export async function loadProfileIfCurrent<T>(load: () => Promise<T>, isCurrent: () => boolean): Promise<T | undefined> {
  const loaded = await load();
  return isCurrent() ? loaded : undefined;
}

export async function settleAccountCleanup(
  cleanup: readonly (() => Promise<void>)[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(cleanup.map((operation) => operation()));
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}

export async function loadGuestSafely<T>(
  load: () => Promise<T>,
): Promise<{ data: T } | { error: unknown }> {
  try {
    return { data: await load() };
  } catch (error) {
    return { error };
  }
}
