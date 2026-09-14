import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Picks a JSON file from the vault (used to restore settings). */
export class JsonFileSuggestModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private pick: (file: TFile) => void;

  constructor(app: App, files: TFile[], pick: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.pick = pick;
    this.setPlaceholder("Pick a settings JSON file…");
    this.emptyStateText = "No JSON files in this vault.";
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.pick(file);
  }
}
