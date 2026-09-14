/**
 * Prompt construction.
 *
 * The rules below encode how Obsidian actually parses Markdown (wikilinks,
 * embeds, properties, callouts, tasks, math) plus the conventions observed in
 * the user's own vault, so generated notes belong in the vault instead of
 * looking like generic Markdown.
 */

import type { VaultConventions } from "./types";

const FENCE = "```";

export type NoteTask = "create" | "rewrite" | "fix" | "answer" | "chat";

export interface NoteContext {
  vaultName: string;
  targetFolder: string;
  notePath?: string;
  noteTitle?: string;
  activeNoteContent?: string;
  selection?: string;
  existingNotes: string[];
  folderList: string[];
  includeFrontmatter: boolean;
  frontmatterTemplate: string;
  conventions: VaultConventions | null;
  language: string;
}

export const OBSIDIAN_RULES = `OBSIDIAN MARKDOWN RULES — follow these exactly.

Output contract
- Return the finished note itself and nothing else. No greeting, no preamble such as "Here is the note", no commentary before or after it, no closing question.
- Never wrap the whole note in a code fence. Fenced blocks are only for code that belongs inside the note.

Properties (frontmatter)
- Frontmatter, when used, is the first thing in the file: a line containing exactly --- , then YAML, then a closing --- line.
- YAML syntax only: key: value . No tabs, ever. Use two-space indentation for nested maps.
- Booleans are true / false (lowercase). Dates are YYYY-MM-DD . Numbers are unquoted. Text with a colon or a leading special character is quoted.
- Lists are either block style (key: followed by indented lines starting with - ) or inline (key: [a, b]) — match the vault.
- Reuse the vault's existing property names and casing. Do not invent near-duplicates such as created vs Date.

Headings
- Exactly one H1 ( # Title ) at the top when the vault does that, then H2 ( ## ) and H3 ( ### ) without skipping levels.
- Never use bold text, an all-caps line or a trailing colon line as a heading substitute. Never add a heading just to say "Introduction".

Links
- Internal links are wikilinks: [[Note Name]] . Never [[Note Name.md]] , never a relative file path, never a URL for something inside the vault.
- Display text: [[Note Name|Shown text]] . Section: [[Note Name#Heading]] . Block reference: [[Note Name#^block-id]] .
- Link only to notes that exist in the vault list you were given, unless asked to plan a future note.
- External links use standard Markdown: [label](https://example.com) .

Embeds
- ![[Note Name]] embeds a note, ![[Note Name#Heading]] embeds a section, ![[picture.png]] embeds an attachment, ![[picture.png|300]] sets a width.

Tags
- Tags contain no spaces and no punctuation beyond / and - : #project/kitchen , #status-active .
- Nested tags use a slash. Put tags inline ( #tag ) or under the properties tags: key — follow whichever the vault uses more.

Callouts and blockquotes
- Callout syntax: a line starting with > [!type] optional title , then the body as following > lines. Use only callout types the vault already uses when the vault uses callouts.
- Plain quotes are > lines without the [!type] marker.

Lists, tasks, tables
- Unordered lists use - plus a space. Ordered lists use 1. plus a space. Nested items are indented by two spaces per level.
- Task items are - [ ] todo and - [x] done .
- Tables need a header row, a separator row of dashes, and one pipe per column. Keep every cell on a single line.

Code and math
- Fenced code blocks carry a language tag, for example ${FENCE}ts . Inline code uses single backticks.
- Use straight quotes and straight apostrophes only. Never use curly or typographic quotes.
- Math is $inline$ or $$display$$ . Never put currency amounts inside $...$ without escaping the risk — prefer writing amounts plainly.

File names
- A file name may not contain any of these characters: forward slash, backslash, colon, asterisk, question mark, double quote, less-than, greater-than, pipe, hash, caret, or square brackets.
- No leading or trailing spaces or dots. Keep it under 100 characters. Do not use the word Untitled.
- The file name should read as the title of the note so wikilinks to it stay readable.

Content quality
- Write real, specific content for the note. Do not output placeholders like "content goes here", and do not add a summary section that just restates the title.
- Never invent facts about the user's files, projects or people. If information is missing, write the note around what is known.
- Match the language of the request.`;

export function conventionsBlock(conventions: VaultConventions | null): string {
  if (!conventions || conventions.unknown) return "";
  const percent = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const lines: string[] = [];
  lines.push("VAULT CONVENTIONS — observed in THIS vault (" + conventions.scanned + " notes analysed of " + conventions.totalNotes + "):");
  lines.push(
    "- Properties: used in " +
      percent(conventions.frontmatterUsed, conventions.scanned) +
      "% of notes." +
      (conventions.keys.length > 0
        ? " Keys in use, most frequent first: " +
          conventions.keys
            .slice(0, 12)
            .map((key) => key.key + " (" + (key.types[0] || "text") + (key.samples[0] ? ", e.g. " + key.samples[0] : "") + ")")
            .join("; ") +
          "."
        : "")
  );
  if (conventions.quoting && conventions.quoting.quoted + conventions.quoting.unquoted > 0) {
    const quoted = conventions.quoting.quoted;
    const total = quoted + conventions.quoting.unquoted;
    lines.push(
      quoted / total >= 0.5
        ? "- Property values: text values are usually quoted, e.g. title: \"Kitchen renovation\"."
        : "- Property values: text values are usually written without quotes."
    );
  }
  if (conventions.tags.total > 0) {
    lines.push(
      "- Tags: style " +
        conventions.tags.style +
        ", " +
        conventions.tags.inFrontmatter +
        " notes keep them in properties and " +
        conventions.tags.inline +
        " inline. Examples: " +
        conventions.tags.samples.slice(0, 8).join(" ") +
        "."
    );
  }
  if (conventions.links.wiki + conventions.links.markdown + conventions.links.embed > 0) {
    lines.push(
      "- Links: " +
        conventions.links.wiki +
        " wikilinks, " +
        conventions.links.markdown +
        " markdown links (external only), " +
        conventions.links.embed +
        " embeds."
    );
  }
  lines.push(
    "- Headings: " +
      percent(conventions.headings.notesWithH1, conventions.scanned) +
      "% of notes open with an H1 title" +
      (conventions.headings.samples.length > 0 ? " (e.g. " + conventions.headings.samples.slice(0, 3).join(" / ") + ")" : "") +
      "."
  );
  if (conventions.filenames.samples.length > 0) {
    lines.push(
      "- File names: " +
        conventions.filenames.separator +
        ", about " +
        conventions.filenames.avgWords +
        " words. Examples: " +
        conventions.filenames.samples.slice(0, 4).join(" | ") +
        "."
    );
  }
  if (conventions.callouts.length > 0) {
    lines.push("- Callout types already in use: " + conventions.callouts.join(", ") + ".");
  }
  return lines.join("\n");
}

function folderBlock(context: NoteContext): string {
  const lines: string[] = [];
  if (context.folderList.length > 0) {
    lines.push("Vault folders: " + context.folderList.slice(0, 60).join(", "));
  }
  lines.push("Target folder for this note: " + (context.targetFolder || "vault root") + ".");
  if (context.existingNotes.length > 0) {
    lines.push(
      "Existing notes in that folder that you may link to (" +
        context.existingNotes.length +
        "): " +
        context.existingNotes.join(" | ")
    );
  } else {
    lines.push("The target folder has no notes yet — do not invent wikilinks to it.");
  }
  return lines.join("\n");
}

function frontmatterBlock(context: NoteContext): string {
  if (!context.includeFrontmatter) {
    return "Do not add frontmatter to this note: this vault does not use properties on generated notes.";
  }
  return (
    "Start the note with frontmatter following this vault's shape, filling in real values and only adding a key when it truly applies:\n" +
    context.frontmatterTemplate
  );
}

export function systemPrompt(task: NoteTask, context: NoteContext): string {
  const parts: string[] = [];
  parts.push(
    "You are the note-writing engine behind an Obsidian plugin, connected to a Hermes Agent instance. You write Markdown notes for the vault named " +
      context.vaultName +
      "."
  );
  parts.push(OBSIDIAN_RULES);
  const conventions = conventionsBlock(context.conventions);
  if (conventions) parts.push(conventions);
  parts.push(folderBlock(context));
  parts.push(frontmatterBlock(context));

  if (task === "create") {
    parts.push(
      "Your job: write ONE new note as a complete file (frontmatter plus body). Choose a clear title that becomes its file name, then write substantive, well-structured content. Aim for depth appropriate to the request — a stub is a failure unless the user asked for a skeleton."
    );
  } else if (task === "rewrite") {
    parts.push(
      "Your job: return the FULL improved note as a complete file. Keep every fact, link and file name that already exists unless the user asked to change it: this output replaces the file on disk. Improve structure, wording, tag and link correctness, and Obsidian syntax. Never drop content silently."
    );
  } else if (task === "fix") {
    parts.push(
      "Your job: repair Obsidian syntax only. Return the FULL note as a complete file. Fix broken wikilinks, illegal characters, malformed frontmatter, heading level jumps, incorrect tag syntax, curly quotes and stray code fences. Do not rewrite the prose, do not add or remove information, do not change the meaning or ordering of sentences."
    );
  } else if (task === "answer") {
    parts.push(
      "Your job: answer the user about the note or vault. Answer in prose — do NOT return a whole note unless the user explicitly asks for one. Cite specific notes as wikilinks. Be concise and concrete."
    );
  } else {
    parts.push(
      "Your job: act as a vault-aware writing assistant. Answer in prose unless the user asks for note content. Always respect the vault conventions and the Obsidian syntax rules above."
    );
  }
  if (context.language && context.language !== "auto") {
    parts.push("Write in " + context.language + " unless the user writes in another language.");
  }
  return parts.join("\n\n");
}

export function activeNoteBlock(context: NoteContext): string {
  if (context.selection) {
    return "The user has selected this text inside " + (context.notePath || "the active note") + ":\n\n" + context.selection;
  }
  if (context.activeNoteContent) {
    return "The active note (" + (context.notePath || "untitled") + ") is:\n\n" + context.activeNoteContent;
  }
  return "";
}

export function createUserPrompt(request: string, context: NoteContext): string {
  const lines = ["Write a new note that satisfies this request:", "", request.trim()];
  if (context.selection) {
    lines.push("", "Use this selected text as source material:", "", context.selection);
  }
  if (context.activeNoteContent) {
    lines.push("", "The note currently open in Obsidian is:", "", context.activeNoteContent);
  }
  lines.push("", "Return the note file only.");
  return lines.join("\n");
}

export function rewriteUserPrompt(instruction: string, context: NoteContext): string {
  const lines: string[] = [];
  if (instruction.trim()) lines.push("Apply this instruction to the note:", "", instruction.trim(), "");
  else lines.push("Improve this note: sharpen the structure, fix prose, and make it consistent with the vault conventions.", "");
  lines.push("Current content of " + (context.notePath || "the note") + ":", "", context.activeNoteContent || "", "");
  lines.push("Return the complete replacement note file only, keeping a file name that still fits the note: " + (context.noteTitle || ""));
  return lines.join("\n");
}

export function fixUserPrompt(context: NoteContext): string {
  return [
    "Normalise this note for Obsidian without changing its meaning.",
    "",
    "Current content of " + (context.notePath || "the note") + ":",
    "",
    context.activeNoteContent || "",
    "",
    "Return the complete corrected note file only.",
  ].join("\n");
}

export function answerUserPrompt(question: string, context: NoteContext): string {
  const lines = [question.trim()];
  const block = activeNoteBlock(context);
  if (block) lines.push("", block);
  return lines.join("\n");
}

export function chatUserPrompt(message: string, context: NoteContext): string {
  const lines = [message.trim()];
  if (context.activeNoteContent) {
    lines.push("", "Context — the note open in Obsidian (" + (context.notePath || "untitled") + "):", "", context.activeNoteContent);
  }
  return lines.join("\n");
}

/** Trim a conversation to the last N messages, always keeping the system role out. */
export function trimHistory(messages: { role: string; content: string }[], max: number): { role: "user" | "assistant"; content: string }[] {
  const relevant = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  if (max <= 0) return relevant;
  return relevant.length > max ? relevant.slice(relevant.length - max) : relevant;
}
