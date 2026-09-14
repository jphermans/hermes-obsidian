/**
 * Quick prompts: the prompts you use all the time, saved once, fired from chips
 * above the chat input or by typing "!". They may reference notes with
 * @[[Wikilinks]] — the mention pipeline picks those up like any other message.
 */

export interface QuickPrompt {
  id: string;
  label: string;
  prompt: string;
}

/** Offered on first run, so the chips are not an empty row. */
export const QUICK_PROMPT_SAMPLES: QuickPrompt[] = [
  {
    id: "qp-summarise",
    label: "Summarise this note",
    prompt: "Summarise @[[{note}]] in a short paragraph and list the open questions it raises.",
  },
  {
    id: "qp-links",
    label: "Suggest links",
    prompt: "Which notes should this note link to, and why? Answer with the wikilinks to add.",
  },
  {
    id: "qp-format",
    label: "Fix the formatting",
    prompt: "Fix the Markdown and Obsidian formatting of this note and return the complete file.",
  },
  {
    id: "qp-tags",
    label: "Suggest tags",
    prompt: "Suggest tags for this note following this vault's tag conventions, and explain each one.",
  },
];

export const MAX_QUICK_PROMPTS = 40;

export function defaultQuickPrompts(): QuickPrompt[] {
  return QUICK_PROMPT_SAMPLES.map((entry) => ({ ...entry }));
}

export function makeQuickPromptId(existing: QuickPrompt[]): string {
  let index = existing.length + 1;
  while (existing.some((entry) => entry.id === "qp-" + index)) index++;
  return "qp-" + index;
}

/** Keeps the list sane: no blanks, no duplicates, capped. */
export function normalizeQuickPrompts(input: unknown): QuickPrompt[] {
  if (!Array.isArray(input)) return [];
  const out: QuickPrompt[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { id?: unknown; label?: unknown; prompt?: unknown };
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (prompt.length === 0) continue;
    const label = typeof record.label === "string" && record.label.trim().length > 0 ? record.label.trim() : firstLine(prompt);
    const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : "qp-" + (out.length + 1);
    if (out.some((entry) => entry.id === id)) continue;
    out.push({ id, label: label.slice(0, 60), prompt });
    if (out.length >= MAX_QUICK_PROMPTS) break;
  }
  return out;
}

function firstLine(text: string): string {
  const line = (text || "").split("\n")[0].trim();
  return line.length > 48 ? line.slice(0, 45).trim() + "…" : line || "Quick prompt";
}

/** True while the user is typing a "!" lookup in the chat input. */
export function quickPromptQuery(text: string): string | null {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("!")) return null;
  if (trimmed.indexOf(" ") >= 0) return null;
  return trimmed.slice(1).toLowerCase();
}

export function filterQuickPrompts(prompts: QuickPrompt[], query: string): QuickPrompt[] {
  const wanted = (query || "").trim().toLowerCase();
  if (wanted.length === 0) return prompts.slice();
  const scored: { prompt: QuickPrompt; score: number }[] = [];
  for (const entry of prompts) {
    const label = entry.label.toLowerCase();
    const body = entry.prompt.toLowerCase();
    let score = -1;
    if (label.startsWith(wanted)) score = 0;
    else if (label.indexOf(wanted) >= 0) score = 1;
    else if (body.indexOf(wanted) >= 0) score = 2;
    if (score >= 0) scored.push({ prompt: entry, score });
  }
  scored.sort((a, b) => (a.score === b.score ? a.prompt.label.localeCompare(b.prompt.label) : a.score - b.score));
  return scored.map((entry) => entry.prompt);
}

/** {note} in a sample becomes the open note's name, when there is one. */
export function fillQuickPrompt(prompt: string, noteName: string): string {
  return (prompt || "").split("{note}").join(noteName || "this note");
}
