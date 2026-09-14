/**
 * A small keyboard-driven picker that sits above the chat input: it serves both
 * `@` note mentions and `/` commands. Plain DOM on purpose — the chat view has no
 * framework, and the list has to feel native on a phone.
 */

export interface SuggestItem {
  id: string;
  label: string;
  detail?: string;
}

export class SuggestDropdown {
  private el: HTMLElement;
  private items: SuggestItem[] = [];
  private onPick: ((id: string) => void) | null = null;
  private selected = 0;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: "hermes-suggest is-hidden" });
    this.el.setAttr("role", "listbox");
  }

  get isOpen(): boolean {
    return !this.el.hasClass("is-hidden");
  }

  get count(): number {
    return this.items.length;
  }

  show(items: SuggestItem[], onPick: (id: string) => void): void {
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.items = items;
    this.onPick = onPick;
    this.selected = 0;
    this.render();
    this.el.removeClass("is-hidden");
  }

  hide(): void {
    this.items = [];
    this.onPick = null;
    this.el.addClass("is-hidden");
    this.el.empty();
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.render();
  }

  /** Acts on the highlighted row; returns false when there is nothing to pick. */
  pick(): boolean {
    const item = this.items[this.selected];
    const handler = this.onPick;
    if (!item || !handler) return false;
    this.hide();
    handler(item.id);
    return true;
  }

  private render(): void {
    this.el.empty();
    this.items.forEach((item, index) => {
      const button = this.el.createEl("button", {
        cls: index === this.selected ? "hermes-suggest-item is-selected" : "hermes-suggest-item",
      });
      button.setAttr("type", "button");
      button.createSpan({ cls: "hermes-suggest-label", text: item.label });
      if (item.detail) button.createSpan({ cls: "hermes-suggest-detail", text: item.detail });
      button.addEventListener("click", () => {
        this.selected = index;
        this.pick();
      });
    });
  }
}
