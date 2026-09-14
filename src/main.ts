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
import { AnswerModal, AnswerActions } from "./ui/answer-modal";
import { looksLikeNewNoteRequest } from "./intent";
import {
  applyableOps,
  looksLikeFileOpRequest,
  parseFileOps,
  planListing,
  validateFileOps,
} from "./file-ops";
import type { ValidatedOp } from "./file-ops";
import { FileOpsModal } from "./ui/file-ops-modal";
import { matchMentionedFile } from "./mentions";
import { ErrorLog, describeForLog } from "./error-log";
import type { ErrorEntry } from "./error-log";
import { ConventionsModal } from "./ui/conventions-modal";
import {
  applyFilenameStyle,
  ensureFolder,
  extractNote,
  mergeFrontmatter,
  sanitizeFilename,
  serializeNote,
  titleFromNote,
  declaredTitle,
  contentTitle,
  usableFallbackTitle,
  isPlaceholderTitle,
  normalizeTitle,
  truncateTitle,
  uniquePath,
  unwrapFence,
  writeNote,
} from "./note-writer";
import {
  exportableSettings,
  mergeImportedSettings,
  settingsBackupPath,
  settingsExportPath,
} from "./settings-file";
import { JsonFileSuggestModal } from "./ui/file-suggest";
import { stripCaveats } from "./caveats";
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
  titleUserPrompt,
  fileOpsUserPrompt,
  createUserPrompt,
  fixUserPrompt,
  rewriteUserPrompt,
  systemPrompt,
} from "./prompts";

const MAX_CONTEXT_CHARS = 12000;
/** Mentioned notes are explicit, but the request still has to stay affordable. */
const MAX_MENTIONED_CHARS = 24000;
const MAX_MENTIONED_NOTE_CHARS = 12000;

/** How an answer actually travelled back, so the UI can be honest about it. */
export interface TransportInfo {
  streamed: boolean;
  buffered: boolean;
  fellBack: boolean;
}

const EXAMPLES = [
  "Meeting notes for the kitchen renovation kickoff",
  "Summarise this note and tighten the prose",
  "Turn this into a project note with tasks",
];

export default class HermesAgentNotesPlugin extends Plugin {
  settings!: HermesAgentNotesSettings;
  private sessionId = "";
  private scanPromise: Promise<VaultConventions | null> | null = null;
  private errorLogInstance: ErrorLog | null = null;
  private statusBarEl: HTMLElement | null = null;
  private backupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMarkdownView: MarkdownView | null = null;
  lastBackupAt = 0;

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

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberMarkdownView(leaf);
        this.refreshViews();
      })
    );
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
      id: "file-operations",
      name: "Copy, move or delete notes",
      callback: () => void this.fileOpsInteractive(),
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
    this.scheduleBackup();
    this.refreshStatusBar();
    this.refreshViews();
  }

  // --- settings persistence ------------------------------------------------

  private scheduleBackup(): void {
    if (!this.settings.autoBackup) return;
    if (this.backupTimer !== null) clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      void this.writeBackup();
    }, 1200);
  }

  backupPath(): string {
    return settingsBackupPath(this.manifest.id);
  }

  /** Mirrors the settings next to the plugin, so a wiped folder is recoverable. */
  async writeBackup(): Promise<void> {
    try {
      const path = this.backupPath();
      await this.app.vault.adapter.write(path, JSON.stringify(exportableSettings(this.settings), null, 2) + "\n");
      this.lastBackupAt = Date.now();
    } catch (error) {
      console.warn("[Hermes Agent Notes] settings backup failed", error);
    }
  }

  /** Writes a visible settings file into the vault and returns its path. */
  async exportSettings(): Promise<string> {
    const path = settingsExportPath(this.settings.defaultFolder);
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder) await ensureFolder(this.app, folder);
    await this.app.vault.adapter.write(path, JSON.stringify(exportableSettings(this.settings), null, 2) + "\n");
    return path;
  }

  async restoreFromBackup(): Promise<void> {
    const path = this.backupPath();
    try {
      if (!(await this.app.vault.adapter.exists(path))) {
        new Notice("No automatic backup yet — it appears at " + path + " after the first settings change.", 8000);
        return;
      }
      const raw = await this.app.vault.adapter.read(path);
      await this.applyImportedSettings(JSON.parse(raw), "the automatic backup");
    } catch (error) {
      new Notice("Could not read the automatic backup: " + (error instanceof Error ? error.message : String(error)), 10000);
    }
  }

  async restoreFromFile(): Promise<void> {
    const files = this.app.vault.getFiles().filter((file) => file.extension === "json");
    if (files.length === 0) {
      new Notice("No JSON files in this vault to restore from.");
      return;
    }
    new JsonFileSuggestModal(this.app, files, (file) => {
      void (async () => {
        try {
          const raw = await this.app.vault.read(file);
          await this.applyImportedSettings(JSON.parse(raw), file.path);
        } catch (error) {
          new Notice("Could not read " + file.path + ": " + (error instanceof Error ? error.message : String(error)), 10000);
        }
      })();
    }).open();
  }

  private async applyImportedSettings(raw: unknown, source: string): Promise<void> {
    const result = mergeImportedSettings(this.settings, raw);
    if (result.applied.length === 0) {
      new Notice(
        "Nothing restored from " + source + (result.errors.length > 0 ? ": " + result.errors.join("; ") : " — no known settings in that file."),
        12000
      );
      return;
    }
    this.settings = result.settings;
    await this.saveSettings();
    new Notice(
      "Restored " + result.applied.length + " setting" + (result.applied.length === 1 ? "" : "s") + " from " + source +
        (result.errors.length > 0 ? " — skipped: " + result.errors.join("; ") : "") +
        (result.ignored.length > 0 ? " (" + result.ignored.length + " unrecognised key(s) ignored)" : ""),
      9000
    );
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
    if (!state.ok) {
      await this.logError("Test connection", state.detail, this.settings.baseUrl);
    }
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
        if (result.buffered) this.warnAboutBuffering();
      } catch (error) {
        if (error instanceof HermesError && error.kind === "aborted") throw error;
        console.warn("[Hermes Agent Notes] streaming failed in the setup page", error);
        await this.logError("Streaming (setup page)", error, this.endpointLabel());
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

  /**
   * Remembers the last markdown view. While the chat panel (a sidebar view) has
   * focus, `getActiveViewOfType(MarkdownView)` returns null, so the editor has to
   * be recalled from the last leaf that was a markdown view.
   */
  private rememberMarkdownView(leaf?: WorkspaceLeaf | null): void {
    const view = leaf && leaf.view instanceof MarkdownView ? leaf.view : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file) this.lastMarkdownView = view;
  }

  /**
   * The note Obsidian considers open — `getActiveFile()` keeps tracking it even
   * when the sidebar holds focus, which is why Append works with the chat open.
   */
  activeNoteFile(): TFile | null {
    const usable = (file: TFile | null | undefined): TFile | null => {
      if (!file || file.extension !== "md") return null;
      // Excalidraw drawings are .md files too — never append prose into one.
      if (file.path.toLowerCase().endsWith(".excalidraw.md")) return null;
      return file;
    };
    const active = usable(this.app.workspace.getActiveFile());
    if (active) return active;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const fromView = usable(view.file);
      if (fromView) return fromView;
    }
    if (this.lastMarkdownView) return usable(this.lastMarkdownView.file);
    return null;
  }

  activeNoteName(): string {
    const file = this.activeNoteFile();
    return file ? file.basename : "";
  }

  /** The editor to insert into, if any is reachable from the current layout. */
  private activeEditor(): Editor | null {
    const info = this.app.workspace.activeEditor;
    if (info && info.editor) return info.editor;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) || this.lastMarkdownView;
    if (view && view.file) return view.editor;
    return null;
  }

  private withActiveNote(checking: boolean, action: () => void): boolean {
    const hasFile = this.activeNoteFile() !== null;
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
    mentioned?: TFile[];
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

    const mentioned: { path: string; content: string }[] = [];
    let budget = MAX_MENTIONED_CHARS;
    for (const entry of options.mentioned || []) {
      if (budget <= 0) break;
      if (entry.path === (file ? file.path : "")) continue;
      if (mentioned.some((note) => note.path === entry.path)) continue;
      let body = "";
      try {
        body = await this.app.vault.cachedRead(entry);
      } catch {
        continue;
      }
      const room = Math.min(MAX_MENTIONED_NOTE_CHARS, budget);
      if (body.length > room) body = body.slice(0, room) + "\n\n[truncated here]";
      budget -= body.length;
      mentioned.push({ path: entry.path, content: body });
    }

    return {
      vaultName: this.app.vault.getName(),
      targetFolder,
      notePath: file ? file.path : undefined,
      noteTitle: file ? file.basename : undefined,
      activeNoteContent: activeContent,
      mentioned,
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
      /** Notes named with @[[…]] that should travel with this request. */
      mentionTitles?: string[];
      onDelta?: (delta: string, full: string) => void;
      onController?: (controller: AbortController) => void;
      /** Told which transport answered, so the UI can say so. */
      onTransport?: (info: TransportInfo) => void;
    } = {}
  ): Promise<string> {
    const conversation: ChatMessage[] = history.map((entry) => ({ role: entry.role, content: entry.content }));
    // "Create a new note about X" must not be answered out of the note that is
    // open, otherwise the new note comes out as a continuation of the old one.
    const lastUser = [...conversation].reverse().find((entry) => entry.role === "user");
    const wantsNewNote = lastUser ? looksLikeNewNoteRequest(lastUser.content) : false;
    const mentioned = await this.resolveMentionedNotes(options.mentionTitles || []);
    const context = await this.noteContext({
      includeActive: options.includeNote !== false && !wantsNewNote,
      mentioned,
    });
    for (let index = conversation.length - 1; index >= 0; index--) {
      if (conversation[index].role === "user") {
        conversation[index] = { role: "user", content: chatUserPrompt(conversation[index].content, context) };
        break;
      }
    }
    const system = options.system || systemPrompt("chat", context);
    const client = this.client();

    let fellBack = false;
    if (this.settings.streaming && options.onDelta) {
      const controller = new AbortController();
      if (options.onController) options.onController(controller);
      try {
        const streamed = await client.chatStream(conversation, { system, signal: controller.signal, sessionId: this.sessionId, sessionKey: this.sessionKey() }, options.onDelta);
        if (streamed.buffered) this.warnAboutBuffering();
        if (options.onTransport) {
          options.onTransport({ streamed: true, buffered: streamed.buffered === true, fellBack: false });
        }
        return streamed.content;
      } catch (error) {
        if (error instanceof HermesError && error.kind === "aborted") throw error;
        console.warn("[Hermes Agent Notes] streaming failed, using the native transport", error);
        await this.logError("Streaming", error, this.endpointLabel());
        new Notice("Streaming was refused — falling back to the standard transport.", 6000);
        fellBack = true;
      }
    }

    const chatOptions: ChatOptions = { system, sessionId: this.sessionId, sessionKey: this.sessionKey() };
    const result = await client.chat(conversation, chatOptions);
    // Reported once, after the fact: a fallback must not be reported as a plain deliver.
    if (options.onTransport) options.onTransport({ streamed: false, buffered: false, fellBack });
    return result.content;
  }

  private async askOnce(task: "create" | "rewrite" | "fix" | "answer" | "title" | "fileops", context: NoteContext, userPrompt: string): Promise<string> {
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
    void this.logError("Request", error);
  }

  private bufferingWarned = false;

  /** Says once, with the likely cause, why tokens are not appearing one by one. */
  private warnAboutBuffering(): void {
    if (this.bufferingWarned) return;
    this.bufferingWarned = true;
    new Notice(
      "The whole answer arrived in one piece: something between Obsidian and Hermes is buffering the stream — a reverse proxy (nginx needs proxy_buffering off), a CDN, or the server itself. Everything else works.",
      14000
    );
    void this.logError("Streaming buffered", "the answer arrived in a single read", this.endpointLabel());
  }

  /**
   * One small streamed request, measured, and reported in plain words: whether
   * streaming works, and if not, which side is stopping it.
   */
  async verifyStreaming(): Promise<string> {
    const client = this.client();
    const started = Date.now();
    let firstDeltaAt = 0;
    let deltas = 0;
    let received = "";
    try {
      const result = await client.chatStream(
        [{ role: "user", content: "Reply with exactly: streaming works" }],
        {
          system: "You are a connectivity probe. Answer with one short line and nothing else.",
          sessionId: this.sessionId,
          sessionKey: this.sessionKey(),
        },
        (_delta, full) => {
          deltas++;
          if (firstDeltaAt === 0) firstDeltaAt = Date.now() - started;
          received = full;
        }
      );
      const total = Date.now() - started;
      if (result.buffered) {
        return (
          "Streaming is connected, but the whole answer arrived in one piece after " +
          total +
          " ms. Something is buffering the response: a reverse proxy (nginx: proxy_buffering off), a CDN, or the server itself. Until that is off, tokens cannot appear one by one."
        );
      }
      return (
        "Streaming works: " +
        deltas +
        " events, first token after " +
        firstDeltaAt +
        " ms, " +
        total +
        " ms in total, " +
        received.trim().length +
        " characters received."
      );
    } catch (error) {
      await this.logError("Verify streaming", error, this.endpointLabel());
      return "Streaming failed: " + describeError(error);
    }
  }

  // --- diagnostics ---------------------------------------------------------

  /** Somewhere to look when something failed, especially on a phone. */
  private errorLog(): ErrorLog {
    if (!this.errorLogInstance) {
      const path = this.app.vault.configDir + "/plugins/" + this.manifest.id + "/errors.log";
      const adapter = this.app.vault.adapter;
      const folder = path.slice(0, path.lastIndexOf("/"));
      this.errorLogInstance = new ErrorLog({
        read: async () => ((await adapter.exists(path)) ? adapter.read(path) : ""),
        write: async (text) => {
          try {
            await adapter.mkdir(folder);
          } catch {
            // already there
          }
          await adapter.write(path, text);
        },
      });
    }
    return this.errorLogInstance;
  }

  /** Records a problem. Never throws, never blocks the feature that failed. */
  async logError(source: string, error: unknown, detail?: string): Promise<void> {
    try {
      await this.errorLog().record({
        at: new Date().toISOString(),
        source,
        message: describeForLog(error),
        detail,
      });
    } catch {
      // a broken log must not escalate
    }
  }

  recentErrors(limit = 60): Promise<ErrorEntry[]> {
    return this.errorLog().read(limit);
  }

  clearErrors(): Promise<void> {
    return this.errorLog().clear();
  }

  errorLogPath(): string {
    return this.app.vault.configDir + "/plugins/" + this.manifest.id + "/errors.log";
  }

  /**
   * Turns the notes the user named with @[[…]] into files. Names that match
   * nothing (or too many notes) are reported instead of being silently dropped.
   */
  async resolveMentionedNotes(titles: string[]): Promise<TFile[]> {
    if (titles.length === 0) return [];
    const all = this.app.vault.getMarkdownFiles();
    const files: TFile[] = [];
    const leftOut: string[] = [];
    for (const title of titles) {
      const file = matchMentionedFile(all, title);
      if (!file || files.some((entry) => entry.path === file.path) || files.length >= 4) {
        leftOut.push(title);
        continue;
      }
      files.push(file);
    }
    if (leftOut.length > 0) {
      new Notice("Not sent with the message: " + leftOut.join(", "), 8000);
    }
    return files;
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
      await this.logError("Write note", error, result.path);
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
      const wantsNewNote = looksLikeNewNoteRequest(answer.prompt);
      const context = await this.noteContext({ includeActive: !wantsNewNote });
      const raw = await this.askOnce("answer", context, chatUserPrompt(answer.prompt, context));
      const actions: AnswerActions = wantsNewNote
        ? { create: () => void this.saveTextAsNote(raw, answer.prompt) }
        : {
            insert: () => this.insertAtCursor(raw),
            append: () => void this.appendToActiveNote(raw),
            save: () => void this.saveTextAsNote(raw, answer.prompt),
          };
      new AnswerModal(
        this.app,
        wantsNewNote ? "New note from Hermes" : "Hermes on " + file.basename,
        raw,
        actions
      ).open();
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
      const wantsNewNote = looksLikeNewNoteRequest(answer.prompt);
      const context = await this.noteContext({ includeActive: !wantsNewNote });
      const raw = await this.askOnce("answer", context, chatUserPrompt(answer.prompt, context));
      if (wantsNewNote) {
        // A request for a new note is never inserted into the note that is open.
        await this.saveTextAsNote(raw, answer.prompt);
        return;
      }
      const text = raw.trim();
      const cursor = editor.getCursor();
      const needsBreak = cursor.ch > 0;
      editor.replaceSelection((needsBreak ? "\n\n" : "") + text + "\n");
      new Notice("Inserted.");
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * Answers written into a note lose the assistant's own caveats; generated
   * notes never do (a real note may legitimately contain a "Note:" line).
   */
  private cleanAnswer(text: string): { text: string; suffix: string } {
    if (!this.settings.stripCaveats) return { text: text.trim(), suffix: "" };
    const cleaned = stripCaveats(text);
    const count = cleaned.removed.length;
    return {
      text: cleaned.text,
      suffix: count > 0 ? " (dropped " + count + " caveat" + (count === 1 ? "" : "s") + ")" : "",
    };
  }

  insertAtCursor(text: string): void {
    const cleaned = this.cleanAnswer(text);
    const editor = this.activeEditor();
    if (editor) {
      const cursor = editor.getCursor();
      editor.replaceSelection((cursor.ch > 0 ? "\n\n" : "") + cleaned.text + "\n");
      new Notice("Inserted at the cursor" + cleaned.suffix + ".");
      return;
    }
    // No editor reachable (chat panel focused, note in another window): appending
    // is more useful than refusing.
    const file = this.activeNoteFile();
    if (file) {
      void this.appendToFile(file, cleaned, "appended to the end of ");
      return;
    }
    new Notice("Open a note first — Obsidian has no active note right now.");
  }

  async appendToActiveNote(text: string): Promise<void> {
    const file = this.activeNoteFile();
    if (!file) {
      new Notice("Open a note first — Obsidian has no active note right now.");
      return;
    }
    await this.appendToFile(file, this.cleanAnswer(text), "appended to ");
  }

  private async appendToFile(file: TFile, cleaned: { text: string; suffix: string }, verb: string): Promise<void> {
    try {
      const current = await this.app.vault.read(file);
      const separator = current.length === 0 || current.endsWith("\n") ? "\n" : "\n\n";
      await this.app.vault.modify(file, current + separator + cleaned.text + "\n");
      new Notice("Answer " + verb + file.basename + cleaned.suffix + ".");
    } catch (error) {
      new Notice("Could not update the note: " + (error instanceof Error ? error.message : String(error)));
      await this.logError("Append to note", error, file.path);
    }
  }

  /**
   * Asks Hermes to name a note that arrived without one. The answer is validated
   * against the placeholder list, so "Hermes", "Answer" or "Untitled" can never
   * become a file name; an unusable answer simply yields no title.
   */
  private async askForTitle(content: string): Promise<string> {
    try {
      const context = await this.noteContext({ includeActive: false });
      const raw = await this.askOnce("title", context, titleUserPrompt(content.slice(0, 6000)));
      const title = truncateTitle(normalizeTitle(raw), 10, 70);
      return isPlaceholderTitle(title) ? "" : title;
    } catch (error) {
      await this.logError("Title request", error);
      return "";
    }
  }

  async saveTextAsNote(text: string, hint: string): Promise<void> {
    const cleaned = this.cleanAnswer(text);
    // Answers get the fence treatment only: their conversational cleanup is the
    // stripCaveats setting above, so the toggle actually means something.
    const note = unwrapFence(cleaned.text);
    if (!note.trim()) {
      new Notice("There is nothing to save.");
      return;
    }
    // The title must come from the note itself — the properties or H1 the agent
    // wrote, otherwise the agent is asked to name it. Never a stand-in such as
    // "Hermes answer", and never the raw request ("make it shorter").
    let title = declaredTitle(note);
    if (title.length === 0) title = await this.askForTitle(note);
    if (title.length === 0) title = contentTitle(note);
    if (title.length === 0) title = usableFallbackTitle(hint);
    if (title.length === 0) title = "Untitled note";
    const fileName = sanitizeFilename(applyFilenameStyle(sanitizeFilename(title), this.settings.filenameStyle));
    const folder = this.settings.defaultFolder;
    const path = uniquePath(this.app, folder, fileName);
    try {
      const file = await writeNote(this.app, path, note.trim() + "\n", "create");
      new Notice("Saved as " + file.path + cleaned.suffix);
      if (this.settings.openAfterCreate) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
    } catch (error) {
      new Notice("Could not save the note: " + (error instanceof Error ? error.message : String(error)));
      await this.logError("Save as note", error, hint);
    }
  }

  // --- copy, move and delete -----------------------------------------------

  /**
   * Plans copy / move / delete for a request, shows the exact operations for
   * approval, and only then touches the vault. Returns a Markdown summary either
   * way, so the chat can show what happened (or why nothing did).
   */
  async runFileOpRequest(request: string, heading = "File operations"): Promise<string> {
    if (!this.settings.allowFileOps) {
      return "Copying, moving and deleting notes is turned off in the plugin settings.";
    }
    const files = this.app.vault.getMarkdownFiles();
    const listing = planListing(files, request, 300);
    const context = await this.noteContext({ includeActive: false });
    const raw = await this.askOnce(
      "fileops",
      context,
      fileOpsUserPrompt(request, listing, listFolders(this.app).slice(0, 60))
    );
    const plan = parseFileOps(raw);
    const ops = validateFileOps(plan.ops, files, listFolders(this.app));

    if (applyableOps(ops).length === 0) {
      const why = plan.note || (ops.length === 0 ? "Hermes did not find a file operation in that request." : "");
      const reasons = ops
        .filter((op) => op.skip)
        .map((op) => "- " + op.label + " — " + op.skip)
        .join("\n");
      const dropped = plan.dropped > 0 ? "\n\n(only the first 25 operations were considered.)" : "";
      return ["**Nothing to apply**" + (why ? " — " + why : ""), reasons ? "\n" + reasons : "", dropped]
        .join("\n")
        .trim();
    }

    const choice = await FileOpsModal.ask(this.app, {
      heading,
      note: plan.note,
      ops,
      allowPermanent: true,
      startPermanent: this.settings.permanentDelete,
    });
    if (!choice) return "Cancelled — nothing in the vault was changed.";
    return this.applyFileOperations(choice.ops, { permanentDelete: choice.permanentDelete });
  }

  /** The only place in the plugin that changes the vault's file layout. */
  async applyFileOperations(
    ops: ValidatedOp[],
    options: { permanentDelete: boolean }
  ): Promise<string> {
    const done: string[] = [];
    const failed: string[] = [];
    for (const op of ops) {
      if (op.skip) continue;
      try {
        const target = this.app.vault.getAbstractFileByPath(op.from);
        if (!(target instanceof TFile)) throw new Error("that note is no longer in the vault");
        if (op.op === "copy" && op.to) {
          await this.app.vault.copy(target, op.to);
          done.push("Copied `" + op.from + "` to `" + op.to + "`");
        } else if (op.op === "move" && op.to) {
          // Obsidian's own rename, so wikilinks and embeds follow the note.
          await this.app.fileManager.renameFile(target, op.to);
          done.push("Moved `" + op.from + "` to `" + op.to + "` (links updated)");
        } else if (op.op === "delete") {
          if (options.permanentDelete) {
            await this.app.vault.delete(target, true);
            done.push("Deleted `" + op.from + "` permanently");
          } else {
            await this.trashNote(target);
            done.push("Moved `" + op.from + "` to the trash");
          }
        }
      } catch (error) {
        failed.push(op.label + " — " + (error instanceof Error ? error.message : String(error)));
        await this.logError("File operation", error, op.label);
      }
    }

    const lines: string[] = [];
    if (done.length > 0) lines.push("**Done**", ...done.map((line) => "- " + line));
    if (failed.length > 0) lines.push("", "**Failed**", ...failed.map((line) => "- " + line));
    new Notice(
      done.length +
        " file operation" +
        (done.length === 1 ? "" : "s") +
        " applied" +
        (failed.length > 0 ? ", " + failed.length + " failed (see Diagnostics)" : "."),
      8000
    );
    return lines.length > 0 ? lines.join("\n") : "Nothing was changed.";
  }

  /**
   * Obsidian's own delete: it honours the user's "Deleted files" preference
   * (trash folder, system trash or permanent) instead of guessing.
   */
  private async trashNote(file: TFile): Promise<void> {
    const manager = this.app.fileManager as unknown as { trashFile?: (file: TFile) => Promise<void> };
    if (typeof manager.trashFile === "function") {
      await manager.trashFile(file);
      return;
    }
    await this.app.vault.trash(file, true);
  }

  private async fileOpsInteractive(): Promise<void> {
    const answer = await PromptModal.ask(this.app, {
      title: "Copy, move or delete notes",
      placeholder: "e.g. move the boiler note into Archive, and delete the 2025 draft",
      submitLabel: "Plan it",
      rows: 3,
    });
    if (!answer) return;
    try {
      const summary = await this.runFileOpRequest(answer.prompt, "Copy, move or delete");
      new AnswerModal(this.app, "File operations", summary, {}).open();
    } catch (error) {
      this.reportError(error);
    }
  }
}
