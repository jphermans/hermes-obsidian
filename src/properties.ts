/**
 * Obsidian property (frontmatter) rules.
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

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
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
  return day + "T" + pad(hours) + ":" + pad(minutes) + (seconds > 0 ? ":" + pad(seconds) : "");
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
      if (LIST_PROPERTY_KEYS.indexOf(key.toLowerCase()) >= 0) {
        for (const entry of value) {
          const text = typeof entry === "string" ? entry : "";
          if (text.startsWith("#")) {
            issues.push({ level: "info", key, message: "Tags in properties are written without “#” — Obsidian adds it when rendering." });
            break;
          }
        }
        for (const entry of value) {
          if (typeof entry === "string" && /\s/.test(entry.trim()) && key.toLowerCase().indexOf("tag") >= 0) {
            issues.push({
              level: "warn",
              key,
              message: "The tag “" + entry.trim() + "” contains a space — Obsidian splits tags on spaces. Use “" + entry.trim().replace(/\s+/g, "-") + "” or nesting (“a/b”).",
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
      if (looksLikeWrongDate(value)) {
        issues.push({
          level: "warn",
          key,
          message: "“" + value.trim() + "” is not a date Obsidian recognises — use YYYY-MM-DD (or YYYY-MM-DDTHH:MM) so it becomes a Date property instead of text.",
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
export function normalizeProperties(data: Record<string, unknown> | null): {
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
    const plainObject = value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
    if (plainObject) {
      // Obsidian shows an object as an invalid value; dropping the key is kinder than
      // storing something it cannot render.
      fixes.push("dropped the object property “" + name + "” (unsupported in Obsidian)");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      fixes.push("removed a duplicate “" + name + "”");
    }
    out[name] = normalizeValue(name, value, fixes);
  }
  return { data: out, fixes };
}

function normalizeValue(key: string, value: unknown, fixes: string[]): unknown {
  const lower = key.toLowerCase();
  if (typeof value === "string") {
    let text = value.trim();
    // A quoted "true"/"false" is always a mistake: Obsidian reads it as text, not a checkbox.
    if (/^(true|false)$/i.test(text)) {
      fixes.push("turned “" + key + "” into a checkbox (" + text.toLowerCase() + ", unquoted)");
      return text.toLowerCase() === "true";
    }
    if (LIST_PROPERTY_KEYS.indexOf(lower) >= 0 && text.indexOf(",") >= 0) {
      const parts = text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      fixes.push("turned “" + key + "” into a list (" + parts.length + " entries)");
      return parts.map((part) => (lower.indexOf("tag") >= 0 ? part.replace(/^#+/, "") : part));
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
        if (lower.indexOf("tag") >= 0) text = text.replace(/^#+/, "");
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
export function serializeProperties(data: Record<string, unknown> | null): { text: string; fixes: string[] } {
  const { data: normalized, fixes } = normalizeProperties(data);
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
