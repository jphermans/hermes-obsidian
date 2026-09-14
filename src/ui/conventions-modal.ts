import { App, Component, MarkdownRenderer, Modal, Notice, Platform } from "obsidian";

/** Read-only report of what the plugin inferred about this vault. */
export class ConventionsModal extends Modal {
  private report: string;
  private rescan: () => Promise<string>;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private renderComponent: Component | null = null;

  constructor(app: App, report: string, rescan: () => Promise<string>) {
    super(app);
    this.report = report;
    this.rescan = rescan;
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText("Vault conventions detected by Hermes");
    this.bodyEl = this.contentEl.createDiv({ cls: "hermes-conventions-body" });
    this.footerEl = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });

    const rescanButton = this.footerEl.createEl("button", { text: "Rescan vault", cls: "mod-cta" });
    rescanButton.addEventListener("click", () => {
      rescanButton.setText("Scanning…");
      rescanButton.setAttr("disabled", "true");
      this.rescan()
        .then((report) => {
          this.report = report;
          this.render();
          new Notice("Vault conventions refreshed.");
        })
        .catch((error) => {
          new Notice("Rescan failed: " + (error instanceof Error ? error.message : String(error)));
        })
        .finally(() => {
          rescanButton.setText("Rescan vault");
          rescanButton.removeAttribute("disabled");
        });
    });
    this.footerEl.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());

    if (!Platform.isMobile) {
      const firstButton = this.footerEl.querySelector("button");
      if (firstButton) requestAnimationFrame(() => (firstButton as HTMLButtonElement).focus());
    }

    this.render();
  }

  private render(): void {
    this.bodyEl.empty();
    if (this.renderComponent) this.renderComponent.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    void MarkdownRenderer.render(this.app, this.report, this.bodyEl, "", this.renderComponent);
  }

  onClose(): void {
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
    this.contentEl.empty();
  }
}
