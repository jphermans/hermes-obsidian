import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type HermesAgentNotesPlugin from "./main";
import { cleartextWarning, describeError, endpointsFor, obsidianOrigins } from "./hermes-client";
import { REMOTE_PRESETS, mergeHeaderLines, presetFor } from "./remote";
import { loopbackBlockMessage } from "./settings-file";
import type { AccessMode } from "./types";
import { copyText } from "./ui/clipboard";
import { listFolders } from "./vault-rules";

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
    this.renderRemoteAccess(containerEl);
    this.renderPromptTest(containerEl);
    this.renderNotes(containerEl);
    this.renderConventions(containerEl);
    this.renderSettingsFile(containerEl);
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

    const unreachable = cleartextWarning(endpointsFor(this.plugin.settings.baseUrl, this.plugin.settings.profile).v1);
    const loopbackOnMobile = loopbackBlockMessage(this.plugin.settings.baseUrl, Platform.isMobile);
    if (unreachable || loopbackOnMobile) {
      const warn = containerEl.createDiv({ cls: "hermes-callout hermes-callout-warn" });
      warn.createEl("p", { text: loopbackOnMobile || unreachable });
    }

    let urlError: HTMLElement | null = null;
    let blockedUrl = "";

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

    const keySetting = new Setting(containerEl)
      .setName("API key")
      .setClass("hermes-wide")
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

    steps.createEl("h3", { text: "3 · Reach it from anywhere (phones, tablets, other networks)" });
    steps.createEl("p", {
      text:
        "Mobile operating systems refuse plain HTTP to another machine, so a phone cannot use http://192.168.x.x:8642. Reach Hermes over HTTPS — any of these keeps the plugin identical on desktop and mobile:",
    });
    const remote = steps.createEl("ul", { cls: "hermes-guide-list" });
    remote.createEl("li", {
      text: "Tailscale (easiest, nothing exposed to the internet): install it on the Hermes host and on the phone, run the command below, and paste the https://…ts.net address it prints.",
    });
    remote.createEl("li", {
      text: "Cloudflare Tunnel: a public HTTPS hostname without opening a port. With Cloudflare Access in front, paste the service token headers into Extra request headers.",
    });
    remote.createEl("li", {
      text: "A TLS reverse proxy on a VPS or the same host — for example Caddy, which gets a certificate automatically.",
    });
    this.codeBlock(
      steps,
      [
        "# Tailscale — HTTPS address for every device on your tailnet",
        "tailscale serve --bg 8642",
        "",
        "# Cloudflare Tunnel — quick public HTTPS URL",
        "cloudflared tunnel --url http://127.0.0.1:8642",
        "",
        "# Caddy on the host (Caddyfile): automatic HTTPS in front of the API server",
        "hermes.example.com {",
        "    reverse_proxy 127.0.0.1:8642",
        "}",
      ],
      "Copy recipes"
    );
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
