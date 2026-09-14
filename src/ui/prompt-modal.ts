import { App, Modal, Notice, Platform, Setting } from "obsidian";

export interface PromptModalOptions {
  title: string;
  description?: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel: string;
  folders?: string[];
  initialFolder?: string;
  showFolder?: boolean;
  showIncludeNote?: boolean;
  includeNote?: boolean;
  activeNoteName?: string;
  rows?: number;
}

export interface PromptModalResult {
  prompt: string;
  folder: string;
  includeNote: boolean;
}

export class PromptModal extends Modal {
  private options: PromptModalOptions;
  private settle: ((result: PromptModalResult | null) => void) | null = null;
  private textarea!: HTMLTextAreaElement;
  private folder: string;
  private includeNote: boolean;
  private settled = false;

  constructor(app: App, options: PromptModalOptions) {
    super(app);
    this.options = options;
    this.folder = options.initialFolder || "";
    this.includeNote = options.includeNote !== false;
  }

  static ask(app: App, options: PromptModalOptions): Promise<PromptModalResult | null> {
    return new Promise((resolve) => {
      const modal = new PromptModal(app, options);
      modal.settle = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl, options } = this;
    contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText(options.title);
    if (options.description) {
      contentEl.createEl("p", { cls: "hermes-notes-desc", text: options.description });
    }

    this.textarea = contentEl.createEl("textarea", { cls: "hermes-notes-textarea" });
    this.textarea.rows = options.rows || 7;
    this.textarea.placeholder = options.placeholder || "";
    this.textarea.value = options.initialValue || "";
    this.textarea.setAttr("autocomplete", "off");
    this.textarea.setAttr("autocapitalize", "sentences");
    this.textarea.setAttr("spellcheck", "true");
    if (Platform.isMobile) this.textarea.setAttr("enterkeyhint", "enter");
    this.textarea.addEventListener("input", () => {
      this.textarea.style.height = "auto";
      this.textarea.style.height = Math.min(360, Math.max(120, this.textarea.scrollHeight)) + "px";
    });

    if (options.showFolder && options.folders && options.folders.length > 0) {
      new Setting(contentEl).setName("Folder").addDropdown((dropdown) => {
        dropdown.addOption("", "Vault root");
        for (const folder of options.folders || []) dropdown.addOption(folder, folder);
        dropdown.setValue(this.folder);
        dropdown.onChange((value) => {
          this.folder = value;
        });
      });
    }

    if (options.showIncludeNote) {
      new Setting(contentEl)
        .setName("Include the open note as context")
        .setDesc(options.activeNoteName ? "Currently: " + options.activeNoteName : "No note is open right now.")
        .addToggle((toggle) =>
          toggle.setValue(this.includeNote).onChange((value) => {
            this.includeNote = value;
          })
        );
    }

    const buttons = contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const submit = buttons.createEl("button", { text: options.submitLabel, cls: "mod-cta" });
    submit.addEventListener("click", () => this.submit());
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    contentEl.createEl("p", {
      cls: "hermes-notes-hint",
      text: Platform.isMobile ? "Hermes writes the note into this vault — no vault access needed on the Hermes host." : "Ctrl/Cmd + Enter to send · Esc to cancel.",
    });

    this.textarea.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit();
      }
    });

    if (!Platform.isMobile) {
      requestAnimationFrame(() => this.textarea.focus());
    }
  }

  private submit(): void {
    const prompt = this.textarea.value.trim();
    if (!prompt) {
      new Notice("Enter a request first.");
      return;
    }
    this.settled = true;
    const result: PromptModalResult = { prompt, folder: this.folder, includeNote: this.includeNote };
    const settle = this.settle;
    this.settle = null;
    this.close();
    if (settle) settle(result);
  }

  onClose(): void {
    this.contentEl.empty();
    const settle = this.settle;
    this.settle = null;
    if (!this.settled && settle) settle(null);
  }
}
