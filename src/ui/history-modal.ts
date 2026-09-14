import { App, Modal, Notice } from "obsidian";
import type { HistoryEntry, HistorySession } from "../history";
import { describeSession, searchSessions } from "../history";

export interface HistoryHost {
  listHistory(): Promise<HistorySession[]>;
  deleteHistorySession(id: string): Promise<void>;
  clearHistory(): Promise<void>;
}

/** Browse, search and restore earlier conversations. */
export class HistoryModal extends Modal {
  private host: HistoryHost;
  private restore: (entries: HistoryEntry[], id: string) => void;
  private sessions: HistorySession[] = [];
  private query = "";
  private listEl!: HTMLElement;

  constructor(app: App, host: HistoryHost, restore: (entries: HistoryEntry[], id: string) => void) {
    super(app);
    this.host = host;
    this.restore = restore;
  }

  onOpen(): void {
    this.contentEl.addClass("hermes-notes-modal");
    this.titleEl.setText("Chat history");

    const body = this.contentEl.createDiv({ cls: "hermes-notes-body" });
    const search = body.createEl("input", { cls: "hermes-field", type: "search" });
    search.placeholder = "Search conversations";
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.listEl = body.createDiv({ cls: "hermes-history" });

    const buttons = this.contentEl.createDiv({ cls: "hermes-notes-buttons" });
    const clear = buttons.createEl("button", { text: "Clear everything" });
    clear.addEventListener("click", () => {
      void this.host.clearHistory().then(() => {
        this.sessions = [];
        this.renderList();
        new Notice("Chat history cleared.");
      });
    });
    const close = buttons.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());

    void this.load();
  }

  private async load(): Promise<void> {
    this.sessions = await this.host.listHistory();
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    const shown = searchSessions(this.sessions, this.query);
    if (shown.length === 0) {
      this.listEl.createDiv({
        cls: "hermes-notes-desc",
        text: this.sessions.length === 0 ? "No conversations stored yet." : "Nothing matches that search.",
      });
      return;
    }
    const now = Date.now();
    for (const session of shown) {
      const row = this.listEl.createDiv({ cls: "hermes-history-row" });
      const main = row.createDiv({ cls: "hermes-history-main" });
      main.createEl("span", { cls: "hermes-history-title", text: session.title });
      main.createEl("span", { cls: "hermes-history-meta", text: describeSession(session, now) });

      const open = row.createEl("button", { cls: "hermes-history-open", text: "Restore" });
      open.addEventListener("click", () => {
        this.restore(session.entries, session.id);
        this.close();
      });
      const remove = row.createEl("button", { cls: "hermes-history-delete", text: "Delete" });
      remove.addEventListener("click", () => {
        void this.host.deleteHistorySession(session.id).then(() => {
          this.sessions = this.sessions.filter((entry) => entry.id !== session.id);
          this.renderList();
        });
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
