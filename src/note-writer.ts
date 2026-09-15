/**
 * File-name and note-content handling: sanitising names the way Obsidian does,
 * unwrapping model output that came back fenced or chatty, merging frontmatter
 * without destroying existing values, and creating files that never collide.
 */

import { App, TFile, normalizePath } from "obsidian";
import { serializeProperties } from "./properties";
import type { KnownPropertyTypes } from "./properties";
import { splitFrontmatter } from "./vault-rules";
import type { FilenameStyle } from "./types";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Illegal in a file name on at least one Obsidian platform: " # * / : < > ? [ \ ] ^ | */
const BAD_FILENAME_CODES = new Set<number>([34, 35, 42, 47, 58, 60, 62, 63, 91, 92, 93, 94, 124]);

export function isBadFilenameChar(code: number): boolean {
  return code < 32 || code === 127 || BAD_FILENAME_CODES.has(code);
}

export function sanitizeFilename(input: string, fallback = "Untitled note"): string {
  const source = stripBom(input || "").split("\n").join(" ").split("\r").join(" ");
  let out = "";
  for (const character of source.normalize("NFC")) {
    const code = character.codePointAt(0) || 0;
    if (isBadFilenameChar(code)) continue;
    out += character;
  }
  out = out.split("  ").join(" ").trim();
  while (out.length > 0 && (out.charAt(0) === "." || out.charAt(0) === " ")) out = out.slice(1);
  while (out.length > 0 && (out.endsWith(".") || out.endsWith(" "))) out = out.slice(0, out.length - 1);
  if (out.length > 100) out = out.slice(0, 100).trim();
  if (out.length === 0) out = fallback;
  return out;
}

function keepAllowed(text: string, allowed: (code: number) => boolean): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) || 0;
    if (code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 97 && code <= 122)) {
      out += character;
      continue;
    }
    if (allowed(code)) out += character;
  }
  return out;
}

function collapseRepeats(text: string, character: string): string {
  let out = text;
  const double = character + character;
  while (out.indexOf(double) >= 0) out = out.split(double).join(character);
  return out;
}

function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function applyFilenameStyle(name: string, style: FilenameStyle): string {
  if (style === "keep") return name;
  const words = name
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return name;
  if (style === "title") return titleCase(words.join(" "));
  const joined = words.join(" ");
  if (style === "kebab") {
    const lowered = keepAllowed(joined.toLowerCase(), (code) => code === 32).trim();
    const dashed = collapseRepeats(lowered.split(" ").filter((part) => part.length > 0).join("-"), "-");
    return dashed.replace(/^-+/, "").replace(/-+$/, "") || name;
  }
  const lowered = keepAllowed(joined.toLowerCase(), (code) => code === 32).trim();
  const underscored = collapseRepeats(lowered.split(" ").filter((part) => part.length > 0).join("_"), "_");
  return underscored.replace(/^_+/, "").replace(/_+$/, "") || name;
}

const CHATTER_PREFIX = [
  "sure,",
  "sure!",
  "sure thing",
  "here is",
  "here's",
  "heres ",
  "here you go",
  "absolutely",
  "certainly",
  "of course",
  "below is",
  "the following is",
  "this is the",
  "i've written",
  "i have written",
  "i created",
  "i've created",
  "great,",
];

const CHATTER_SUFFIX = [
  "let me know",
  "feel free",
  "i hope",
  "would you like",
  "if you'd like",
  "if you want",
  "hope this helps",
  "just say the word",
];

const FENCE = "```";

function stripChatter(text: string): string {
  const lines = text.split("\n");
  let headRemoved = 0;
  while (lines.length > 1 && headRemoved < 5) {
    const first = lines[0].trim();
    if (first.length === 0) {
      lines.shift();
      headRemoved++;
      continue;
    }
    if (first.length > 200) break;
    const lower = first.toLowerCase();
    if (!CHATTER_PREFIX.some((prefix) => lower.startsWith(prefix))) break;
    lines.shift();
    headRemoved++;
  }
  let tailRemoved = 0;
  while (lines.length > 1 && tailRemoved < 4) {
    const last = lines[lines.length - 1].trim();
    if (last.length === 0) {
      lines.pop();
      tailRemoved++;
      continue;
    }
    if (last.length > 200) break;
    const lower = last.toLowerCase();
    if (!CHATTER_SUFFIX.some((prefix) => lower.startsWith(prefix))) break;
    lines.pop();
    tailRemoved++;
  }
  return lines.join("\n");
}

/** Unwrap a single fence that wraps the whole note (a very common model tic). */
export function unwrapFence(text: string): string {
  if (!text.startsWith(FENCE)) return text;
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return text;
  const info = text.slice(FENCE.length, firstBreak).trim().toLowerCase();
  const isNoteFence = info === "" || info === "md" || info === "markdown";
  if (!isNoteFence) return text;
  const tail = text.lastIndexOf(FENCE);
  if (tail <= firstBreak) return text;
  if (text.slice(tail + FENCE.length).trim().length > 0) return text;
  const inner = text.slice(firstBreak + 1, tail).trim();
  return inner.indexOf(FENCE) >= 0 ? text : inner;
}

/** Turn raw model output into the note file it was supposed to be. */
export function extractNote(raw: string): string {
  let text = (raw || "").split("\r\n").join("\n").trim();
  for (let pass = 0; pass < 2; pass++) {
    text = stripChatter(text);
    text = unwrapFence(text);
  }
  // A trailing unclosed fence is always an artefact.
  if (text.indexOf(FENCE) >= 0) {
    const tail = text.lastIndexOf(FENCE);
    if (text.indexOf(FENCE) === tail && tail > 0 && text.slice(tail + FENCE.length).trim().length === 0) {
      text = text.slice(0, tail).trim();
    }
  }
  return text.trim();
}

function firstHeading(body: string): string {
  const lines = body.split("\n");
  let inspected = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    inspected++;
    if (inspected > 6) break;
    if (trimmed.charAt(0) === "#") {
      let level = 0;
      while (level < trimmed.length && trimmed.charAt(level) === "#") level++;
      if (level === 1 && trimmed.charAt(level) === " ") return trimmed.slice(level).trim();
    }
  }
  return "";
}

/** Characters a model wraps a title in, stripped from both ends. */
const TITLE_JUNK = "`*_\"'“”‘’[]()#";

/** Collapses a title to one clean line: no hashes, quotes, markdown or colons. */
export function normalizeTitle(raw: string): string {
  let text = (raw || "").split("\n")[0].trim();
  let changed = true;
  while (changed) {
    changed = false;
    while (text.length > 0 && TITLE_JUNK.indexOf(text.charAt(0)) >= 0) {
      text = text.slice(1).trim();
      changed = true;
    }
    while (text.length > 0 && TITLE_JUNK.indexOf(text.charAt(text.length - 1)) >= 0) {
      text = text.slice(0, -1).trim();
      changed = true;
    }
  }
  while (text.endsWith(":") || text.endsWith(".")) text = text.slice(0, -1).trim();
  if (text.toLowerCase().startsWith("title:")) text = text.slice(6).trim();
  return text.split("\t").join(" ").split(" ").filter((word) => word.length > 0).join(" ");
}

/** Stand-ins that say nothing about the note. */
const PLACEHOLDER_TITLES = [
  "hermes",
  "hermes answer",
  "hermes reply",
  "hermes note",
  "hermes agent",
  "hermes agent notes",
  "answer",
  "the answer",
  "reply",
  "response",
  "output",
  "assistant",
  "the assistant",
  "ai",
  "ai answer",
  "ai note",
  "note",
  "new note",
  "my note",
  "untitled",
  "untitled note",
  "document",
  "markdown",
  "content",
];

/**
 * True for titles that name the assistant or say nothing: a note must be named
 * after what is in it, never "Hermes answer" or "Untitled".
 */
export function isPlaceholderTitle(title: string): boolean {
  const cleaned = normalizeTitle(title).toLowerCase();
  if (cleaned.length === 0) return true;
  if (PLACEHOLDER_TITLES.indexOf(cleaned) >= 0) return true;
  if (cleaned.startsWith("hermes")) {
    const rest = cleaned.slice(6).trim();
    if (
      rest.length === 0 ||
      rest.charAt(0) === ":" ||
      rest.charAt(0) === "-" ||
      rest.startsWith("answer") ||
      rest.startsWith("reply") ||
      rest.startsWith("respons") ||
      rest.startsWith("note") ||
      rest.startsWith("agent") ||
      rest.startsWith("summary")
    ) {
      return true;
    }
  }
  if (cleaned.startsWith("ai ") || cleaned.startsWith("an ai ")) return true;
  if (cleaned.endsWith(" by hermes") || cleaned.endsWith(" by ai") || cleaned.endsWith(" by an ai")) return true;
  return false;
}

/** Shortens a title to something that still reads well as a file name. */
export function truncateTitle(text: string, maxWords = 8, maxChars = 60): string {
  const words = normalizeTitle(text).split(" ").filter((word) => word.length > 0);
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length >= maxWords) break;
    if (kept.length > 0 && kept.join(" ").length + word.length + 1 > maxChars) break;
    kept.push(word);
  }
  return kept.join(" ").trim();
}

/** Openers that mean the text is an instruction, not a subject. */
const INSTRUCTION_OPENERS = [
  "make",
  "fix",
  "rewrite",
  "summarise",
  "summarize",
  "create",
  "add",
  "insert",
  "append",
  "change",
  "update",
  "remove",
  "delete",
  "please",
  "can",
  "could",
  "explain",
  "what",
  "why",
  "how",
  "which",
  "who",
  "when",
  "where",
  "give",
  "show",
  "write",
  "turn",
  "split",
  "shorten",
  "expand",
  "translate",
  "answer",
];

/** A last-resort title taken from the request, when nothing better exists. */
export function usableFallbackTitle(text: string): string {
  const cleaned = normalizeTitle(text);
  if (cleaned.length === 0 || isPlaceholderTitle(cleaned)) return "";
  if (cleaned.endsWith("?")) return "";
  const words = cleaned.split(" ").filter((word) => word.length > 0);
  if (words.length > 9) return "";
  if (INSTRUCTION_OPENERS.indexOf(words[0].toLowerCase()) >= 0) return "";
  if (words[0].toLowerCase() === "the" && words.length > 1 && INSTRUCTION_OPENERS.indexOf(words[1].toLowerCase()) >= 0) {
    return "";
  }
  return truncateTitle(cleaned, 8, 60);
}

/** Strips a blockquote marker, a callout type or a bullet from a line. */
function stripBlockPrefix(line: string): string {
  let text = (line || "").trim();
  const markers = ">-+*|";
  while (text.length > 0 && markers.indexOf(text.charAt(0)) >= 0) text = text.slice(1).trim();
  // "> [!note] Boiler pressure is low" — the callout type is not the title.
  while (text.startsWith("[!")) {
    const closing = text.indexOf("]");
    if (closing < 0) break;
    text = text.slice(closing + 1).trim();
  }
  return text;
}

/** The title the note declares for itself: properties, or its H1. */
export function declaredTitle(content: string): string {
  const split = splitFrontmatter(content);
  if (split.data) {
    for (const key of ["title", "name", "aliases", "alias"]) {
      const value = split.data[key];
      let candidate = "";
      if (typeof value === "string") candidate = value.trim();
      else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
        candidate = String(value[0]).trim();
      }
      if (candidate.length > 0 && !isPlaceholderTitle(candidate)) return truncateTitle(candidate, 12, 90);
    }
  }
  const heading = firstHeading(split.body);
  if (heading && !isPlaceholderTitle(heading)) return truncateTitle(heading, 12, 90);
  return "";
}

/**
 * A title derived from the note itself when it declares none: the first line of
 * real text. Used only after the agent has been asked, and still never a
 * placeholder.
 */
export function contentTitle(content: string): string {
  const declared = declaredTitle(content);
  if (declared) return declared;
  const split = splitFrontmatter(content);
  let inFence = false;
  for (const line of split.body.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const stripped = stripBlockPrefix(line);
    if (stripped.length < 3) continue;
    if (stripped.charAt(0) === "#") continue;
    if (stripped.startsWith("---")) continue;
    if (isPlaceholderTitle(stripped)) continue;
    return truncateTitle(stripped, 8, 70);
  }
  return "";
}

export function titleFromNote(content: string, fallback: string): string {
  const declared = declaredTitle(content);
  if (declared) return declared;
  const derived = contentTitle(content);
  if (derived) return derived;
  const hint = usableFallbackTitle(fallback);
  if (hint) return hint;
  return "Untitled note";
}

export function serializeNote(
  frontmatter: Record<string, unknown> | null,
  body: string,
  knownTypes: KnownPropertyTypes = {}
): string {
  const cleanBody = body.replace(/^[\n]+/, "").replace(/[\n]+$/, "") + "\n";
  if (!frontmatter || Object.keys(frontmatter).length === 0) return cleanBody;
  // serializeProperties, not stringifyYaml: it emits dates unquoted (quoted dates are Text
  // properties, not Dates), keeps booleans bare, makes list-shaped keys lists, and drops
  // property names Obsidian cannot store.
  const { text: yaml } = serializeProperties(frontmatter, knownTypes);
  if (!yaml.trim()) return cleanBody;
  return ["---", yaml, "---", "", cleanBody].join("\n");
}

export function mergeFrontmatter(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null,
  options: { keepExisting?: boolean; mergeLists?: boolean } = {}
): Record<string, unknown> | null {
  const keepExisting = options.keepExisting !== false;
  const mergeLists = options.mergeLists !== false;
  if (!existing && !incoming) return null;
  if (!existing) return incoming;
  if (!incoming) return existing;
  const result: Record<string, unknown> = Object.assign({}, incoming);
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in result)) {
      result[key] = value;
      continue;
    }
    if (keepExisting) {
      result[key] = value;
      continue;
    }
    const incomingValue = result[key];
    if (mergeLists && Array.isArray(value) && Array.isArray(incomingValue)) {
      const merged = value.slice();
      for (const item of incomingValue) {
        const needle = String(item);
        if (!merged.some((entry) => String(entry) === needle)) merged.push(item);
      }
      result[key] = merged;
    }
  }
  return result;
}

export async function ensureFolder(app: App, folder: string): Promise<string> {
  const clean = normalizePath((folder || "").trim());
  if (!clean || clean === "/" || clean === ".") return "";
  let current = "";
  for (const part of clean.split("/")) {
    if (!part) continue;
    current = current ? current + "/" + part : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        /* created concurrently — harmless */
      }
    }
  }
  return clean;
}

export function uniquePath(app: App, folder: string, baseName: string, extension = ".md"): string {
  const dir = normalizePath((folder || "").trim());
  const prefix = !dir || dir === "/" || dir === "." ? "" : dir + "/";
  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? "" : " " + index;
    const path = normalizePath(prefix + baseName + suffix + extension);
    if (!app.vault.getAbstractFileByPath(path)) return path;
  }
  return normalizePath(prefix + baseName + " " + Date.now() + extension);
}

export async function writeNote(
  app: App,
  path: string,
  content: string,
  mode: "create" | "overwrite" | "append"
): Promise<TFile> {
  const target = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(target);
  if (existing instanceof TFile) {
    if (mode === "append") {
      const current = await app.vault.read(existing);
      const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      await app.vault.modify(existing, current + separator + content);
      return existing;
    }
    if (mode === "create") throw new Error("A note already exists at " + target + ".");
    await app.vault.modify(existing, content);
    return existing;
  }
  const parent = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  if (parent) await ensureFolder(app, parent);
  return await app.vault.create(target, content);
}

export function countWords(text: string): number {
  return text.split("\n").join(" ").split(" ").filter((part) => part.trim().length > 0).length;
}
