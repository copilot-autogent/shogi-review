/** PostgreSQL int4 max; migrated rows use compact nonnegative array indexes. */
export const MAX_SOURCE_ORDER = 2_147_483_647;
/** Reserve a disjoint namespace above compact indexes produced by legacy migration. */
export const IMPORT_ORDER_BASE = 1_000_000_000;
/** New imports are ordered in minutes from this epoch, leaving millennia of headroom. */
export const IMPORT_ORDER_EPOCH = "2020-01-01T00:00:00.000Z";

export function importSourceOrder(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error("無法建立安全的棋局排序值。");
  const minutes = Math.floor((timestamp - Date.parse(IMPORT_ORDER_EPOCH)) / 60_000);
  const order = IMPORT_ORDER_BASE + minutes;
  if (!Number.isSafeInteger(order) || order < IMPORT_ORDER_BASE || order > MAX_SOURCE_ORDER) {
    throw new Error("無法建立安全的棋局排序值。");
  }
  return order;
}
