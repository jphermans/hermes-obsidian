/**
 * Vault inspection: works out how THIS vault actually writes Markdown
 * (properties, tags, link style, headings, file names, callouts) so Hermes can
 * be told the user's conventions instead of generic Markdown ones.
 *
 * Parsing is deliberately line-based — no regex escapes, no external parser,
 * and it works identically on desktop and mobile.
 */

import { App, parseYaml } from "obsidian";
import { isDateOnly, recoverFrontmatter, reviveProperties, todayLocal } from "./properties";
import type { FrontmatterKeyInfo, VaultConventions } from "./types";

export interface FrontmatterSplit {
  data: Record<string, unknown> | null;
  /** Raw YAML text between the fences. */
  raw: string;
  /** Everything after the closing fence. */
  body: string;
  present: boolean;
  /**
   * Set when the block did not parse as YAML and the properties were read line by line
   * instead — so they survive an edit that would otherwise write the note without them.
   */
  recovered?: { keys: number; skipped: string[] };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitFrontmatter(input: string): FrontmatterSplit {
  const normalised = stripBom(input || "").split("\r\n").join("\n");
  const lines = normalised.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: null, raw: "", body: normalised, present: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: null, raw: "", body: normalised, present: false };

  const raw = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^[\n]+/, "");
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // YAML turns `created: 2026-09-14` into a JS Date; re-serialising that writes
      // 2026-09-14T00:00:00.000Z. Keep dates as the strings Obsidian stores.
      data = reviveProperties(parsed as Record<string, unknown>);
    }
  } catch {
    data = null;
  }
  if (!data) {
    // The block is there but does not parse. Obsidian would show no properties at all, so
    // recover them line by line rather than read-then-write the note without them.
    const recovery = recoverFrontmatter(raw);
    if (recovery) {
      return {
        data: reviveProperties(recovery.data),
        raw,
        body,
        present: true,
        recovered: { keys: Object.keys(recovery.data).length, skipped: recovery.skipped },
      };
    }
    return { data: null, raw, body: normalised, present: false };
  }
  return { data, raw, body, present: true };
}

export function typeName(value: unknown): string {
  if (Array.isArray(value)) return "list";
  if (value instanceof Date) return "date";
  if (typeof value === "string" && isDateOnly(value)) return "date";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "map";
  const text = String(value == null ? "" : value);
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text)) return "date";
  return "text";
}

function sampleFor(value: unknown): string {
  if (Array.isArray(value)) {
    const flat = value.slice(0, 3).map((item) => String(item));
    return flat.length > 0 ? "[" + flat.join(", ") + "]" : "";
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object") return "";
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  return text.length > 28 ? text.slice(0, 28) + "…" : text;
}

function toTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isTagChar(code: number): boolean {
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  return code === 45 || code === 47 || code === 95; // - / _
}

export function isQuotedValue(value: string): boolean {
  const first = value.charAt(0);
  return (first === '"' || first === "'") && value.length > 1 && value.endsWith(first);
}

/** Counts quoted vs bare scalar values in a raw frontmatter block. */
export function countQuoting(rawYaml: string): { quoted: number; unquoted: number } {
  let quoted = 0;
  let unquoted = 0;
  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let value = trimmed;
    if (trimmed.startsWith("- ")) {
      value = trimmed.slice(2).trim();
    } else {
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      value = trimmed.slice(colon + 1).trim();
    }
    if (!value || value === "[]" || value === "{}" || value.startsWith("|") || value.startsWith(">")) continue;
    if (value.startsWith("[") || value.startsWith("{")) {
      if (value.includes('"') || value.includes("'")) quoted++;
      else unquoted++;
      continue;
    }
    if (isQuotedValue(value)) quoted++;
    else unquoted++;
  }
  return { quoted, unquoted };
}

export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function headingLevel(line: string): number {
  if (line.charAt(0) !== "#") return 0;
  let level = 0;
  while (level < line.length && line.charAt(level) === "#") level++;
  if (level > 6) return 0;
  return line.charAt(level) === " " ? level : 0;
}

function calloutType(line: string): string {
  const trimmed = line.trim();
  if (trimmed.charAt(0) !== ">") return "";
  const open = trimmed.indexOf("[!");
  if (open < 0) return "";
  const close = trimmed.indexOf("]", open);
  if (close < 0) return "";
  return trimmed.slice(open + 2, close).trim().toLowerCase();
}

export function listFolders(app: App): string[] {
  const counts = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([folder]) => folder);
}

/** Direct children of `folder` (root when the folder is empty), newest first. */
export function listNotesInFolder(app: App, folder: string, limit: number): string[] {
  const target = folder && folder !== "/" ? folder : "/";
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => (file.parent ? file.parent.path : "/") === target)
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
  const limited = limit > 0 ? files.slice(0, limit) : files;
  return limited.map((file) => file.basename);
}

export async function scanVault(app: App, sampleSize: number): Promise<VaultConventions> {
  const all = app.vault.getMarkdownFiles();
  const sorted = all.slice().sort((a, b) => b.stat.mtime - a.stat.mtime);
  const size = Math.max(1, Math.min(sampleSize, sorted.length));
  const sample = sorted.slice(0, size);

  const keyMap = new Map<string, { count: number; types: Set<string>; samples: string[] }>();
  const tagCounts = new Map<string, number>();
  const headingSamples: string[] = [];
  const nameSamples: string[] = [];
  const callouts = new Set<string>();

  let frontmatterUsed = 0;
  let notesWithH1 = 0;
  let notesWithAnyHeading = 0;
  let tagsInFrontmatter = 0;
  let tagsInline = 0;
  let wikiLinks = 0;
  let markdownLinks = 0;
  let embedCount = 0;
  let nameWords = 0;
  let separatorSpace = 0;
  let separatorHyphen = 0;
  let separatorUnderscore = 0;
  let separatorNone = 0;
  let quotedValues = 0;
  let unquotedValues = 0;

  for (const file of sample) {
    let content = "";
    try {
      content = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    const split = splitFrontmatter(content);
    const body = split.present ? split.body : content;

    if (split.present && split.data) {
      frontmatterUsed++;
      const quoting = countQuoting(split.raw);
      quotedValues += quoting.quoted;
      unquotedValues += quoting.unquoted;
      for (const [key, value] of Object.entries(split.data)) {
        const entry = keyMap.get(key) || { count: 0, types: new Set<string>(), samples: [] };
        entry.count++;
        entry.types.add(typeName(value));
        const sampleValue = sampleFor(value);
        if (sampleValue && entry.samples.length < 2) entry.samples.push(sampleValue);
        keyMap.set(key, entry);
      }
      const frontmatterTags = toTagList(split.data.tags !== undefined ? split.data.tags : split.data.tag);
      if (frontmatterTags.length > 0) {
        tagsInFrontmatter++;
        for (const tag of frontmatterTags) {
          const key = tag.charAt(0) === "#" ? tag : "#" + tag;
          tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
        }
      }
    }

    const lines = body.split("\n");
    let sawH1 = false;
    let sawHeading = false;
    let inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const level = headingLevel(trimmed);
      if (level === 1) {
        sawH1 = true;
        sawHeading = true;
        if (headingSamples.length < 8 && trimmed.length > 2) headingSamples.push(trimmed.slice(2).trim());
        continue;
      }
      if (level > 1) sawHeading = true;

      const type = calloutType(line);
      if (type) callouts.add(type);

      for (const token of trimmed.split(" ")) {
        if (token.length < 2 || token.charAt(0) !== "#") continue;
        let valid = true;
        for (let i = 1; i < token.length; i++) {
          if (!isTagChar(token.charCodeAt(i))) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        if (/^#([0-9]+)$/.test(token)) continue;
        tagCounts.set(token, (tagCounts.get(token) || 0) + 1);
      }
    }
    if (sawH1) notesWithH1++;
    if (sawHeading) notesWithAnyHeading++;

    const wiki = countOccurrences(body, "[[");
    const embeds = countOccurrences(body, "![[");
    wikiLinks += Math.max(0, wiki - embeds);
    embedCount += embeds;
    markdownLinks += countOccurrences(body, "](");
    if (countOccurrences(body, "#") > 0) tagsInline += 1;

    const name = file.basename;
    if (nameSamples.length < 6) nameSamples.push(name);
    const words = name.split(" ").filter((part) => part.length > 0);
    nameWords += Math.max(1, words.length);
    if (name.indexOf(" ") >= 0) separatorSpace++;
    else if (name.indexOf("_") >= 0) separatorUnderscore++;
    else if (name.indexOf("-") >= 0) separatorHyphen++;
    else separatorNone++;
  }

  const keys: FrontmatterKeyInfo[] = Array.from(keyMap.entries())
    .map(([key, entry]) => ({
      key,
      count: entry.count,
      types: Array.from(entry.types),
      samples: entry.samples,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 16);

  const tagList = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  const tagSamples = tagList.slice(0, 10);
  const separators: { label: string; count: number }[] = [
    { label: "spaces between words", count: separatorSpace },
    { label: "underscores", count: separatorUnderscore },
    { label: "hyphens", count: separatorHyphen },
    { label: "single words", count: separatorNone },
  ];
  separators.sort((a, b) => b.count - a.count);

  return {
    at: Date.now(),
    totalNotes: all.length,
    scanned: sample.length,
    folders: listFolders(app)
      .slice(0, 12)
      .map((folder) => ({
        path: folder || "/",
        notes: app.vault.getMarkdownFiles().filter((file) => (file.parent ? file.parent.path : "/") === (folder || "/")).length,
      })),
    frontmatterUsed,
    keys,
    tags: {
      total: tagList.length,
      style: describeTagStyle(tagList, tagsInFrontmatter, tagsInline),
      samples: tagSamples,
      inFrontmatter: tagsInFrontmatter,
      inline: tagsInline,
    },
    quoting: { quoted: quotedValues, unquoted: unquotedValues },
    links: { wiki: wikiLinks, markdown: markdownLinks, embed: embedCount },
    headings: { notesWithH1, samples: headingSamples.slice(0, 4) },
    filenames: {
      separator: separators[0].label,
      samples: nameSamples,
      avgWords: sample.length > 0 ? Math.round((nameWords / sample.length) * 10) / 10 : 0,
    },
    callouts: Array.from(callouts).sort().slice(0, 10),
    unknown: notesWithAnyHeading === 0 && frontmatterUsed === 0 && all.length === 0,
  };
}

function describeTagStyle(tags: string[], inFrontmatter: number, inline: number): string {
  if (tags.length === 0) return "none detected";
  const nested = tags.some((tag) => tag.indexOf("/") >= 0);
  const kebab = tags.some((tag) => tag.indexOf("-") >= 0);
  const snake = tags.some((tag) => tag.indexOf("_") >= 0);
  const upper = tags.some((tag) => tag !== tag.toLowerCase());
  const parts: string[] = [];
  parts.push(nested ? "nested with slashes" : "flat");
  if (snake) parts.push("snake_case");
  else if (kebab) parts.push("kebab-case");
  if (upper) parts.push("mixed case");
  else parts.push("lowercase");
  parts.push(inFrontmatter >= inline ? "mostly in properties" : "mostly inline");
  return parts.join(", ");
}

export function defaultFrontmatterTemplate(conventions: VaultConventions | null): string {
  const today = todayLocal();
  const lines: string[] = ["---"];
  const used = new Set<string>();
  const keys = conventions && conventions.keys.length > 0 ? conventions.keys : [];
  for (const info of keys) {
    if (lines.length >= 8) break;
    const key = info.key;
    if (used.has(key)) continue;
    used.add(key);
    const type = info.types[0] || "text";
    if (key === "tags" || key === "tag" || type === "list") lines.push(key + ": []");
    else if (key === "title" || key === "name") lines.push(key + ": <note title>");
    else if (type === "date") lines.push(key + ": " + today);
    else if (type === "boolean") lines.push(key + ": false");
    else if (type === "number") lines.push(key + ": 0");
    else lines.push(key + ": <value>");
  }
  if (!used.has("title")) lines.push("title: <note title>");
  if (!used.has("tags")) lines.push("tags: []");
  if (!used.has("created")) lines.push("created: " + today);
  lines.push("---");
  return lines.join("\n");
}

export function conventionsReport(conventions: VaultConventions, cacheMinutes: number): string {
  const percent = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const lines: string[] = [];
  lines.push("## Detected vault conventions");
  lines.push("");
  lines.push(
    "Analysed **" +
      conventions.scanned +
      "** of **" +
      conventions.totalNotes +
      "** notes · scan from " +
      new Date(conventions.at).toLocaleString() +
      " · cache " +
      cacheMinutes +
      " min"
  );
  lines.push("");
  lines.push("| Aspect | Observed |");
  lines.push("| --- | --- |");
  lines.push("| Properties (frontmatter) | in " + percent(conventions.frontmatterUsed, conventions.scanned) + "% of notes |");
  if (conventions.quoting && conventions.quoting.quoted + conventions.quoting.unquoted > 0) {
    const total = conventions.quoting.quoted + conventions.quoting.unquoted;
    lines.push("| Property values | quoted in " + percent(conventions.quoting.quoted, total) + "% of values |");
  }
  lines.push("| Tags | " + conventions.tags.style + " |");
  lines.push("| Links | " + conventions.links.wiki + " wikilinks · " + conventions.links.markdown + " markdown · " + conventions.links.embed + " embeds |");
  lines.push("| H1 titles | " + percent(conventions.headings.notesWithH1, conventions.scanned) + "% of notes |");
  lines.push("| File names | " + conventions.filenames.separator + " · ~" + conventions.filenames.avgWords + " words |");
  if (conventions.callouts.length > 0) lines.push("| Callouts | " + conventions.callouts.join(", ") + " |");
  lines.push("");
  if (conventions.keys.length > 0) {
    lines.push("### Properties in use");
    lines.push("");
    lines.push("| Key | Notes | Type | Example |");
    lines.push("| --- | --- | --- | --- |");
    for (const key of conventions.keys) {
      lines.push(
        "| `" +
          key.key +
          "` | " +
          key.count +
          " | " +
          key.types.join(", ") +
          " | " +
          (key.samples[0] ? "`" + key.samples[0] + "`" : "—") +
          " |"
      );
    }
    lines.push("");
  }
  if (conventions.tags.samples.length > 0) {
    lines.push("### Tag samples");
    lines.push("");
    lines.push(conventions.tags.samples.join(" "));
    lines.push("");
  }
  lines.push("### Suggested frontmatter skeleton");
  lines.push("");
  lines.push("```yaml");
  lines.push(defaultFrontmatterTemplate(conventions));
  lines.push("```");
  lines.push("");
  lines.push("### Folders");
  lines.push("");
  lines.push(
    conventions.folders
      .map((folder) => "`" + (folder.path === "/" ? "vault root" : folder.path) + "` (" + folder.notes + ")")
      .join(" · ")
  );
  return lines.join("\n");
}
