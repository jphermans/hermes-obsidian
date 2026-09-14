import { App, Component, MarkdownRenderer, Modal, Notice, Platform, Setting } from "obsidian";
import { copyText } from "./clipboard";
import { sanitizeFilename } from "../note-writer";
import { validateNote } from "../validate";
import type { NoteCheck } from "../validate";
import { diffForDisplay, diffLines, summarizeDiff } from "../diff";
import type { VaultConventions } from "../types";

export interface PreviewModalOptions {
  heading: string;
  notePath: string;
  content: string;
  folders: string[];
  mode: "create" | "overwrite" | "append";
  conventions: VaultConventions | null;
  openAfter: boolean;
  note?: string;
  /** The note as it is on disk: turns this into a review with a diff. */
  before?: string;
}

export interface PreviewModalResult {
  action: "create" | "overwrite" | "append" | "cancel";
  path: string;
  content: string;
  openAfter: boolean;
}

function splitPath(path: string): { folder: string; name: string } {
  const clean = (path || "").replace(/\.md$/i, "");
  const slash = clean.lastIndexOf("/");
  if (slash < 0) return { folder: "", name: clean };
  return { folder: clean.slice(0, slash), name: clean.slice(slash + 1) };
}

export class PreviewModal extends Modal {
  private options: PreviewModalOptions;
  private settle: ((result: PreviewModalResult | null) => void) | null = null;
  private folder: string;
  private name: string;
  private content: string;
  private openAfter: boolean;
  private settled = false;

  private nameInput!: HTMLInputElement;
  private checkEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private pathHint!: HTMLElement;
  private view: "changes" | "preview" | "raw" = "preview";
  private tabs: { key: "changes" | "preview" | "raw"; button: HTMLButtonElement }[] = [];
  private renderComponent: Component | null = null;

  /** A before/after review rather than a plain preview. */
  private reviewing(): boolean {
    return this.options.before !== undefined && this.options.mode === "overwrite";
  }

  constructor(app: App, options: PreviewModalOptions) {
    super(app);
    this.options = options;
    const parts = splitPath(options.notePath);
    this.folder = parts.folder;
    this.name = parts.name;
    this.content = options.content;
    this.openAfter = options.openAfter;
  }

  static ask(app: App, options: PreviewModalOptions): Promise<PreviewModalResult | null> {
    return new Promise((resolve) => {
      const modal = new PreviewModal(app, options);
      modal.settle = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("hermes-notes-modal");
    contentEl.addClass("hermes-preview-modal");
    this.titleEl.setText(this.options.heading);
    if (this.options.note) {
      contentEl.createEl("p", { cls: "hermes-notes-desc", text: this.options.note });
    }

    new Setting(contentEl)
      .setName("Folder")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Vault root");
        const folders = this.options.folders.slice();
        if (this.folder && folders.indexOf(this.folder) < 0) folders.unshift(this.folder);
        for (const folder of folders) dropdown.addOption(folder, folder);
        dropdown.setValue(this.folder);
        dropdown.onChange((value) => {
          this.folder = value;
          this.updatePathHint();
        });
      });

    new Setting(contentEl)
      .setName("File name")
      .setDesc("Obsidian removes characters it cannot store: / \\ : * ? \" < > | # ^ [ ]")
      .addText((text) => {
        this.nameInput = text.inputEl;
        text.setValue(this.name).onChange((value) => {
          this.name = value;
          this.updatePathHint();
        });
      });

    this.pathHint = contentEl.createEl("p", { cls: "hermes-notes-path" });

    const checkRow = contentEl.createDiv({ cls: "hermes-notes-checks" });
    this.checkEl = checkRow;

    const tabRow = contentEl.createDiv({ cls: "hermes-notes-tabs" });
    const addTab = (key: "changes" | "preview" | "raw", label: string) => {
      const button = tabRow.createEl("button", { text: label, cls: "hermes-tab" });
      button.addEventListener("click", () => {
        this.view = key;
        this.updateTabs();
        this.renderBody();
      });
      this.tabs.push({ key, button });
    };
    if (this.reviewing()) addTab("changes", "Changes");
    addTab("preview", "Preview");
    addTab("raw", "Markdown");
    this.view = this.reviewing() ? "changes" : "preview";
    this.updateTabs();
    this.bodyEl = contentEl.createDiv({ cls: "hermes-notes-body" });

    if (this.options.mode !== "append") {
      new Setting(contentEl)
        .setName("Open the note after saving")
        .addToggle((toggle) =>
          toggle.setValue(this.openAfter).onChange((value) => {
            this.openAfter = value;
          })
        );
    }

    const buttons = contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const reviewing = this.reviewing();
    const primary = buttons.createEl("button", {
      text: reviewing
        ? "Approve & save"
        : this.options.mode === "create"
          ? "Create note"
          : this.options.mode === "append"
            ? "Append"
            : "Replace note",
      cls: "mod-cta",
    });
    primary.addEventListener("click", () => this.submit());
    if (reviewing) {
      const reject = buttons.createEl("button", { text: "Reject" });
      reject.addEventListener("click", () => this.close());
    }
    const copy = buttons.createEl("button", { text: "Copy Markdown" });
    copy.addEventListener("click", () => {
      this.copyMarkdown();
    });
    if (!reviewing) {
      const cancel = buttons.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.close());
    }

    // Approve without reaching for the mouse.
    contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit();
      }
    });

    this.renderBody();
    this.updatePathHint();
    this.updateChecks();

    if (!Platform.isMobile) {
      requestAnimationFrame(() => this.nameInput.focus());
    }
  }

  private currentName(): string {
    return sanitizeFilename(this.name, "Untitled note");
  }

  private currentPath(): string {
    const folder = this.folder.replace(/^[/]+/, "").replace(/[/]+$/, "");
    return (folder ? folder + "/" : "") + this.currentName() + ".md";
  }

  private updatePathHint(): void {
    const folder = this.folder.replace(/^[/]+/, "").replace(/[/]+$/, "");
    this.pathHint.setText("Saves to " + (folder ? folder + "/" : "") + this.currentName() + ".md");
  }

  private updateChecks(): void {
    const check: NoteCheck = validateNote(this.content, this.currentName(), this.options.conventions);
    this.checkEl.empty();
    const pills = this.checkEl.createDiv({ cls: "hermes-pills" });
    const addPill = (text: string, cls: string) => pills.createEl("span", { cls: "hermes-pill " + cls, text });
    addPill(check.stats.words + " words", "");
    addPill(check.stats.properties + " properties", "");
    addPill(check.stats.wikiLinks + " wikilinks", "");
    if (check.stats.embeds > 0) addPill(check.stats.embeds + " embeds", "");
    if (check.stats.tags > 0) addPill(check.stats.tags + " tags", "");
    if (check.stats.headings > 0) addPill(check.stats.headings + " headings", "");
    if (check.stats.callouts > 0) addPill(check.stats.callouts + " callouts", "");

    const list = this.checkEl.createDiv({ cls: "hermes-issue-list" });
    const warnings = check.issues.filter((issue) => issue.level !== "ok");
    const oks = check.issues.filter((issue) => issue.level === "ok");
    for (const issue of warnings.concat(oks.slice(0, 3))) {
      const icon = issue.level === "warn" ? "⚠️" : issue.level === "info" ? "ℹ️" : "✅";
      const row = list.createDiv({ cls: "hermes-issue hermes-issue-" + issue.level });
      row.createEl("span", { cls: "hermes-issue-icon", text: icon });
      row.createEl("span", { text: issue.message });
    }
  }

  private updateTabs(): void {
    for (const tab of this.tabs) {
      tab.button.toggleClass("is-active", tab.key === this.view);
    }
  }

  private renderBody(): void {
    const scroll = this.bodyEl.scrollTop;
    this.bodyEl.empty();
    this.bodyEl.toggleClass("is-raw", this.view === "raw");

    if (this.view === "changes") {
      this.renderChanges();
      this.bodyEl.scrollTop = 0;
      return;
    }

    if (this.view === "raw") {
      const textarea = this.bodyEl.createEl("textarea", { cls: "hermes-notes-raw" });
      textarea.value = this.content;
      textarea.rows = 18;
      textarea.setAttr("spellcheck", "false");
      textarea.addEventListener("input", () => {
        this.content = textarea.value;
        this.updateChecks();
      });
      this.bodyEl.scrollTop = scroll;
      return;
    }
    const target = this.bodyEl.createDiv({ cls: "markdown-preview-view hermes-preview-render" });
    if (this.renderComponent) this.renderComponent.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    void MarkdownRenderer.render(this.app, this.content, target, "", this.renderComponent);
    this.bodyEl.scrollTop = scroll;
  }

  /** The note as it is, as it would be, and what changed in between. */
  private renderChanges(): void {
    const before = this.options.before || "";
    const diff = diffLines(before, this.content);
    this.bodyEl.createDiv({ cls: "hermes-diff-summary", text: summarizeDiff(diff) });
    if (diff.coarse) return;
    if (diff.added === 0 && diff.removed === 0) {
      this.bodyEl.createDiv({ cls: "hermes-diff-empty", text: "This is exactly what is already on disk." });
      return;
    }
    const block = this.bodyEl.createDiv({ cls: "hermes-diff" });
    for (const line of diffForDisplay(diff)) {
      const row = block.createDiv({ cls: "hermes-diff-line is-" + line.type });
      row.createEl("span", {
        cls: "hermes-diff-sign",
        text: line.type === "add" ? "+" : line.type === "remove" ? "−" : " ",
      });
      row.createEl("span", { cls: "hermes-diff-text", text: line.text.length > 0 ? line.text : " " });
    }
  }

  private copyMarkdown(): void {
    copyText(this.content, "Markdown copied.");
  }

  private submit(): void {
    const content = this.content.trim();
    if (!content) {
      new Notice("The note is empty.");
      return;
    }
    this.settled = true;
    const result: PreviewModalResult = {
      action: this.options.mode,
      path: this.currentPath(),
      content: content + "\n",
      openAfter: this.openAfter,
    };
    const settle = this.settle;
    this.settle = null;
    this.close();
    if (settle) settle(result);
  }

  onClose(): void {
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
    this.contentEl.empty();
    const settle = this.settle;
    this.settle = null;
    if (!this.settled && settle) settle(null);
  }
}
