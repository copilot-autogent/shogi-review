import { describe, expect, it } from "vitest";
import { userErrorMessage } from "./user-error.js";

describe("safe user error messages", () => {
  it("renders actionable messages for PostgREST plain objects without leaking details", () => {
    const message = userErrorMessage({ code: "23514", message: "SQL secret", details: "payload secret", hint: "private hint" });
    expect(message).toContain("格式");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("payload");
  });

  it("handles Error and unknown objects safely", () => {
    expect(userErrorMessage(new Error("請貼上棋譜或選擇檔案。"))).toBe("請貼上棋譜或選擇檔案。");
    expect(userErrorMessage(new Error("網路失敗"))).toBe("操作失敗，請重新載入後再試。");
    expect(userErrorMessage(new Error("INSERT failed: private payload"))).not.toContain("private");
    expect(userErrorMessage({ arbitrary: "value" })).toBeTruthy();
  });

  it("classifies Error subclasses by structured code before inspecting messages", () => {
    const error = new Error('duplicate key value violates unique constraint "games_pkey"') as Error & { code: string };
    error.code = "23505";
    expect(userErrorMessage(error)).toBe("資料已存在，請重新載入後再試。");
    expect(userErrorMessage({ code: "PGRST204", message: "schema cache secret" })).toBe("雲端資料服務暫時無法完成操作，請重新載入後再試。");
  });
});
