/**
 * The note flows: ask Hermes for a note, show the draft, and either save it, drop it, or
 * send it back with a correction.
 *
 * Extracted from the plugin class so the review loop — including the revision cap — can be
 * tested with a fake host instead of a live Obsidian instance.
 */

import { App, Notice, TFile } from "obsidian";
import { PreviewModal } from "./ui/preview-modal";
import { applyFilenameStyle, extractNote, mergeFrontmatter, sanitizeFilename, serializeNote, titleFromNote, uniquePath, writeNote } from "./note-writer";
import { contentChanged } from "./diff";
import { vaultTypeMap } from "./properties";
import { listFolders, splitFrontmatter } from "./vault-rules";
import { revisionPrompt } from "./prompts";
import type { NoteContext } from "./prompts";
import type { FilenameStyle, VaultConventions } from "./types";

/** A note request kind — the same set the chat client accepts. */
export type AskKind = "create" | "rewrite" | "fix" | "answer" | "title" | "fileops";

/** What came back from the review window: written, dropped, or "do it again like this". */
export type PresentOutcome = "saved" | "cancelled" | { revise: string };

/** How many times a draft may be sent back before the plugin stops asking. */
export const MAX_REVISIONS = 5;

export interface ReviewRequest {
  mode: "create" | "overwrite";
  note: string;
  baseName: string;
  folder: string;
  existingPath: string | null;
  existingContent: string | null;
  heading: string;
}

/** Everything the flows need from the plugin: no Obsidian state of their own. */
export interface NoteFlowHost {
  app: App;
  settings: { openAfterCreate: boolean; trackEdits: boolean; filenameStyle: FilenameStyle };
  ask(kind: AskKind, context: NoteContext, userPrompt: string): Promise<string>;
  conventions(): Promise<VaultConventions | null>;
  logError(source: string, error: unknown, detail?: string): Promise<void>;
  /** Opens the note at the first changed line; `before` is the version that was on disk. */
  openAtChange(file: TFile, before: string, after: string): Promise<void>;
}

/**
 * Asks for a note, shows the draft, and if the reviewer asked for a change, sends the
 * draft back with that correction rather than making them retype the request.
 */
export async function askAndPresent(
  host: NoteFlowHost,
  label: AskKind,
  context: NoteContext,
  userPrompt: string,
  present: (note: string) => Promise<PresentOutcome>,
  notify: (message: string) => void = (message) => new Notice(message, 10000)
): Promise<PresentOutcome> {
  let prompt = userPrompt;
  let outcome: PresentOutcome = "cancelled";
  for (let attempt = 0; attempt < MAX_REVISIONS; attempt++) {
    const raw = await host.ask(label, context, prompt);
    const draft = extractNote(raw);
    outcome = await present(draft);
    if (typeof outcome !== "object") return outcome;
    prompt = revisionPrompt(userPrompt, draft, outcome.revise);
  }
  notify("Five revisions in a row — nothing was written. Ask again when you know what should change.");
  return outcome;
}

export async function reviewAndSave(
host: NoteFlowHost,
request: ReviewRequest
): Promise<PresentOutcome> {
const { mode, note, baseName, folder, existingPath, existingContent, heading } = request;
  if (!note.trim()) {
    new Notice("Hermes returned an empty note.");
    return "saved";
  }
  let content = note;
  if (existingContent !== null) {
    const incoming = splitFrontmatter(note);
    const existing = splitFrontmatter(existingContent);
    if (incoming.present || existing.present) {
      const merged = mergeFrontmatter(existing.data, incoming.data, { keepExisting: true, mergeLists: true });
      // The vault's own type for a property name is what Obsidian's panel shows, so the
      // writer honours it: a numeric string for a name the vault counts in numbers becomes
      // a number, a name the vault lists becomes a list.
      content = serializeNote(merged, incoming.body, vaultTypeMap(await host.conventions()));
    }
  }

  const title = titleFromNote(content, baseName);
  const fileName = sanitizeFilename(applyFilenameStyle(sanitizeFilename(title), host.settings.filenameStyle));
  const suggestedPath = existingPath && mode === "overwrite" ? existingPath : uniquePath(host.app, folder, fileName);

  const result = await PreviewModal.ask(host.app, {
    heading,
    notePath: suggestedPath,
    content,
    folders: listFolders(host.app),
    mode,
    conventions: await host.conventions(),
    openAfter: mode === "create" ? host.settings.openAfterCreate : false,
    before: existingContent !== null ? existingContent : undefined,
    note:
      mode === "create"
        ? "Check the note, its file name and the Obsidian checks, then create it. Nothing is written until you press Create note."
        : "The changes are listed line by line. The file is replaced only when you press Approve & save; existing properties are kept.",
  });
  if (!result) {
    if (existingContent !== null) new Notice("Rejected — the note was left untouched.");
    return "cancelled";
  }
  if (result.action === "revise") {
    // Hand the draft and the correction back to Hermes instead of ending the flow.
    return { revise: result.feedback || "" };
  }

  try {
    const renamed = existingPath !== null && result.path !== existingPath;
    // The note may have been edited elsewhere while the review window was open.
    if (mode === "overwrite" && !renamed && existingContent !== null) {
      const target = host.app.vault.getAbstractFileByPath(result.path);
      const current = target instanceof TFile ? await host.app.vault.read(target) : null;
      if (current !== null && contentChanged(current, existingContent)) {
        new Notice(
          "Nothing was written: the note changed while you were reviewing it. Run the command again to see the current version.",
          12000
        );
        await host.logError("Stale approval", "the note changed between review and save", result.path);
        return "cancelled";
      }
    }
    const written = await writeNote(
      host.app,
      result.path,
      result.content,
      mode === "overwrite" && !renamed ? "overwrite" : "create"
    );
    if (renamed) new Notice("Saved as a new note: " + written.path);
    else new Notice((mode === "create" ? "Note created: " : "Note updated: ") + written.path);
    if (mode === "overwrite" && existingContent !== null && host.settings.trackEdits) {
      // Follow the edit: open the note where it actually changed.
      await host.openAtChange(written, existingContent, result.content);
    } else if (result.openAfter) {
      const leaf = host.app.workspace.getLeaf(false);
      await leaf.openFile(written);
    }
    return "saved";
  } catch (error) {
    new Notice("Could not write the note: " + (error instanceof Error ? error.message : String(error)));
    await host.logError("Write note", error, result.path);
    return "cancelled";
  }
}
