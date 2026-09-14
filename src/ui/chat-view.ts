import { ItemView, MarkdownRenderer, Notice, Platform, WorkspaceLeaf } from "obsidian";
import type HermesAgentNotesPlugin from "../main";
import { describeError } from "../hermes-client";
import { trimHistory } from "../prompts";
import { looksLikeNewNoteRequest } from "../intent";
import {
  completeMention,
  detectMention,
  extractMentionedTitles,
  stripMentionSyntax,
  suggestNotes,
} from "../mentions";
import type { MentionContext } from "../mentions";
import type { TransportInfo } from "../main";
import { filterCommands, isCommandInput, runCommand, SLASH_COMMANDS } from "../slash";
import type { SlashAction } from "../slash";
import { looksLikeFileOpRequest } from "../file-ops";
import { SuggestDropdown } from "./suggest-dropdown";
import { copyText } from "./clipboard";

export const VIEW_TYPE_HERMES_CHAT = "hermes-agent-chat";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  /** This answer came from a request for a new note. */
  newNote?: boolean;
  /** Informational entry (help): no Insert/Append/Save row. */
  noActions?: boolean;
  /** How this answer travelled back. */
  transport?: TransportInfo;
}

const EXAMPLES = [
  "Create a note about today's meeting with the supplier",
  "Summarise this note and rewrite it in our house style",
  "Fix the Obsidian formatting of this note",
  "What links should this note have?",
];

/** One short line saying how the answer actually arrived. */
export function transportLabel(info: TransportInfo): string {
  if (info.streamed && info.buffered) return "one piece — something is buffering the stream";
  if (info.streamed) return "streamed live";
  if (info.fellBack) return "streaming refused — delivered whole";
  return "delivered whole (streaming is off)";
}

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
  private pendingTextEl: HTMLElement | null = null;
  private pendingSpinnerEl: HTMLElement | null = null;
  private pendingText = "";
  private pendingFrame = 0;
  private suggest: SuggestDropdown | null = null;
  private mention: MentionContext | null = null;

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
    this.suggest = new SuggestDropdown(composer);
    this.contextEl = composer.createDiv({ cls: "hermes-chat-context" });
    this.renderContext();

    this.inputEl = composer.createEl("textarea", { cls: "hermes-chat-input" });
    this.inputEl.rows = Platform.isMobile ? 2 : 3;
    this.inputEl.placeholder = "Ask Hermes, or describe the note to write…  (@ note · / command)";
    this.inputEl.setAttr("autocomplete", "off");
    this.inputEl.setAttr("enterkeyhint", "enter");
    this.inputEl.addEventListener("input", () => this.updateSuggestions());
    this.inputEl.addEventListener("keyup", (event: KeyboardEvent) => {
      if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        this.updateSuggestions();
      }
    });
    this.inputEl.addEventListener("blur", () => {
      // A click on a suggestion blurs the input first; give it time to land.
      window.setTimeout(() => {
        if (document.activeElement !== this.inputEl) this.suggest?.hide();
      }, 180);
    });
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (this.suggest && this.suggest.isOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.suggest.move(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          this.suggest.move(-1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.suggest.hide();
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          this.suggest.pick();
          return;
        }
      }
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
        if (!this.plugin.settings.streaming) {
          empty.createEl("p", {
            cls: "hermes-chat-empty-hint",
            text: "Streaming is off, so answers arrive in one piece. Turn it on in the settings and press Verify streaming to see what your server allows.",
          });
        }
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
      if (entry.transport) {
        const label = transportLabel(entry.transport);
        if (label) wrapper.createDiv({ cls: "hermes-transport", text: label });
      }
      if (entry.noActions !== true) this.addActions(wrapper, entry.content, entry.newNote === true, prompt);
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
    const typed = this.inputEl.value.trim();
    if (!typed) {
      new Notice("Type a message first.");
      return;
    }
    const command = runCommand(typed);
    if (command && command.kind === "action") {
      this.inputEl.value = "";
      this.suggest?.hide();
      this.runAction(command.action);
      return;
    }
    if (command && command.kind === "unknown") {
      new Notice("No such command: /" + command.name + ". Try /help.");
      return;
    }
    // A command expands into a message; @[[…]] becomes a plain wikilink.
    const outgoing = command && command.kind === "message" ? command.text : stripMentionSyntax(typed);
    this.inputEl.value = "";
    this.suggest?.hide();
    this.entries.push({ role: "user", content: typed });
    // "move the boiler note into Archive" is a file operation, not a question.
    if (this.plugin.settings.allowFileOps && looksLikeFileOpRequest(outgoing)) {
      await this.runFileOps(typed);
      return;
    }
    await this.runTurn(outgoing, typed);
  }

  /** Plans copy / move / delete, asks for approval, and reports what happened. */
  private async runFileOps(request: string): Promise<void> {
    this.busy = true;
    this.setBusy(true);
    this.pendingText = "";
    this.createPending();
    this.setPendingLabel("Planning file operations");
    try {
      const summary = await this.plugin.runFileOpRequest(request, "File operations");
      this.entries.push({ role: "assistant", content: summary, noActions: true });
    } catch (error) {
      this.entries.push({ role: "assistant", content: "⚠️ " + describeError(error) });
      if (this.pendingEl) this.pendingEl.remove();
    } finally {
      this.pendingEl = null;
      this.pendingTextEl = null;
      this.pendingSpinnerEl = null;
      this.controller = null;
      this.busy = false;
      this.setBusy(false);
      this.renderEntries();
    }
  }

  private async runTurn(outgoing: string, typed: string): Promise<void> {
    this.busy = true;
    this.setBusy(true);
    this.pendingText = "";
    const newNote = looksLikeNewNoteRequest(outgoing);
    const mentionTitles = extractMentionedTitles(typed);
    this.createPending();
    if (newNote) this.setPendingLabel("Drafting a new note");
    let transport: TransportInfo | undefined;
    try {
      const history = trimHistory(this.entries, this.plugin.settings.maxHistoryMessages);
      // The bubble is not always what goes out: a command has been expanded and
      // mention syntax has been stripped, so the last user turn is replaced.
      for (let index = history.length - 1; index >= 0; index--) {
        if (history[index].role === "user") {
          history[index] = { role: "user", content: outgoing };
          break;
        }
      }
      const answer = await this.plugin.runChat(history, {
        // runChat enforces this too; passing it here keeps the two in step.
        includeNote: this.includeNote && !newNote,
        mentionTitles,
        onTransport: (info) => {
          transport = info;
        },
        onDelta: (_delta, full) => {
          this.pendingText = full;
          this.schedulePendingRender();
        },
        onController: (controller) => {
          this.controller = controller;
        },
      });
      this.entries.push({ role: "assistant", content: answer, newNote, transport });
    } catch (error) {
      const message = describeError(error);
      this.entries.push({ role: "assistant", content: "⚠️ " + message });
      if (this.pendingEl) this.pendingEl.remove();
    } finally {
      this.pendingEl = null;
      this.pendingTextEl = null;
      this.pendingSpinnerEl = null;
      this.controller = null;
      this.busy = false;
      this.setBusy(false);
      this.renderEntries();
    }
  }

  /** Offers notes for an @-mention, or commands for a /-command. */
  private updateSuggestions(): void {
    if (!this.suggest) return;
    const text = this.inputEl.value;
    const caret = this.inputEl.selectionStart === null ? text.length : this.inputEl.selectionStart;

    const mention = detectMention(text, caret);
    if (mention) {
      this.mention = mention;
      const notes = suggestNotes(this.plugin.app.vault.getMarkdownFiles(), mention.query, 8);
      this.suggest.show(
        notes.map((file) => ({ id: file.path, label: file.basename, detail: file.path })),
        (id) => this.pickMention(id)
      );
      return;
    }
    this.mention = null;

    if (isCommandInput(text)) {
      this.suggest.show(
        filterCommands(text).map((command) => ({
          id: command.name,
          label: command.usage,
          detail: command.description,
        })),
        (id) => this.pickCommand(id)
      );
      return;
    }
    this.suggest.hide();
  }

  private pickMention(path: string): void {
    const mention = this.mention;
    const file = this.plugin.app.vault.getMarkdownFiles().find((entry) => entry.path === path);
    if (!mention || !file) return;
    const next = completeMention(this.inputEl.value, mention, file.basename);
    this.inputEl.value = next.text;
    this.inputEl.selectionStart = next.cursor;
    this.inputEl.selectionEnd = next.cursor;
    this.mention = null;
    this.inputEl.focus();
  }

  private pickCommand(name: string): void {
    const command = SLASH_COMMANDS.find((entry) => entry.name === name);
    if (!command) return;
    if (command.kind === "action" && command.action) {
      this.inputEl.value = "";
      this.runAction(command.action);
      return;
    }
    const filled = "/" + command.name + " ";
    this.inputEl.value = filled;
    this.inputEl.selectionStart = filled.length;
    this.inputEl.selectionEnd = filled.length;
    this.inputEl.focus();
  }

  private runAction(action: SlashAction): void {
    if (action === "clear") {
      this.newChat();
      new Notice("New conversation.");
      return;
    }
    if (action === "conventions") {
      void this.plugin.showConventions();
      return;
    }
    if (action === "settings") {
      this.plugin.openSettings();
      return;
    }
    if (action === "context") {
      this.includeNote = !this.includeNote;
      this.plugin.settings.includeActiveNote = this.includeNote;
      void this.plugin.saveSettings();
      this.renderContext();
      new Notice(
        this.includeNote ? "The open note is sent as context." : "The open note is no longer sent as context."
      );
      return;
    }
    if (action === "help") this.showHelp();
  }

  private showHelp(): void {
    const lines = [
      "**Hermes chat commands**",
      "",
      "Type `@` to pull a note into the conversation, or `/` for these:",
      "",
    ];
    for (const command of SLASH_COMMANDS) lines.push("- `" + command.usage + "` — " + command.description);
    lines.push("", "Enter sends, Shift+Enter adds a line, the Stop button cancels a running answer.");
    this.entries.push({ role: "assistant", content: lines.join("\n"), noActions: true });
    this.renderEntries();
  }

  private createPending(): void {
    this.listEl.empty();
    let prompt = "";
    for (const entry of this.entries) {
      if (entry.role === "user") prompt = entry.content;
      this.renderEntry(entry, prompt);
    }
    const wrapper = this.listEl.createDiv({ cls: "hermes-msg hermes-msg-assistant hermes-msg-pending" });
    this.pendingEl = wrapper.createDiv({ cls: "hermes-bubble hermes-bubble-pending" });
    this.pendingTextEl = this.pendingEl.createSpan({ cls: "hermes-pending-text" });
    // An animated indicator instead of the word "Thinking…": it keeps pulsing
    // while the answer streams in, so "still working" stays visible.
    const spinner = this.pendingEl.createDiv({ cls: "hermes-spinner" });
    spinner.setAttr("role", "status");
    spinner.setAttr("aria-label", "Hermes is working");
    spinner.setAttr("title", "Hermes is working");
    spinner.createSpan();
    spinner.createSpan();
    spinner.createSpan();
    this.pendingSpinnerEl = spinner;
    this.scrollToBottom();
  }

  /** The indicator carries its label for screen readers and as a tooltip. */
  private setPendingLabel(label: string): void {
    if (!this.pendingSpinnerEl) return;
    this.pendingSpinnerEl.setAttr("aria-label", label);
    this.pendingSpinnerEl.setAttr("title", label);
  }

  private schedulePendingRender(): void {
    if (this.pendingFrame) return;
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = 0;
      if (!this.pendingTextEl) return;
      this.pendingTextEl.setText(this.pendingText);
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
    if (this.inputEl) this.inputEl.value = "";
    this.suggest?.hide();
    this.renderEntries();
  }
}
