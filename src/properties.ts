/**
 * Obsidian property (frontmatter) rules, following the official documentation
 * (help.obsidian.md/properties, /tags and /aliases):
 *
 *  - one YAML block at the very top, between `---` lines, `name: value` with a space
 *    after the colon, each name used once;
 *  - the types are Text, List, Number, Checkbox, Date, Date & time and Tags, and a
 *    property's type belongs to its NAME across the whole vault — every note with that
 *    name uses that type;
 *  - a List is one `- value` per line, with internal links quoted;
 *  - Tags are a type used exclusively by the `tags` property, always written as a list,
 *    without `#`, and every tag needs at least one non-numeric character;
 *  - dates are `YYYY-MM-DD`, dates with times are `YYYY-MM-DDTHH:MM:SS`;
 *  - nested properties are unsupported, and `tag`/`alias`/`cssclass` were deprecated in
 *    1.4 with their support dropped in 1.9.
 *
 * It also guards two traps in the round trip through js-yaml:
 *
 * Obsidian's own parser is YAML, but it only recognises a fixed set of *shapes*:
 * text, list, number, checkbox, date and datetime. Everything else it renders as
 * an unsupported value — and two traps live in the round trip through js-yaml:
 *
 *   1. `created: 2026-09-14` parses to a JS Date, and dumping it back writes
 *      `2026-09-14T00:00:00.000Z` — a UTC datetime, not the local date the vault uses.
 *   2. A date that arrives as a *string* is dumped **quoted** (`'2026-09-14'`), which
 *      Obsidian reads as Text rather than a Date property.
 *
 * This module parses, checks, normalises and serialises properties so what lands in
 * the note is what Obsidian expects.
 */

import { parseYaml, stringifyYaml } from "obsidian";
import type { VaultConventions } from "./types";

export interface PropertyIssue {
  level: "warn" | "info";
  /** The key it is about, when the issue belongs to one. */
  key?: string;
  message: string;
}

/** Letters, digits, then letters/digits/underscore/hyphen. Obsidian allows no spaces. */
export const PROPERTY_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Keys Obsidian treats as lists; a comma string here is a common mistake. */
export const LIST_PROPERTY_KEYS = ["tags", "tag", "aliases", "alias", "cssclasses"];

/**
 * The Tags *type* is exclusive to the `tags` property — it cannot be assigned to another
 * name ("Tags properties are a special property type used exclusively by the tags
 * property"). `tag` is its deprecated spelling, so it gets the tag hygiene too.
 */
export const TAG_KEYS = ["tag", "tags"];

/** Deprecated in Obsidian 1.4, support as default properties dropped in 1.9. */
export const DEPRECATED_KEYS: Record<string, string> = {
  tag: "tags",
  alias: "aliases",
  cssclass: "cssclasses",
};

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Accepted when reading; the documented *stored* form includes seconds. */
export const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
/** What Obsidian writes: `time: 2020-08-21T10:30:00`. */
export const DATE_TIME_CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/** A tag needs at least one non-numeric character: `#1984` is not a valid tag. */
export const NUMERIC_ONLY_TAG = /^\d+$/;
export const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;
const DASHED_DATE = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;
const WRITTEN_DATE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}$/i;

/**
 * Today where the user is. `toISOString().slice(0, 10)` is UTC, so in Brussels (UTC+2) it
 * reports *yesterday* between midnight and 02:00 — a note created "today" would be dated
 * yesterday.
 */
export function todayLocal(now: Date = new Date()): string {
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test((value || "").trim());
}

export function isDateTime(value: string): boolean {
  return DATE_TIME.test((value || "").trim());
}

/** A date-ish string Obsidian will NOT read as a Date property. */
export function looksLikeWrongDate(value: string): boolean {
  const text = (value || "").trim();
  if (isDateOnly(text) || isDateTime(text)) return false;
  if (DASHED_DATE.test(text) || WRITTEN_DATE.test(text)) return true;
  return false;
}

export function isValidPropertyKey(key: string): boolean {
  return PROPERTY_KEY_PATTERN.test((key || "").trim());
}

function pad(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

/**
 * A Date back to what Obsidian stores.
 *
 * js-yaml resolves timestamps as **UTC** — `created: 2026-09-14` arrives as 2026-09-14T00:00Z,
 * which in Brussels is 02:00 local, so reading it back with local getters would write
 * `2026-09-14T02:00`. A Date the plugin built locally at midnight is the mirror case. So the
 * basis whose time-of-day is midnight decides: local midnight keeps its own calendar date,
 * everything the YAML parser produced is formatted back in UTC.
 */
export function yamlDateToString(date: Date): string {
  const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  const useUtc = !localMidnight;
  const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
  const month = (useUtc ? date.getUTCMonth() : date.getMonth()) + 1;
  const dayOfMonth = useUtc ? date.getUTCDate() : date.getDate();
  const hours = useUtc ? date.getUTCHours() : date.getHours();
  const minutes = useUtc ? date.getUTCMinutes() : date.getMinutes();
  const seconds = useUtc ? date.getUTCSeconds() : date.getSeconds();
  const day = year + "-" + pad(month) + "-" + pad(dayOfMonth);
  if (hours === 0 && minutes === 0 && seconds === 0) return day;
  // Obsidian stores a Date & time as YYYY-MM-DDTHH:MM:SS, seconds included.
  return day + "T" + pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
}

/** Dates from the YAML parser become strings, so nothing re-serialises as an ISO stamp. */
export function reviveProperties(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = reviveValue(value);
  return out;
}

function reviveValue(value: unknown): unknown {
  if (value instanceof Date) return yamlDateToString(value);
  if (Array.isArray(value)) return value.map(reviveValue);
  return value;
}

export type PropertyKind =
  | "text"
  | "list"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "empty"
  | "unsupported";

/** What Obsidian will show this value as. */
export function propertyKind(value: unknown): PropertyKind {
  if (value === null || value === undefined || value === "") return "empty";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    if (isDateOnly(value)) return "date";
    if (isDateTime(value)) return "datetime";
    return "text";
  }
  return "unsupported";
}

function stripQuotes(text: string): string {
  const value = text.trim();
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * A recovered scalar, typed the way YAML would have typed it — including the rule that
 * quoting makes it text: `"1977"` stays a string while `1977` is a number.
 */
function coerceScalar(text: string): unknown {
  const raw = text.trim();
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1);
  }
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

export interface FrontmatterRecovery {
  data: Record<string, unknown>;
  /** Lines that could not be read as a property at all. */
  skipped: string[];
}

/**
 * A block that fails to parse means Obsidian shows *no* properties, and a naive
 * read-then-write would drop every one of them. Read it line by line instead, so a single
 * malformed line cannot take the rest down with it: `name: value` with or without the space
 * after the colon, and `- item` lines belonging to the key above them.
 */
export function recoverFrontmatter(raw: string): FrontmatterRecovery | null {
  const data: Record<string, unknown> = {};
  const skipped: string[] = [];
  let lastKey: string | null = null;
  let items: unknown[] | null = null;
  for (const line of (raw || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.charAt(0) === "#") continue;
    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item && lastKey) {
      if (!items) {
        items = [];
        data[lastKey] = items;
      }
      items.push(coerceScalar(item[1].trim()));
      continue;
    }
    const match = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) {
      skipped.push(trimmed.slice(0, 60));
      lastKey = null;
      items = null;
      continue;
    }
    lastKey = match[1];
    items = null;
    data[lastKey] = match[2].trim() === "" ? null : coerceScalar(match[2]);
  }
  if (Object.keys(data).length === 0) return null;
  return { data, skipped };
}

/** Problems with the raw block that the parsed data cannot tell you about. */
export function checkPropertyText(raw: string): PropertyIssue[] {
  const issues: PropertyIssue[] = [];
  const text = raw || "";
  if (text.trim().length === 0) {
    issues.push({ level: "warn", message: "The frontmatter block is empty — Obsidian shows an empty properties panel." });
    return issues;
  }
  if (/\t/.test(text)) {
    issues.push({ level: "warn", message: "The frontmatter contains a tab character; YAML requires spaces." });
  }
  const seen = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9_][A-Za-z0-9_ -]*):/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    seen.set(key, (seen.get(key) || 0) + 1);
    // "Property names are separated from their values by a colon followed by a space."
    // Without the space the line is a plain YAML scalar, so Obsidian sees no property.
    if (line.charAt(match[0].length) !== " " && line.charAt(match[0].length) !== "") {
      issues.push({
        level: "warn",
        key,
        message: "Obsidian writes a property as “" + key + ": value” — with the space after the colon. Without it the line is not a property at all.",
      });
    }
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      issues.push({
        level: "warn",
        key,
        message: "The property “" + key + "” is declared " + count + " times — YAML keeps the last one and silently drops the rest.",
      });
    }
  }
  return issues;
}

/** The doc's words for a value shape, for messages a user reads. */
function kindLabel(kind: PropertyKind): string {
  if (kind === "list") return "a list";
  if (kind === "number") return "a number";
  if (kind === "checkbox") return "a checkbox";
  if (kind === "date") return "a date";
  if (kind === "datetime") return "a date and time";
  if (kind === "empty") return "empty";
  return "text";
}

/** The vault's type name for a key, in the vocabulary of this module. */
function vaultKind(vaultType: string): PropertyKind | null {
  if (vaultType === "list") return "list";
  if (vaultType === "date") return "date";
  if (vaultType === "number") return "number";
  if (vaultType === "boolean") return "checkbox";
  if (vaultType === "text") return "text";
  return null;
}

/**
 * "Once a property type is assigned to a property name, all properties with that name across
 * your vault will use the same type." So a note that reuses one of the vault's property names
 * with a different shape gets the wrong type in the properties panel — and, worse, the panel
 * may then show it as the vault's type. Worth saying before the note is written.
 */
export type KnownPropertyTypes = Record<string, string>;

/** The vault's type for each property name it already uses, keyed in lower case. */
export function vaultTypeMap(conventions: VaultConventions | null): KnownPropertyTypes {
  const known: KnownPropertyTypes = {};
  if (!conventions || !Array.isArray(conventions.keys)) return known;
  for (const info of conventions.keys) {
    if (!info || typeof info.key !== "string") continue;
    const type = info.types && info.types[0] ? info.types[0] : "";
    if (type) known[info.key.trim().toLowerCase()] = type;
  }
  return known;
}

export function vaultTypeIssues(
  data: Record<string, unknown> | null,
  conventions: VaultConventions | null
): PropertyIssue[] {
  const issues: PropertyIssue[] = [];
  if (!data) return issues;
  const known = new Map<string, string>();
  for (const [key, type] of Object.entries(vaultTypeMap(conventions))) known.set(key, type);
  if (known.size === 0) return issues;
  for (const [key, value] of Object.entries(data)) {
    const vaultType = known.get(key.trim().toLowerCase());
    if (!vaultType) continue;
    const expected = vaultKind(vaultType);
    const actual = propertyKind(value);
    if (!expected || actual === "empty" || actual === "unsupported") continue;
    const matches = expected === actual || (expected === "date" && actual === "datetime");
    if (matches) continue;
    issues.push({
      level: "warn",
      key,
      message:
        "This vault already uses “" + key + "” as " + kindLabel(expected) + " property, but this value is " + kindLabel(actual) +
        ". Obsidian keeps one type per property name across the whole vault, so it would show as " + kindLabel(expected) + " — match the vault or use another name.",
    });
  }
  return issues;
}

/** One line for the preview: the property name, when the issue belongs to one. */
export function describePropertyIssue(issue: PropertyIssue): string {
  return issue.key ? "“" + issue.key + "” — " + issue.message : issue.message;
}

/** Every rule Obsidian enforces on a property, per key. */
export function checkProperties(data: Record<string, unknown> | null): PropertyIssue[] {
  const issues: PropertyIssue[] = [];
  if (!data) return issues;
  for (const [key, value] of Object.entries(data)) {
    const trimmed = key.trim();
    if (DEPRECATED_KEYS[trimmed.toLowerCase()]) {
      issues.push({
        level: "warn",
        key: trimmed,
        message: "“" + trimmed + "” was deprecated in Obsidian 1.4 and support as a default property was dropped in 1.9 — use “" + DEPRECATED_KEYS[trimmed.toLowerCase()] + "”.",
      });
    }
    if (trimmed.length === 0) {
      issues.push({ level: "warn", message: "A property has an empty name, which Obsidian cannot store." });
      continue;
    }
    if (trimmed !== key) {
      issues.push({ level: "info", key, message: "The property name “" + key + "” has surrounding spaces; Obsidian trims it." });
    }
    if (/\s/.test(trimmed)) {
      issues.push({
        level: "warn",
        key: trimmed,
        message: "Property names cannot contain spaces — Obsidian refuses them. Use “" + trimmed.replace(/\s+/g, "-").toLowerCase() + "”.",
      });
    } else if (!isValidPropertyKey(trimmed)) {
      issues.push({
        level: "warn",
        key: trimmed,
        message: "Property names may only contain letters, numbers, “_” and “-”. Obsidian will show “" + trimmed + "” as invalid.",
      });
    }

    if (Array.isArray(value)) {
      if (value.some((entry) => entry !== null && typeof entry === "object" && !(entry instanceof Date))) {
        issues.push({ level: "warn", key, message: "A property list may only hold text, numbers or dates — nested objects are unsupported." });
      }
      if (value.length === 0) {
        issues.push({ level: "info", key, message: "The list property “" + key + "” is empty." });
      }
      if (typeof value === "string") return issues;
      for (const entry of value) {
        if (entry === null || entry === "") {
          issues.push({ level: "info", key, message: "The list property “" + key + "” has an empty entry, which Obsidian shows as a blank row." });
        }
      }
      if (TAG_KEYS.indexOf(key.toLowerCase()) >= 0) {
        for (const entry of value) {
          const tag = typeof entry === "string" ? entry.trim() : "";
          if (tag === "") continue;
          if (tag.charAt(0) === "#") {
            issues.push({ level: "info", key, message: "Tags in the tags property are written without “#” — Obsidian adds it when rendering." });
          }
          if (/\s/.test(tag)) {
            issues.push({
              level: "warn",
              key,
              message: "The tag “" + tag + "” contains a space, which Obsidian splits on. Use “" + tag.replace(/\s+/g, "-") + "” or nesting (“a/b”).",
            });
          }
          if (tag.indexOf(",") >= 0) {
            issues.push({ level: "warn", key, message: "The tag “" + tag + "” contains a comma — each tag belongs on its own “- value” line." });
          }
          if (NUMERIC_ONLY_TAG.test(tag.replace(/^#+/, ""))) {
            issues.push({
              level: "warn",
              key,
              message: "“" + tag.replace(/^#+/, "") + "” is all digits, and a tag needs at least one non-numeric character — Obsidian does not accept it.",
            });
          }
        }
      }
      continue;
    }

    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      issues.push({
        level: "warn",
        key,
        message: "Object properties are unsupported in Obsidian — it shows “" + key + "” as an invalid value. Use a list of text values instead.",
      });
      continue;
    }

    if (typeof value === "string") {
      if (isDateTime(value) && !DATE_TIME_CANONICAL.test(value.trim())) {
        issues.push({
          level: "info",
          key,
          message: "Obsidian stores a Date & time as YYYY-MM-DDTHH:MM:SS — “" + value.trim() + "” is missing the seconds.",
        });
      }
      if (!TAG_KEYS.concat(LIST_PROPERTY_KEYS).includes(key.toLowerCase()) && /(^|\s)#[^\s#]+/.test(value)) {
        // "Hashtags do not create tags when used in text properties."
        issues.push({
          level: "info",
          key,
          message: "A hashtag inside a text property is only text — Obsidian creates tags from the tags property or from a #tag in the note body.",
        });
      }
      if (looksLikeWrongDate(value)) {
        issues.push({
          level: "warn",
          key,
          message: "“" + value.trim() + "” is not a date Obsidian recognises — use YYYY-MM-DD for a Date, or YYYY-MM-DDTHH:MM:SS for a Date & time.",
        });
      }
      if (LIST_PROPERTY_KEYS.indexOf(key.toLowerCase()) >= 0 && value.indexOf(",") >= 0) {
        issues.push({
          level: "warn",
          key,
          message: "“" + key + "” should be a list, not a comma-separated line — Obsidian would store it as a single text value.",
        });
      }
      if (/^(true|false)$/i.test(value.trim())) {
        issues.push({
          level: "info",
          key,
          message: "“" + value.trim() + "” is quoted, so Obsidian shows it as text rather than a checkbox.",
        });
      }
      if (NUMERIC_TEXT.test(value.trim()) && key.toLowerCase().indexOf("count") >= 0) {
        issues.push({ level: "info", key, message: "“" + value.trim() + "” is quoted, so it is a text property rather than a number." });
      }
    }
  }
  return issues;
}

/**
 * Repairs the shapes Obsidian cannot store, without changing what the values mean.
 * Returns the fixed object plus a human list of what changed.
 */
export function normalizeProperties(
  data: Record<string, unknown> | null,
  knownTypes: KnownPropertyTypes = {}
): {
  data: Record<string, unknown> | null;
  fixes: string[];
} {
  if (!data) return { data: null, fixes: [] };
  const fixes: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    let name = key.trim();
    if (name.length === 0) {
      fixes.push("dropped a property with an empty name");
      continue;
    }
    if (/\s/.test(name) || !isValidPropertyKey(name)) {
      const fixed = name.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
      if (fixed.length > 0 && isValidPropertyKey(fixed)) {
        fixes.push("renamed “" + name + "” to “" + fixed + "” (property names cannot contain spaces or punctuation)");
        name = fixed;
      } else {
        fixes.push("dropped the unusable property name “" + name + "”");
        continue;
      }
    }
    // `tag`/`alias`/`cssclass` are dead letters since Obsidian 1.9: rename them, keeping
    // values that are already there under the modern name.
    const modern = DEPRECATED_KEYS[name.toLowerCase()];
    if (modern && modern !== name) {
      const existing = out[modern];
      if (existing === undefined) {
        fixes.push("renamed “" + name + "” to “" + modern + "” (the old name was deprecated in Obsidian 1.4)");
        name = modern;
      } else {
        const merged = mergeListValues(existing, value);
        out[modern] = merged;
        fixes.push("merged the deprecated “" + name + "” into “" + modern + "”");
        continue;
      }
    }
    const plainObject = value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
    if (plainObject) {
      // Obsidian shows an object as an invalid value; dropping the key is kinder than
      // storing something it cannot render.
      fixes.push("dropped the object property “" + name + "” (unsupported in Obsidian)");
      continue;
    }
    const vaultType = knownTypes[name.toLowerCase()];
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      const previous = out[name];
      const cleaned = normalizeValue(name, value, fixes, vaultType);
      if (Array.isArray(previous) || Array.isArray(cleaned)) {
        out[name] = mergeListValues(previous, cleaned);
        fixes.push("merged the repeated “" + name + "” instead of dropping a value");
      } else {
        out[name] = cleaned;
        fixes.push("kept the last “" + name + "” (it is declared twice; YAML would too)");
      }
      continue;
    }
    out[name] = normalizeValue(name, value, fixes, vaultType);
  }
  return { data: out, fixes };
}

/** Keeps both values when a deprecated key is merged into its modern name. */
function mergeListValues(existing: unknown, incoming: unknown): unknown {
  const left = Array.isArray(existing) ? existing.slice() : [existing];
  const right = Array.isArray(incoming) ? incoming : [incoming];
  const merged: unknown[] = [];
  for (const entry of left.concat(right)) {
    if (entry === null || entry === undefined) continue;
    const text = typeof entry === "string" ? entry.trim() : entry;
    if (text === "") continue;
    if (merged.some((item) => String(item) === String(text))) continue;
    merged.push(text);
  }
  return merged;
}

function normalizeValue(key: string, value: unknown, fixes: string[], vaultType = ""): unknown {
  const lower = key.toLowerCase();
  if (typeof value === "string") {
    let text = value.trim();
    // A quoted "true"/"false" is always a mistake: Obsidian reads it as text, not a checkbox.
    if (/^(true|false)$/i.test(text)) {
      fixes.push("turned “" + key + "” into a checkbox (" + text.toLowerCase() + ", unquoted)");
      return text.toLowerCase() === "true";
    }
    // The vault already decided this name is a number, so a numeric string is text only by
    // accident of quoting — make it the number the vault's panel expects.
    if (vaultType === "number" && NUMERIC_TEXT.test(text)) {
      fixes.push("made “" + key + "” a number, because this vault uses that name as a number");
      return Number(text);
    }
    if (LIST_PROPERTY_KEYS.indexOf(lower) >= 0 || vaultType === "list") {
      // tags, aliases and cssclasses are List properties in the documentation, so a bare
      // value is wrong even without a comma: `cssclass: wide` is a List of one. A name the
      // vault already uses as a list gets the same treatment.
      const parts = text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      // Always reported: a bare value on a List-typed key was a Text property before.
      fixes.push("turned “" + key + "” into a list (" + parts.length + " entr" + (parts.length === 1 ? "y" : "ies") + ")");
      return parts.map((part) => (TAG_KEYS.indexOf(lower) >= 0 ? part.replace(/^#+/, "") : part));
    }
    return text;
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      if (entry === null || entry === undefined) continue;
      if (typeof entry === "string") {
        let text = entry.trim();
        if (text.length === 0) continue;
        if (TAG_KEYS.indexOf(lower) >= 0) text = text.replace(/^#+/, "");
        if (entries.indexOf(text) < 0) entries.push(text);
        continue;
      }
      if (entry instanceof Date) {
        entries.push(yamlDateToString(entry));
        continue;
      }
      if (typeof entry === "object") {
        fixes.push("removed a nested object from the list “" + key + "” (unsupported in Obsidian)");
        continue;
      }
      entries.push(entry);
    }
    return entries;
  }
  if (value instanceof Date) return yamlDateToString(value);
  return value;
}

const QUOTED_SCALAR = /^(\s*(?:-\s+)?)([A-Za-z0-9_-]+):\s*'([^']*)'(\s*)$/;

/**
 * YAML for the properties block, with the two date traps undone: date-shaped scalars
 * are emitted **unquoted** (so Obsidian reads a Date) and never as an ISO timestamp.
 */
export function serializeProperties(
  data: Record<string, unknown> | null,
  knownTypes: KnownPropertyTypes = {}
): { text: string; fixes: string[] } {
  const { data: normalized, fixes } = normalizeProperties(data, knownTypes);
  if (!normalized || Object.keys(normalized).length === 0) return { text: "", fixes };
  let yaml = "";
  try {
    yaml = stringifyYaml(normalized).replace(/[\n]+$/, "");
  } catch {
    return { text: "", fixes };
  }
  const lines = yaml.split("\n").map((line) => {
    const match = QUOTED_SCALAR.exec(line);
    if (!match) return line;
    const value = match[3];
    if (isDateOnly(value) || isDateTime(value)) {
      return match[1] + match[2] + ": " + value + match[4];
    }
    return line;
  });
  const hasQuotedDate = yaml !== lines.join("\n");
  if (hasQuotedDate) fixes.push("unquoted a date so Obsidian stores it as a Date, not text");
  return { text: lines.join("\n"), fixes };
}

/** Sanity check used by the tests and the setup guide: does this parse back cleanly? */
export function roundTripProperties(text: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return reviveProperties(parsed as Record<string, unknown>);
    }
    return null;
  } catch {
    return null;
  }
}
