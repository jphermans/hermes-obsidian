import { App, Modal, Notice, Setting } from "obsidian";
import type HermesAgentNotesPlugin from "../main";
import { REMOTE_PRESETS } from "../remote";
import { describeError } from "../hermes-client";
import type { AccessMode } from "../types";

/**
 * The first run: three short steps instead of a wall of settings.
 *
 * It writes the same settings the setup page does — a route, a URL, a key — and ends by
 * testing the connection, so the first thing a new user sees is either a working plugin or
 * one sentence saying what is wrong.
 */
export class OnboardingModal extends Modal {
  private plugin: HermesAgentNotesPlugin;
  private mode: AccessMode;
  private step = 0;

  private url = "";
  private key = "";
  private profile = "";

  private bodyEl!: HTMLElement;
  private stepLabel!: HTMLElement;

  constructor(app: App, plugin: HermesAgentNotesPlugin) {
    super(app);
    this.plugin = plugin;
    this.mode = plugin.settings.accessMode || "local";
    this.url = plugin.settings.baseUrl;
    this.key = plugin.settings.apiKey;
    this.profile = plugin.settings.profile;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass("hermes-settings");
    contentEl.addClass("hermes-onboarding");
    titleEl.setText("Set up Hermes Agent Notes");
    this.stepLabel = contentEl.createDiv({ cls: "hermes-onboarding-step" });
    this.bodyEl = contentEl.createDiv({ cls: "hermes-onboarding-body" });
    this.render();
  }

  private render(): void {
    this.bodyEl.empty();
    this.stepLabel.setText("Step " + (this.step + 1) + " of 3");
    if (this.step === 0) this.renderRoute();
    else if (this.step === 1) this.renderConnection();
    else this.renderFinish();
  }

  /** 1 — where Hermes runs. The same presets as the setup page, short labels only. */
  private renderRoute(): void {
    this.bodyEl.createEl("p", {
      cls: "setting-item-description",
      text: "How will this device reach Hermes? Pick the closest match — the setup guide has the details for each route.",
    });
    for (const preset of REMOTE_PRESETS) {
      const row = new Setting(this.bodyEl).setName(preset.shortLabel || preset.label).setDesc(preset.summary);
      row.addButton((button) =>
        button.setButtonText(preset.id === this.mode ? "Selected" : "Use this").onClick(() => {
          this.mode = preset.id;
          // The URL follows the route when it publishes a shape; otherwise it stays as-is.
          if (preset.urlTemplate) this.url = preset.urlTemplate;
          this.render();
        })
      );
    }
    const buttons = this.bodyEl.createDiv({ cls: "hermes-notes-buttons" });
    const next = buttons.createEl("button", { text: "Next", cls: "mod-cta" });
    next.addEventListener("click", () => {
      this.step = 1;
      this.render();
    });
    const skip = buttons.createEl("button", { text: "I will do this later" });
    skip.addEventListener("click", () => void this.finish(false));
  }

  /** 2 — the address and the key, with the profile prefix where it belongs. */
  private renderConnection(): void {
    this.bodyEl.createEl("p", {
      cls: "setting-item-description",
      text: "The API server on the Hermes host. The key is API_SERVER_KEY there — and behind a /p/<profile> prefix it must be that profile's own key, at least 16 characters.",
    });
    new Setting(this.bodyEl)
      .setName("API server URL")
      .addText((text) =>
        text.setPlaceholder("http://127.0.0.1:8642").setValue(this.url).onChange((value) => {
          this.url = value.trim();
        })
      );
    new Setting(this.bodyEl)
      .setName("API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("API_SERVER_KEY").setValue(this.key).onChange((value) => {
          this.key = value.trim();
        });
      })
      .addExtraButton((button) =>
        button
          .setIcon("eye")
          .setTooltip("Show or hide the key")
          .onClick(() => {
            const input = this.bodyEl.querySelector("input[type=password], input[type=text]");
            if (input instanceof HTMLInputElement) input.type = input.type === "password" ? "text" : "password";
          })
      );
    new Setting(this.bodyEl)
      .setName("Profile prefix")
      .setDesc("Only when the gateway serves several profiles (gateway.multiplex_profiles).")
      .addText((text) => text.setPlaceholder("default").setValue(this.profile).onChange((value) => (this.profile = value.trim())));

    const buttons = this.bodyEl.createDiv({ cls: "hermes-notes-buttons" });
    const back = buttons.createEl("button", { text: "Back" });
    back.addEventListener("click", () => {
      this.step = 0;
      this.render();
    });
    const test = buttons.createEl("button", { text: "Test and finish", cls: "mod-cta" });
    test.addEventListener("click", () => void this.apply(true));
    const later = buttons.createEl("button", { text: "I will do this later" });
    later.addEventListener("click", () => void this.finish(false));
  }

  /** 3 — the outcome, in plain words. */
  private renderFinish(): void {
    const connection = this.plugin.settings.connection;
    const ok = !!(connection && connection.ok);
    this.bodyEl.createEl("h3", { text: ok ? "Connected" : "Not connected yet" });
    this.bodyEl.createEl("p", {
      cls: ok ? "setting-item-description" : "hermes-callout hermes-callout-warn",
      text: connection ? connection.detail : "No test has run yet.",
    });
    if (ok) {
      this.bodyEl.createEl("p", {
        cls: "setting-item-description",
        text: "Open the chat panel from the ribbon icon, or run a command from the palette. Every note Hermes writes is shown to you for approval first.",
      });
    } else {
      this.bodyEl.createEl("p", {
        cls: "setting-item-description",
        text: "The setup guide covers every route, the API server side and the keys. You can also reopen this wizard from the settings.",
      });
    }
    const buttons = this.bodyEl.createDiv({ cls: "hermes-notes-buttons" });
    const close = buttons.createEl("button", { text: ok ? "Start using it" : "Close", cls: "mod-cta" });
    close.addEventListener("click", () => void this.finish(true));
    if (!ok) {
      const retry = buttons.createEl("button", { text: "Back" });
      retry.addEventListener("click", () => {
        this.step = 1;
        this.render();
      });
      const guide = buttons.createEl("button", { text: "Open the setup guide" });
      guide.addEventListener("click", () => this.plugin.openSetupGuide());
    }
  }

  /** Writes what was typed, optionally tests, then shows the result. */
  private async apply(test: boolean): Promise<void> {
    this.plugin.settings.accessMode = this.mode;
    this.plugin.settings.baseUrl = this.url.trim();
    this.plugin.settings.apiKey = this.key.trim();
    this.plugin.settings.profile = this.profile.trim();
    this.plugin.settings.connection = null;
    await this.plugin.saveSettings();
    if (!test) {
      await this.finish(true);
      return;
    }
    const state = await this.plugin.testConnection();
    new Notice(state.ok ? "Hermes is reachable: " + state.detail : "Hermes could not be reached: " + state.detail, state.ok ? 6000 : 12000);
    if (!state.ok) await this.plugin.logError("Setup wizard", state.detail, this.plugin.endpointLabel());
    this.step = 2;
    this.render();
  }

  /**
   * Marked done on every close, including "I will do this later": the wizard must not nag on
   * every start. The command in the palette reopens it whenever it is wanted.
   */
  private async finish(_done: boolean): Promise<void> {
    this.plugin.settings.onboardingDone = true;
    await this.plugin.saveSettings();
    this.close();
  }
}

/** Never let a failed wizard be silent. */
export function describeWizardError(error: unknown): string {
  return describeError(error);
}
