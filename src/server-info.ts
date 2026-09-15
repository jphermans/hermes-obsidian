/**
 * What the Hermes server says about itself.
 *
 * `/v1/capabilities` is Hermes-native, so the plugin treats it as optional: it reads the
 * fields it understands, keeps the rest out of the way, and says plainly when a feature it
 * relies on is missing rather than failing later with a confusing error.
 */

import type { ConnectionState } from "./types";

export interface ServerInfo {
  /** Version string the server reports, whatever it calls it. */
  version: string;
  /** Feature flags, lower-cased, in the order the server listed them. */
  features: string[];
  /** Whether the server advertises accepting images in a request. */
  vision: boolean;
}

const VERSION_KEYS = ["version", "server_version", "hermes_version", "app_version", "build"];
const FEATURE_KEYS = ["features", "capabilities", "enabled", "flags"];
const VISION_KEYS = ["vision", "images", "image_input", "multimodal", "attachments"];

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return ["true", "yes", "1", "on", "supported", "enabled"].indexOf(value.trim().toLowerCase()) >= 0;
  return false;
}

function featureList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").map((entry) => String(entry).trim().toLowerCase());
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .filter((key) => truthy((value as Record<string, unknown>)[key]))
      .map((key) => key.toLowerCase());
  }
  return [];
}

/** Read a /v1/capabilities payload defensively — an unknown shape must not throw. */
export function readServerInfo(capabilities: unknown): ServerInfo {
  const info: ServerInfo = { version: "", features: [], vision: false };
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return info;
  const body = capabilities as Record<string, unknown>;
  for (const key of VERSION_KEYS) {
    const value = asString(body[key]);
    if (value) {
      info.version = value;
      break;
    }
  }
  for (const key of FEATURE_KEYS) {
    const list = featureList(body[key]);
    if (list.length > 0) {
      info.features = list;
      break;
    }
  }
  for (const key of VISION_KEYS) {
    if (truthy(body[key])) {
      info.vision = true;
      break;
    }
  }
  if (!info.vision && info.features.some((feature) => VISION_KEYS.indexOf(feature) >= 0)) info.vision = true;
  return info;
}

/** The server's own description, or "" when it never said. */
export function describeServer(state: ConnectionState | null): string {
  if (!state) return "";
  const parts: string[] = [];
  if (state.version) parts.push("Hermes " + state.version);
  if (state.features && state.features.length > 0) parts.push(state.features.slice(0, 6).join(", "));
  return parts.join(" · ");
}

/**
 * Things worth saying before they surprise you: a server too old to report itself, a
 * streaming setting the server does not offer, and images that cannot be sent.
 */
export function capabilityWarnings(state: ConnectionState | null, settings: { streaming: boolean; sendImages: boolean }): string[] {
  const warnings: string[] = [];
  if (!state || !state.ok) return warnings;
  if (!state.version && (!state.features || state.features.length === 0)) {
    warnings.push(
      "This server did not answer /v1/capabilities, so the plugin cannot tell which optional features it supports — streaming and images may not work. Update Hermes on the host if that endpoint is missing."
    );
    return warnings;
  }
  const features = state.features || [];
  if (settings.streaming && features.length > 0 && features.indexOf("streaming") < 0 && features.indexOf("sse") < 0 && features.indexOf("stream") < 0) {
    warnings.push("Streaming answers is on, but this server does not advertise streaming. Press Verify streaming, or turn the setting off.");
  }
  if (settings.sendImages && !readServerInfo({ capabilities: features }).vision) {
    warnings.push("Sending images to the model is on, but this server does not advertise accepting them — the image is still saved to the vault and linked in the note.");
  }
  return warnings;
}
