export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/i.test(navigator.platform) ||
    /Mac/i.test(navigator.userAgent));

export const MOD = isMac ? "⌘" : "Ctrl";
export const SHIFT_KEY = isMac ? "⇧" : "Shift";

export function formatShortcut(...parts: string[]): string {
  return parts.join(isMac ? " " : "+");
}
