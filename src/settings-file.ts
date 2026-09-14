/**
 * Settings persistence helpers: what gets written to the automatic backup file,
 * what gets exported to a visible vault file, and how an imported file is
 * validated before it is allowed to change anything.
 */

import { hostOfUrl, isLoopbackHost } from "./hermes-client";
import type { HermesAgentNotesSettings } from "./types";

export const BACKUP_FILENAME = "settings-backup.json";
export const EXPORT_FILENAME = "Hermes Agent Notes settings.json";

/** Caches, not settings: never exported, never imported. */
export const RUNTIME_KEYS = ["conventions", "connection", "availableModels"];

export function settingsBackupPath(pluginId: string): string {
  const id = (pluginId || "hermes-agent-notes").replace(/[/]+$/, "");
  return ".obsidian/plugins/" + id + "/" + BACKUP_FILENAME;
}

export function settingsExportPath(folder: string): string {
  const dir = (folder || "").replace(/^[/]+/, "").replace(/[/]+$/, "");
  return (dir ? dir + "/" : "") + EXPORT_FILENAME;
}

/** The settings worth keeping, with caches stripped and a marker added. */
export function exportableSettings(settings: HermesAgentNotesSettings): Record<string, unknown> {
  const source = settings as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (RUNTIME_KEYS.indexOf(key) >= 0) continue;
    out[key] = source[key];
  }
  out.plugin = "hermes-agent-notes";
  out.exportedAt = new Date().toISOString();
  return out;
}

export interface ImportResult {
  settings: HermesAgentNotesSettings;
  applied: string[];
  ignored: string[];
  errors: string[];
}

function sameShape(current: unknown, incoming: unknown): boolean {
  if (Array.isArray(current)) return Array.isArray(incoming);
  if (current === null) return incoming === null;
  return typeof current === typeof incoming;
}

/**
 * Merges an imported object onto the current settings: only known keys with a
 * matching type are applied, unknown keys and type clashes are reported and
 * skipped, and caches are always ignored.
 */
export function mergeImportedSettings(
  current: HermesAgentNotesSettings,
  raw: unknown
): ImportResult {
  const result: ImportResult = { settings: Object.assign({}, current), applied: [], ignored: [], errors: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    result.errors.push("That file does not contain a settings object.");
    return result;
  }
  const incoming = raw as Record<string, unknown>;
  const known = Object.keys(current);
  for (const key of Object.keys(incoming)) {
    if (key === "plugin" || key === "exportedAt") continue;
    if (RUNTIME_KEYS.indexOf(key) >= 0) {
      result.ignored.push(key);
      continue;
    }
    if (known.indexOf(key) < 0) {
      result.ignored.push(key);
      continue;
    }
    const currentValue = (current as unknown as Record<string, unknown>)[key];
    const incomingValue = incoming[key];
    if (!sameShape(currentValue, incomingValue)) {
      result.errors.push(key + " has the wrong type");
      continue;
    }
    if (Array.isArray(incomingValue)) {
      (result.settings as unknown as Record<string, unknown>)[key] = incomingValue.slice();
    } else {
      (result.settings as unknown as Record<string, unknown>)[key] = incomingValue;
    }
    result.applied.push(key);
  }
  return result;
}

/**
 * On a phone or tablet, localhost points at the device itself — the Hermes
 * machine is elsewhere. Empty string means the URL is fine to save.
 */
export function loopbackBlockMessage(baseUrl: string, isMobile: boolean): string {
  if (!isMobile) return "";
  if (!baseUrl) return "";
  const host = hostOfUrl(baseUrl.indexOf("://") >= 0 ? baseUrl : "http://" + baseUrl);
  if (!host || !isLoopbackHost(host)) return "";
  return (
    host +
    " points at this phone or tablet itself, not at your Hermes machine, so it cannot be saved here. " +
    "Use the https:// address of your route instead (Tailscale, Cloudflare Tunnel, ngrok) — or save it anyway if Hermes really runs on this device."
  );
}
