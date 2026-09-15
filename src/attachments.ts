/**
 * Pasted images: naming, where they go, and how they travel.
 *
 * Kept pure so the naming and encoding can be tested without a vault: `Buffer` does not
 * exist on mobile, so base64 is done by hand.
 */

export interface PendingImage {
  /** File name inside the vault, extension included. */
  name: string;
  /** Raw bytes. */
  data: ArrayBuffer;
  /** MIME type as the browser reported it. */
  type: string;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

export function extensionFor(type: string, fallback = "png"): string {
  const clean = (type || "").split(";")[0].trim().toLowerCase();
  return EXTENSIONS[clean] || fallback;
}

/** `hermes-2026-09-15-1.png` — sortable, and obviously ours. */
export function attachmentName(type: string, at: Date = new Date(), index = 1): string {
  const pad = (value: number) => (value < 10 ? "0" + value : String(value));
  const stamp = at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate());
  return "hermes-" + stamp + "-" + index + "." + extensionFor(type);
}

/** Where attachments go: the setting, else "Attachments" at the vault root. */
export function attachmentFolder(setting: string): string {
  const clean = (setting || "").trim().replace(/^[/]+/, "").replace(/[/]+$/, "");
  return clean || "Attachments";
}

export function attachmentPath(folder: string, name: string): string {
  const clean = attachmentFolder(folder);
  return clean + "/" + name.replace(/^[/]+/, "");
}

/** A name that is not taken yet, given the paths that already exist. */
export function uniqueAttachmentName(existing: string[], folder: string, name: string): string {
  const taken = new Set(existing.map((path) => path.toLowerCase()));
  if (!taken.has(attachmentPath(folder, name).toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 500; index++) {
    const candidate = stem + "-" + index + extension;
    if (!taken.has(attachmentPath(folder, candidate).toLowerCase())) return candidate;
  }
  return stem + "-" + Date.now() + extension;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of raw bytes, without Node's Buffer (mobile has none). */
export function base64Encode(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += BASE64.charAt(a >> 2);
    out += BASE64.charAt(((a & 3) << 4) | (b >> 4));
    out += index + 1 < bytes.length ? BASE64.charAt(((b & 15) << 2) | (c >> 6)) : "=";
    out += index + 2 < bytes.length ? BASE64.charAt(c & 63) : "=";
  }
  return out;
}

/** The data URL the OpenAI-compatible endpoint expects for an image part. */
export function imageDataUrl(image: PendingImage): string {
  const type = (image.type || "image/png").split(";")[0].trim() || "image/png";
  return "data:" + type + ";base64," + base64Encode(image.data);
}

/** The lines appended to a message so the note can embed what was pasted. */
export function embedLines(folder: string, names: string[]): string {
  return names.map((name) => "![[" + attachmentPath(folder, name) + "]]").join("\n");
}
