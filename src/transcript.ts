/**
 * A conversation as a note.
 *
 * The markdown goes through serializeProperties/serializeNote like every other write, so the
 * properties follow the Obsidian documentation and the headings keep the vault's shape.
 */

import { serializeNote } from "./note-writer";
import type { KnownPropertyTypes } from "./properties";
import { todayLocal } from "./properties";

export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TranscriptOptions {
  /** Note title — also the H1. */
  title: string;
  /** Local date, YYYY-MM-DD. Defaults to today. */
  created?: string;
  /** Where the conversation happened, for the note's own record. */
  endpoint?: string;
  model?: string;
  /** Extra property values the vault uses (status, type, …). */
  extraProperties?: Record<string, unknown>;
  /** Property types already used by this vault, so names keep one type. */
  knownTypes?: KnownPropertyTypes;
}

/** One line, no markdown, short enough to be a heading. */
export function summarisePrompt(text: string, limit = 72): string {
  const first = (text || "")
    .split("\n")
    .map((line) => line.replace(/^[#>\-*\s]+/, "").trim())
    .filter((line) => line.length > 0)[0];
  const clean = (first || "Conversation").replace(/[*_`\[\]]/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean || "Conversation";
  return clean.slice(0, limit - 1).trimEnd() + "…";
}

/** The note itself: title, properties, then one section per exchange. */
export function transcriptNote(turns: TranscriptTurn[], options: TranscriptOptions): string {
  const created = options.created || todayLocal();
  const properties: Record<string, unknown> = { title: options.title, created };
  if (options.model) properties.model = options.model;
  if (options.endpoint) properties.source = options.endpoint;
  Object.assign(properties, options.extraProperties || {});

  const body: string[] = ["# " + options.title, ""];
  let heading = "";
  for (const turn of turns) {
    const content = (turn.content || "").trim();
    if (content.length === 0) continue;
    if (turn.role === "user") {
      heading = summarisePrompt(content);
      body.push("## " + heading, "");
      body.push("> " + content.split("\n").join("\n> "), "");
      continue;
    }
    if (!heading) {
      body.push("## Answer", "");
      heading = "Answer";
    }
    body.push(content, "");
  }
  return serializeNote(properties, body.join("\n"), options.knownTypes || {});
}
