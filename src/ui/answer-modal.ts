import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { copyText } from "./clipboard";

export interface AnswerActions {
  insert?: () => void;
  append?: () => void;
  save?: () => void;
}

/** Shows a Hermes answer as rendered Markdown with note actions. */
export class AnswerModal extends Modal {
  private heading: string;
  private markdown: string;
  private actions: AnswerActions;
  private renderComponent: Component | null = null;

  constructor(app: App, heading: string, markdown: string, actions: AnswerActions) {
    super(app);
    this.heading = heading;
    this.markdown = markdown;
    this.actions = actions;
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText(this.heading);
    const body = this.contentEl.createDiv({ cls: "hermes-notes-body hermes-answer-body" });
    this.renderComponent = new Component();
    this.renderComponent.load();
    void MarkdownRenderer.render(this.app, this.markdown, body, "", this.renderComponent);

    const buttons = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });
    if (this.actions.insert) {
      const insert = buttons.createEl("button", { text: "Insert at cursor", cls: "mod-cta" });
      insert.addEventListener("click", () => {
        this.actions.insert?.();
        this.close();
      });
    }
    if (this.actions.append) {
      const append = buttons.createEl("button", { text: "Append to note" });
      append.addEventListener("click", () => {
        this.actions.append?.();
        this.close();
      });
    }
    if (this.actions.save) {
      const save = buttons.createEl("button", { text: "Save as note" });
      save.addEventListener("click", () => {
        this.actions.save?.();
        this.close();
      });
    }
    const copy = buttons.createEl("button", { text: "Copy" });
    copy.addEventListener("click", () => copyText(this.markdown));
    const close = buttons.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
    this.contentEl.empty();
  }
}
