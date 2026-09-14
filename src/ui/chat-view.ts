import { ItemView, MarkdownRenderer, Notice, Platform, WorkspaceLeaf } from "obsidian";
import type HermesAgentNotesPlugin from "../main";
import { describeError } from "../hermes-client";
import { trimHistory } from "../prompts";
import { looksLikeNewNoteRequest } from "../intent";
import { copyText } from "./clipboard";

export const VIEW_TYPE_HERMES_CHAT = "hermes-agent-chat";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  /** This answer came from a request for a new note. */
  newNote?: boolean;
}

const EXAMPLES = [
  "Create a note about today's meeting with the supplier",
  "Summarise this note and rewrite it in our house style",
  "Fix the Obsidian formatting of this note",
  "What links should this note have?",
];

export class HermesChatView extends ItemView {
  plugin: HermesAgentNotesPlugin;
  private entries: ChatEntry[] = [];
  private includeNote = true;
  private busy = false;
  private controller: AbortController | null = null;

  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private pendingEl: HTMLElement | null = null;
  private pendingText = "";
  private pendingFrame = 0;

  constructor(leaf: WorkspaceLeaf, plugin: HermesAgentNotesPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HERMES_CHAT;
  }

  getDisplayText(): string {
    return "Hermes Agent";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.includeNote = this.plugin.settings.includeActiveNote;
    this.build();
  }

  async onClose(): Promise<void> {
    this.cancel();
    this.contentEl.empty();
  }

  // --- layout --------------------------------------------------------------

  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("hermes-chat");

    const header = root.createDiv({ cls: "hermes-chat-header" });
    header.createEl("span", { cls: "hermes-chat-title", text: "Hermes Agent" });
    this.statusEl = header.createEl("span", { cls: "hermes-status", text: "" });
    const headerActions = header.createDiv({ cls: "hermes-chat-header-actions" });
    const newButton = headerActions.createEl("button", { text: "New", cls: "hermes-icon-btn" });
    newButton.setAttr("title", "Start a new conversation");
    newButton.addEventListener("click", () => this.newChat());
    const settingsButton = headerActions.createEl("button", { text: "⚙", cls: "hermes-icon-btn" });
    settingsButton.setAttr("title", "Hermes connection settings");
    settingsButton.addEventListener("click", () => this.plugin.openSettings());

    this.listEl = root.createDiv({ cls: "hermes-chat-messages" });

    const composer = root.createDiv({ cls: "hermes-chat-composer" });
    this.contextEl = composer.createDiv({ cls: "hermes-chat-context" });
    this.renderContext();

    this.inputEl = composer.createEl("textarea", { cls: "hermes-chat-input" });
    this.inputEl.rows = Platform.isMobile ? 2 : 3;
    this.inputEl.placeholder = "Ask Hermes, or describe the note to write…";
    this.inputEl.setAttr("autocomplete", "off");
    this.inputEl.setAttr("enterkeyhint", "enter");
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !Platform.isMobile) {
        event.preventDefault();
        void this.send();
      }
    });

    const actions = composer.createDiv({ cls: "hermes-chat-actions" });
    this.sendBtn = actions.createEl("button", { text: "Send", cls: "mod-cta hermes-send" });
    this.sendBtn.addEventListener("click", () => void this.send());
    this.stopBtn = actions.createEl("button", { text: "Stop", cls: "hermes-stop is-hidden" });
    this.stopBtn.addEventListener("click", () => this.cancel());

    this.renderEntries();
    this.renderStatus();
  }

  private renderContext(): void {
    if (!this.contextEl) return;
    this.contextEl.empty();
    const label = this.contextEl.createEl("label", { cls: "hermes-context-toggle" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.includeNote;
    box.addEventListener("change", () => {
      this.includeNote = box.checked;
      this.plugin.settings.includeActiveNote = box.checked;
      void this.plugin.saveSettings();
    });
    label.createEl("span", { text: "Include open note" });
    const name = this.plugin.activeNoteName();
    this.contextEl.createEl("span", { cls: "hermes-context-note", text: name || "no note open" });
  }

  private renderStatus(): void {
    if (!this.statusEl) return;
    const connection = this.plugin.settings.connection;
    const ok = !!(connection && connection.ok);
    this.statusEl.setText(ok ? this.plugin.modelLabel() : "not connected");
    this.statusEl.toggleClass("is-ok", ok);
    this.statusEl.toggleClass("is-bad", !ok);
  }

  refresh(): void {
    this.renderContext();
    this.renderStatus();
  }

  // --- messages ------------------------------------------------------------

  private renderEntries(): void {
    if (!this.listEl) return;
    this.pendingEl = null;
    this.listEl.empty();

    if (this.entries.length === 0) {
      const empty = this.listEl.createDiv({ cls: "hermes-chat-empty" });
      const connection = this.plugin.settings.connection;
      if (!connection || !connection.ok) {
        empty.createEl("p", {
          cls: "hermes-chat-empty-warning",
          text: "Not connected to Hermes yet. Open Settings → Hermes Agent Notes and press Test connection.",
        });
        const openSettings = empty.createEl("button", { text: "Open settings", cls: "mod-cta" });
        openSettings.addEventListener("click", () => this.plugin.openSettings());
      } else {
        empty.createEl("p", { text: "Connected to " + this.plugin.endpointLabel() + " as " + this.plugin.modelLabel() + "." });
      }
      empty.createEl("p", { cls: "hermes-chat-empty-hint", text: "Try one of these:" });
      const list = empty.createEl("ul", { cls: "hermes-chat-examples" });
      for (const example of EXAMPLES) {
        const item = list.createEl("li");
        const button = item.createEl("button", { text: example, cls: "hermes-example-btn" });
        button.addEventListener("click", () => {
          this.inputEl.value = example;
          this.inputEl.focus();
        });
      }
      return;
    }

    let prompt = "";
    for (const entry of this.entries) {
      if (entry.role === "user") prompt = entry.content;
      this.renderEntry(entry, prompt);
    }
    this.scrollToBottom();
  }

  private renderEntry(entry: ChatEntry, prompt = ""): void {
    const wrapper = this.listEl.createDiv({ cls: "hermes-msg hermes-msg-" + entry.role });
    const bubble = wrapper.createDiv({ cls: "hermes-bubble" });
    if (entry.role === "assistant") {
      void MarkdownRenderer.render(this.app, entry.content, bubble, "", this);
      this.addActions(wrapper, entry.content, entry.newNote === true, prompt);
    } else {
      bubble.setText(entry.content);
    }
  }

  private addActions(container: HTMLElement, text: string, newNote: boolean, hint: string): void {
    const row = container.createDiv({ cls: "hermes-msg-actions" });
    const add = (label: string, title: string, handler: () => void, primary = false) => {
      const button = row.createEl("button", {
        text: label,
        cls: primary ? "hermes-mini-btn mod-cta" : "hermes-mini-btn",
      });
      button.setAttr("title", title);
      button.addEventListener("click", handler);
    };
    if (newNote) {
      // The request was for a new note: it must never land in the open one.
      add("Create note", "Create this as a new note", () => void this.plugin.saveTextAsNote(text, hint), true);
    } else {
      add("Insert", "Insert at the cursor in the active note", () => this.plugin.insertAtCursor(text));
      add("Append", "Append to the active note", () => void this.plugin.appendToActiveNote(text));
      add("Save as note", "Save this answer as a new note", () => void this.plugin.saveTextAsNote(text, hint));
    }
    add("Copy", "Copy to the clipboard", () => copyText(text));
  }

  private scrollToBottom(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  // --- running a turn ------------------------------------------------------

  private async send(): Promise<void> {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) {
      new Notice("Type a message first.");
      return;
    }
    this.inputEl.value = "";
    this.entries.push({ role: "user", content: text });
    await this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.busy = true;
    this.setBusy(true);
    this.pendingText = "";
    const prompt = this.lastUserText();
    const newNote = looksLikeNewNoteRequest(prompt);
    this.createPending();
    if (newNote && this.pendingEl) this.pendingEl.setText("Drafting a new note…");
    try {
      const history = trimHistory(this.entries, this.plugin.settings.maxHistoryMessages);
      const answer = await this.plugin.runChat(history, {
        // runChat enforces this too; passing it here keeps the two in step.
        includeNote: this.includeNote && !newNote,
        onDelta: (_delta, full) => {
          this.pendingText = full;
          this.schedulePendingRender();
        },
        onController: (controller) => {
          this.controller = controller;
        },
      });
      this.entries.push({ role: "assistant", content: answer, newNote });
    } catch (error) {
      const message = describeError(error);
      this.entries.push({ role: "assistant", content: "⚠️ " + message });
      if (this.pendingEl) this.pendingEl.remove();
    } finally {
      this.pendingEl = null;
      this.controller = null;
      this.busy = false;
      this.setBusy(false);
      this.renderEntries();
    }
  }

  private lastUserText(): string {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].role === "user") return this.entries[index].content;
    }
    return "";
  }

  private createPending(): void {
    this.listEl.empty();
    let prompt = "";
    for (const entry of this.entries) {
      if (entry.role === "user") prompt = entry.content;
      this.renderEntry(entry, prompt);
    }
    const wrapper = this.listEl.createDiv({ cls: "hermes-msg hermes-msg-assistant hermes-msg-pending" });
    this.pendingEl = wrapper.createDiv({ cls: "hermes-bubble", text: "Thinking…" });
    this.scrollToBottom();
  }

  private schedulePendingRender(): void {
    if (this.pendingFrame) return;
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = 0;
      if (!this.pendingEl) return;
      this.pendingEl.setText(this.pendingText);
      this.scrollToBottom();
    });
  }

  private setBusy(busy: boolean): void {
    if (this.sendBtn) this.sendBtn.toggleClass("is-hidden", busy);
    if (this.stopBtn) this.stopBtn.toggleClass("is-hidden", !busy);
    if (this.inputEl) this.inputEl.toggleClass("is-busy", busy);
  }

  private cancel(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  newChat(): void {
    this.cancel();
    this.entries = [];
    this.plugin.rotateSession();
    this.renderEntries();
  }
}
