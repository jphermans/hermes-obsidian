/**
 * Copy / move / delete notes on request.
 *
 * Division of labour, deliberately: the model proposes a plan (natural language
 * is its job), this module validates every path against the real vault (that is
 * arithmetic, not judgement), and the user approves in a modal before anything
 * touches disk. Nothing here writes to the vault — see `applyFileOps` in main.ts.
 */

import { sanitizeFilename } from "./note-writer";
import { matchMentionedFile } from "./mentions";

export type FileOpKind = "copy" | "move" | "delete";

export interface FileOp {
  op: FileOpKind;
  from: string;
  to?: string;
}

export interface OpCandidate {
  basename: string;
  path: string;
}

export interface ValidatedOp {
  op: FileOpKind;
  /** Resolved vault path of the source. */
  from: string;
  /** Resolved vault path of the destination (copy/move only). */
  to?: string;
  /** One line for the confirmation modal. */
  label: string;
  /** Set when the operation cannot be applied, with the reason. */
  skip?: string;
}

/** A guard against a model that decides to reorganise the whole vault. */
export const MAX_FILE_OPS = 25;

const VERBS: Record<string, FileOpKind> = {
  copy: "copy",
  duplicate: "copy",
  move: "move",
  rename: "move",
  delete: "delete",
  remove: "delete",
  trash: "delete",
};

function stripFences(raw: string): string {
  let text = (raw || "").trim();
  if (text.startsWith("```")) {
    const firstBreak = text.indexOf("\n");
    if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    const lastFence = text.lastIndexOf("```");
    if (lastFence >= 0) text = text.slice(0, lastFence);
  }
  return text.trim();
}

/** Reads the model's plan. Tolerant about shape, strict about meaning. */
export function parseFileOps(raw: string): { ops: FileOp[]; note: string; dropped: number } {
  const text = stripFences(raw);
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const useArray = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart);
  const start = useArray ? arrayStart : objectStart;
  let parsed: unknown = null;
  if (start >= 0) {
    const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
    const slice = end > start ? text.slice(start, end + 1) : text.slice(start);
    try {
      parsed = JSON.parse(slice);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return { ops: [], note: "", dropped: 0 };

  const rawOps = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ops?: unknown }).ops)
      ? ((parsed as { ops: unknown[] }).ops as unknown[])
      : [];

  const note =
    !Array.isArray(parsed) && typeof (parsed as { note?: unknown }).note === "string"
      ? String((parsed as { note: string }).note)
      : !Array.isArray(parsed) && typeof (parsed as { explanation?: unknown }).explanation === "string"
        ? String((parsed as { explanation: string }).explanation)
        : "";

  const ops: FileOp[] = [];
  for (const entry of rawOps) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { op?: unknown; from?: unknown; to?: unknown; path?: unknown; to_path?: unknown };
    const kind = VERBS[String(record.op || "").toLowerCase().trim()];
    const from = String(record.from || record.path || "").trim();
    const to = String(record.to || record.to_path || "").trim();
    if (!kind || from.length === 0) continue;
    ops.push(kind === "delete" || to.length === 0 ? { op: kind, from } : { op: kind, from, to });
  }

  // Same operation twice is a mistake, not an instruction.
  const unique: FileOp[] = [];
  for (const op of ops) {
    if (unique.some((entry) => entry.op === op.op && entry.from === op.from && entry.to === op.to)) continue;
    unique.push(op);
  }
  const capped = unique.slice(0, MAX_FILE_OPS);
  return { ops: capped, note, dropped: unique.length - capped.length };
}

/**
 * The note list the model plans against. Notes whose name appears in the request
 * come first, then the rest, up to a cap — a prompt cannot carry 10 000 paths.
 */
export function planListing(files: OpCandidate[], request: string, limit = 300): string[] {
  const words = request
    .toLowerCase()
    .split(" ")
    .map((word) => word.split("[").join("").split("]").join("").split("@").join("").trim())
    .filter((word) => word.length >= 3);
  const relevant: string[] = [];
  const rest: string[] = [];
  for (const file of files) {
    const name = file.basename.toLowerCase();
    const path = file.path.toLowerCase();
    const matches = words.some((word) => name.indexOf(word) >= 0 || path.indexOf(word) >= 0);
    if (matches) relevant.push(file.path);
    else rest.push(file.path);
  }
  relevant.sort();
  rest.sort();
  return relevant.concat(rest).slice(0, limit);
}

/** A destination that is only a folder name gets the source's own name. */
function resolveDestination(source: string, destination: string, folders: string[]): string {
  const sourceName = source.slice(source.lastIndexOf("/") + 1);
  let target = destination.trim().split("\\").join("/");
  while (target.startsWith("/")) target = target.slice(1);

  // "Archive/" is a folder. A bare word is a folder only when the vault really has
  // one with that name — otherwise "Boiler copy" is a note name, not a folder.
  const trimmed = target.replace(/[/]+$/, "");
  const isKnownFolder = trimmed.length > 0 && folders.some((folder) => folder.toLowerCase() === trimmed.toLowerCase());
  const folderOnly = target.length === 0 || target.endsWith("/") || (target.indexOf("/") < 0 && isKnownFolder);
  if (folderOnly) {
    return (trimmed.length > 0 ? trimmed + "/" : "") + sourceName;
  }

  const segments = target.split("/");
  const last = segments[segments.length - 1];
  const name = last.toLowerCase().endsWith(".md") ? last : last + ".md";
  segments[segments.length - 1] = sanitizeFilename(name);
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeFilename(segment))
    .join("/");
}

/**
 * Turns a proposed plan into exact operations, or into reasons it cannot run.
 * Every path is resolved against the vault; nothing is invented.
 */
export function validateFileOps(ops: FileOp[], files: OpCandidate[], folders: string[] = []): ValidatedOp[] {
  const paths = new Set(files.map((file) => file.path));
  const taken = new Set<string>();
  const validated: ValidatedOp[] = [];

  for (const op of ops) {
    const source = matchMentionedFile(files, op.from);
    if (!source) {
      validated.push({ op: op.op, from: op.from, to: op.to, label: op.op + " " + op.from, skip: "no note matches " + op.from });
      continue;
    }
    if (!source.path.toLowerCase().endsWith(".md")) {
      validated.push({
        op: op.op,
        from: source.path,
        to: op.to,
        label: source.path,
        skip: "only Markdown notes can be copied, moved or deleted",
      });
      continue;
    }
    if (source.path.indexOf(".obsidian") === 0) {
      validated.push({ op: op.op, from: source.path, label: source.path, skip: "vault configuration is off limits" });
      continue;
    }

    if (op.op === "delete") {
      validated.push({ op: "delete", from: source.path, label: "Delete " + source.path });
      continue;
    }

    if (!op.to || op.to.trim().length === 0) {
      validated.push({ op: op.op, from: source.path, label: op.op + " " + source.path, skip: "no destination was given" });
      continue;
    }
    // Report an attempt to leave the vault instead of quietly rewriting it.
    if (op.to.indexOf("..") >= 0) {
      validated.push({
        op: op.op,
        from: source.path,
        to: op.to,
        label: op.op + " " + source.path,
        skip: "the destination path is not valid",
      });
      continue;
    }
    const destination = resolveDestination(source.path, op.to, folders);
    if (destination.length === 0 || destination.indexOf("..") >= 0) {
      validated.push({ op: op.op, from: source.path, to: op.to, label: op.op + " " + source.path, skip: "the destination path is not valid" });
      continue;
    }
    if (destination.indexOf(".obsidian") === 0 || destination.indexOf(".obsidian/") >= 0) {
      validated.push({ op: op.op, from: source.path, to: destination, label: destination, skip: "vault configuration is off limits" });
      continue;
    }
    if (destination === source.path) {
      validated.push({
        op: op.op,
        from: source.path,
        to: destination,
        label: source.path + " → " + destination,
        skip: "that is where it already is",
      });
      continue;
    }
    if (paths.has(destination) || taken.has(destination)) {
      validated.push({
        op: op.op,
        from: source.path,
        to: destination,
        label: source.path + " → " + destination,
        skip: destination + " already exists",
      });
      continue;
    }
    taken.add(destination);
    validated.push({
      op: op.op,
      from: source.path,
      to: destination,
      label: (op.op === "copy" ? "Copy " : "Move ") + source.path + " → " + destination,
    });
  }

  return validated;
}

export function applyableOps(ops: ValidatedOp[]): ValidatedOp[] {
  return ops.filter((op) => !op.skip);
}

/** A question about files is not an instruction to touch them. */
const QUESTION_WORDS = [
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "can",
  "could",
  "should",
  "is",
  "are",
  "do",
  "does",
  "did",
  "explain",
  "tell",
];

/** "Move the boiler note into Archive" → is this a file operation at all? */
export function looksLikeFileOpRequest(text: string): boolean {
  const trimmed = (text || "").trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  const verbs = ["move", "rename", "copy", "duplicate", "delete", "remove", "trash"];
  if (!verbs.some((verb) => lower.indexOf(verb) >= 0)) return false;
  const nouns = ["note", "notes", "file", "files", "folder", "vault", "[[", ".md"];
  if (!nouns.some((noun) => lower.indexOf(noun) >= 0)) return false;
  // "How do I delete notes in Obsidian?" must stay a question.
  if (trimmed.endsWith("?")) {
    const first = lower.match(/[a-z]+/);
    if (first && QUESTION_WORDS.indexOf(first[0]) >= 0) return false;
  }
  return true;
}

export function summarizeFileOps(ops: ValidatedOp[]): string {
  const counts: Record<string, number> = { copy: 0, move: 0, delete: 0 };
  for (const op of applyableOps(ops)) counts[op.op]++;
  const parts: string[] = [];
  if (counts.move > 0) parts.push(counts.move + " moved");
  if (counts.copy > 0) parts.push(counts.copy + " copied");
  if (counts.delete > 0) parts.push(counts.delete + " deleted");
  const skipped = ops.length - applyableOps(ops).length;
  const summary = parts.length > 0 ? parts.join(", ") : "nothing to do";
  return skipped > 0 ? summary + " (" + skipped + " skipped)" : summary;
}
