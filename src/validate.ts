/**
 * Obsidian-syntax checks for a generated note, shown before anything is
 * written. These are the mistakes models actually make: chatty preambles,
 * a fence around the whole note, frontmatter that will not parse, `.md` links
 * instead of wikilinks, unbalanced brackets, heading level jumps and illegal
 * file-name characters.
 */

import {
  checkProperties,
  checkPropertyText,
  describePropertyIssue,
  normalizeProperties,
  vaultTypeIssues,
  vaultTypeMap,
} from "./properties";
import type { PropertyIssue } from "./properties";
import { countOccurrences, headingLevel, splitFrontmatter } from "./vault-rules";
import { isBadFilenameChar } from "./note-writer";
import type { VaultConventions } from "./types";

export type IssueLevel = "warn" | "info" | "ok";

export interface NoteIssue {
  level: IssueLevel;
  message: string;
}

export interface NoteStats {
  words: number;
  characters: number;
  headings: number;
  properties: number;
  wikiLinks: number;
  externalLinks: number;
  embeds: number;
  tags: number;
  callouts: number;
}

export interface NoteCheck {
  issues: NoteIssue[];
  stats: NoteStats;
}

function countTags(body: string): number {
  let tags = 0;
  for (const line of body.split("\n")) {
    for (const token of line.split(" ")) {
      if (token.length < 2 || token.charAt(0) !== "#") continue;
      tags++;
    }
  }
  return tags;
}

function countCallouts(body: string): number {
  let count = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.charAt(0) === ">" && trimmed.indexOf("[!") >= 0) count++;
  }
  return count;
}

function hasCurlyQuote(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) || 0;
    if (code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d) return true;
  }
  return false;
}

export function validateNote(content: string, filename: string, conventions: VaultConventions | null): NoteCheck {
  const issues: NoteIssue[] = [];
  const split = splitFrontmatter(content);
  // A missing name must report, not throw: this runs while the preview is being built.
  const name = typeof filename === "string" ? filename : "";
  const body = split.present ? split.body : content;

  let headings = 0;
  let h1Count = 0;
  let previousLevel = 0;
  let levelJump = false;
  let inFence = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const level = headingLevel(trimmed);
    if (level === 0) continue;
    headings++;
    if (level === 1) h1Count++;
    if (previousLevel > 0 && level > previousLevel + 1) levelJump = true;
    previousLevel = level;
  }

  const stats: NoteStats = {
    words: body.split("\n").join(" ").split(" ").filter((part) => part.trim().length > 0).length,
    characters: content.length,
    headings,
    properties: split.data ? Object.keys(split.data).length : 0,
    wikiLinks: Math.max(0, countOccurrences(body, "[[") - countOccurrences(body, "![[")),
    externalLinks: countOccurrences(body, "]("),
    embeds: countOccurrences(body, "![["),
    tags: countTags(body) + (split.data && Array.isArray(split.data.tags) ? split.data.tags.length : 0),
    callouts: countCallouts(body),
  };

  // --- file name ---------------------------------------------------------
  if (!name.trim()) {
    issues.push({ level: "warn", message: "The note needs a file name." });
  } else {
    let badCharacters: string[] = [];
    for (const character of name) {
      if (isBadFilenameChar(character.codePointAt(0) || 0)) badCharacters.push(character);
    }
    if (badCharacters.length > 0) {
      issues.push({
        level: "warn",
        message: "File name contains characters Obsidian cannot store: " + badCharacters.join(" ") + " — they will be removed.",
      });
    }
    if (name.length > 100) {
      issues.push({ level: "warn", message: "File name is longer than 100 characters; wikilinks to it will be unreadable." });
    }
    if (name.charAt(0) === "." || name.endsWith(".") || name !== name.trim()) {
      issues.push({ level: "warn", message: "File names may not start or end with a dot or a space." });
    }
    if (/^(untitled|new note|note)$/i.test(name.trim())) {
      issues.push({ level: "info", message: "Consider a descriptive file name — this one will be hard to find later." });
    }
  }

  // --- frontmatter -------------------------------------------------------
  const looksLikeFrontmatter = content.trimStart().startsWith("---");
  // Raw-text checks (tabs, duplicate keys, an empty block) live in one place so the
  // preview and the writer agree on what Obsidian can store.
  for (const issue of checkPropertyText(split.raw)) {
    issues.push({ level: issue.level === "info" ? "info" : "warn", message: describePropertyIssue(issue) });
  }
  if (split.recovered) {
    // Recovered line by line: Obsidian shows nothing for a block it cannot parse, and the
    // note is rewritten as valid YAML, so say what was kept and what could not be read —
    // then keep checking every recovered property below.
    issues.push({
      level: "warn",
      message:
        "The property block does not parse as YAML" +
        (split.recovered.skipped.length > 0 ? " (“" + split.recovered.skipped.join("”, “") + "” cannot be read)" : "") +
        " — Obsidian would show no properties at all. " +
        split.recovered.keys +
        " propert" + (split.recovered.keys === 1 ? "y was" : "ies were") +
        " recovered and will be written back as valid YAML.",
    });
  } else if (looksUnparsed(looksLikeFrontmatter, split.present)) {
    issues.push({
      level: "warn",
      message: "The frontmatter block does not parse as YAML — Obsidian would show it as plain text.",
    });
  }
  if (split.present && split.data) {
    const keys = Object.keys(split.data);
    issues.push({ level: "ok", message: "Properties present and parseable: " + (keys.length > 0 ? keys.join(", ") : "none") });
    for (const issue of checkProperties(split.data)) {
      issues.push({ level: issue.level === "info" ? "info" : "warn", message: describePropertyIssue(issue) });
    }
    // The vault's own type for each name wins in Obsidian's properties panel.
    for (const issue of vaultTypeIssues(split.data, conventions)) {
      issues.push({ level: issue.level === "info" ? "info" : "warn", message: describePropertyIssue(issue) });
    }
    const fixes = normalizeProperties(split.data, vaultTypeMap(conventions)).fixes;
    if (fixes.length > 0) {
      issues.push({ level: "info", message: "Corrected when saved: " + fixes.join("; ") + "." });
    }
    const known = conventions && conventions.keys.length > 0 ? new Set(conventions.keys.map((key) => key.key)) : null;
    if (known) {
      const novel = keys.filter((key) => !known.has(key));
      if (novel.length > 0 && known.size > 2) {
        issues.push({ level: "info", message: "New property keys for this vault: " + novel.join(", ") });
      }
    }
  } else if (conventions && conventions.scanned > 0 && conventions.frontmatterUsed / conventions.scanned >= 0.6) {
    issues.push({
      level: "warn",
      message:
        "This vault uses properties in " +
        Math.round((conventions.frontmatterUsed / conventions.scanned) * 100) +
        "% of notes, but this note has no frontmatter.",
    });
  }

  // --- links -------------------------------------------------------------
  const openBrackets = countOccurrences(body, "[[");
  const closeBrackets = countOccurrences(body, "]]");
  if (openBrackets !== closeBrackets) {
    issues.push({
      level: "warn",
      message: "Unbalanced wikilink brackets: " + openBrackets + " opening vs " + closeBrackets + " closing.",
    });
  } else if (openBrackets > 0) {
    issues.push({ level: "ok", message: openBrackets + " wikilink" + (openBrackets === 1 ? "" : "s") + " balanced." });
  }
  const markdownInternal = countOccurrences(body, ".md)") + countOccurrences(body, ".md#");
  if (markdownInternal > 0) {
    issues.push({
      level: "warn",
      message: markdownInternal + " internal link(s) written as Markdown paths with .md — Obsidian resolves [[wikilinks]] more reliably.",
    });
  }
  if (countOccurrences(body, "](h") + countOccurrences(body, "](H") > 0) {
    issues.push({ level: "ok", message: "External links use standard Markdown." });
  }

  // --- structure ---------------------------------------------------------
  if (levelJump) {
    issues.push({ level: "info", message: "Heading levels skip a step somewhere (for example H2 followed by H4)." });
  }
  if (h1Count > 1) {
    issues.push({ level: "warn", message: h1Count + " H1 headings — keep exactly one title." });
  }
  if (h1Count === 0 && headings > 0) {
    const prefersH1 =
      conventions && conventions.scanned > 0 && conventions.headings.notesWithH1 / conventions.scanned >= 0.6;
    issues.push({
      level: prefersH1 ? "info" : "ok",
      message: prefersH1
        ? "This vault usually opens notes with an H1 title; this note does not."
        : "No H1 title (this vault does not usually use one).",
    });
  }
  if (hasCurlyQuote(body)) {
    issues.push({ level: "info", message: "Typographic quotes found — Obsidian renders straight quotes more predictably." });
  }
  if (stats.words < 25 && stats.words > 0) {
    issues.push({ level: "info", message: "Short note (" + stats.words + " words)." });
  }
  if (stats.words === 0) {
    issues.push({ level: "warn", message: "The note body is empty." });
  }

  return { issues, stats };
}

function looksUnparsed(looksLikeFrontmatter: boolean, present: boolean): boolean {
  return looksLikeFrontmatter && !present;
}
