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
    expect(userErrorMessage(new Error("網路失敗"))).toBe("網路失敗");
    expect(userErrorMessage(new Error("INSERT failed: private payload"))).not.toContain("private");
    expect(userErrorMessage({ arbitrary: "value" })).toBeTruthy();
  });
});
