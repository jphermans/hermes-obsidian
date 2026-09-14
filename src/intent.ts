/**
 * Recognises a request that asks for a *new* note, as opposed to a question or an
 * edit of the note that happens to be open. When it matches, the plugin keeps the
 * open note out of the request and offers "Create note" instead of Insert/Append,
 * so a new note is never appended to the note you are looking at.
 */

const CREATE_PHRASES = [
  "new note",
  "create a note",
  "create note",
  "make a note",
  "make note",
  "write a note",
  "draft a note",
  "add a note",
  "start a note",
  "generate a note",
  "save as a note",
  "new md file",
  "new markdown file",
  "create a file",
  "create an obsidian note",
  "create a page",
  "note about",
  "note for the",
  "note titled",
  "note called",
  "note named",
];

/** A question about note-making is not an instruction to make one. */
const QUESTION_WORDS = [
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "can",
  "could",
  "should",
  "shall",
  "is",
  "are",
  "do",
  "does",
  "did",
  "explain",
  "tell",
];

function firstWord(lower: string): string {
  const match = lower.match(/[a-z]+/);
  return match ? match[0] : "";
}

export function looksLikeNewNoteRequest(text: string): boolean {
  const trimmed = (text || "").trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (trimmed.endsWith("?") && QUESTION_WORDS.indexOf(firstWord(lower)) >= 0) return false;
  return CREATE_PHRASES.some((phrase) => lower.indexOf(phrase) >= 0);
}
