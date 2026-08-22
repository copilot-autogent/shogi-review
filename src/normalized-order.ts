/** PostgreSQL int4 max; migrated rows use compact nonnegative array indexes. */
export const MAX_SOURCE_ORDER = 2_147_483_647;
/** New imports are ordered in minutes from this epoch, leaving millennia of headroom. */
export const IMPORT_ORDER_EPOCH = "2020-01-01T00:00:00.000Z";

export function importSourceOrder(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return 0;
  const minutes = Math.floor((timestamp - Date.parse(IMPORT_ORDER_EPOCH)) / 60_000);
  if (!Number.isSafeInteger(minutes)) return 0;
  return Math.max(0, Math.min(MAX_SOURCE_ORDER, minutes));
}
