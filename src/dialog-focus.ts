export type DialogKind = "delete-point" | "delete-game" | "rename-game" | "clear-guest" | "remove-profile" | "conflict" | "guest-import" | "restore";
export type DialogFocus = "cancel" | "input" | "backup" | "guest-copy";

export function dialogInitialFocus(kind: DialogKind): DialogFocus {
  if (kind === "rename-game") return "input";
  if (kind === "conflict") return "backup";
  if (kind === "guest-import") return "guest-copy";
  return "cancel";
}
