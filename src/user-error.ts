type PostgrestErrorShape = { code?: unknown; message?: unknown };

function postgrestError(error: unknown): PostgrestErrorShape | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const value = error as Record<string, unknown>;
  if (!("code" in value) && !("message" in value)) return null;
  return { code: value.code, message: value.message };
}

const SAFE_LOCAL_MESSAGES = new Set([
  "請貼上棋譜或選擇檔案。",
  "棋譜沒有可重播的指し手，無法建立複盤。",
  "檔案不是有效的 UTF-8 或 Shift-JIS，無法安全解碼。",
  "目前離線；已停用雲端資料修改，重新連線後再試。",
  "無法確認帳號資料來源；目前僅能檢視，請重新連線後再修改。",
  "資料版本已變更或已刪除，請重新載入後再試。",
  "無法建立安全的棋局排序值。",
]);

export function userErrorMessage(error: unknown): string {
  const shaped = postgrestError(error);
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  if (code === "23505") return "資料已存在，請重新載入後再試。";
  if (code === "23503" || code === "23514") return "棋局資料格式不完整，請重新匯入。";
  if (code === "42501" || code === "PGRST301") return "帳號沒有執行此操作的權限，請重新登入後再試。";
  if (code.startsWith("PGRST")) return "雲端資料服務暫時無法完成操作，請重新載入後再試。";
  if (code === "NETWORK_ERROR" || code === "FETCH_ERROR") return "目前無法連線，請確認網路後再試。";
  if (error instanceof Error && SAFE_LOCAL_MESSAGES.has(error.message.trim())) return error.message.trim();
  return "操作失敗，請重新載入後再試。";
}
