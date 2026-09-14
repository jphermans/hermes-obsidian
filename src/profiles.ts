/**
 * Connection profiles: several Hermes instances — a local one and a remote one,
 * or two profiles on the same gateway — saved by name and switched in one click.
 * The active settings stay where they always were; a profile is a snapshot of
 * them, so nothing else in the plugin needs to know profiles exist.
 */

import type { AccessMode, HermesAgentNotesSettings } from "./types";

export interface ConnectionProfile {
  id: string;
  name: string;
  baseUrl: string;
  accessMode: AccessMode;
  profile: string;
  apiKey: string;
  extraHeaders: string;
  model: string;
  provider: string;
  /** Last time this profile was saved or used. */
  at: number;
}

export const MAX_PROFILES = 12;

/** The connection fields, and nothing else. */
export function captureProfile(settings: HermesAgentNotesSettings, name: string, at: number): ConnectionProfile {
  return {
    id: "profile-" + String(at),
    name: name.trim().slice(0, 40) || "Connection",
    baseUrl: settings.baseUrl,
    accessMode: settings.accessMode,
    profile: settings.profile,
    apiKey: settings.apiKey,
    extraHeaders: settings.extraHeaders,
    model: settings.model,
    provider: settings.provider,
    at,
  };
}

/** Copies a profile into the live settings. Returns the same object for chaining. */
export function applyProfile(
  settings: HermesAgentNotesSettings,
  profile: ConnectionProfile
): HermesAgentNotesSettings {
  settings.baseUrl = profile.baseUrl;
  settings.accessMode = profile.accessMode;
  settings.profile = profile.profile;
  settings.apiKey = profile.apiKey;
  settings.extraHeaders = profile.extraHeaders;
  if (profile.model) settings.model = profile.model;
  settings.provider = profile.provider;
  return settings;
}

export function normalizeProfiles(input: unknown): ConnectionProfile[] {
  if (!Array.isArray(input)) return [];
  const out: ConnectionProfile[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Partial<ConnectionProfile>;
    if (typeof record.baseUrl !== "string" || record.baseUrl.trim().length === 0) continue;
    const id =
      typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : "profile-" + (out.length + 1);
    if (out.some((entry) => entry.id === id)) continue;
    out.push({
      id,
      name: typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim().slice(0, 40) : "Connection",
      baseUrl: record.baseUrl.trim(),
      accessMode: (record.accessMode as AccessMode) || "custom",
      profile: typeof record.profile === "string" ? record.profile : "",
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
      extraHeaders: typeof record.extraHeaders === "string" ? record.extraHeaders : "",
      model: typeof record.model === "string" ? record.model : "",
      provider: typeof record.provider === "string" ? record.provider : "",
      at: typeof record.at === "number" ? record.at : 0,
    });
    if (out.length >= MAX_PROFILES) break;
  }
  return out.sort((a, b) => b.at - a.at);
}

export function upsertProfile(list: ConnectionProfile[], profile: ConnectionProfile): ConnectionProfile[] {
  // Re-saving a name keeps the original id, so anything pointing at it stays valid.
  const existing = list.find(
    (entry) => entry.id === profile.id || entry.name.toLowerCase() === profile.name.toLowerCase()
  );
  const merged = existing && existing.id !== profile.id ? { ...profile, id: existing.id, name: existing.name } : profile;
  const others = list.filter(
    (entry) => entry.id !== merged.id && entry.name.toLowerCase() !== merged.name.toLowerCase()
  );
  return [merged, ...others].slice(0, MAX_PROFILES);
}

export function removeProfile(list: ConnectionProfile[], id: string): ConnectionProfile[] {
  return list.filter((entry) => entry.id !== id);
}

export function findProfile(list: ConnectionProfile[], id: string): ConnectionProfile | null {
  return list.find((entry) => entry.id === id) || null;
}

/** "Remote (https://hermes.example.com, key set)" — never the key itself. */
export function describeProfile(profile: ConnectionProfile): string {
  let host = profile.baseUrl;
  try {
    const url = new URL(profile.baseUrl);
    host = url.host + (url.pathname && url.pathname !== "/" ? url.pathname : "");
  } catch {
    host = profile.baseUrl;
  }
  const parts = [host];
  if (profile.profile) parts.push("profile " + profile.profile);
  parts.push(profile.apiKey.trim().length > 0 ? "key set" : "no key");
  if (profile.model) parts.push(profile.model);
  return parts.join(" · ");
}

/** True when the live settings are already exactly this profile. */
export function profileMatches(settings: HermesAgentNotesSettings, profile: ConnectionProfile): boolean {
  return (
    settings.baseUrl === profile.baseUrl &&
    settings.profile === profile.profile &&
    settings.apiKey === profile.apiKey &&
    settings.extraHeaders === profile.extraHeaders
  );
}
