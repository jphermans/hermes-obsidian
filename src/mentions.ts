/**
 * @-mentions in the chat input: "bring this note into the conversation" using
 * Obsidian's own `@[[Note name]]` syntax. Detection and completion are pure
 * functions so they can be tested without a DOM; resolving a title to a real
 * note happens in the plugin, against the vault index.
 *
 * Design taken from UltimateAI-org/aitoolsforobsidian's mention utilities
 * (idea, not code): type `@`, get a note picker, and the notes you name are
 * added to the request context.
 */

export interface MentionContext {
  /** Index of the "@". */
  start: number;
  /** Index just past the mention (past "]]" when the brackets are closed). */
  end: number;
  /** What has been typed for the note name. */
  query: string;
}

const LETTER_OR_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function isWordCharacter(character: string): boolean {
  return character.length > 0 && (LETTER_OR_DIGIT.indexOf(character) >= 0 || character === "_");
}

/**
 * The mention being typed at the cursor, or null. Mirrors the shape the
 * mention plugin resolves: `@name` while typing and `@[[Name]]` once chosen.
 */
export function detectMention(text: string, cursor: number): MentionContext | null {
  if (cursor < 0 || cursor > text.length) return null;
  const upToCursor = text.slice(0, cursor);
  const at = upToCursor.lastIndexOf("@");
  if (at < 0) return null;
  // "me@example.com" is not a mention.
  if (at > 0 && isWordCharacter(upToCursor.charAt(at - 1))) return null;

  const after = upToCursor.slice(at + 1);
  if (after.startsWith("[[")) {
    const closing = after.indexOf("]]");
    if (closing < 0) return { start: at, end: cursor, query: after.slice(2) };
    const closingEnd = at + 1 + closing + 2;
    if (cursor > closingEnd) return null;
    return { start: at, end: closingEnd, query: after.slice(2, closing) };
  }
  if (after.indexOf(" ") >= 0 || after.indexOf("\t") >= 0 || after.indexOf("\n") >= 0) return null;
  return { start: at, end: cursor, query: after };
}

/** Replace the mention under the cursor with `@[[Title]] ` and place the caret after it. */
export function completeMention(
  text: string,
  mention: MentionContext,
  title: string
): { text: string; cursor: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  // Do not add a second space when one is already there.
  const needsSpace = after.length === 0 || (after.charAt(0) !== " " && after.charAt(0) !== "\n");
  const replacement = "@[[" + title + "]]" + (needsSpace ? " " : "");
  return { text: before + replacement + after, cursor: before.length + replacement.length };
}

/** Every `@[[Title]]` in a message, in order, without duplicates. */
export function extractMentionedTitles(text: string): string[] {
  const titles: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("@[[", index);
    if (start < 0) break;
    const end = text.indexOf("]]", start + 3);
    if (end < 0) break;
    const title = text.slice(start + 3, end).trim();
    if (title.length > 0 && titles.indexOf(title) < 0) titles.push(title);
    index = end + 2;
  }
  return titles;
}

/** Removes the `@[[…]]` wrappers so a message reads naturally to the model. */
export function stripMentionSyntax(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("@[[", index);
    if (start < 0) break;
    const end = text.indexOf("]]", start + 3);
    if (end < 0) break;
    result += text.slice(index, start) + "[[" + text.slice(start + 3, end).trim() + "]]";
    index = end + 2;
  }
  return result + text.slice(index);
}

export interface MentionCandidate {
  basename: string;
  path: string;
}

/**
 * Resolves a mentioned title the way Obsidian does: exact basename first, then
 * case-insensitive, then a path match ("Projects/Kitchen renovation"), then a
 * unique prefix. Ambiguity returns null rather than picking a random note.
 */
export function matchMentionedFile<T extends MentionCandidate>(candidates: T[], title: string): T | null {
  const wanted = title.trim();
  if (wanted.length === 0) return null;
  const lower = wanted.toLowerCase();
  const withExtension = lower.endsWith(".md") ? lower : lower + ".md";

  const exact = candidates.filter((file) => file.basename === wanted);
  if (exact.length === 1) return exact[0];

  const insensitive = candidates.filter((file) => file.basename.toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];

  const byPath = candidates.filter(
    (file) => file.path.toLowerCase() === withExtension || file.path.toLowerCase().endsWith("/" + withExtension)
  );
  if (byPath.length === 1) return byPath[0];

  const prefix = candidates.filter((file) => file.basename.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];

  return null;
}

/** The note names to offer for a query, best (prefix) matches first. */
export function suggestNotes<T extends MentionCandidate>(candidates: T[], query: string, limit = 8): T[] {
  const wanted = query.trim().toLowerCase();
  const scored: { file: T; score: number }[] = [];
  for (const file of candidates) {
    const name = file.basename.toLowerCase();
    let score = -1;
    if (wanted.length === 0) score = 1;
    else if (name === wanted) score = 0;
    else if (name.startsWith(wanted)) score = 1;
    else if (name.indexOf(wanted) >= 0) score = 2;
    else if (file.path.toLowerCase().indexOf(wanted) >= 0) score = 3;
    if (score >= 0) scored.push({ file, score });
  }
  scored.sort((a, b) => (a.score === b.score ? a.file.basename.localeCompare(b.file.basename) : a.score - b.score));
  return scored.slice(0, limit).map((entry) => entry.file);
}
