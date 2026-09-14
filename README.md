# Hermes Agent Notes

An Obsidian plugin that writes and repairs Markdown notes with a self-hosted **Hermes Agent** instance — local or remote — following *your* vault's own Obsidian conventions.

Hermes runs on your machine (or a server you own). The plugin talks to it over its OpenAI-compatible API server, sends the note request plus a summary of how your vault writes Markdown, and writes the resulting note into the vault itself. On desktop and on iOS/Android.

> Works with any Hermes Agent install (`hermes gateway` with `API_SERVER_ENABLED=true`). Nothing is sent to a third-party service unless your Hermes instance is configured to use one.

## What it does

| Command | What happens |
| --- | --- |
| **Create a note from a prompt** | Describe the note. Hermes writes a complete file — properties, headings, wikilinks, tags — and you confirm it in a preview. |
| **Improve the active note** | Rewrites the open note, keeping every existing property and link. |
| **Rewrite the active note with an instruction** | "shorter", "add a decisions table", "split this into a project note". |
| **Fix the active note for Obsidian** | Repairs Obsidian syntax only (broken wikilinks, illegal characters, malformed frontmatter, heading jumps, curly quotes) without changing your prose. |
| **Ask Hermes about the active note** | Vault-aware answers with *Insert at cursor* / *Append* / *Save as note*. |
| **Turn the selection into a note** | Selection as source material for a new note. |
| **Insert a Hermes answer at the cursor** | Inline help without leaving the editor. |
| **Open the chat panel** | Side panel with history, streaming, and note actions on every answer. |
| **Show / rescan vault conventions** | See exactly what the plugin learned about your vault. |
| **Test the Hermes connection** | Health + model discovery, with a plain-language diagnosis. |

Every write goes through a preview that shows the file name, a rendered preview, the raw Markdown you can edit, and the Obsidian syntax checks.

## Following Obsidian's rules

A model that knows Markdown still gets Obsidian wrong, so the plugin does two things:

1. **It carries the Obsidian format rules** — `---` YAML properties with no tabs and real date/boolean types, one H1 then H2/H3 without skipping levels, `[[Wikilinks]]` instead of `[path](note.md)`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `![[embeds]]`, nested `#tag/child`, `> [!note]` callouts, two-space list nesting, `- [ ]` tasks, code fences with a language, straight quotes, and the file-name characters Obsidian refuses to store.
2. **It learns your vault's conventions** before asking: which properties you use and their types, tag style, wikilink vs Markdown links, whether notes open with an H1, your file-name style, the callouts you actually use, and the notes in the target folder so links resolve to real notes.

Press **Show detected vault conventions** to inspect or rescan that analysis. Nothing but that summary and the notes you explicitly send ever leaves the vault.

## Install with BRAT

BRAT installs straight from this repo's GitHub releases, so no manual file copying:

1. Command palette → **BRAT: Add a beta plugin for testing**
2. Enter `jphermans/hermes-obsidian`
3. Enable **Hermes Agent Notes** in *Settings → Community plugins*

A release must exist with the three built files attached:

```bash
npm run build
gh release create v0.1.0 \
  --title "v0.1.0 — first release" \
  --notes "Connects Obsidian to a Hermes Agent instance and writes notes that follow the vault's own Obsidian conventions." \
  main.js manifest.json styles.css
```

Bump `manifest.json`, `package.json` and `versions.json` together before every release — BRAT only picks up a new version when `manifest.json` changes.

**Manual install instead** — copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/hermes-agent-notes/`.

## Setup

### 1. Enable the API server on the Hermes host

```bash
hermes config set API_SERVER_ENABLED true
hermes config set API_SERVER_KEY my-secret-key
hermes gateway stop && hermes gateway
```

The flag lands in `config.yaml`, the key in `~/.hermes/.env`. You should see `[API Server] API server listening on http://127.0.0.1:8642`.

### 2. Check it is reachable

```bash
curl -s http://127.0.0.1:8642/health
curl -s -H "Authorization: Bearer my-secret-key" http://127.0.0.1:8642/v1/models
```

### 3. Fill in the plugin

*Settings → Hermes Agent Notes*: API server URL (`http://127.0.0.1:8642`), the same API key, then **Test connection**. The status card turns green and shows the advertised model name.

### Remote instances

* Bind beyond loopback (`API_SERVER_HOST=0.0.0.0`) or publish through a tunnel, then use that address.
* **Prefer HTTPS.** iOS and Android are stricter than desktop about plain-HTTP traffic, so a TLS reverse proxy (Caddy, Tailscale, Cloudflare Tunnel) is the reliable path on mobile.
* The key guards a full agent with terminal access. Treat it like an SSH password.
* Several profiles: give each its own port and key, or enable `gateway.multiplex_profiles` and set the profile prefix — `/p/<profile>` accepts only that profile's own key.

### Streaming (optional)

Live token output is a browser request, so the Hermes side needs an explicit origin allowlist:

```
API_SERVER_CORS_ORIGINS=app://obsidian.md,capacitor://localhost,http://localhost
```

Restart the gateway afterwards. Desktop presents `app://obsidian.md`, iOS `capacitor://localhost`, Android `http://localhost`. With streaming off (the default) the plugin uses Obsidian's native HTTP client and no CORS entry is needed at all — and if a streaming request is refused, it falls back to that transport automatically.

## Mobile

The plugin is `isDesktopOnly: false` and was written for it:

* Obsidian's native `requestUrl` for every normal call — no CORS, no cleartext-traffic surprises from a browser transport, works on iOS and Android.
* No Node.js imports anywhere (that is what crashes plugins on mobile).
* No auto-focus on mobile, so the keyboard never covers a dialog; 16px inputs so iOS does not zoom; 44px touch targets in a responsive layout; clipboard fallback for older WebViews.
* The chat panel is a normal sidebar view, so it works on phones and tablets.

## Files and data

* Settings live in `<vault>/.obsidian/plugins/hermes-agent-notes/data.json` — including the API key. Keep the vault private, and prefer a key you can rotate.
* The plugin never modifies notes you did not ask it to touch; rewrites keep existing frontmatter values and add missing keys instead of replacing them.
* Requests go to your Hermes instance only. Session IDs are opt-in and only used so long runs appear in Hermes session history.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # tsc --noEmit + esbuild production
npm test         # unit tests + API/SSE tests against a mock Hermes server
```

`npm test` bundles the tested modules with `scripts/obsidian-stub.mjs` standing in for the Obsidian runtime (`js-yaml` stands in for its YAML parser, test-only), then runs:

* `scripts/selftest.mjs` — URL handling, file-name sanitising, model-output unwrapping, frontmatter split/merge, the syntax validator, prompt construction, the vault-convention scan, and real writes against an in-memory vault.
* `scripts/mock-server-test.mjs` — the shipped client against a mock Hermes API server: `/health`, `/v1/models`, `/v1/capabilities`, buffered and SSE completions, headers, and the 401/404 error mapping.
* `scripts/vault-dryrun.mjs <vaultPath> [sample]` — runs the convention engine over a real vault and prints what Hermes would be told (handy when tuning prompts).

## Licence

MIT — see `LICENSE`.
