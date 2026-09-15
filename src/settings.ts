import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type HermesAgentNotesPlugin from "./main";
import { cleartextWarning, describeError, endpointsFor, obsidianOrigins } from "./hermes-client";
import { REMOTE_PRESETS, apiKeyAdvice, apiKeyEnvTarget, mergeHeaderLines, presetFor, randomApiKey } from "./remote";
import { loopbackBlockMessage } from "./settings-file";
import type { AccessMode } from "./types";
import { copyText } from "./ui/clipboard";
import { ErrorsModal } from "./ui/errors-modal";
import { QuickPromptModal } from "./ui/quick-prompt-modal";
import { describeProfile, profileMatches } from "./profiles";
import { listFolders } from "./vault-rules";

/** The published, long-form setup guide — every route in one page. */
const GUIDE_URL = "https://jphermans.github.io/hermes-obsidian/";

/** One-click prompts for the setup page's prompt box. */
const PROMPT_SAMPLES: { label: string; prompt: string }[] = [
  {
    label: "Which model are you?",
    prompt: "Answer in one short line: which model and provider are you running as right now?",
  },
  {
    label: "Which tools do you have?",
    prompt: "List the toolsets you have available, one per line, at most 10 lines.",
  },
  {
    label: "Describe my vault's style",
    prompt:
      "In two sentences, describe the note style of this vault, based on the vault conventions you were given.",
  },
  {
    label: "Draft a note title",
    prompt: "Suggest five possible note titles for a note about a kitchen renovation, as a plain list.",
  },
];

export class HermesSettingTab extends PluginSettingTab {
  /** Last "Verify streaming" report, kept so it stays readable on screen. */
  private streamingReport = "";
  plugin: HermesAgentNotesPlugin;

  constructor(app: App, plugin: HermesAgentNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** The setup page, split so no single view is a wall of settings. */
  private static readonly TABS: { id: string; label: string }[] = [
    { id: "connection", label: "Connection" },
    { id: "remote", label: "Remote access" },
    { id: "notes", label: "Notes" },
    { id: "chat", label: "Chat & prompts" },
    { id: "backup", label: "Backup & errors" },
    { id: "guide", label: "Setup guide" },
  ];

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hermes-settings");

    // Obsidian opens this pane the moment the tab is clicked. A throw anywhere used to
    // leave the whole page blank with no clue why, so every part is guarded now: whatever
    // fails names itself on the page and lands in the error log.
    this.guard(containerEl, "version label", () => this.renderVersionLabel(containerEl));

    if (!this.plugin.settings) {
      containerEl.createEl("p", {
        text: "Hermes Agent Notes is still starting up — this page fills in a moment. Close and reopen it if it stays like this.",
      });
      return;
    }

    const known = HermesSettingTab.TABS;
    const wanted = this.plugin.settings.settingsTab || "connection";
    const active = known.some((tab) => tab.id === wanted) ? wanted : "connection";

    this.guard(containerEl, "tab row", () => {
      const strip = containerEl.createDiv({ cls: "hermes-tabs" });
      for (const tab of known) {
        const button = strip.createEl("button", {
          text: tab.label,
          cls: tab.id === active ? "hermes-tab is-active" : "hermes-tab",
        });
        button.setAttr("aria-selected", tab.id === active ? "true" : "false");
        button.addEventListener("click", () => {
          this.plugin.settings.settingsTab = tab.id;
          void this.plugin.saveSettings();
          this.display();
        });
      }
    });

    const body = containerEl.createDiv({ cls: "hermes-tab-body" });
    this.renderActiveTab(active, body);
  }

  /**
   * Runs one part of the page. A failure is reported in place — with the message — so a
   * problem in a single section can never make the page look empty.
   */
  private guard(parent: HTMLElement, label: string, render: () => void): void {
    try {
      render();
    } catch (error) {
      const message = describeError(error);
      try {
        void this.plugin.logError("Settings — " + label, message).catch(() => undefined);
      } catch {
        // The error log itself must never be the reason a page stays empty.
      }
      const box = parent.createDiv({ cls: "hermes-callout hermes-callout-warn" });
      box.createEl("p", { text: "The “" + label + "” part of this page could not be shown: " + message });
      box.createEl("p", {
        cls: "setting-item-description",
        text: "The same message is in the error log — Diagnostics → Show recent errors. Please include it in a bug report.",
      });
    }
  }

  /**
   * One tab's content. Only the visible tab is built, so the page stays cheap.
   *
   * NOT named renderTab(): Obsidian 1.13 added renderTab() to the SettingTab base class
   * and calls it when the pane opens. A member with that name shadows it — Obsidian then
   * calls ours with no arguments, display() never runs, and the pane comes up blank with
   * no error anywhere. It is not in the public typings, so nothing warns about it.
   */
  private renderActiveTab(id: string, el: HTMLElement): void {
    switch (id) {
      case "remote":
        this.guard(el, "Remote access", () => this.renderRemoteAccess(el));
        return;
      case "notes":
        this.guard(el, "Note writing", () => this.renderNotes(el));
        this.guard(el, "Vault conventions", () => this.renderConventions(el));
        return;
      case "chat":
        this.guard(el, "Chat, prompts and saved setup", () => this.renderLibrary(el));
        return;
      case "backup":
        this.guard(el, "Keeping your settings", () => this.renderSettingsFile(el));
        this.guard(el, "Diagnostics", () => this.renderDiagnostics(el));
        return;
      case "guide":
        this.guard(el, "Setup guide", () => this.renderGuide(el));
        return;
      default:
        this.guard(el, "Hermes connection", () => this.renderConnection(el));
        this.guard(el, "Ask Hermes", () => this.renderPromptTest(el));
    }
  }

  // --- version label --------------------------------------------------------

  /**
   * Which build is installed, as a label at the top of the setup page — so a
   * bug report never has to guess, and a stale BRAT update is obvious.
   */
  private renderVersionLabel(containerEl: HTMLElement): void {
    const row = containerEl.createDiv({ cls: "hermes-version-row" });
    row.createEl("span", { cls: "hermes-version-name", text: "Hermes Agent Notes" });

    const version = "v" + this.plugin.manifest.version;
    const badge = row.createEl("span", { cls: "hermes-version-badge", text: version });
    badge.setAttr(
      "title",
      (Platform.isDesktop ? "Desktop" : "Mobile") +
        " build · id " +
        this.plugin.manifest.id +
        " · click to copy"
    );
    badge.addEventListener("click", () => {
      copyText(
        "Hermes Agent Notes " + version + " (" + (Platform.isDesktop ? "desktop" : "mobile") + ")",
        "Copied " + version
      );
    });

    // The connection state, right next to the version — the two things a bug
    // report always asks for.
    const connection = this.plugin.settings.connection;
    if (connection) {
      const state = row.createEl("span", {
        cls: "hermes-version-state",
        text: connection.ok ? "connected" : "connection failed",
      });
      state.toggleClass("is-ok", !!connection.ok);
      state.toggleClass("is-bad", !connection.ok);
    }

    const guide = row.createEl("a", { cls: "hermes-version-guide", text: "Complete setup guide ↗" });
    guide.setAttr("href", GUIDE_URL);
    guide.setAttr("target", "_blank");
    guide.setAttr("rel", "noopener");
  }

  // --- connection ----------------------------------------------------------

  private renderConnection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Hermes connection" });

    const connection = this.plugin.settings.connection;
    const card = containerEl.createDiv({ cls: "hermes-status-card" });
    const line = card.createDiv({ cls: "hermes-status-line" });
    const dot = line.createEl("span", { cls: "hermes-status-dot" });
    const label = line.createEl("span", { text: "" });
    const detail = card.createDiv({ cls: "hermes-status-detail" });

    const ok = !!(connection && connection.ok);
    dot.toggleClass("is-ok", ok);
    dot.toggleClass("is-bad", !!connection && !ok);
    label.setText(
      !connection ? "Not tested yet" : ok ? "Connected — " + (connection.model || this.plugin.settings.model) : "Connection failed"
    );
    detail.setText(
      !connection
        ? "Hermes API server at " + this.plugin.endpointLabel() + " (start it with: hermes gateway)"
        : connection.detail + (connection.at ? " · checked " + new Date(connection.at).toLocaleTimeString() : "")
    );

    const buttons = card.createDiv({ cls: "hermes-notes-buttons" });
    const test = buttons.createEl("button", { text: "Test connection", cls: "mod-cta" });
    test.addEventListener("click", () => {
      test.setText("Testing…");
      test.setAttr("disabled", "true");
      void this.plugin
        .testConnection()
        .then((state) => {
          new Notice(
            state.ok ? "Hermes is reachable: " + state.detail : "Hermes could not be reached: " + state.detail,
            state.ok ? 5000 : 10000
          );
        })
        .finally(() => this.display());
    });
    const chat = buttons.createEl("button", { text: "Open chat panel" });
    chat.addEventListener("click", () => void this.plugin.activateChatView());

    const unreachable = cleartextWarning(endpointsFor(this.plugin.settings.baseUrl, this.plugin.settings.profile).v1);
    const loopbackOnMobile = loopbackBlockMessage(this.plugin.settings.baseUrl, Platform.isMobile);
    if (unreachable || loopbackOnMobile) {
      const warn = containerEl.createDiv({ cls: "hermes-callout hermes-callout-warn" });
      warn.createEl("p", { text: loopbackOnMobile || unreachable });
    }

    let urlError: HTMLElement | null = null;
    let blockedUrl = "";

    // A prefixed (multiplexed) profile silently rejects a short key with 401, so
    // say it here instead of letting the connection card go red for no visible reason.
    let keyAdviceEl: HTMLElement | null = null;
    const paintKeyAdvice = () => {
      if (!keyAdviceEl) return;
      const advice = apiKeyAdvice(this.plugin.settings.profile, this.plugin.settings.apiKey);
      keyAdviceEl.empty();
      keyAdviceEl.toggleClass("is-hidden", !advice);
      if (advice) keyAdviceEl.createEl("p", { text: advice });
    };

    new Setting(containerEl)
      .setName("API server URL")
      .setClass("hermes-wide")
      .setDesc("Root of the Hermes API server — no /v1 suffix. The port is optional: https://hermes.example.com works when a tunnel or proxy serves it on 443. Without a scheme, a public hostname becomes https and a LAN or loopback address stays http. Local default: http://127.0.0.1:8642")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8642")
          .setValue(this.plugin.settings.baseUrl)
          .onChange((value) => {
            const trimmed = value.trim();
            const blocked = loopbackBlockMessage(trimmed, Platform.isMobile);
            if (blocked && urlError) {
              // Keep what was typed on screen, but do not store it: on a phone this
              // address points at the phone itself, so nothing could ever reach Hermes.
              blockedUrl = trimmed;
              urlError.empty();
              urlError.createEl("p", { text: blocked });
              const saveAnyway = urlError.createEl("button", { text: "Save anyway — Hermes runs on this device" });
              saveAnyway.addEventListener("click", () => {
                this.plugin.settings.baseUrl = blockedUrl;
                this.plugin.settings.connection = null;
                void this.plugin.saveSettings().then(() => this.display());
              });
              urlError.removeClass("is-hidden");
              return;
            }
            this.plugin.settings.baseUrl = trimmed;
            this.plugin.settings.connection = null;
            void this.plugin.saveSettings();
            if (urlError) urlError.addClass("is-hidden");
          })
      );

    urlError = containerEl.createDiv({ cls: "hermes-callout hermes-callout-warn is-hidden" });

    new Setting(containerEl)
      .setName("Profile prefix")
      .setClass("hermes-wide")
      .setDesc("Only when the Hermes gateway serves several profiles (gateway.multiplex_profiles). Requests then go to /p/<profile>/v1 — and they authenticate with THAT profile's own API_SERVER_KEY, a separate key created for it (never another profile's). Leave empty for the default profile.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(this.plugin.settings.profile)
          .onChange((value) => {
            this.plugin.settings.profile = value.trim();
            this.plugin.settings.connection = null;
            void this.plugin.saveSettings();
            paintKeyAdvice();
          })
      );

    new Setting(containerEl)
      .setName("Extra request headers")
      .setClass("hermes-wide")
      .setDesc(
        "One Name: value per line. Needed when the API server sits behind Cloudflare Access, an authenticating proxy or a gateway that wants its own headers. A header named Authorization replaces the API key above."
      )
      .addTextArea((text) => {
        text.setPlaceholder("CF-Access-Client-Id: xxxx.access\nCF-Access-Client-Secret: yyyy");
        text.setValue(this.plugin.settings.extraHeaders);
        text.inputEl.rows = 6;
        text.inputEl.addClass("hermes-headers-input");
        text.onChange((value) => {
          this.plugin.settings.extraHeaders = value;
          this.plugin.settings.connection = null;
          void this.plugin.saveSettings();
        });
      });

    keyAdviceEl = containerEl.createDiv({ cls: "hermes-callout hermes-callout-warn is-hidden" });
    paintKeyAdvice();

    const keySetting = new Setting(containerEl)
      .setName("API key")
      .setClass("hermes-wide")
      .setDesc("Must equal API_SERVER_KEY in the .env of the profile you are talking to — its own key, created for it (use the ⟳ button to make one). Stored in this vault's plugin data, so keep the vault private.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("your API_SERVER_KEY")
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => {
            this.plugin.settings.apiKey = value.trim();
            this.plugin.settings.connection = null;
            void this.plugin.saveSettings();
            paintKeyAdvice();
          });
      });
    keySetting.addExtraButton((button) =>
      button
        .setIcon("eye")
        .setTooltip("Show or hide the key")
        .onClick(() => {
          const input = keySetting.controlEl.querySelector("input");
          if (input) input.type = input.type === "password" ? "text" : "password";
        })
    );
    keySetting.addExtraButton((button) =>
      button
        .setIcon("refresh-cw")
        .setTooltip("Generate a new 48-character key and copy the .env line")
        .onClick(() => {
          const generated = randomApiKey();
          this.plugin.settings.apiKey = generated;
          this.plugin.settings.connection = null;
          void this.plugin.saveSettings();
          const target = apiKeyEnvTarget(this.plugin.settings.profile);
          copyText("API_SERVER_KEY=" + generated, "Copied — now paste that line into " + target + " and restart the gateway there.");
          const input = keySetting.controlEl.querySelector("input");
          if (input) {
            input.value = generated;
            input.type = "text";
          }
          paintKeyAdvice();
        })
    );

    new Setting(containerEl)
      .setName("Model")
      .setClass("hermes-wide")
      .setDesc(
        "Hermes normally uses its own configured default model and ignores this name. Fill in a provider below to make this model take effect, or set gateway.platforms.api_server.direct_model_requests on the host."
      )
      .addText((text) =>
        text
          .setPlaceholder("hermes-agent")
          .setValue(this.plugin.settings.model)
          .onChange((value) => {
            this.plugin.settings.model = value.trim();
            void this.plugin.saveSettings();
          })
      )
      .addButton((button) => {
        let busy = false;
        button.setButtonText("Fetch models").onClick(() => {
          if (busy) {
            new Notice("Still waiting for Hermes — this request gives up on its own, check the timeout below.", 6000);
            return;
          }
          busy = true;
          button.setButtonText("Fetching…");
          void this.plugin
            .fetchModels()
            .then((models) => {
              if (models.length === 0) new Notice("Hermes did not advertise any model name.");
              else new Notice("Advertised model names: " + models.join(", "), 8000);
            })
            .catch((error) => new Notice("Could not list models: " + describeError(error), 12000))
            .finally(() => {
              busy = false;
              button.setButtonText("Fetch models");
              this.display();
            });
        });
      });

    if (this.plugin.settings.availableModels.length > 0) {
      new Setting(containerEl)
        .setName("Advertised model names")
        .setDesc("Reported by GET /v1/models on this instance. Click one to use it.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "— pick a detected name —");
          for (const name of this.plugin.settings.availableModels) dropdown.addOption(name, name);
          dropdown.setValue(this.plugin.settings.availableModels.indexOf(this.plugin.settings.model) >= 0 ? this.plugin.settings.model : "");
          dropdown.onChange((value) => {
            if (!value) return;
            this.plugin.settings.model = value;
            void this.plugin.saveSettings();
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName("Provider override")
      .setClass("hermes-wide")
      .setDesc("Optional Hermes provider slug (for example openrouter, anthropic, minimax). Sent with every request so the model above is honoured.")
      .addText((text) =>
        text
          .setPlaceholder("(leave empty)")
          .setValue(this.plugin.settings.provider)
          .onChange((value) => {
            this.plugin.settings.provider = value.trim();
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Stream answers")
      .setDesc(
        "Shows tokens and tool progress as they arrive. Streaming is a browser request, so Hermes must allow this app's origin — otherwise the plugin falls back to the silent transport automatically. Works on desktop and mobile."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.streaming).onChange((value) => {
          this.plugin.settings.streaming = value;
          void this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) => {
        let busy = false;
        button.setButtonText("Verify streaming").onClick(() => {
          if (busy) return;
          busy = true;
          button.setButtonText("Checking…");
          void this.plugin
            .verifyStreaming()
            .then((report) => {
              this.streamingReport = report;
              this.display();
            })
            .finally(() => {
              busy = false;
              button.setButtonText("Verify streaming");
            });
        });
      });

    if (this.streamingReport) {
      containerEl.createEl("p", { cls: "hermes-notes-path", text: this.streamingReport });
    }

    if (this.plugin.settings.streaming) {
      const origins = obsidianOrigins();
      const corsLine = "API_SERVER_CORS_ORIGINS=" + origins.join(",");
      const corsBox = containerEl.createDiv({ cls: "hermes-callout" });
      corsBox.createEl("p", {
        text:
          "Add this line to the Hermes .env and restart the gateway (`hermes gateway stop && hermes gateway`). Keep every origin you use — desktop, iOS and Android present different ones."
      });
      this.codeBlock(corsBox, [corsLine], "Copy line");
    }

    new Setting(containerEl)
      .setName("Report the conversation to Hermes sessions")
      .setDesc("Sends X-Hermes-Session-Id so long runs survive in Hermes session history and background delegation can deliver its result.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.reportSession).onChange((value) => {
          this.plugin.settings.reportSession = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("−1 keeps the provider default. Sent only when 0 or higher.")
      .addSlider((slider) =>
        slider
          .setLimits(-1, 1, 0.05)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.temperature = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Connection check timeout")
      .setDesc(
        "Seconds to wait for /health, /v1/models and /v1/capabilities before reporting a timeout. This is what stops the settings page hanging on an address that never answers."
      )
      .addSlider((slider) =>
        slider
          .setLimits(3, 120, 1)
          .setValue(Math.round(this.plugin.settings.probeTimeoutMs / 1000))
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.probeTimeoutMs = value * 1000;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Answer timeout")
      .setDesc("Seconds to wait for a full answer. Agent turns can legitimately take minutes; 0 waits forever.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1800, 15)
          .setValue(Math.round(this.plugin.settings.chatTimeoutMs / 1000))
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.chatTimeoutMs = value * 1000;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Conversation memory")
      .setDesc("How many previous messages from the chat panel are sent with each request. 0 sends none.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 40, 2)
          .setValue(this.plugin.settings.maxHistoryMessages)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.maxHistoryMessages = value;
            void this.plugin.saveSettings();
          })
      );
  }

  // --- remote access -------------------------------------------------------

  private renderRemoteAccess(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Remote access — when Hermes is not local" });

    const mode = this.plugin.settings.accessMode;
    const preset = presetFor(mode);

    new Setting(containerEl)
      .setName("How do you reach Hermes?")
      .setDesc(
        "Picks the recipe, the URL shape and the headers this route needs. It never rewrites the URL by itself — press the button below when you want that URL filled in."
      )
      .addDropdown((dropdown) => {
        for (const entry of REMOTE_PRESETS) dropdown.addOption(entry.id, entry.label);
        dropdown.setValue(mode);
        dropdown.onChange((value) => {
          this.plugin.settings.accessMode = value as AccessMode;
          void this.plugin.saveSettings();
          this.display();
        });
      });

    const card = containerEl.createDiv({ cls: "hermes-callout" });
    card.createEl("p", { text: preset.summary });
    if (preset.commands.length > 0) {
      this.codeBlock(card, preset.commands, "Copy commands");
    }
    for (const note of preset.notes) {
      card.createEl("p", { cls: "setting-item-description", text: note });
    }

    const routeDoc = card.createEl("a", {
      cls: "hermes-guide-link",
      text: "Full guide for this route: " + preset.shortLabel + " ↗",
    });
    routeDoc.setAttr("href", GUIDE_URL + "#" + preset.docAnchor);
    routeDoc.setAttr("target", "_blank");
    routeDoc.setAttr("rel", "noopener");

    const buttons = card.createDiv({ cls: "hermes-notes-buttons" });
    if (preset.urlTemplate) {
      const useTemplate = buttons.createEl("button", { text: "Use " + preset.urlTemplate });
      useTemplate.addEventListener("click", () => {
        this.plugin.settings.baseUrl = preset.urlTemplate as string;
        this.plugin.settings.connection = null;
        void this.plugin.saveSettings().then(() => this.display());
      });
    }
    const headerLines = preset.requiredHeaders.concat(preset.optionalHeaders);
    if (headerLines.length > 0) {
      const insert = buttons.createEl("button", { text: "Insert needed headers", cls: "mod-cta" });
      insert.addEventListener("click", () => {
        const merged = mergeHeaderLines(this.plugin.settings.extraHeaders, headerLines);
        this.plugin.settings.extraHeaders = merged.text;
        this.plugin.settings.connection = null;
        void this.plugin.saveSettings().then(() => this.display());
        new Notice(
          merged.added.length > 0
            ? "Added " + merged.added.length + " header line(s) — fill in the real values."
            : "Those headers are already set."
        );
      });
    }
    const testRoute = buttons.createEl("button", { text: "Test this route" });
    testRoute.addEventListener("click", () => void this.plugin.testConnectionWithNotice());

    if (!preset.mobileSafe) {
      const warn = card.createDiv({ cls: "hermes-callout hermes-callout-warn" });
      warn.createEl("p", {
        text: "Phones and tablets cannot use this route: iOS and Android refuse plain-HTTP requests to another machine. Pick Tailscale, Cloudflare or ngrok for mobile use.",
      });
    }

    const baseUrl = this.plugin.settings.baseUrl.trim();
    if (preset.id !== "local" && preset.id !== "lan" && baseUrl.length > 0 && !baseUrl.toLowerCase().startsWith("https://")) {
      const warn = card.createDiv({ cls: "hermes-callout hermes-callout-warn" });
      warn.createEl("p", {
        text: "This route needs an https:// URL — the one currently configured (" + baseUrl + ") is not HTTPS.",
      });
    }
  }

  // --- note writing --------------------------------------------------------

  private renderNotes(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Note writing" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Every generated note is shown in a preview with its file name and Obsidian syntax checks before it is written — nothing is saved unseen.",
    });

    new Setting(containerEl)
      .setName("Default folder for new notes")
      .setDesc("Where new notes land unless the create dialog picks another folder.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Vault root");
        for (const folder of listFolders(this.app)) dropdown.addOption(folder, folder);
        const current = this.plugin.settings.defaultFolder;
        if (current && listFolders(this.app).indexOf(current) < 0) dropdown.addOption(current, current);
        dropdown.setValue(current);
        dropdown.onChange((value) => {
          this.plugin.settings.defaultFolder = value;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("File names")
      .setDesc("How Hermes titles are turned into file names. Obsidian removes / \\ : * ? \" < > | # ^ [ ] in any case.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keep", "As written")
          .addOption("title", "Title Case")
          .addOption("kebab", "kebab-case")
          .addOption("snake", "snake_case")
          .setValue(this.plugin.settings.filenameStyle)
          .onChange((value) => {
            this.plugin.settings.filenameStyle = value as "keep" | "title" | "kebab" | "snake";
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open new notes")
      .setDesc("Open the note in the current tab after creating it.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openAfterCreate).onChange((value) => {
          this.plugin.settings.openAfterCreate = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Ask for frontmatter")
      .setDesc("Reuse the properties your vault already uses (detected below) instead of writing notes without frontmatter.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoFrontmatter).onChange((value) => {
          this.plugin.settings.autoFrontmatter = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Strip caveats from answers")
      .setDesc(
        "When an answer is inserted, appended or saved into a note, drop the assistant's own remarks — “Let me know if you want more”, “Note: I can only see the conventions you shared”. Generated notes are never touched, and Copy always gives the raw answer."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.stripCaveats).onChange((value) => {
          this.plugin.settings.stripCaveats = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Send the open note as context")
      .setDesc("Default for the chat panel and the create dialog. The open note is trimmed to about 12 000 characters.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeActiveNote).onChange((value) => {
          this.plugin.settings.includeActiveNote = value;
          void this.plugin.saveSettings();
        })
      );

    this.renderFileOps(containerEl);
  }

  /** Copy, move and delete: the one capability that changes the vault's layout. */
  private renderFileOps(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Files").setHeading();

    new Setting(containerEl)
      .setName("Copy, move and delete notes")
      .setDesc(
        "Ask in the chat (\"move the boiler note into Archive\") or run the command, and Hermes plans the operations. Nothing changes until you approve a list of exact paths: existing notes are never overwritten, wikilinks follow a move, and vault configuration is off limits."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowFileOps).onChange((value) => {
          this.plugin.settings.allowFileOps = value;
          void this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Deleting a note")
      .setDesc(
        "Move to trash uses Obsidian's own delete, so it follows your \"Deleted files\" setting (Obsidian trash folder or system trash) and can be undone. Delete permanently cannot be undone."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("trash", "Move to trash (recoverable)")
          .addOption("permanent", "Delete permanently")
          .setValue(this.plugin.settings.permanentDelete ? "permanent" : "trash")
          .onChange((value) => {
            this.plugin.settings.permanentDelete = value === "permanent";
            void this.plugin.saveSettings();
          })
      );
  }

  // --- conventions ---------------------------------------------------------

  private renderConventions(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Vault conventions" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The plugin reads a sample of your existing notes to learn how this vault writes Markdown — properties and their types, tag style, link style, heading habits, file-name style and the callouts in use — and sends that to Hermes with every request. Nothing leaves the vault except that summary and the notes you explicitly send.",
    });

    new Setting(containerEl)
      .setName("Learn from this vault")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.conventionsEnabled).onChange((value) => {
          this.plugin.settings.conventionsEnabled = value;
          if (!value) this.plugin.settings.conventions = null;
          void this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Notes to analyse")
      .setDesc("Most recently modified notes are read first.")
      .addSlider((slider) =>
        slider
          .setLimits(20, 400, 20)
          .setValue(this.plugin.settings.conventionsSample)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.conventionsSample = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Existing note names to offer for linking")
      .setDesc("How many note titles from the target folder are given to Hermes so it can write real wikilinks.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 200, 10)
          .setValue(this.plugin.settings.conventionsNotesListed)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.conventionsNotesListed = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cache the analysis")
      .setDesc("Minutes before the vault is scanned again. 0 rescans on every request.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 240, 5)
          .setValue(this.plugin.settings.conventionsCacheMinutes)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.conventionsCacheMinutes = value;
            void this.plugin.saveSettings();
          })
      );

    const detected = this.plugin.settings.conventions;
    const summary = containerEl.createDiv({ cls: "hermes-callout" });
    summary.createEl("p", {
      text: detected
        ? "Last scan: " +
          detected.scanned +
          " of " +
          detected.totalNotes +
          " notes · properties in " +
          (detected.scanned > 0 ? Math.round((detected.frontmatterUsed / detected.scanned) * 100) : 0) +
          "% · tags " +
          detected.tags.style +
          " · " +
          detected.links.wiki +
          " wikilinks · callouts: " +
          (detected.callouts.join(", ") || "none") +
          "."
        : "No analysis cached yet — it runs on the first request.",
    });

    new Setting(containerEl)
      .setName("Inspect or rescan")
      .addButton((button) =>
        button.setButtonText("Show detected conventions").onClick(() => void this.plugin.showConventions())
      )
      .addButton((button) =>
        button.setButtonText("Rescan now").onClick(() => {
          button.setButtonText("Scanning…");
          void this.plugin
            .rescanVault(true)
            .then(() => this.display())
            .finally(() => button.setButtonText("Rescan now"));
        })
      );
  }

  // --- guide ---------------------------------------------------------------

  private renderGuide(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Setup guide" });
    const steps = containerEl.createDiv({ cls: "hermes-guide" });
    steps.createEl("p", {
      text:
        "Hermes exposes an OpenAI-compatible API server. The plugin talks to it; Hermes never needs access to this vault, because the plugin writes every note itself.",
    });

    // The long-form version of this guide, for every route and every setup.
    const webGuide = steps.createDiv({ cls: "hermes-guide-web" });
    const webLink = webGuide.createEl("a", {
      cls: "hermes-guide-link",
      text: "Complete setup guide for every instance ↗",
    });
    webLink.setAttr("href", GUIDE_URL);
    webLink.setAttr("target", "_blank");
    webLink.setAttr("rel", "noopener");
    webGuide.createEl("span", {
      cls: "hermes-guide-web-url",
      text: "same machine · LAN · Tailscale · Cloudflare Tunnel · ngrok · reverse proxy · its own profile · on the phone — with a copy button on every command",
    });

    steps.createEl("h3", { text: "1 · Enable the API server on the Hermes host" });
    this.codeBlock(
      steps,
      [
        "# ~/.hermes/.env — environment variables, not config.yaml keys",
        "API_SERVER_ENABLED=true",
        "API_SERVER_KEY=my-secret-key",
        "",
        "# API_SERVER_HOST defaults to 127.0.0.1: this device only.",
        "# Set it when another device has to reach the API server:",
        "# API_SERVER_HOST=0.0.0.0            # LAN (desktop only — phones need HTTPS)",
        "# API_SERVER_HOST=10.8.0.1           # a WireGuard VPN address",
        "# (a tunnel or proxy does not need this: it connects over loopback)",
        "",
        "hermes gateway stop && hermes gateway",
      ],
      "Copy commands"
    );
    steps.createEl("p", {
      cls: "setting-item-description",
      text: "The flag and the key are environment variables — hermes config set does not own those names. Paste the same key into the API key field above, and leave API_SERVER_HOST alone unless something other than this machine has to reach the port.",
    });

    steps.createEl("h3", { text: "2 · Check that it is listening" });
    this.codeBlock(
      steps,
      [
        "curl -s http://127.0.0.1:8642/health",
        'curl -s -H "Authorization: Bearer my-secret-key" http://127.0.0.1:8642/v1/models',
      ],
      "Copy"
    );
    steps.createEl("p", {
      cls: "setting-item-description",
      text: "The first call returns {\"status\": \"ok\"}; the second lists the agent as a model. A 401 means the key does not match.",
    });

    steps.createEl("h3", { text: "3 · Reach it from anywhere (phones, tablets, other networks)" });
    steps.createEl("p", {
      text:
        "Mobile operating systems refuse plain HTTP to another machine, so a phone cannot use http://192.168.x.x:8642 — that is why every remote route below is HTTPS. Pick yours in the dropdown of How do you reach Hermes? above: it shows that route's commands, its URL shape, the headers it needs and a Test this route button, which is why this page no longer carries every recipe at once.",
    });
    this.renderRouteLinks(steps);
    const safety = steps.createEl("ul", { cls: "hermes-guide-list" });
    safety.createEl("li", {
      text: "Keep the API server bound to 127.0.0.1 and let the tunnel or proxy be the only way in — that way the port is never open directly.",
    });
    safety.createEl("li", {
      text: "The key protects a full agent with terminal access. Prefer Tailscale or Cloudflare Access over a bare public port, and rotate the key if it ever leaks.",
    });
    safety.createEl("li", {
      text: "Plain LAN HTTP (API_SERVER_HOST=0.0.0.0 plus http://192.168.x.x:8642) works on desktop only; phones will refuse it.",
    });

    steps.createEl("h3", { text: "3b · A permanent URL that survives restarts" });
    steps.createEl("p", {
      text:
        "A quick tunnel hands you a URL for right now and a different one after every restart, which means editing this page again. For a URL you paste once, use a named Cloudflare tunnel or an ngrok static domain — each has its walkthrough, including the install and the service step for your system:",
    });
    this.renderDocLinks(steps, ["cloudflare", "ngrok", "wireguard"]);
    steps.createEl("p", {
      cls: "setting-item-description",
      text:
        "Behind the URL, make the rest permanent too: hermes gateway install && hermes gateway start (not a terminal you keep open), the tunnel itself as a service, and a host that does not sleep. WireGuard is the third option if you would rather not involve a third party at all — desktop works with it as-is, while a phone still needs HTTPS in front.",
    });

    steps.createEl("h3", { text: "4 · Streaming (optional)" });
    steps.createEl("p", {
      text:
        "Live token output is a browser request, so the Hermes side needs an explicit origin allowlist. This is only needed when Stream answers is on.",
    });
    this.codeBlock(steps, ["API_SERVER_CORS_ORIGINS=" + obsidianOrigins().join(",")], "Copy line");
    steps.createEl("p", {
      cls: "setting-item-description",
      text:
        "Desktop presents app://obsidian.md; iOS presents capacitor://localhost; Android presents http://localhost. Add the ones you use, restart the gateway, then press Test connection.",
    });

    steps.createEl("h3", { text: "5 · Profiles and several machines" });
    steps.createEl("p", {
      text:
        "Each Hermes profile runs its own API server on its own port with its own key. Point the URL at that port, or enable gateway.multiplex_profiles and set the profile prefix — a named prefix accepts only that profile's own key.",
    });

    steps.createEl("h3", { text: "6 · Keep vault work in its own Hermes profile" });
    steps.createEl("p", {
      text:
        "By default this vault talks to your main Hermes profile, so its prompts and answers share the session store and memory with everything else you do with Hermes. A profile is a separate folder — its own config, key, personality, memory and sessions — so use one when you want vault work kept apart:",
    });
    this.codeBlock(
      steps,
      [
        "hermes profile create obsidian      # + an `obsidian` command",
        "# ~/.hermes/profiles/obsidian/.env:",
        "#   API_SERVER_ENABLED=true",
        "#   API_SERVER_KEY=my-vault-key",
        "#   API_SERVER_PORT=8643",
        "#   API_SERVER_HOST=127.0.0.1      # or 0.0.0.0 / the VPN address to reach it from another device",
        "obsidian setup && obsidian gateway start",
      ],
      "Copy commands"
    );
    const profileNotes = steps.createEl("ul", { cls: "hermes-guide-list" });
    profileNotes.createEl("li", {
      text: "Make a SEPARATE key for this profile. A URL-selected profile (/p/<name>) authenticates with its own API_SERVER_KEY and nothing else — reusing the default profile's key, or a key from another profile, always answers 401. Press the ⟳ button beside the API key field above (it generates 48 characters and copies the whole API_SERVER_KEY=… line), paste that line into ~/.hermes/profiles/<name>/.env, restart the gateway, and keep the same value in the field here. It must be at least 16 characters.",
    });
    profileNotes.createEl("li", {
      text: "Create the profile on the Hermes host first — the plugin only sends requests, so it cannot create one or check for one. Until it exists and its API server is listening you will see 404 (wrong port or prefix) or 401 (a key from another profile). No shell handy? hermes dashboard → Profiles does it, and you can start on your default profile today and switch later.",
    });
    profileNotes.createEl("li", {
      text: "Route to it either way: its own port (URL http://<host>:8643, that profile's key, empty prefix), or one gateway with gateway.multiplex_profiles true on the default profile and the prefix obsidian → /p/obsidian/v1. Under multiplexing a secondary profile must not run its own gateway, and two profiles that both leave API_SERVER_PORT unset collide on 8642. API_SERVER_HOST defaults to 127.0.0.1 — with multiplexing the host and port belong to the default profile's API server, since that is the one actually listening.",
    });
    const profileDoc = profileNotes.createEl("li", {
      text: "You will know it routed when /v1/models advertises the profile name — it appears in the chat panel's model dropdown. Full walkthrough: ",
    });
    const profileLink = profileDoc.createEl("a", { cls: "hermes-guide-link", text: "keeping vault work in its own profile ↗" });
    profileLink.setAttr("href", GUIDE_URL + "#profile");
    profileLink.setAttr("target", "_blank");
    profileLink.setAttr("rel", "noopener");

    const about = containerEl.createDiv({ cls: "hermes-callout" });
    about.createEl("p", {
      text:
        "Hermes Agent Notes " +
        this.plugin.manifest.version +
        " · " +
        (Platform.isDesktop ? "desktop" : "mobile") +
        " · docs at hermes-agent.nousresearch.com/docs/user-guide/features/api-server",
    });
  }

  // --- settings file -------------------------------------------------------

  private renderSettingsFile(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Keeping your settings" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Settings are stored in this vault's plugin data. With the automatic backup on they are also mirrored to " +
        this.plugin.backupPath() +
        ", so a plugin folder that gets wiped — a reinstall, a sync conflict — can be recovered. Export writes a visible JSON file into the vault; that file contains your API key and any extra headers, so keep it private.",
    });

    new Setting(containerEl)
      .setName("Automatic backup file")
      .setDesc("Mirrors the settings after every change (at most once every 1.2 s).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoBackup).onChange((value) => {
          this.plugin.settings.autoBackup = value;
          void this.plugin.saveSettings().then(() => {
            if (value) void this.plugin.writeBackup();
          });
        })
      );

    new Setting(containerEl)
      .setName("Settings file")
      .setDesc(
        "Export writes " +
          this.plugin.settings.defaultFolder +
          (this.plugin.settings.defaultFolder ? "/" : "") +
          "Hermes Agent Notes settings.json — restore reads a JSON file you pick, or the automatic backup."
      )
      .addButton((button) =>
        button.setButtonText("Export to the vault").onClick(() => {
          button.setButtonText("Exporting…");
          void this.plugin
            .exportSettings()
            .then((path) => new Notice("Settings written to " + path, 9000))
            .catch((error) => new Notice("Export failed: " + describeError(error), 10000))
            .finally(() => {
              button.setButtonText("Export to the vault");
              this.display();
            });
        })
      )
      .addButton((button) => button.setButtonText("Restore from a file…").onClick(() => void this.plugin.restoreFromFile()))
      .addButton((button) => button.setButtonText("Restore automatic backup").onClick(() => void this.plugin.restoreFromBackup()));

    containerEl.createEl("p", {
      cls: "hermes-notes-path",
      text: this.plugin.lastBackupAt
        ? "Last automatic backup this session: " + new Date(this.plugin.lastBackupAt).toLocaleTimeString()
        : "No automatic backup written yet in this session.",
    });
  }

  /** Where to look when something failed — the only place on a phone. */
  private renderDiagnostics(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Diagnostics").setHeading();

    new Setting(containerEl)
      .setName("Recorded problems")
      .setDesc(
        "Failures are written to " + this.plugin.errorLogPath() + " — newest kept, the file is capped so it cannot grow forever. Useful in a bug report; nothing is sent anywhere."
      )
      .addButton((button) =>
        button
          .setButtonText("Show recent errors")
          .onClick(() => new ErrorsModal(this.plugin.app, this.plugin).open())
      )
      .addButton((button) =>
        button.setButtonText("Clear").onClick(() => {
          void this.plugin.clearErrors().then(() => new Notice("Error log cleared."));
        })
      );

  }

  /** Quick prompts, saved setup and the follow-edits switch. */
  private renderLibrary(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Quick prompts").setHeading();
    const prompts = this.plugin.settings.quickPrompts;
    const list = containerEl.createDiv({ cls: "hermes-library" });
    if (prompts.length === 0) {
      list.createEl("p", { cls: "hermes-notes-desc", text: "No quick prompts yet." });
    }
    for (const entry of prompts) {
      const row = list.createDiv({ cls: "hermes-library-row" });
      const main = row.createDiv({ cls: "hermes-library-main" });
      main.createEl("span", { cls: "hermes-history-title", text: entry.label });
      main.createEl("span", { cls: "hermes-history-meta", text: entry.prompt.split("\n")[0] });
      const edit = row.createEl("button", { text: "Edit" });
      edit.addEventListener("click", () =>
        new QuickPromptModal(this.app, prompts, entry, (next) => void this.savePrompts(next)).open()
      );
      const remove = row.createEl("button", { text: "Delete" });
      remove.addEventListener("click", () =>
        void this.savePrompts(prompts.filter((item) => item.id !== entry.id))
      );
    }
    new Setting(containerEl)
      .setDesc(
        "Chips appear above the chat input and typing ! searches them. A prompt may reference notes with @[[Note]], and {note} becomes the open note's name."
      )
      .addButton((button) =>
        button
          .setButtonText("Add a quick prompt")
          .onClick(() => new QuickPromptModal(this.app, prompts, null, (next) => void this.savePrompts(next)).open())
      );

    new Setting(containerEl).setName("Saved setup").setHeading();
    // One slot on purpose: several saved connections made it hard to tell which one
    // was live, so saving always replaces it.
    const saved = this.plugin.settings.profiles[0];
    const setupList = containerEl.createDiv({ cls: "hermes-library" });
    if (!saved) {
      setupList.createEl("p", {
        cls: "hermes-notes-desc",
        text: "Nothing saved yet. Save the connection above once, and you can switch back to it after experimenting with a route or a profile.",
      });
    } else {
      const row = setupList.createDiv({ cls: "hermes-library-row" });
      const main = row.createDiv({ cls: "hermes-library-main" });
      main.createEl("span", { cls: "hermes-history-title", text: saved.name });
      main.createEl("span", { cls: "hermes-history-meta", text: describeProfile(saved) });
      const active = profileMatches(this.plugin.settings, saved);
      const use = row.createEl("button", { text: active ? "Active" : "Switch to this", cls: active ? "" : "mod-cta" });
      if (!active) {
        use.addEventListener("click", () => void this.plugin.switchProfile(saved.id).then(() => this.display()));
      }
      const remove = row.createEl("button", { text: "Forget" });
      remove.addEventListener("click", () => void this.plugin.deleteProfile(saved.id).then(() => this.display()));
    }
    new Setting(containerEl)
      .setDesc(
        "Keeps the URL, key, extra headers, profile prefix, model and provider as one setup. Saving again replaces it — there is only ever one."
      )
      .addButton((button) =>
        button
          .setButtonText(saved ? "Save again (replaces it)" : "Save this setup")
          .onClick(() => void this.plugin.saveSetup().then(() => this.display()))
      );

    new Setting(containerEl)
      .setName("Follow edits")
      .setDesc(
        "After you approve an edit, open the note at the first changed line so the change is in front of you, instead of leaving the note where it was."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.trackEdits).onChange((value) => {
          this.plugin.settings.trackEdits = value;
          void this.plugin.saveSettings();
        })
      );
  }

  private async savePrompts(prompts: typeof this.plugin.settings.quickPrompts): Promise<void> {
    await this.plugin.saveQuickPrompts(prompts);
    this.display();
  }

  // --- guide links ---------------------------------------------------------

  /** Deep links to one or more routes' walkthroughs on the published guide. */
  private renderDocLinks(parent: HTMLElement, ids: string[]): void {
    const row = parent.createDiv({ cls: "hermes-guide-links" });
    for (const id of ids) {
      const preset = REMOTE_PRESETS.find((entry) => entry.id === id);
      if (!preset) continue;
      const link = row.createEl("a", { cls: "hermes-guide-link", text: preset.shortLabel + " ↗" });
      link.setAttr("href", GUIDE_URL + "#" + preset.docAnchor);
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
  }

  /** Every route as a link — the dropdown above carries the commands. */
  private renderRouteLinks(parent: HTMLElement): void {
    this.renderDocLinks(
      parent,
      REMOTE_PRESETS.map((preset) => preset.id)
    );
  }

  // --- prompt box ----------------------------------------------------------

  private renderPromptTest(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Ask Hermes" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Type a prompt and read the answer right here. It travels the plugin's normal path — the Obsidian rules, your vault conventions and the session headers are all included — so a reply proves the whole chain works, not just that the port is open. Nothing is written to the vault.",
    });

    const input = containerEl.createEl("textarea", { cls: "hermes-prompt-input" });
    input.rows = 6;
    input.placeholder = "Ask Hermes anything…";
    input.setAttr("spellcheck", "false");
    input.setAttr("autocomplete", "off");

    const sampleRow = containerEl.createDiv({ cls: "hermes-notes-buttons" });
    for (const sample of PROMPT_SAMPLES) {
      const chip = sampleRow.createEl("button", { text: sample.label, cls: "hermes-example-btn" });
      chip.setAttr("title", sample.prompt);
      chip.addEventListener("click", () => {
        input.value = sample.prompt;
        if (!Platform.isMobile) input.focus();
      });
    }

    const actionRow = containerEl.createDiv({ cls: "hermes-notes-buttons" });
    const send = actionRow.createEl("button", { text: "Send to Hermes", cls: "mod-cta" });
    const openChat = actionRow.createEl("button", { text: "Open chat panel" });
    openChat.addEventListener("click", () => void this.plugin.activateChatView());

    const box = containerEl.createDiv({ cls: "hermes-answer-box" });

    send.addEventListener("click", () => void this.sendPrompt(input, send, box));
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.sendPrompt(input, send, box);
      }
    });
  }

  private async sendPrompt(input: HTMLTextAreaElement, button: HTMLButtonElement, box: HTMLElement): Promise<void> {
    const prompt = input.value.trim();
    if (!prompt) {
      new Notice("Type a prompt first.");
      return;
    }
    button.setText("Sending…");
    button.setAttr("disabled", "true");
    box.empty();
    box.removeClass("is-error");
    const meta = box.createDiv({ cls: "hermes-notes-path" });
    meta.setText("Waiting for Hermes…");
    const answer = box.createEl("pre", { cls: "hermes-answer-text" });

    try {
      const result = await this.plugin.quickPrompt(prompt, (_delta, full) => {
        answer.setText(full);
        meta.setText("Streaming…");
      });
      answer.setText(result.text);
      meta.setText(
        result.model +
          " · " +
          result.ms +
          " ms · " +
          (result.streamed ? "streamed" : "buffered through Obsidian's HTTP client")
      );
    } catch (error) {
      answer.remove();
      box.addClass("is-error");
      meta.setText("Failed: " + describeError(error));
    } finally {
      button.setText("Send to Hermes");
      button.removeAttribute("disabled");
    }
  }

  private codeBlock(parent: HTMLElement, lines: string[], label: string): void {
    const wrap = parent.createDiv({ cls: "hermes-code" });
    const pre = wrap.createEl("pre");
    pre.setText(lines.join("\n"));
    const button = wrap.createEl("button", { text: label, cls: "hermes-mini-btn" });
    button.addEventListener("click", () => copyText(lines.join("\n"), "Copied."));
  }
}
