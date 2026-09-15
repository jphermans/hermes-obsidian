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

export type NoteTask = "create" | "rewrite" | "fix" | "answer" | "chat" | "title" | "fileops";

export interface NoteContext {
  vaultName: string;
  targetFolder: string;
  notePath?: string;
  noteTitle?: string;
  activeNoteContent?: string;
  /** Notes the user pulled in with @[[…]] — always sent, they asked for them. */
  mentioned?: { path: string; content: string }[];
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
- Frontmatter, when used, is the first thing in the file: a line containing exactly --- , then YAML, then a closing --- line. Nothing before it, not even a blank line.
- Write each property as name: value — a colon followed by a space. No tabs, ever. Each name appears once in a note.
- Names may contain only letters, numbers, _ and - . Never a space (write word-count , not "word count"), and never punctuation.
- Obsidian's property types are Text, List, Number, Checkbox, Date, Date & time and Tags, and they are stored like this:
  - Text — one line. Markdown is not rendered in it, and a #hashtag inside a text property is plain text, not a tag.
  - List — one value per line, each on its own line preceded by a hyphen and a space:
      tags:
        - journal
        - personal
    Never a comma-separated line: tags: a, b is a single text value, not a list. Internal links inside a list must be quoted, because [ starts a list:
      links:
        - "[[Note Name]]"
  - Number — a literal number only, no operators or units: year: 1977 , pie: 3.14 . Unquoted; "1977" is text.
  - Checkbox — true or false , lowercase and unquoted. An empty value is an indeterminate checkbox, so do not leave a property blank.
  - Date — YYYY-MM-DD , unquoted, e.g. date: 2020-08-21 . A quoted date is text, not a Date.
  - Date & time — YYYY-MM-DDTHH:MM:SS , unquoted and with the seconds, e.g. time: 2020-08-21T10:30:00 .
  - Tags — only the tags property is a Tags property, and it is always a list. Tags carry no # in frontmatter, contain no spaces, and need at least one non-numeric character: project/kitchen is valid, 1984 is not.
- A property's type belongs to its name across the whole vault: if the vault already uses a name, use the type the vault uses for it.
- Never nest a map under a property and never repeat a key — Obsidian shows nested values as unsupported. Use a list of text values instead.
- Quote any text value containing : # [ ] { } or a leading/trailing space, or starting with - ? * & ! | > % @ \` .
- Reuse the vault's existing property names and casing. Never use the deprecated names tag , alias or cssclass — they were replaced by tags , aliases and cssclasses and are no longer supported.

Headings
- Exactly one H1 ( # Title ) at the top when the vault does that, then H2 ( ## ) and H3 ( ### ) without skipping levels.
- Never use bold text, an all-caps line or a trailing colon line as a heading substitute. Never add a heading just to say "Introduction".

Links
- Internal links are wikilinks: [[Note Name]] . Never [[Note Name.md]] , never a relative file path, never a URL for something inside the vault.
- Display text: [[Note Name|Shown text]] . Heading: [[Note Name#Heading]] ; a subheading adds another hash ( [[Note Name#Heading#Subheading]] ) and [[#Heading]] links inside the same note. Block: [[Note Name#^block-id]] .
- A note inside a folder keeps the folder in the path, starting at the vault root, with forward slashes: [[Folder/Note Name]] .
- A link target must not contain # | ^ : %% or square brackets — Obsidian may not resolve such a link.
- A block identifier is ^id at the end of a line, after a space; for a list, quote, callout or table put it on its own line with a blank line before and after. It may contain only Latin letters, numbers and dashes ( ^quote-of-the-day ).
- Link only to notes that exist in the vault list you were given, unless asked to plan a future note.
- External links use standard Markdown: [label](https://example.com) . A space inside the URL must be written as %20 , or the whole URL wrapped in angle brackets: [label](<https://example.com/a b>) .

Embeds
- ![[Note Name]] embeds a note, ![[Note Name#Heading]] embeds a section, ![[Note Name#^block-id]] embeds a block, ![[picture.png]] embeds an attachment, ![[Document.pdf#page=3]] opens a PDF at a page.
- Size an embedded attachment with |width or |widthxheight : ![[picture.png|300]] , ![[picture.png|300x200]] . The same works for an external image: ![250](https://example.com/photo.jpg) .

Tags
- Tags contain no spaces and no punctuation beyond / and - : #project/kitchen , #status-active .
- Nested tags use a slash. Put tags inline ( #tag ) or under the properties tags: key — follow whichever the vault uses more.

Callouts and blockquotes
- Callout syntax: a line starting with > [!type] optional title , then the body as following > lines. Use only callout types the vault already uses when the vault uses callouts.
- The types are note, abstract (alias summary, tldr), info, todo, tip (hint, important), success (check, done), question (help, faq), warning (caution, attention), failure (fail, missing), danger (error), bug, example, quote (cite). Any other type silently renders as note, so do not invent one.
- A title is optional (a title-only callout is fine) and without one Obsidian shows the type in title case. Put + or - straight after the type to have it expanded or collapsed at first: > [!faq]- Are callouts foldable? .
- Plain quotes are > lines without the [!type] marker.

Lists, tasks, tables
- Unordered lists use - plus a space ( * and + also work; stay with - ). Ordered lists use 1. or 1) plus a space.
- Nest a list item with a tab — what Obsidian inserts — or align it under the item's text: two spaces under - , three under 1. .
- Task items are - [ ] todo and - [x] done . Any character inside the brackets marks a task done ( [?] , [-] ), so never leave the brackets empty by accident.
- Tables need a header row, a separator row of dashes with at least two hyphens per column ( -- | -- ), and one pipe per column. Keep every cell on a single line and leave no blank line inside a table — it breaks it.
- Inside a table cell escape a pipe as \| , which is required for an alias or a resized embed: [[Other note\|display text]] and ![[image.png\|200]] .
- Align a column by putting colons in the separator row: :-- left, :-: centre, --: right.

Formatting
- Bold **text** , italics *text* , bold italics ***text*** , highlight ==text== , strikethrough ~~text~~ . Never use any of them as a heading substitute.

Footnotes and comments
- A footnote reference is [^1] and its definition is a line [^1]: the text . A footnote that runs on indents its next line by two spaces. Named footnotes ( [^note] ) work and are easier to keep track of. Inline footnotes, ^[like this] , only render in reading view.
- A comment is %%hidden%% or a block on its own lines between %% markers. Comments never render, so put nothing the reader needs inside one.

HTML and line breaks
- Obsidian does not render Markdown inside HTML tags: do not wrap Markdown in <div> , <span> or any other tag, and keep an HTML block free of blank lines.
- Separate paragraphs with a blank line; a single newline continues the same paragraph. Two trailing spaces make a line break inside one paragraph.
- A horizontal rule is *** , --- or ___ on its own line, and it needs a blank line above it: --- directly under a line of text turns that line into a heading instead.

Code and math
- Fenced code blocks carry a language tag, for example ${FENCE}ts ; three or more backticks or tildes both work, and a fence inside a fence has to be longer than the one around it. Inline code uses single backticks.
- Math uses $inline$ or $$display$$ , with the $$ on its own line for a display block. Math is not processed inside code blocks.
- Use straight quotes and straight apostrophes only. Never use curly or typographic quotes.
- Escape a character that must show literally with a backslash: \* \_ \# \| \~ and \` . A numbered list item that is meant as plain text escapes the period, not the number: 1\. . Never put currency amounts inside $...$ without escaping the risk — prefer writing amounts plainly.

File names
- A file name may not contain any of these characters: forward slash, backslash, colon, asterisk, question mark, double quote, less-than, greater-than, pipe, hash, caret, or square brackets.
- No leading or trailing spaces or dots. Keep it under 100 characters. Do not use the word Untitled.
- Never name a note after the assistant or with a generic word: no "Hermes", "AI", "Assistant", "Answer" or "Note" as a title or file name. Name it after its subject.
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
  } else if (task === "fileops") {
    parts.push(
      "Your job: turn a plain-language request into a precise plan of file operations (copy, move, rename or delete notes). You never perform anything yourself — a human approves the plan first, so the plan must be complete and literal."
    );
  } else if (task === "title") {
    parts.push(
      "Your job: name an existing note. Answer with the title only — one line, no quotes, no markdown, no trailing punctuation, at most 8 words. The title must describe what the note is actually about. Never title a note after the assistant or after a generic word: no \"Hermes\", \"AI\", \"Assistant\", \"Answer\", \"Note\" or \"Untitled\"."
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
  const mentioned = mentionedBlock(context);
  if (mentioned) lines.push("", mentioned);
  if (context.activeNoteContent) {
    lines.push("", "Context — the note open in Obsidian (" + (context.notePath || "untitled") + "):", "", context.activeNoteContent);
  }
  return lines.join("\n");
}

/** The notes named with @[[…]], with their content, as its own context block. */
export function mentionedBlock(context: NoteContext): string {
  const notes = context.mentioned || [];
  if (notes.length === 0) return "";
  const lines = ["Context — notes mentioned in this message (the user asked for these specifically):"];
  for (const note of notes) {
    lines.push("", "### " + note.path, "", note.content);
  }
  return lines.join("\n");
}

export function fileOpsUserPrompt(request: string, notePaths: string[], folders: string[]): string {
  const lines = [
    "Plan the file operations this request asks for.",
    "",
    "Request: " + request.trim(),
    "",
    "Notes that exist — use these paths exactly as written:",
  ];
  if (notePaths.length === 0) lines.push("(the vault has no notes yet)");
  for (const path of notePaths) lines.push("- " + path);
  lines.push("", "Folders that exist: " + (folders.length > 0 ? folders.join(", ") : "(none yet)"));
  lines.push(
    "",
    "Answer with JSON only, in exactly this shape:",
    '{"ops":[{"op":"move","from":"House/Kitchen renovation.md","to":"Archive/Kitchen renovation.md"}],"note":"one short sentence about what you are doing"}',
    "",
    "Rules:",
    "- op is move, copy or delete. from must be one of the paths above, spelled exactly like it.",
    "- to is the destination path for move and copy, ending in .md. A folder name on its own means 'into that folder'.",
    "- Never invent a note. Never use a path containing .obsidian. Never plan more than 25 operations.",
    "- If nothing is really being asked for, or the request is too vague to resolve, answer with {\"ops\":[],\"note\":\"why\"}.",
    "- Do not explain outside the JSON."
  );
  return lines.join("\n");
}

export function titleUserPrompt(content: string): string {
  return [
    "Answer with the title only.",
    "",
    "Give this note a short, descriptive title, as it should appear as an Obsidian file name.",
    "One line, no quotes, no markdown, no trailing punctuation, at most 8 words.",
    "It must describe the note's content and must never be \"Hermes\", \"AI\", \"Answer\", \"Note\" or anything similarly generic.",
    "",
    "Note:",
    "",
    content,
  ].join("\n");
}

/** Trim a conversation to the last N messages, always keeping the system role out. */
export function trimHistory(messages: { role: string; content: string }[], max: number): { role: "user" | "assistant"; content: string }[] {
  const relevant = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  if (max <= 0) return relevant;
  return relevant.length > max ? relevant.slice(relevant.length - max) : relevant;
}
