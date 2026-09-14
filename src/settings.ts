import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type HermesAgentNotesPlugin from "./main";
import { describeError, obsidianOrigins } from "./hermes-client";
import { copyText } from "./ui/clipboard";
import { listFolders } from "./vault-rules";

export class HermesSettingTab extends PluginSettingTab {
  plugin: HermesAgentNotesPlugin;

  constructor(app: App, plugin: HermesAgentNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hermes-settings");

    this.renderConnection(containerEl);
    this.renderNotes(containerEl);
    this.renderConventions(containerEl);
    this.renderGuide(containerEl);
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

    new Setting(containerEl)
      .setName("API server URL")
      .setDesc("Root of the Hermes API server — no /v1 suffix. Local default: http://127.0.0.1:8642")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8642")
          .setValue(this.plugin.settings.baseUrl)
          .onChange((value) => {
            this.plugin.settings.baseUrl = value.trim();
            this.plugin.settings.connection = null;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Profile prefix")
      .setDesc("Only when the Hermes gateway serves several profiles (gateway.multiplex_profiles). Requests then go to /p/<profile>/v1. Leave empty for the default profile.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(this.plugin.settings.profile)
          .onChange((value) => {
            this.plugin.settings.profile = value.trim();
            this.plugin.settings.connection = null;
            void this.plugin.saveSettings();
          })
      );

    const keySetting = new Setting(containerEl)
      .setName("API key")
      .setDesc("Must equal API_SERVER_KEY in the Hermes .env. Stored in this vault's plugin data, so keep the vault private.")
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

    new Setting(containerEl)
      .setName("Model")
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
      .addButton((button) =>
        button.setButtonText("Fetch models").onClick(() => {
          button.setButtonText("Fetching…");
          void this.plugin
            .fetchModels()
            .then((models) => {
              if (models.length === 0) new Notice("Hermes did not advertise any model name.");
              else new Notice("Advertised model names: " + models.join(", "), 8000);
              this.display();
            })
            .catch((error) => new Notice("Could not list models: " + describeError(error), 10000))
            .finally(() => button.setButtonText("Fetch models"));
        })
      );

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
      );

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
      .setName("Send the open note as context")
      .setDesc("Default for the chat panel and the create dialog. The open note is trimmed to about 12 000 characters.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeActiveNote).onChange((value) => {
          this.plugin.settings.includeActiveNote = value;
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

    steps.createEl("h3", { text: "1 · Enable the API server on the Hermes host" });
    this.codeBlock(
      steps,
      [
        "hermes config set API_SERVER_ENABLED true",
        "hermes config set API_SERVER_KEY my-secret-key",
        "hermes gateway stop && hermes gateway",
      ],
      "Copy commands"
    );
    steps.createEl("p", {
      cls: "setting-item-description",
      text: "The flag goes to config.yaml, the key to ~/.hermes/.env. Paste the same key into the API key field above.",
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

    steps.createEl("h3", { text: "3 · Remote instances" });
    const remote = steps.createEl("ul", { cls: "hermes-guide-list" });
    remote.createEl("li", {
      text: "Bind the API server to more than loopback (API_SERVER_HOST=0.0.0.0) or publish it through a tunnel, then use that address here.",
    });
    remote.createEl("li", {
      text: "Prefer HTTPS. iOS and Android are stricter than desktop about plain-HTTP traffic, so a TLS reverse proxy (Caddy, Tailscale, Cloudflare Tunnel) is the reliable route on mobile.",
    });
    remote.createEl("li", {
      text: "The key protects a full agent with terminal access. Treat it like an SSH password and never share the vault the plugin data lives in.",
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

  private codeBlock(parent: HTMLElement, lines: string[], label: string): void {
    const wrap = parent.createDiv({ cls: "hermes-code" });
    const pre = wrap.createEl("pre");
    pre.setText(lines.join("\n"));
    const button = wrap.createEl("button", { text: label, cls: "hermes-mini-btn" });
    button.addEventListener("click", () => copyText(lines.join("\n"), "Copied."));
  }
}
