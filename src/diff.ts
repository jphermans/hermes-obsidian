/**
 * Line diff for the edit-review window. Common lines at the top and bottom are
 * trimmed before the dynamic-programming step, so a one-line change in a long
 * note stays cheap — which matters on a phone.
 */

export interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Too large to align line by line: the caller should show the result instead. */
  coarse: boolean;
  /** Lines that only differ in trailing whitespace are not counted. */
  truncated?: boolean;
}

const MAX_ALIGN_LINES = 1200;

function splitLines(text: string): string[] {
  const normalised = (text || "").split("\r\n").join("\n");
  const lines = normalised.split("\n");
  // A trailing newline is not a line of its own.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffResult {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  // Identical halves on both ends need no alignment at all.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const oldMiddle = oldLines.slice(start, endOld);
  const newMiddle = newLines.slice(start, endNew);

  if (oldMiddle.length > MAX_ALIGN_LINES || newMiddle.length > MAX_ALIGN_LINES) {
    return {
      lines: [],
      added: newMiddle.length,
      removed: oldMiddle.length,
      coarse: true,
    };
  }

  for (let index = 0; index < start; index++) lines.push({ type: "same", text: oldLines[index] });

  // Classic longest-common-subsequence table over the trimmed middle.
  const rows = oldMiddle.length;
  const cols = newMiddle.length;
  const table: number[][] = [];
  for (let row = 0; row <= rows; row++) table.push(new Array<number>(cols + 1).fill(0));
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      table[row][col] =
        oldMiddle[row] === newMiddle[col]
          ? table[row + 1][col + 1] + 1
          : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }

  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (oldMiddle[row] === newMiddle[col]) {
      lines.push({ type: "same", text: oldMiddle[row] });
      row++;
      col++;
    } else if (table[row + 1][col] >= table[row][col + 1]) {
      lines.push({ type: "remove", text: oldMiddle[row] });
      removed++;
      row++;
    } else {
      lines.push({ type: "add", text: newMiddle[col] });
      added++;
      col++;
    }
  }
  while (row < rows) {
    lines.push({ type: "remove", text: oldMiddle[row] });
    removed++;
    row++;
  }
  while (col < cols) {
    lines.push({ type: "add", text: newMiddle[col] });
    added++;
    col++;
  }

  for (let index = endOld; index < oldLines.length; index++) lines.push({ type: "same", text: oldLines[index] });

  return { lines, added, removed, coarse: false };
}

/** Compact view: changed lines plus a few lines of context around them. */
export function diffForDisplay(result: DiffResult, context = 3): DiffLine[] {
  if (result.coarse) return [];
  const keep = new Array<boolean>(result.lines.length).fill(false);
  result.lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset;
      if (target >= 0 && target < result.lines.length) keep[target] = true;
    }
  });

  const displayed: DiffLine[] = [];
  let skipped = false;
  for (const line of result.lines.map((entry, index) => ({ entry, keep: keep[index] }))) {
    if (line.keep) {
      // Mark a skipped region wherever it is, including the head and the tail:
      // otherwise the reader cannot tell that lines are missing.
      if (skipped) {
        displayed.push({ type: "same", text: "…" });
        skipped = false;
      }
      displayed.push(line.entry);
    } else {
      skipped = true;
    }
  }
  if (skipped) displayed.push({ type: "same", text: "…" });
  return displayed;
}

export function summarizeDiff(result: DiffResult): string {
  if (result.coarse) {
    return "This note is too large to compare line by line — showing the whole result instead.";
  }
  if (result.added === 0 && result.removed === 0) return "No changes.";
  const parts: string[] = [];
  parts.push(result.added + (result.added === 1 ? " line added" : " lines added"));
  parts.push(result.removed + (result.removed === 1 ? " line removed" : " lines removed"));
  return parts.join(", ");
}

/** True when two versions differ. Used to refuse a stale approval. */
export function contentChanged(before: string, after: string): boolean {
  return (before || "") !== (after || "");
}

/**
 * Zero-based line number of the first difference — where the cursor belongs after
 * an approved edit, so the note opens on the change instead of the top.
 */
export function firstChangedLine(before: string, after: string): number {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const limit = Math.min(oldLines.length, newLines.length);
  for (let index = 0; index < limit; index++) {
    if (oldLines[index] !== newLines[index]) return index;
  }
  return oldLines.length === newLines.length ? 0 : limit;
}

export interface WordSegment {
  text: string;
  changed: boolean;
}

/** Split into words and the whitespace between them, so nothing is lost by re-joining. */
function tokenize(text: string): string[] {
  return (text || "").match(/\s+|[^\s]+/g) || [];
}

function unchangedMask(before: string[], after: string[]): { before: boolean[]; after: boolean[] } {
  // Longest common subsequence over tokens: everything outside it is a change.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table: number[][] = [];
  for (let i = 0; i < rows; i++) table.push(new Array(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const beforeSame = new Array(before.length).fill(false);
  const afterSame = new Array(after.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      beforeSame[i] = true;
      afterSame[j] = true;
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { before: beforeSame, after: afterSame };
}

function group(tokens: string[], same: boolean[]): WordSegment[] {
  const segments: WordSegment[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const changed = !same[index];
    const last = segments[segments.length - 1];
    // Whitespace takes the colour of the segment before it, so a highlight never starts with a space.
    const flag = /^\s+$/.test(tokens[index]) && last ? last.changed : changed;
    if (last && last.changed === flag) last.text += tokens[index];
    else segments.push({ text: tokens[index], changed: flag });
  }
  return segments;
}

/**
 * Word-level markup for a changed line, so a long line shows what actually changed rather
 * than being replaced wholesale. Unchanged words are shared between both sides.
 */
export function wordDiff(before: string, after: string): { before: WordSegment[]; after: WordSegment[] } {
  const left = tokenize(before);
  const right = tokenize(after);
  const mask = unchangedMask(left, right);
  return { before: group(left, mask.before), after: group(right, mask.after) };
}
