import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  ChatMessage,
  ChatOptions,
  HermesClient,
  HermesError,
  describeError,
  endpointsFor,
} from "./hermes-client";
import { DEFAULT_SETTINGS, HermesAgentNotesSettings, VaultConventions } from "./types";
import type { ConnectionState } from "./types";
import { HermesSettingTab } from "./settings";
import { HermesChatView, VIEW_TYPE_HERMES_CHAT } from "./ui/chat-view";
import { PromptModal } from "./ui/prompt-modal";
import { PreviewModal } from "./ui/preview-modal";
import { AnswerModal } from "./ui/answer-modal";
import { ConventionsModal } from "./ui/conventions-modal";
import {
  applyFilenameStyle,
  extractNote,
  mergeFrontmatter,
  sanitizeFilename,
  serializeNote,
  titleFromNote,
  uniquePath,
  writeNote,
} from "./note-writer";
import {
  conventionsReport,
  defaultFrontmatterTemplate,
  listFolders,
  listNotesInFolder,
  scanVault,
  splitFrontmatter,
} from "./vault-rules";
import {
  NoteContext,
  chatUserPrompt,
  createUserPrompt,
  fixUserPrompt,
  rewriteUserPrompt,
  systemPrompt,
} from "./prompts";

const MAX_CONTEXT_CHARS = 12000;

const EXAMPLES = [
  "Meeting notes for the kitchen renovation kickoff",
  "Summarise this note and tighten the prose",
  "Turn this into a project note with tasks",
];

export default class HermesAgentNotesPlugin extends Plugin {
  settings!: HermesAgentNotesSettings;
  private sessionId = "";
  private scanPromise: Promise<VaultConventions | null> | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.sessionId = this.newSessionId();

    this.registerView(VIEW_TYPE_HERMES_CHAT, (leaf: WorkspaceLeaf) => new HermesChatView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));
    this.addRibbonIcon("sparkles", "Hermes Agent: open the chat panel", () => void this.activateChatView());

    this.registerCommands();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("hermes-statusbar");
    this.refreshStatusBar();

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshViews()));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_CHAT);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-chat",
      name: "Open the chat panel",
      callback: () => void this.activateChatView(),
    });

    this.addCommand({
      id: "create-note",
      name: "Create a note from a prompt",
      callback: () => void this.createNoteInteractive(),
    });

    this.addCommand({
      id: "improve-note",
      name: "Improve the active note",
      checkCallback: (checking) =>
        this.withActiveNote(checking, () => void this.rewriteActiveNote("")),
    });

    this.addCommand({
      id: "rewrite-note",
      name: "Rewrite the active note with an instruction",
      checkCallback: (checking) =>
        this.withActiveNote(checking, () => void this.rewriteActiveNote(null)),
    });

    this.addCommand({
      id: "fix-note",
      name: "Fix the active note for Obsidian",
      checkCallback: (checking) => this.withActiveNote(checking, () => void this.fixActiveNote()),
    });

    this.addCommand({
      id: "ask-note",
      name: "Ask Hermes about the active note",
      checkCallback: (checking) => this.withActiveNote(checking, () => void this.askAboutActiveNote()),
    });

    this.addCommand({
      id: "insert-answer",
      name: "Insert a Hermes answer at the cursor",
      editorCallback: (editor: Editor) => void this.insertAnswerInteractive(editor),
    });

    this.addCommand({
      id: "selection-to-note",
      name: "Turn the selection into a note",
      editorCheckCallback: (checking, editor: Editor) => {
        if (editor.getSelection().trim().length === 0) return false;
        if (!checking) void this.selectionToNote(editor);
        return true;
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "Test the Hermes connection",
      callback: () => void this.testConnectionWithNotice(),
    });

    this.addCommand({
      id: "show-conventions",
      name: "Show detected vault conventions",
      callback: () => void this.showConventions(),
    });

    this.addCommand({
      id: "rescan-vault",
      name: "Rescan vault conventions",
      callback: () => void this.rescanVault(true),
    });
  }

  // --- settings ------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<HermesAgentNotesSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    if (!this.settings.model) this.settings.model = DEFAULT_SETTINGS.model;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshStatusBar();
    this.refreshViews();
  }

  // --- labels --------------------------------------------------------------

  client(): HermesClient {
    return new HermesClient(this.settings);
  }

  endpointLabel(): string {
    return endpointsFor(this.settings.baseUrl, this.settings.profile).scoped;
  }

  modelLabel(): string {
    return (this.settings.model || "hermes-agent").trim() || "hermes-agent";
  }

  openSettings(): void {
    const internal = this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    };
    if (!internal.setting) return;
    internal.setting.open();
    internal.setting.openTabById(this.manifest.id);
  }

  // --- connection ----------------------------------------------------------

  async testConnection(): Promise<ConnectionState> {
    const client = this.client();
    let detail = "";
    let models: string[] = [];
    let ok = false;
    let model = this.modelLabel();
    try {
      const health = await client.health();
      if (!health.ok) throw new HermesError("Hermes answered HTTP " + health.status + ".", "server", health.status);
      detail = health.detail;
      try {
        models = await client.models();
      } catch (error) {
        models = [];
        detail = detail + " · could not list models (" + describeError(error) + ")";
      }
      if (models.length > 0) {
        detail = detail + " · model" + (models.length === 1 ? "" : "s") + ": " + models.join(", ");
        if (models.indexOf(model) < 0) {
          detail =
            detail +
            " · note: " + model + " is not advertised by this instance" + (this.settings.provider ? "" : " and is sent without a provider, so Hermes uses its own default model");
        }
      }
      ok = true;
    } catch (error) {
      detail = describeError(error);
      ok = false;
    }
    const state: ConnectionState = { ok, at: Date.now(), detail, model, models };
    this.settings.connection = state;
    if (models.length > 0) this.settings.availableModels = models;
    await this.saveSettings();
    return state;
  }

  async testConnectionWithNotice(): Promise<void> {
    const state = await this.testConnection();
    new Notice(state.ok ? "Hermes is reachable: " + state.detail : "Hermes could not be reached: " + state.detail, state.ok ? 6000 : 12000);
  }

  async fetchModels(): Promise<string[]> {
    const models = await this.client().models();
    this.settings.availableModels = models;
    await this.saveSettings();
    return models;
  }

  /**
   * One plain prompt with no note attached, used by the setup page's prompt box.
   * Goes through the normal path — Obsidian rules, vault conventions, session
   * headers — so a reply proves the whole chain works, not just /health.
   */
  async quickPrompt(
    prompt: string,
    onDelta?: (delta: string, full: string) => void
  ): Promise<{ text: string; ms: number; model: string; streamed: boolean }> {
    const started = Date.now();
    const context = await this.noteContext({ includeActive: false });
    const client = this.client();
    const messages: ChatMessage[] = [{ role: "user", content: chatUserPrompt(prompt, context) }];
    const base: ChatOptions = {
      system: systemPrompt("chat", context),
      sessionId: this.sessionId,
      sessionKey: this.sessionKey(),
    };

    let text = "";
    let model = this.modelLabel();
    let streamed = false;

    if (this.settings.streaming && onDelta) {
      try {
        const result = await client.chatStream(messages, Object.assign({}, base), onDelta);
        text = result.content;
        model = result.model || model;
        streamed = true;
      } catch (error) {
        if (error instanceof HermesError && error.kind === "aborted") throw error;
        console.warn("[Hermes Agent Notes] streaming failed in the setup page", error);
        new Notice("Streaming was refused — using the standard transport.", 6000);
      }
    }
    if (!text) {
      const result = await client.chat(messages, base);
      text = result.content;
      model = result.model || model;
    }

    const ms = Date.now() - started;
    this.settings.connection = {
      ok: true,
      at: Date.now(),
      detail: "Verified by a live prompt in " + ms + " ms.",
      model,
      models: this.settings.availableModels,
    };
    await this.saveSettings();
    return { text, ms, model, streamed };
  }

  private refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    const ok = !!(this.settings.connection && this.settings.connection.ok);
    this.statusBarEl.setText(ok ? "Hermes ✓" : "Hermes ⚠");
    this.statusBarEl.toggleClass("hermes-statusbar-ok", ok);
    this.statusBarEl.toggleClass("hermes-statusbar-bad", !ok);
    this.statusBarEl.setAttr(
      "aria-label",
      ok ? "Hermes connected — " + this.endpointLabel() : "Hermes not connected — open the plugin settings"
    );
    this.statusBarEl.onclick = () => void this.activateChatView();
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_CHAT)) {
      const view = leaf.view;
      if (view instanceof HermesChatView) view.refresh();
    }
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_CHAT);
    let leaf: WorkspaceLeaf | null = existing.length > 0 ? existing[0] : null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE_HERMES_CHAT, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
    this.refreshViews();
  }

  // --- note context --------------------------------------------------------

  activeNoteFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.file ? view.file : null;
  }

  activeNoteName(): string {
    const file = this.activeNoteFile();
    return file ? file.basename : "";
  }

  private withActiveNote(checking: boolean, action: () => void): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasFile = !!(view && view.file);
    if (!checking && hasFile) action();
    return hasFile;
  }

  private sessionKey(): string {
    const vault = this.app.vault.getName().replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
    return "obsidian:" + vault + ":" + this.sessionId;
  }

  private newSessionId(): string {
    return "obsidian-" + Math.random().toString(36).slice(2, 10);
  }

  rotateSession(): void {
    this.sessionId = this.newSessionId();
  }

  private async noteContext(options: {
    targetFolder?: string;
    includeActive?: boolean;
    selection?: string;
  } = {}): Promise<NoteContext> {
    const conventions = await this.getConventions();
    const file = this.activeNoteFile();
    const folderOfFile = file && file.parent && file.parent.path !== "/" ? file.parent.path : "";
    const targetFolder =
      options.targetFolder !== undefined ? options.targetFolder : folderOfFile || this.settings.defaultFolder;

    let activeContent: string | undefined;
    if (file && options.includeActive !== false) {
      try {
        activeContent = await this.app.vault.cachedRead(file);
      } catch {
        activeContent = undefined;
      }
    }
    if (activeContent && activeContent.length > MAX_CONTEXT_CHARS) {
      activeContent = activeContent.slice(0, MAX_CONTEXT_CHARS) + "\n\n[the note continues; it was truncated here]";
    }

    return {
      vaultName: this.app.vault.getName(),
      targetFolder,
      notePath: file ? file.path : undefined,
      noteTitle: file ? file.basename : undefined,
      activeNoteContent: activeContent,
      selection: options.selection,
      existingNotes: listNotesInFolder(this.app, targetFolder, this.settings.conventionsNotesListed),
      folderList: listFolders(this.app).slice(0, 60),
      includeFrontmatter: this.settings.autoFrontmatter,
      frontmatterTemplate: defaultFrontmatterTemplate(conventions),
      conventions,
      language: "auto",
    };
  }

  // --- conventions ---------------------------------------------------------

  async getConventions(force = false): Promise<VaultConventions | null> {
    if (!this.settings.conventionsEnabled) return null;
    const cached = this.settings.conventions;
    const ttl = Math.max(0, this.settings.conventionsCacheMinutes) * 60 * 1000;
    if (!force && cached && Date.now() - cached.at < ttl) return cached;
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      try {
        const conventions = await scanVault(this.app, this.settings.conventionsSample);
        this.settings.conventions = conventions;
        await this.saveSettings();
        return conventions;
      } catch (error) {
        console.error("[Hermes Agent Notes] vault scan failed", error);
        return cached;
      } finally {
        this.scanPromise = null;
      }
    })();
    return this.scanPromise;
  }

  async rescanVault(notify: boolean): Promise<VaultConventions | null> {
    const conventions = await this.getConventions(true);
    if (notify) {
      new Notice(
        conventions
          ? "Analysed " + conventions.scanned + " notes · properties in " +
            (conventions.scanned > 0 ? Math.round((conventions.frontmatterUsed / conventions.scanned) * 100) : 0) +
            "% · " + conventions.links.wiki + " wikilinks"
          : "Vault analysis is turned off."
      );
    }
    return conventions;
  }

  async showConventions(): Promise<void> {
    const conventions = await this.getConventions(true);
    if (!conventions) {
      new Notice("Vault analysis is turned off in the plugin settings.");
      return;
    }
    new ConventionsModal(this.app, conventionsReport(conventions, this.settings.conventionsCacheMinutes), async () => {
      const refreshed = await this.getConventions(true);
      return refreshed ? conventionsReport(refreshed, this.settings.conventionsCacheMinutes) : "The scan returned nothing.";
    }).open();
  }

  // --- talking to Hermes ---------------------------------------------------

  /** One chat turn, honouring the streaming setting with an automatic fallback. */
  async runChat(
    history: { role: "user" | "assistant"; content: string }[],
    options: {
      includeNote?: boolean;
      system?: string;
      onDelta?: (delta: string, full: string) => void;
      onController?: (controller: AbortController) => void;
    } = {}
  ): Promise<string> {
    const conversation: ChatMessage[] = history.map((entry) => ({ role: entry.role, content: entry.content }));
    const context = await this.noteContext({ includeActive: options.includeNote !== false });
    for (let index = conversation.length - 1; index >= 0; index--) {
      if (conversation[index].role === "user") {
        conversation[index] = { role: "user", content: chatUserPrompt(conversation[index].content, context) };
        break;
      }
    }
    const system = options.system || systemPrompt("chat", context);
    const client = this.client();

    if (this.settings.streaming && options.onDelta) {
      const controller = new AbortController();
      if (options.onController) options.onController(controller);
      try {
        const streamed = await client.chatStream(conversation, { system, signal: controller.signal, sessionId: this.sessionId, sessionKey: this.sessionKey() }, options.onDelta);
        return streamed.content;
      } catch (error) {
        if (error instanceof HermesError && error.kind === "aborted") throw error;
        console.warn("[Hermes Agent Notes] streaming failed, using the native transport", error);
        new Notice("Streaming was refused — falling back to the standard transport.", 6000);
      }
    }

    const chatOptions: ChatOptions = { system, sessionId: this.sessionId, sessionKey: this.sessionKey() };
    const result = await client.chat(conversation, chatOptions);
    return result.content;
  }

  private async askOnce(task: "create" | "rewrite" | "fix" | "answer", context: NoteContext, userPrompt: string): Promise<string> {
    const client = this.client();
    const notice = new Notice("Hermes is working…", 0);
    try {
      const result = await client.chat([{ role: "user", content: userPrompt }], {
        system: systemPrompt(task, context),
        sessionId: this.sessionId,
        sessionKey: this.sessionKey(),
      });
      return result.content;
    } finally {
      notice.hide();
    }
  }

  private reportError(error: unknown): void {
    if (error instanceof HermesError && error.kind === "aborted") return;
    new Notice("Hermes: " + describeError(error), 12000);
  }

  // --- creating notes ------------------------------------------------------

  async createNoteInteractive(prefill = ""): Promise<void> {
    const folders = listFolders(this.app);
    const answer = await PromptModal.ask(this.app, {
      title: "Create a note with Hermes",
      description: "Describe the note. Hermes writes it into this vault using your Obsidian conventions.",
      placeholder: EXAMPLES[0],
      initialValue: prefill,
      submitLabel: "Write the note",
      folders,
      initialFolder: this.settings.defaultFolder,
      showFolder: true,
      showIncludeNote: true,
      includeNote: this.settings.includeActiveNote,
      activeNoteName: this.activeNoteName(),
    });
    if (!answer) return;

    try {
      const context = await this.noteContext({ targetFolder: answer.folder, includeActive: answer.includeNote });
      const raw = await this.askOnce("create", context, createUserPrompt(answer.prompt, context));
      await this.presentNote("create", extractNote(raw), answer.prompt, answer.folder, null, null, "New note from Hermes");
    } catch (error) {
      this.reportError(error);
    }
  }

  private async selectionToNote(editor: Editor): Promise<void> {
    const selection = editor.getSelection().trim();
    if (!selection) {
      new Notice("Select some text first.");
      return;
    }
    const answer = await PromptModal.ask(this.app, {
      title: "Turn the selection into a note",
      description: "The selected text is used as the source material for a complete note.",
      placeholder: "Optional extra instruction",
      submitLabel: "Write the note",
      folders: listFolders(this.app),
      initialFolder: this.settings.defaultFolder,
      showFolder: true,
      rows: 4,
    });
    if (!answer) return;
    try {
      const context = await this.noteContext({ targetFolder: answer.folder, includeActive: false, selection });
      const instruction = answer.prompt || "Turn this selection into a complete, self-contained note.";
      const raw = await this.askOnce("create", context, createUserPrompt(instruction, context));
      await this.presentNote("create", extractNote(raw), instruction, answer.folder, null, null, "New note from the selection");
    } catch (error) {
      this.reportError(error);
    }
  }

  private async rewriteActiveNote(instruction: string | null): Promise<void> {
    const file = this.activeNoteFile();
    if (!file) {
      new Notice("Open a note first.");
      return;
    }
    let prompt = instruction || "";
    if (instruction === null) {
      const answer = await PromptModal.ask(this.app, {
        title: "Rewrite " + file.basename,
        description: "Tell Hermes what to change. It returns the whole note; the file is replaced only after the preview.",
        placeholder: "e.g. shorter, add a summary table, fix the structure",
        submitLabel: "Rewrite",
        rows: 4,
      });
      if (!answer) return;
      prompt = answer.prompt;
    }
    try {
      const original = await this.app.vault.read(file);
      const context = await this.noteContext({ includeActive: true });
      context.notePath = file.path;
      context.noteTitle = file.basename;
      context.activeNoteContent = original;
      const raw = await this.askOnce("rewrite", context, rewriteUserPrompt(prompt || "Improve this note.", context));
      await this.presentNote(
        "overwrite",
        extractNote(raw),
        prompt || file.basename,
        file.parent && file.parent.path !== "/" ? file.parent.path : "",
        file.path,
        original,
        "Hermes rewrote " + file.basename
      );
    } catch (error) {
      this.reportError(error);
    }
  }

  private async fixActiveNote(): Promise<void> {
    const file = this.activeNoteFile();
    if (!file) {
      new Notice("Open a note first.");
      return;
    }
    try {
      const original = await this.app.vault.read(file);
      const context = await this.noteContext({ includeActive: true });
      context.notePath = file.path;
      context.activeNoteContent = original;
      const raw = await this.askOnce("fix", context, fixUserPrompt(context));
      await this.presentNote(
        "overwrite",
        extractNote(raw),
        file.basename,
        file.parent && file.parent.path !== "/" ? file.parent.path : "",
        file.path,
        original,
        "Obsidian fixes for " + file.basename
      );
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * Shows the generated note, then writes it. On rewrite the existing
   * frontmatter is preserved and merged so no property is silently lost.
   */
  private async presentNote(
    mode: "create" | "overwrite",
    note: string,
    baseName: string,
    folder: string,
    existingPath: string | null,
    existingContent: string | null,
    heading: string
  ): Promise<void> {
    if (!note.trim()) {
      new Notice("Hermes returned an empty note.");
      return;
    }
    let content = note;
    if (existingContent !== null) {
      const incoming = splitFrontmatter(note);
      const existing = splitFrontmatter(existingContent);
      if (incoming.present || existing.present) {
        const merged = mergeFrontmatter(existing.data, incoming.data, { keepExisting: true, mergeLists: true });
        content = serializeNote(merged, incoming.body);
      }
    }

    const title = titleFromNote(content, baseName);
    const fileName = sanitizeFilename(applyFilenameStyle(sanitizeFilename(title), this.settings.filenameStyle));
    const suggestedPath = existingPath && mode === "overwrite" ? existingPath : uniquePath(this.app, folder, fileName);

    const result = await PreviewModal.ask(this.app, {
      heading,
      notePath: suggestedPath,
      content,
      folders: listFolders(this.app),
      mode,
      conventions: await this.getConventions(),
      openAfter: mode === "create" ? this.settings.openAfterCreate : false,
      note:
        mode === "create"
          ? "Check the note, its file name and the Obsidian checks, then create it. Nothing is written until you press Create note."
          : "The open note is replaced only when you press Replace note. Existing properties are kept.",
    });
    if (!result) return;

    try {
      const renamed = existingPath !== null && result.path !== existingPath;
      const written = await writeNote(
        this.app,
        result.path,
        result.content,
        mode === "overwrite" && !renamed ? "overwrite" : "create"
      );
      if (renamed) new Notice("Saved as a new note: " + written.path);
      else new Notice((mode === "create" ? "Note created: " : "Note updated: ") + written.path);
      if (result.openAfter) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(written);
      }
    } catch (error) {
      new Notice("Could not write the note: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  // --- answers and editing -------------------------------------------------

  private async askAboutActiveNote(): Promise<void> {
    const file = this.activeNoteFile();
    if (!file) {
      new Notice("Open a note first.");
      return;
    }
    const answer = await PromptModal.ask(this.app, {
      title: "Ask Hermes about " + file.basename,
      placeholder: "e.g. What is missing from this note? Which notes should it link to?",
      submitLabel: "Ask",
      rows: 3,
    });
    if (!answer) return;
    try {
      const context = await this.noteContext({ includeActive: true });
      const raw = await this.askOnce("answer", context, chatUserPrompt(answer.prompt, context));
      new AnswerModal(this.app, "Hermes on " + file.basename, raw, {
        insert: () => this.insertAtCursor(raw),
        append: () => void this.appendToActiveNote(raw),
        save: () => void this.saveTextAsNote(raw, answer.prompt),
      }).open();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async insertAnswerInteractive(editor: Editor): Promise<void> {
    const answer = await PromptModal.ask(this.app, {
      title: "Insert a Hermes answer",
      placeholder: "Ask anything — vault aware, the open note is included",
      submitLabel: "Insert at cursor",
      rows: 3,
    });
    if (!answer) return;
    try {
      const context = await this.noteContext({ includeActive: true });
      const raw = await this.askOnce("answer", context, chatUserPrompt(answer.prompt, context));
      const text = raw.trim();
      const cursor = editor.getCursor();
      const needsBreak = cursor.ch > 0;
      editor.replaceSelection((needsBreak ? "\n\n" : "") + text + "\n");
      new Notice("Inserted.");
    } catch (error) {
      this.reportError(error);
    }
  }

  insertAtCursor(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice("Open a note to insert into.");
      return;
    }
    const editor = view.editor;
    const cursor = editor.getCursor();
    editor.replaceSelection((cursor.ch > 0 ? "\n\n" : "") + text.trim() + "\n");
    new Notice("Inserted at the cursor.");
  }

  async appendToActiveNote(text: string): Promise<void> {
    const file = this.activeNoteFile();
    if (!file) {
      new Notice("Open a note to append to.");
      return;
    }
    try {
      const current = await this.app.vault.read(file);
      const separator = current.length === 0 || current.endsWith("\n") ? "\n" : "\n\n";
      await this.app.vault.modify(file, current + separator + text.trim() + "\n");
      new Notice("Appended to " + file.basename + ".");
    } catch (error) {
      new Notice("Could not update the note: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async saveTextAsNote(text: string, hint: string): Promise<void> {
    const note = extractNote(text);
    if (!note.trim()) {
      new Notice("There is nothing to save.");
      return;
    }
    const title = titleFromNote(note, hint);
    const fileName = sanitizeFilename(applyFilenameStyle(sanitizeFilename(title), this.settings.filenameStyle));
    const folder = this.settings.defaultFolder;
    const path = uniquePath(this.app, folder, fileName);
    try {
      const file = await writeNote(this.app, path, note.trim() + "\n", "create");
      new Notice("Saved as " + file.path);
      if (this.settings.openAfterCreate) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
    } catch (error) {
      new Notice("Could not save the note: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}
