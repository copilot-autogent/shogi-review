type PostgrestErrorShape = { code?: unknown; message?: unknown };

function postgrestError(error: unknown): PostgrestErrorShape | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const value = error as Record<string, unknown>;
  if (!("code" in value) && !("message" in value)) return null;
  return { code: value.code, message: value.message };
}

export function userErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message && !/\b(sql|select|insert|update|delete|postgres|postgrest|payload|details|hint|http(?:s)?[:/])/i.test(message)) return message;
    return "操作失敗，請重新載入後再試。";
  }
  const shaped = postgrestError(error);
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  if (code === "23505") return "資料已存在，請重新載入後再試。";
  if (code === "23503" || code === "23514") return "棋局資料格式不完整，請重新匯入。";
  if (code === "42501" || code.startsWith("PGRST")) return "帳號沒有執行此操作的權限，請重新登入後再試。";
  if (code === "NETWORK_ERROR" || code === "FETCH_ERROR") return "目前無法連線，請確認網路後再試。";
  return "操作失敗，請重新載入後再試。";
}
