import { invoke } from "@tauri-apps/api/core";

export interface SidecarHealth {
  status: string;
  version: string;
  engines: Record<string, unknown>;
}

/**
 * Proxy to the Rust `sidecar_health` command, which calls the Python sidecar's
 * token-guarded `/health`. Rejects with "sidecar starting" while it's (re)starting.
 */
export function sidecarHealth(): Promise<SidecarHealth> {
  return invoke<SidecarHealth>("sidecar_health");
}

export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/i.test(navigator.platform) ||
    /Mac/i.test(navigator.userAgent));

export const MOD = isMac ? "⌘" : "Ctrl";
export const SHIFT_KEY = isMac ? "⇧" : "Shift";

export function formatShortcut(...parts: string[]): string {
  return parts.join(isMac ? " " : "+");
}
