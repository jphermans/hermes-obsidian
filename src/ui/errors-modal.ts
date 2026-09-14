import { App, Modal, Notice } from "obsidian";
import type HermesAgentNotesPlugin from "../main";
import type { ErrorEntry } from "../error-log";
import { copyText } from "./clipboard";

/**
 * Shows the recorded problems. On a phone there is no console, so this is the
 * only way a user can see why something failed — and copy it into a bug report.
 */
export class ErrorsModal extends Modal {
  private plugin: HermesAgentNotesPlugin;
  private entries: ErrorEntry[] = [];

  constructor(app: App, plugin: HermesAgentNotesPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText("Recorded problems");

    const body = this.contentEl.createDiv({ cls: "hermes-notes-body" });
    body.createEl("p", { cls: "hermes-errors-path", text: this.plugin.errorLogPath() });
    const list = body.createEl("ul", { cls: "hermes-errors" });

    const buttons = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const copy = buttons.createEl("button", { text: "Copy all" });
    copy.addEventListener("click", () => {
      copyText(this.asText());
    });
    const clear = buttons.createEl("button", { text: "Clear" });
    clear.addEventListener("click", () => {
      void this.plugin.clearErrors().then(() => {
        this.entries = [];
        list.empty();
        list.createEl("li", { text: "Nothing recorded." });
        new Notice("Error log cleared.");
      });
    });
    const close = buttons.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());

    void this.load(list);
  }

  private async load(list: HTMLElement): Promise<void> {
    list.empty();
    this.entries = await this.plugin.recentErrors(60);
    if (this.entries.length === 0) {
      list.createEl("li", { text: "Nothing recorded — good sign." });
      return;
    }
    // Newest first: the failure you just had should be at the top.
    for (const entry of this.entries.slice().reverse()) {
      const item = list.createEl("li");
      item.createEl("span", { cls: "hermes-error-when", text: entry.at.slice(0, 19).replace("T", " ") });
      item.createEl("span", { cls: "hermes-error-source", text: entry.source });
      item.createEl("span", { cls: "hermes-error-message", text: entry.message });
      if (entry.detail) item.createEl("span", { cls: "hermes-error-detail", text: entry.detail });
    }
  }

  private asText(): string {
    if (this.entries.length === 0) return "No problems recorded.";
    const lines: string[] = [];
    for (const entry of this.entries.slice().reverse()) {
      lines.push(entry.at + "  [" + entry.source + "] " + entry.message + (entry.detail ? "  (" + entry.detail + ")" : ""));
    }
    return lines.join("\n");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
