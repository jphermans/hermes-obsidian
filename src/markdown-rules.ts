/**
 * The rest of Obsidian's documented Markdown, as checks.
 *
 * Properties live in `properties.ts`; this module covers the syntax on
 * help.obsidian.md/syntax, /advanced-syntax, /callouts, /links, /embeds and /html — the
 * rules a generated note can actually break. Code fences and inline code are excluded
 * first, because every rule here is meaningless inside them.
 */

export interface MarkdownIssue {
  level: "warn" | "info";
  message: string;
  /** 1-based line in the body, when the issue belongs to one. */
  line?: number;
}

/** Every callout type the documentation lists, with the aliases it accepts. */
export const CALLOUT_TYPES: { type: string; aliases: string[] }[] = [
  { type: "note", aliases: [] },
  { type: "abstract", aliases: ["summary", "tldr"] },
  { type: "info", aliases: [] },
  { type: "todo", aliases: [] },
  { type: "tip", aliases: ["hint", "important"] },
  { type: "success", aliases: ["check", "done"] },
  { type: "question", aliases: ["help", "faq"] },
  { type: "warning", aliases: ["caution", "attention"] },
  { type: "failure", aliases: ["fail", "missing"] },
  { type: "danger", aliases: ["error"] },
  { type: "bug", aliases: [] },
  { type: "example", aliases: [] },
  { type: "quote", aliases: ["cite"] },
];

export function knownCalloutTypes(): string[] {
  const out: string[] = [];
  for (const entry of CALLOUT_TYPES) out.push(entry.type);
  for (const entry of CALLOUT_TYPES) for (const alias of entry.aliases) out.push(alias);
  return out;
}

/** Everything except fenced blocks and inline code, with the original line numbering. */
export function stripCode(body: string): { lines: string[]; raw: string[] } {
  const raw = (body || "").split("\n");
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of raw) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (match && line.trim().indexOf(fence) === 0) fence = null;
      lines.push("");
      continue;
    }
    if (match) {
      fence = match[1];
      lines.push("");
      continue;
    }
    // Inline code: a backtick run, its content, and the matching run.
    lines.push(line.replace(/`{1,}[^`]*`{1,}/g, "``"));
  }
  return { lines, raw };
}

function isTableRow(line: string): boolean {
  return line.trim().indexOf("|") >= 0;
}

/** A pipe that would actually make this line a table row (an escaped one inside a link does not). */
function hasTablePipe(line: string): boolean {
  return line.replace(/!?\[\[[^\]]*\]\]/g, "").indexOf("|") >= 0;
}

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.indexOf("-") < 0) return false;
  return /^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.indexOf("|") >= 0;
}

/**
 * Every documented rule that a note body can break: footnotes without a definition,
 * unclosed comments, the `---` heading trap, URLs with raw spaces, table traps, invented
 * callout types, malformed block identifiers and link-hostile link targets.
 */
export function checkMarkdown(body: string, options: { calloutTypes?: string[] } = {}): MarkdownIssue[] {
  const issues: MarkdownIssue[] = [];
  const { lines, raw } = stripCode(body);
  const allowedCallouts = (options.calloutTypes && options.calloutTypes.length > 0 ? options.calloutTypes : knownCalloutTypes()).map((type) =>
    type.toLowerCase()
  );

  // --- footnotes: a reference needs a definition ---------------------------
  const references = new Map<string, number>();
  const definitions = new Set<string>();
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\[\^([^\]\s]+)\]/g)) {
      const isDefinition = new RegExp("\\[\\^" + match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\]\\s*:").test(line);
      if (isDefinition) definitions.add(match[1]);
      else if (!references.has(match[1])) references.set(match[1], index + 1);
    }
  });
  for (const [id, line] of references) {
    if (!definitions.has(id)) {
      issues.push({
        level: "warn",
        line,
        message: "The footnote [^" + id + "] has no definition — add a line “[^" + id + "]: …”, or the reference shows as plain text.",
      });
    }
  }
  for (const id of definitions) {
    if (!references.has(id)) {
      issues.push({ level: "info", message: "The footnote definition [^" + id + "] is never referenced." });
    }
  }

  // --- comments must be closed --------------------------------------------
  lines.forEach((line, index) => {
    const markers = (line.match(/%%/g) || []).length;
    if (markers % 2 === 1) {
      issues.push({
        level: "warn",
        line: index + 1,
        message: "A %% comment is opened and never closed on this line, so the rest of the note is hidden.",
      });
    }
  });

  // --- a rule directly under text becomes a heading -----------------------
  lines.forEach((line, index) => {
    if (index === 0) return;
    const previous = lines[index - 1];
    const isRule = /^\s*(?:-{2,}|={2,})\s*$/.test(line);
    if (isRule && previous.trim().length > 0) {
      issues.push({
        level: "warn",
        line: index + 1,
        message:
          "“" +
          line.trim() +
          "” sits directly under text, so Obsidian reads the line above as a heading of that level. Use *** for a horizontal rule, or leave a blank line above.",
      });
    }
  });

  // --- external links: a raw space needs %20 or angle brackets ------------
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\]\(([^)]*)\)/g)) {
      const target = match[1];
      if (target.charAt(0) === "<") continue;
      if (/\s/.test(target)) {
        issues.push({
          level: "warn",
          line: index + 1,
          message: "A URL with a space does not work: write the space as %20, or wrap the URL in angle brackets — [label](<" + target.trim() + ">).",
        });
      }
    }
  });

  // --- tables -------------------------------------------------------------
  let inTable = false;
  let separatorChecked = false;
  lines.forEach((line, index) => {
    const row = isTableRow(line);
    if (!row) {
      if (inTable && line.trim().length === 0) {
        // A blank line ends the table; only complain if another row follows it.
        const rest = lines.slice(index + 1).filter((entry) => entry.trim().length > 0);
        if (rest.length > 0 && isTableRow(rest[0])) {
          issues.push({
            level: "warn",
            line: index + 1,
            message: "A blank line inside a table breaks it — Obsidian renders the rows below as plain text.",
          });
        }
      }
      inTable = false;
      separatorChecked = false;
      return;
    }
    if (!inTable) {
      inTable = true;
      separatorChecked = false;
      return;
    }
    if (!separatorChecked && isSeparatorRow(line)) {
      separatorChecked = true;
      // "the header row must contain at least two hyphens"
      const cells = line.replace(/^\||\|$/g, "").split("|");
      const thin = cells.filter((cell) => {
        const hyphens = (cell.match(/-/g) || []).length;
        return cell.trim().length > 0 && hyphens > 0 && hyphens < 2;
      });
      if (thin.length > 0) {
        issues.push({
          level: "warn",
          line: index + 1,
          message: "A table column needs at least two hyphens in the separator row — write “-- | -- | --” instead of “- | - | -”.",
        });
      }
      return;
    }
    // Inside a table, a pipe that belongs to a link must be escaped.
    for (const match of line.matchAll(/(!?\[\[[^\]]*)\|/g)) {
      // The pipe is escaped when the character before it is a backslash.
      const at = (match.index || 0) + match[1].length;
      if (raw[index].charAt(at - 1) !== "\\") {
        issues.push({
          level: "warn",
          line: index + 1,
          message: "A pipe inside a link or embed in a table cell must be escaped as \\| — “" + match[1].slice(0, 40) + "|…”, otherwise the cell ends there.",
        });
      }
    }
  });

  // --- callouts -----------------------------------------------------------
  lines.forEach((line, index) => {
    const match = /^\s*>+\s*\[!([^\]]+)\]/.exec(line);
    if (!match) return;
    const type = match[1].trim().toLowerCase();
    if (allowedCallouts.indexOf(type) < 0) {
      issues.push({
        level: "info",
        line: index + 1,
        message: "“" + match[1] + "” is not a callout type the documentation lists, so Obsidian renders it as [!note]. Known types: " + CALLOUT_TYPES.map((entry) => entry.type).join(", ") + ".",
      });
    }
  });

  // --- block identifiers --------------------------------------------------
  lines.forEach((line, index) => {
    const match = /\s\^([^\s]+)\s*$/.exec(line);
    if (!match) return;
    const id = match[1];
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      issues.push({
        level: "warn",
        line: index + 1,
        message: "The block identifier ^" + id + " uses characters Obsidian does not accept — it allows Latin letters, numbers and dashes only.",
      });
    }
  });

  // --- link targets -------------------------------------------------------
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
      const target = match[1].split("|")[0].split("#")[0].trim();
      if (target.length === 0) continue;
      const bad = [":", "%%", "^", "[", "]"].filter((character) => target.indexOf(character) >= 0);
      if (bad.length > 0) {
        issues.push({
          level: "warn",
          line: index + 1,
          message: "The link target “" + target + "” contains " + bad.join(" and ") + ", which Obsidian may not resolve — avoid those characters in a note name.",
        });
      }
    }
  });

  // --- an escaped pipe outside a table is wrong too ------------------------
  let fence = false;
  raw.forEach((line, index) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fence = !fence;
    if (fence) return;
    if (hasTablePipe(line)) return;
    if (/\\\|/.test(line) && /!?\[\[[^\]]*\\\|/.test(line)) {
      issues.push({
        level: "info",
        line: index + 1,
        message: "A pipe is escaped as \\| outside a table, where the backslash shows literally — write | inside a link in normal text.",
      });
    }
  });

  // --- code fences --------------------------------------------------------
  let openFence = false;
  raw.forEach((line, index) => {
    const match = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (!match) return;
    if (openFence) {
      openFence = false;
      return;
    }
    openFence = true;
    if (!match[2]) {
      issues.push({ level: "info", line: index + 1, message: "A code block without a language tag gets no syntax highlighting." });
    }
  });

  return issues;
}
