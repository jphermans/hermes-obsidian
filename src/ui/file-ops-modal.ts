import { App, Modal } from "obsidian";
import type { ValidatedOp } from "../file-ops";

export interface FileOpsChoice {
  /** The operations the user kept ticked. */
  ops: ValidatedOp[];
  permanentDelete: boolean;
}

/**
 * The approval step for copy / move / delete. Nothing reaches the vault before
 * this modal is accepted, every path is shown, and anything the validator refused
 * is displayed with its reason instead of being hidden.
 */
export class FileOpsModal extends Modal {
  private heading: string;
  private note: string;
  private ops: ValidatedOp[];
  private allowPermanent: boolean;
  private startPermanent = false;
  private resolve: ((choice: FileOpsChoice | null) => void) | null = null;
  private settled = false;
  private selected: boolean[] = [];
  private permanent = false;

  constructor(
    app: App,
    options: { heading: string; note: string; ops: ValidatedOp[]; allowPermanent: boolean; startPermanent?: boolean }
  ) {
    super(app);
    this.heading = options.heading;
    this.note = options.note;
    this.ops = options.ops;
    this.allowPermanent = options.allowPermanent;
    this.startPermanent = options.startPermanent === true;
    this.permanent = this.startPermanent;
    this.selected = options.ops.map((op) => !op.skip);
  }

  /** Resolves with the approved operations, or null when cancelled. */
  static ask(
    app: App,
    options: { heading: string; note: string; ops: ValidatedOp[]; allowPermanent: boolean; startPermanent?: boolean }
  ): Promise<FileOpsChoice | null> {
    const modal = new FileOpsModal(app, options);
    return new Promise((resolve) => {
      modal.resolve = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText(this.heading);
    const body = this.contentEl.createDiv({ cls: "hermes-notes-body" });
    if (this.note) body.createEl("p", { cls: "hermes-fileops-note", text: this.note });

    const list = body.createEl("ul", { cls: "hermes-fileops" });
    this.ops.forEach((op, index) => {
      const item = list.createEl("li", { cls: op.skip ? "hermes-fileops-item is-skipped" : "hermes-fileops-item" });
      const label = item.createEl("label", { cls: "hermes-fileops-label" });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.selected[index];
      box.disabled = !!op.skip;
      box.addEventListener("change", () => {
        this.selected[index] = box.checked;
      });
      label.createEl("span", { text: op.label });
      if (op.skip) item.createEl("span", { cls: "hermes-fileops-skip", text: "skipped — " + op.skip });
    });

    if (this.ops.some((op) => op.op === "delete" && !op.skip)) {
      const mode = body.createDiv({ cls: "hermes-fileops-mode" });
      mode.createEl("span", { cls: "hermes-fileops-legend", text: "Deleting:" });
      const trash = mode.createEl("label", { cls: "hermes-fileops-radio" });
      const trashBox = trash.createEl("input", { type: "radio" });
      trashBox.checked = !this.startPermanent;
      trashBox.addEventListener("change", () => {
        this.permanent = false;
      });
      trash.createEl("span", { text: "Move to trash (recoverable)" });
      if (this.allowPermanent) {
        const permanent = mode.createEl("label", { cls: "hermes-fileops-radio" });
        const permanentBox = permanent.createEl("input", { type: "radio" });
        permanentBox.checked = this.startPermanent;
        permanentBox.addEventListener("change", () => {
          this.permanent = true;
        });
        permanent.createEl("span", { text: "Delete permanently" });
      }
    }

    const buttons = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const apply = buttons.createEl("button", { text: "Apply", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      const kept = this.ops.filter((op, index) => this.selected[index] && !op.skip);
      this.finish(kept.length > 0 ? { ops: kept, permanentDelete: this.permanent } : null);
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.finish(null);
      this.close();
    });
  }

  private finish(choice: FileOpsChoice | null): void {
    if (this.settled) return;
    this.settled = true;
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve) resolve(choice);
  }

  onClose(): void {
    // Closing with the X or Escape counts as cancel.
    this.finish(null);
    this.contentEl.empty();
  }
}
