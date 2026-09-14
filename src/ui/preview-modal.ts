import { App, Component, MarkdownRenderer, Modal, Notice, Platform, Setting } from "obsidian";
import { copyText } from "./clipboard";
import { sanitizeFilename } from "../note-writer";
import { validateNote } from "../validate";
import type { NoteCheck } from "../validate";
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
  private rawMode = false;
  private renderComponent: Component | null = null;

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
    const previewTab = tabRow.createEl("button", { text: "Preview", cls: "hermes-tab is-active" });
    const rawTab = tabRow.createEl("button", { text: "Markdown", cls: "hermes-tab" });
    this.bodyEl = contentEl.createDiv({ cls: "hermes-notes-body" });

    previewTab.addEventListener("click", () => {
      this.rawMode = false;
      previewTab.addClass("is-active");
      rawTab.removeClass("is-active");
      this.renderBody();
    });
    rawTab.addEventListener("click", () => {
      this.rawMode = true;
      rawTab.addClass("is-active");
      previewTab.removeClass("is-active");
      this.renderBody();
    });

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
    const primary = buttons.createEl("button", {
      text: this.options.mode === "create" ? "Create note" : this.options.mode === "append" ? "Append" : "Replace note",
      cls: "mod-cta",
    });
    primary.addEventListener("click", () => this.submit());
    const copy = buttons.createEl("button", { text: "Copy Markdown" });
    copy.addEventListener("click", () => {
      this.copyMarkdown();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

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

  private renderBody(): void {
    const scroll = this.bodyEl.scrollTop;
    this.bodyEl.empty();
    this.bodyEl.toggleClass("is-raw", this.rawMode);
    if (this.rawMode) {
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
