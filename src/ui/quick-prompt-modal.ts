import { App, Modal, Notice } from "obsidian";
import type { QuickPrompt } from "../quick-prompts";
import { makeQuickPromptId } from "../quick-prompts";

/** Add or edit one quick prompt. */
export class QuickPromptModal extends Modal {
  private prompts: QuickPrompt[];
  private editing: QuickPrompt | null;
  private label: string;
  private prompt: string;
  private save: (prompts: QuickPrompt[]) => void;
  private settled = false;

  constructor(app: App, prompts: QuickPrompt[], editing: QuickPrompt | null, save: (prompts: QuickPrompt[]) => void) {
    super(app);
    this.prompts = prompts;
    this.editing = editing;
    this.label = editing ? editing.label : "";
    this.prompt = editing ? editing.prompt : "";
    this.save = save;
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText(this.editing ? "Edit quick prompt" : "New quick prompt");
    const body = this.contentEl.createDiv({ cls: "hermes-notes-body" });
    body.createEl("p", {
      cls: "hermes-notes-desc",
      text: "Reference notes with @[[Note name]] — they are pulled into the message like any other mention. {note} becomes the name of the open note.",
    });

    const labelField = body.createEl("input", { cls: "hermes-field", type: "text" });
    labelField.placeholder = "Label (shown on the chip)";
    labelField.value = this.label;
    labelField.addEventListener("input", () => {
      this.label = labelField.value;
    });

    const promptField = body.createEl("textarea", { cls: "hermes-field hermes-prompt-input" });
    promptField.placeholder = "The prompt itself";
    promptField.value = this.prompt;
    promptField.rows = 6;
    promptField.addEventListener("input", () => {
      this.prompt = promptField.value;
    });

    const buttons = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const ok = buttons.createEl("button", { text: this.editing ? "Save" : "Add", cls: "mod-cta" });
    ok.addEventListener("click", () => this.submit());
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    window.setTimeout(() => labelField.focus(), 20);
  }

  private submit(): void {
    const prompt = this.prompt.trim();
    if (prompt.length === 0) {
      new Notice("The prompt is empty.");
      return;
    }
    const label = this.label.trim();
    const entry: QuickPrompt = {
      id: this.editing ? this.editing.id : makeQuickPromptId(this.prompts),
      label: label.length > 0 ? label.slice(0, 60) : prompt.split("\n")[0].slice(0, 48),
      prompt,
    };
    const next = this.editing
      ? this.prompts.map((item) => (item.id === entry.id ? entry : item))
      : this.prompts.concat([entry]);
    this.settled = true;
    this.save(next);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.settled = true;
  }
}
