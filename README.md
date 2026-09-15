<p align="center">
  <img src="banner.png" alt="Hermes Agent Notes — write and fix Obsidian notes with your own Hermes Agent, local or remote" width="960">
</p>

# Hermes Agent Notes

**Write and repair Obsidian notes with your own [Hermes Agent](https://github.com/NousResearch/hermes-agent) instance — local or remote — following your vault's Obsidian conventions.**

[![Release](https://img.shields.io/github/v/release/jphermans/hermes-obsidian?sort=semver)](https://github.com/jphermans/hermes-obsidian/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hermes runs on your machine or on a server you own. The plugin talks to its OpenAI-compatible API server, sends your request together with a summary of how *your* vault writes Markdown, and writes the finished note into the vault itself — on desktop and on iOS/Android. No third-party service is involved beyond whatever your Hermes instance already uses.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install with BRAT](#install-with-brat)
- [Setup](#setup)
- [Reachable from anywhere](#reachable-from-anywhere)
- [Keeping vault work in its own Hermes profile](#keeping-vault-work-in-its-own-hermes-profile)
- [Commands](#commands)
- [Following Obsidian's rules](#following-obsidians-rules)
- [Mobile](#mobile)
- [Data, privacy and safety](#data-privacy-and-safety)
- [Settings file and backup](#settings-file-and-backup)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Releasing (BRAT)](#releasing-brat)
- [Author](#author)

**Complete setup guide (web): <https://jphermans.github.io/hermes-obsidian/>** — every instance and route in one page, with copy buttons.

---

## How it works

1. **You ask.** "Meeting notes for the kitchen renovation kickoff", "improve this note", "fix the Obsidian formatting".
2. **The plugin adds context.** A summary of your vault's own conventions (properties and their types, tag style, link style, headings, file names, callouts) plus the names of notes in the target folder, so links resolve to real notes. It also carries the full Obsidian Markdown syntax rules.
3. **You confirm.** Hermes returns the complete note file; you see a rendered preview, the raw Markdown you can edit, the file name, and Obsidian syntax checks. Nothing is written until you press the button.

Hermes never needs access to your vault — the plugin does all the file work.

## Requirements

* Obsidian **1.5.0** or newer (desktop, iOS or Android).
* A Hermes Agent install with its API server enabled (`API_SERVER_ENABLED=true`) and reachable from the device running Obsidian.
* The `API_SERVER_KEY` from that instance.

## Install with BRAT

1. Install **BRAT** (*Obsidian42 - BRAT*) from Community plugins.
2. Command palette → **BRAT: Add a beta plugin for testing**.
3. Enter `jphermans/hermes-obsidian` and confirm.
4. Enable **Hermes Agent Notes** in *Settings → Community plugins*.
5. Open *Settings → Hermes Agent Notes* and fill in your Hermes connection.

BRAT installs the newest GitHub release. To update later: **BRAT: Check for updates to all beta plugins**.

<details>
<summary>Manual install instead</summary>

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jphermans/hermes-obsidian/releases/latest) and place them in `<vault>/.obsidian/plugins/hermes-agent-notes/`, then enable the plugin.
</details>

## Setup

> **Complete setup guide for every instance — same machine, LAN, Tailscale, Cloudflare Tunnel, ngrok, a TLS reverse proxy, a dedicated profile, or Hermes on the phone itself: <https://jphermans.github.io/hermes-obsidian/>**
>
> It is the long-form version of the sections below, with a copy button on every command and a verify checklist that walks outward from the server. The same guide is in the plugin: **Settings → Hermes Agent Notes → Setup guide**.
>
> The setup page stays short on purpose: the per-route recipes live behind the **How do you reach Hermes?** dropdown (that route's commands, URL shape, headers and a *Test this route* button — plus a link to its walkthrough), and the guide itself lists the routes as links instead of printing every recipe at once.

Settings → **Hermes Agent Notes** opens on the setup page, with the installed build as a label at the top — `Hermes Agent Notes` next to a **v0.1.30** badge, and the current connection state beside it. Click the badge to copy the version for a bug report. A BRAT update that has not been reloaded shows up here immediately.

### 1. Enable the API server on the Hermes host

Put these in `~/.hermes/.env` — the enable flag and the key are **environment variables**, not `config.yaml` keys:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=my-secret-key
# API_SERVER_HOST defaults to 127.0.0.1 — this device only. Set it when another
# device has to reach the port: 0.0.0.0 for the LAN (desktop only — phones need
# HTTPS) or the VPN address for WireGuard. A tunnel or proxy needs nothing here.
```

```bash
hermes gateway stop && hermes gateway
```

You should see:

```
[API Server] API server listening on http://127.0.0.1:8642
```

### 2. Check that it answers

```bash
curl -s http://127.0.0.1:8642/health
curl -s -H "Authorization: Bearer my-secret-key" http://127.0.0.1:8642/v1/models
```

The first returns `{"status": "ok"}`; the second lists the agent as a model. A `401` means the key does not match.

### 3. Fill in the plugin

*Settings → Hermes Agent Notes*:

| Field | Value |
| --- | --- |
| API server URL | `http://127.0.0.1:8642` (no `/v1` suffix; a port is optional) |
| API key | the same value as `API_SERVER_KEY` |
| Model | leave `hermes-agent` — Hermes normally uses its own configured default |
| Profile prefix | only when the gateway serves several profiles |

On a phone or tablet, `127.0.0.1` / `localhost` cannot be saved: that address points at the phone itself. Use the https:// address of your Tailscale, Cloudflare Tunnel or ngrok route (see below), or press *Save anyway* if Hermes really runs on that device.

Two timeouts keep the plugin responsive: **Connection check timeout** (15 s default) covers `/health`, `/v1/models` and `/v1/capabilities`, and **Answer timeout** (5 min default, `0` = unlimited) covers a full answer, since agent turns can legitimately take minutes.

Press **Test connection**. A green card with the advertised model name means you are connected.

Then type a prompt in **Ask Hermes** (just below the connection fields) and press *Send to Hermes*: the answer appears in place, with the model, the round-trip time and whether it streamed. That goes through the plugin's normal path — Obsidian rules, your vault conventions, session headers — so it proves the whole chain works, not just that the port is open. It writes nothing to the vault, and it is the quickest way to check a new route from a phone. Four sample prompts are one click away, including *Describe my vault's style*, which shows whether the vault scan reached Hermes.

### Remote instances

* Bind beyond loopback (`API_SERVER_HOST=0.0.0.0`) or publish it through a tunnel, then use that address in the plugin.
* **Prefer HTTPS.** iOS and Android are far stricter than desktop about plain-HTTP traffic, so a TLS reverse proxy (Caddy, Tailscale, Cloudflare Tunnel) is the reliable path on mobile.
* The key protects a full agent with terminal access. Treat it like an SSH password.
* **Several profiles:** give each its own port and key, or enable `gateway.multiplex_profiles` and set the profile prefix — `/p/<profile>` accepts only that profile's own key.

### Streaming (optional)

Live token output is a browser request, so the Hermes side needs an explicit origin allowlist:

```
API_SERVER_CORS_ORIGINS=app://obsidian.md,capacitor://localhost,http://localhost
```

Restart the gateway afterwards. Desktop presents `app://obsidian.md`, iOS `capacitor://localhost`, Android `http://localhost`. With **Stream answers** off (the default) the plugin uses Obsidian's native HTTP client and needs no CORS entry at all — and if a streaming request is refused, it falls back to that transport automatically.

## Reachable from anywhere

**If you would rather read one page that covers all of it** — every route below plus LAN, a reverse proxy, a dedicated profile, Hermes on the phone, and a verify checklist — that page is <https://jphermans.github.io/hermes-obsidian/>.

Phones and tablets refuse plain HTTP to another machine (iOS ATS, Android network security), so `http://192.168.x.x:8642` works on desktop but not on mobile. Expose the API server over HTTPS and the same URL works from every device, on any network.

The setup page asks **How do you reach Hermes?** — local, same-network, Tailscale, Cloudflare Tunnel, ngrok, or a custom HTTPS proxy — and then shows that route's commands, its URL shape, the headers it needs, whether phones can use it, and a **Test this route** button. Nothing is rewritten behind your back: press *Use …* to drop the URL template in, *Insert needed headers* to add what the route requires.

```bash
# Tailscale — HTTPS address for every device on your tailnet, nothing public
tailscale serve --bg 8642          # then use https://<machine>.<tailnet>.ts.net

# Cloudflare Tunnel — public HTTPS hostname without opening a port
cloudflared tunnel --url http://127.0.0.1:8642

# ngrok — quick public HTTPS URL for testing from a phone
ngrok http 8642
ngrok http --url=your-name.ngrok.app 8642      # reserved domain, stable URL
```

```caddyfile
# Caddy on the host: automatic HTTPS in front of the API server
hermes.example.com {
    reverse_proxy 127.0.0.1:8642
}
```

Keep the API server bound to `127.0.0.1` and let the tunnel or proxy be the only way in. The plugin treats an `https://…` URL exactly like a local one — same transport, same streaming behaviour, no extra configuration.

**The port is optional.** Omit it when the tunnel or proxy terminates HTTPS on 443: `https://hermes.example.com` is a valid API server URL and the plugin requests `https://hermes.example.com/v1/…`. A port is only needed when nothing sits on the default 80/443 — a direct API server (`:8642`) or a LAN address. You can also leave the scheme out: a public hostname is treated as `https`, a LAN or loopback address as `http`.

**Behind Cloudflare Access, an authenticating proxy or a gateway that wants its own headers**, add them in *Extra request headers* (one `Name: value` per line):

```
CF-Access-Client-Id: xxxx.access
CF-Access-Client-Secret: yyyy
```

A header named `Authorization` replaces the API key. The plugin warns you in-app when the configured URL is plain HTTP while you are on a mobile device, and it names HTTPS as the fix instead of failing silently.

**Two gotchas on these routes.** Cloudflare Tunnel quick tunnels get a new random URL on every restart — use a named tunnel for anything permanent, and put Cloudflare Access (service token) in front of it. ngrok's free tier shows an interstitial page to browsers, which the suggested `ngrok-skip-browser-warning: true` header skips; do **not** use `ngrok --basic-auth`, because its `Authorization` header would replace your Hermes API key.

### WireGuard — your own VPN, no third party

Tailscale *is* WireGuard with the coordination, key exchange and certificates handled for you. If you would rather run the tunnel yourself — no account, no vendor in the path — install WireGuard on the Hermes host and connect your devices to it. Only **one UDP port** needs to be open, and the API server then answers on its private VPN address. Full walkthrough with every platform: <https://jphermans.github.io/hermes-obsidian/#wireguard>.

**Install WireGuard — every system:**

| System | Install |
|---|---|
| **Debian · Ubuntu · Mint** (host) | `sudo apt install wireguard` |
| **RHEL · CentOS · Fedora** (host) | `sudo dnf install wireguard-tools` |
| **Arch · Manjaro** (host) | `sudo pacman -S wireguard-tools` |
| **Alpine** (host) | `sudo apk add wireguard-tools` |
| **macOS** (host) | WireGuard from the App Store, or `brew install wireguard-tools` for a headless Mac |
| **Windows** (host) | installer from [wireguard.com/install](https://www.wireguard.com/install/) |
| **Clients** | App Store (iOS/iPadOS/macOS), Play Store or F-Droid (Android), wireguard.com/install (Windows/Linux/BSD) — one key pair each |

```bash
# on the Hermes host — one key pair for the server
wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub
```

```ini
# /etc/wireguard/wg0.conf — the host
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <contents of server.key>

[Peer]                              # one block per device
PublicKey = <that device's public key>
AllowedIPs = 10.8.0.2/32            # just this device — keep it tight
```

```ini
# the device's own config — import it in the app
[Interface]
Address = 10.8.0.2/32
PrivateKey = <this device's private key>

[Peer]
PublicKey = <contents of server.pub>
Endpoint = your-host.example.com:51820   # the host's public address
AllowedIPs = 10.8.0.0/24            # the VPN subnet only, not 0.0.0.0/0
PersistentKeepalive = 25            # keeps the NAT hole open
```

```bash
# on the host: bring it up and keep it up
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0
sudo ufw allow 51820/udp                  # the only port to open

# the API server must listen on the VPN address, or the tunnel cannot reach it
#   ~/.hermes/.env:  API_SERVER_HOST=10.8.0.1
hermes gateway stop && hermes gateway

curl -s http://10.8.0.1:8642/health       # from a connected device
```

- **API server URL:** `http://10.8.0.1:8642` (the host's VPN address) · **extra headers:** none.
- **A phone still needs HTTPS.** The VPN removes the exposure, not the OS rule: iOS and Android refuse plain HTTP to a non-loopback address even over a VPN. Desktop works immediately; for phones put TLS on top (Caddy with a DNS-01 certificate) or use [Tailscale](#reachable-from-anywhere), which does exactly that. That is the whole difference between the two.
- **CGNAT blocks it.** Without a reachable public address from your ISP (common on mobile and some fibre plans) an inbound WireGuard endpoint cannot work — that is the case for Tailscale or Cloudflare Tunnel instead of a port forward.
- **What you are trusting:** there are no accounts and no reset — the private key *is* the identity, so keep those files off shared machines. The tunnel reaches the whole host, so keep `AllowedIPs` narrow, open only UDP 51820, and firewall the VPN interface to port 8642 if a device should reach nothing else.

### A permanent URL: Cloudflare Tunnel (named)

A *named* tunnel keeps one hostname forever and runs as a background service, so the plugin's URL never changes. It needs a domain on Cloudflare (the free plan is enough).

**Install `cloudflared` on the Hermes host — every system:**

| System | Install | Notes |
|---|---|---|
| **macOS** | `brew install cloudflared` | or the [darwin arm64/amd64 `.tgz`](https://github.com/cloudflare/cloudflared/releases/latest) |
| **Windows** | `winget install --id Cloudflare.cloudflared -e` | reopen the terminal afterwards so it is on `PATH` |
| **Windows** (no winget) | run the [`.msi`](https://github.com/cloudflare/cloudflared/releases/latest), or copy the `.exe` to `C:\Cloudflared\bin\cloudflared.exe` and call it by full path | |
| **Debian · Ubuntu · Mint** | `sudo mkdir -p --mode=0755 /usr/share/keyrings`<br>`curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \| sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null`<br>`echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \| sudo tee /etc/apt/sources.list.d/cloudflared.list`<br>`sudo apt-get update && sudo apt-get install cloudflared` | Cloudflare's own repository, so `apt upgrade` keeps it current |
| **RHEL · CentOS · Fedora** | `curl -fsSl https://pkg.cloudflare.com/cloudflared.repo \| sudo tee /etc/yum.repos.d/cloudflared.repo`<br>`sudo yum update && sudo yum install cloudflared` | `dnf` on modern Fedora/RHEL |
| **Arch · Manjaro** | `sudo pacman -Syu cloudflared` | official repositories, no AUR needed |
| **Docker / NAS** | `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <token>` | dashboard-created (remotely-managed) tunnels only; a locally-managed one needs its `.json` credentials mounted in |
| **Other Linux** | direct [AMD64 · 386 · ARM · ARM64](https://github.com/cloudflare/cloudflared/releases/latest) binaries, plus `.deb`/`.rpm` | `chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/` |

If you create the tunnel in the Cloudflare **dashboard**, copy the install command it shows you — it is already correct for the machine you are on.

```bash
# 2. Create the tunnel and point a hostname at it (identical on every system)
cloudflared tunnel login                  # browser: pick the zone to authorise
cloudflared tunnel create hermes          # prints the tunnel UUID and credentials file
cloudflared tunnel route dns hermes hermes.example.com
```

```yaml
# ~/.cloudflared/config.yml — name → UUID, credentials, and what to proxy
tunnel: 7b9c1f38-2f4c-4a2e-9c11-3f0a5b6d7e80
credentials-file: /Users/you/.cloudflared/7b9c1f38-2f4c-4a2e-9c11-3f0a5b6d7e80.json
ingress:
  - hostname: hermes.example.com
    service: http://127.0.0.1:8642
  - service: http_status:404
```

On **Windows** the same file lives at `%USERPROFILE%\.cloudflared\config.yml` with Windows paths (`credentials-file: C:\Users\you\.cloudflared\<UUID>.json`, optional `logfile: C:\Cloudflared\cloudflared.log`), and the binary may need its full path. Validate the rules with `cloudflared tunnel ingress validate`.

```bash
# 3. Test it, then make it permanent — the service step differs per system
cloudflared tunnel run hermes             # Ctrl-C once the hostname answers

# macOS
cloudflared service install               # launch agent: starts at login
sudo cloudflared service install          # or launch daemon: starts at boot
sudo launchctl start com.cloudflare.cloudflared
# logs: /Library/Logs/com.cloudflare.cloudflared.{out,err}.log

# Linux (systemd)
sudo cloudflared service install
# sudo makes $HOME=/root, so if the config is in your own home, name it explicitly:
sudo cloudflared --config /home/<USER>/.cloudflared/config.yml service install
sudo systemctl start cloudflared
systemctl status cloudflared              # systemctl restart cloudflared after a config change

# Windows
cloudflared.exe service install
# a service runs as the SYSTEM account: its home is
# C:\Windows\System32\config\systemprofile\.cloudflared\ — put cert.pem,
# the <UUID>.json credentials and config.yml there, then set ImagePath in
#   HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Cloudflared
# to: C:\Cloudflared\bin\cloudflared.exe --config=C:\Windows\System32\config\systemprofile\.cloudflared\config.yml tunnel run
sc start cloudflared                      # sc stop / sc start to reload config

cloudflared tunnel info hermes            # status and connections, every system
```

The Windows service is the fiddly one because the *service identity*, not you, reads the config. Shortcut: create the tunnel in the dashboard and install it in **token** form (`cloudflared.exe service install <token>`), which leaves the configuration on Cloudflare's side. The dashboard route (**Networking → Tunnels → Create a tunnel → Published application**) does the same as the CLI and the connector it gives you also runs as a service.

**Put Cloudflare Access in front of it** so the hostname is not open to the internet. In **Zero Trust → Access controls → Service credentials → Service Tokens**, create a token (**Service Token Duration** — nothing lasts forever, and Cloudflare can alert you a week before it expires), then create an Access application for the hostname with a policy whose action is **Service Auth** — a plain *Allow* policy will still ask for an identity provider login and fail a non-browser client. Paste the two headers it shows you into the plugin's *Extra request headers*:

```
CF-Access-Client-Id: 88bf3b6d86161464f6509f7219099e57.access
CF-Access-Client-Secret: bdd31cbc4dec990953e39163fbbb194c93313ca9f0a6e420346af9d326b1d2a5
```

### A permanent URL: ngrok

ngrok gives your account a **static domain**, which is what makes it usable as a permanent URL — claim it in the dashboard under **Domains → New Domain**, then use it everywhere instead of the random quick-tunnel URL.

**Install the ngrok agent — every system:**

| System | Install |
|---|---|
| **macOS** | `brew install ngrok` |
| **Windows** | `winget install ngrok -s msstore` — or `scoop install ngrok`, or `choco install ngrok` (ngrok publishes the Chocolatey package) |
| **Debian · Ubuntu** | `curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \| sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null`<br>`echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \| sudo tee /etc/apt/sources.list.d/ngrok.list`<br>`sudo apt update && sudo apt install ngrok` (swap `bookworm` for your codename) |
| **Any Linux (snap)** | `sudo snap install ngrok` |
| **Any Linux / FreeBSD / Pi** | standalone binary: `sudo tar -xvzf ~/Downloads/ngrok-v3-stable-linux-amd64.tgz -C /usr/local/bin` |
| **Docker / NAS** | `docker run --net=host -v ~/.config/ngrok/ngrok.yml:/etc/ngrok.yml ngrok/ngrok:latest start --all --config /etc/ngrok.yml` |

```bash
ngrok config add-authtoken <your-authtoken>       # dashboard.ngrok.com → Your Authtoken
```

```yaml
# ngrok.yml — macOS: ~/Library/Application Support/ngrok/ngrok.yml
#             Linux: ~/.config/ngrok/ngrok.yml
#             Windows: %LOCALAPPDATA%\ngrok\ngrok.yml
# Not sure where yours is? `ngrok config edit` opens it, `ngrok config check` locates it.
# Agent v3 config — `tunnels:` is deprecated.
version: 3
agent:
  authtoken: <your-authtoken>
endpoints:
  - name: hermes
    url: https://your-name.ngrok.app
    upstream:
      url: 8642
```

```bash
ngrok config check                        # validates the file
ngrok start hermes                        # test it

ngrok service install --config "$HOME/Library/Application Support/ngrok/ngrok.yml"
ngrok service start                       # now it survives reboots, like the Cloudflare service
```

The free-tier interstitial page is skipped by the plugin's `ngrok-skip-browser-warning: true` header under *Extra request headers* — ngrok does **not** let you add that header through traffic policy on a free account, so it has to come from the client. And never `ngrok --basic-auth`: its `Authorization` header would replace your Hermes API key.

### Keeping the whole chain up

A permanent URL only helps if everything behind it is also permanent:

```bash
# 1. The Hermes gateway itself as a service (not a terminal you have to keep open)
hermes gateway install && hermes gateway start
hermes gateway status                     # per profile: hermes -p obsidian gateway status

# 2. The tunnel as a service — cloudflared service install / ngrok service start (above)

# 3. The host must not sleep: an always-on machine is the reliable answer
sudo pmset -a sleep 0                     # macOS, all power sources
# Linux: systemd services keep running across logouts once lingering is on
sudo loginctl enable-linger "$USER"
```

Keep the API server itself bound to `127.0.0.1` — the tunnel is then the only way in. Verify from outside the network, not just locally:

```bash
curl -sS https://hermes.example.com/health -H "Authorization: Bearer <your-key>"
```

Then press **Test connection** in the plugin; the connection card reports the round trip, and **Test this route** under *How do you reach Hermes?* checks the route you picked.

**Security.** The key protects a full agent with terminal access on that machine. Prefer Tailscale or Cloudflare Access over a bare public port, and rotate `API_SERVER_KEY` if it ever leaks.

## Keeping vault work in its own Hermes profile

By default the plugin talks to your **main** Hermes profile, so every prompt and answer from this vault is stored in the same session store and memory as everything else you do with Hermes — `hermes sessions` lists them side by side. If you would rather keep vault work in one place on the Hermes host, give it its own **profile**. A profile *is* a separate folder:

**Create it first — on the Hermes host.** The profile is a host-side thing: the plugin only sends HTTP requests, so it cannot create one for you, and it cannot check whether one exists. Until the profile exists *and* its API server is listening, the plugin has nothing to talk to — you will see HTTP **404** (wrong port or a prefix for a profile that is not being served) or **401** (a key belonging to another profile). You do **not** have to do this before installing or configuring the plugin, though: start on your default profile and switch later, because the whole connection is just settings. `obsidian` below is an example name — use your own. No shell handy? `hermes dashboard` → **Profiles** creates, activates and deletes profiles too, and the desktop app has the same page.

```
~/.hermes/profiles/obsidian/
├── config.yaml     # its own model, provider, toolsets
├── .env            # its own API_SERVER_KEY (and API_SERVER_PORT)
├── SOUL.md         # its own personality
├── memories/       # MEMORY.md / USER.md — nothing from your other agent
├── sessions/       # routing index
└── state.db        # every prompt and answer that came from the vault
```

```bash
hermes profile create obsidian      # creates the profile and an `obsidian` command
obsidian setup                      # its own model and provider keys
```

Enable its API server in **that profile's** `.env` — `~/.hermes/profiles/obsidian/.env` (the flag is an environment variable, not a `config.yaml` key):

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a key just for this profile>
API_SERVER_PORT=8643
# API_SERVER_HOST defaults to 127.0.0.1 — set 0.0.0.0 (LAN) or the VPN address
# when another device has to reach it. A tunnel or proxy needs nothing here.
```

```bash
obsidian gateway start
```

Then point the plugin at it, either way:

| | How | Plugin settings |
|---|---|---|
| **Its own port** (simplest) | The profile's gateway listens on 8643 | *API server URL* `http://<host>:8643`, *API key* = that profile's key, *Profile prefix* empty |
| **One gateway, many profiles** | On the **default** profile: `hermes config set gateway.multiplex_profiles true`, then `hermes gateway restart`. In this mode a secondary profile must **not** run its own gateway | URL unchanged (`:8642`), *Profile prefix* `obsidian` → requests go to `/p/obsidian/v1` and are authenticated with that profile's own key |

What this buys you:

- **Sessions and memory are separate.** Nothing the plugin sends appears in your main agent's session history or `MEMORY.md`, and nothing from other work leaks into the vault agent's context.
- **Its own `SOUL.md`**, so the vault agent answers as your notes assistant rather than as your general-purpose agent with vault text mixed into its context.
- **Its own key**, so the plugin's credential can be rotated or revoked without touching anything else.
- `/v1/models` advertises the **profile name** (`obsidian`), which is how you confirm the routing took effect — it appears in the plugin's model dropdown.

Save the live connection once under **Saved setup** ("Save this setup") so you can switch back to it after experimenting. There is deliberately only **one** saved setup — saving again replaces it, so nothing can be ambiguous about which one is live.

**A URL-selected profile only accepts a key of at least 16 characters.** Hermes resolves a named profile's key with `has_usable_secret(key, min_length=16)` and treats anything shorter as unusable, so it computes an expected key of empty and answers **401 whatever the plugin sends** — even when the `.env` and the plugin hold the same string. The default scope's own guard is far more lenient, which is why this only appears once a prefix is set. Generate one properly:

```bash
openssl rand -hex 24        # 48 characters — into that profile's .env, restart, re-paste
```

The plugin warns about this under the API key field whenever a profile prefix is set.

**Two things to watch.** Two profiles that both leave `API_SERVER_PORT` unset will both try to bind **8642** — give each one its own port. And under multiplexing you only manage the *default* profile's gateway; a secondary profile's gateway must stay stopped.

**Finer control.** Each conversation already travels in its own lane: the plugin sends `X-Hermes-Session-Id` per conversation, with a memory-scope key of `obsidian:<VaultName>:<sessionId>`. Turning off **Report the conversation to Hermes sessions** (Settings → *Conversation*) means nothing is written to the Hermes session store at all — at the cost of session history and background-delegation delivery.

## Commands

| Command | What it does |
| --- | --- |
| **Copy, move or delete notes** | Ask for a file operation — the plan is shown for approval, deletes go to the trash by default. |
| **Open the chat panel** | Sidebar conversation with history, streaming and note actions. While Hermes works, an animated indicator pulses in the pending bubble instead of the word "Thinking…". |
| **Create a note from a prompt** | Writes a complete new note — properties, headings, wikilinks, tags — for you to confirm. |
| **Improve the active note** | Rewrites the open note, keeping every existing property, link and fact — shown as a diff to approve or reject. |
| **Rewrite the active note with an instruction** | "shorter", "add a decisions table", "split this into a project note". |
| **Fix the active note for Obsidian** | Repairs Obsidian syntax only — broken wikilinks, illegal characters, malformed frontmatter, heading jumps, curly quotes — without touching your prose. |
| **Ask Hermes about the active note** | Vault-aware answers with *Insert at cursor* / *Append* / *Save as note*. |
| **Turn the selection into a note** | Uses the selected text as source material. |
| **Insert a Hermes answer at the cursor** | Inline help without leaving the editor. |
| **Test the Hermes connection** | Health check plus model discovery, with a plain-language diagnosis. |
| **Show detected vault conventions** | See exactly what the plugin learned — and rescan it. |
| **Rescan vault conventions** | Force a fresh analysis. |
| **Open the chat panel** | Sidebar conversation with quick-prompt chips, saved connections, model switching and searchable history. |
| **Chat history** | Every finished turn is stored in `history.json`; the 🕘 button searches it and restores a conversation into the panel. |
| **Switch connection** | Save the current endpoint as a named profile (Local, Server) and switch between them in one click under *Connections*. |

**Asking for a new note never touches the note you have open.** If the request is *"create a new note about…"*, *"make a note titled…"*, *"write a note…"*, *"create a file…"*, then the open note is deliberately **left out of the request** (the vault conventions still go in), and the answer offers a single primary action — **Create note** — with no Insert or Append. So the new note is written as its own file and never appended to the note you happen to be looking at. Questions ("What links should this note have?", "Fix the Obsidian formatting of this note") keep the normal Insert / Append / Save as note / Copy row.

**Answers going into a note lose the assistant's own remarks.** When you use *Insert*, *Append* or *Save as note*, trailing "Let me know if you want more…" / "Note: I can only see the conventions you shared" lines — and a conversational "Sure, here's…" opener — are removed before the text lands in the note, and the notice tells you how many lines were dropped. It is conservative by design: a factual `Note: the warranty expires in 2029.` survives, code blocks are never touched, and *Copy* always gives the raw answer. Turn it off with **Strip caveats from answers** in the settings. Generated notes are never touched by this.

### Bringing notes in with `@`, and commands with `/`

Type **`@`** in the message box: a picker lists your notes, and the one you choose is written into the message as `@[[Note name]]`. That note's **full content travels with the request** (up to four notes, capped so the request stays affordable), alongside the open note. Names resolve the way Obsidian does — exact name, then case-insensitive, then a path like `House/Kitchen renovation` — and a name matching nothing, or two different notes, is reported instead of guessed. Arrow keys move, Enter or Tab picks, Escape closes.

Type **`/`** for commands, which either expand into a message (handled by the normal pipeline, vault conventions and all) or run a local action:

| Command | What it does |
| --- | --- |
| `/note <topic>` | Asks for a new note about a topic — goes through the new-note path, never into the open note |
| `/fix` | Fixes the Markdown and Obsidian formatting of the open note |
| `/improve <instruction>` | Rewrites the open note, keeping every fact (`/improve make it shorter`) |
| `/links` | Which notes the open note should link to, and why |
| `/tags` | Suggests tags following your vault's conventions |
| `/context` | Toggles sending the open note with the message |
| `/conventions` | Shows what the plugin learned about your vault |
| `/clear` | Starts a new conversation |
| `/settings` | Opens the plugin settings |
| `/help` | Lists these commands in the chat |

Nothing in the command list can write to your vault on its own — a command produces an answer, and the answer still goes through the usual Create / Insert / Append confirmation.

### Reviewing an edit: approve or reject

**Improve the active note**, **Rewrite the active note with an instruction** and **Fix the active note for Obsidian** load the note into a review window instead of writing anything. The window opens on a **Changes** tab: the note as it is on disk against the version Hermes proposes, line by line, with additions and removals marked, and a summary (*"12 lines added, 4 lines removed"*) at the top. A **Preview** tab renders the result, and **Markdown** lets you correct it by hand before saving.

Then it is a straight yes or no: **Approve & save** writes the note (⌘/Ctrl+Enter does the same), **Reject** leaves the file exactly as it was — you get a *"Rejected — the note was left untouched"* confirmation rather than silence. Existing properties are still merged, so nothing in your frontmatter is dropped.

If the note is edited elsewhere while the review window is open, approval refuses to write and says so, instead of overwriting changes you have not seen. Notes that are too large to compare line by line say so and show the result instead of a fake diff.

### One job at a time

Everything that talks to Hermes goes through a queue, so a second command never collides with the first:

* pick another command while one is running and it is queued — *"Queued behind Improve note"* — and runs when the first finishes;
* type in the chat panel while an answer is streaming and the message is queued, then sent automatically; **Cancel waiting** in the composer drops the ones you changed your mind about;
* the line under the composer shows what is running, how many commands are queued, and how many of your messages are waiting;
* while a turn is waiting its turn, the pending bubble says *"Waiting for …"* instead of pretending to think.

A job that fails does not strand the queue — the ones behind it still run.

## Following Obsidian's rules

A model that knows Markdown still gets Obsidian wrong, so the plugin does two things.

**It carries the Obsidian format rules** — `---` YAML properties with no tabs and real date/boolean types, one H1 then H2/H3 without skipping levels, `[[Wikilinks]]` instead of `[path](note.md)`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `![[embeds]]`, nested `#tag/child`, `> [!note]` callouts, two-space list nesting, `- [ ]` tasks, tables, fenced code with a language, straight quotes, and the file-name characters Obsidian refuses to store.

**It learns your vault first** — which properties you use and their types, whether values are quoted, tag style, wikilink versus Markdown links, whether notes open with an H1, your file-name style, the callouts you actually use, and the notes in the target folder so wikilinks point at real notes.

Every generated note is checked before it is written: property/word/link counts, balanced `[[ ]]`, `.md` links that should be wikilinks, heading level jumps, tabs in YAML, unparsed frontmatter, illegal file-name characters.

On a rewrite, existing frontmatter values are preserved and missing keys added — properties are never silently replaced.

**A note is named after its content, never after the assistant.** The title (and therefore the file name) comes from what the note says: the `title` property or the H1 the agent wrote. If an answer arrives without either, the agent is asked to name it. `Hermes`, `AI`, `Assistant`, `Answer`, `Note` and `Untitled` are refused as titles and file names, and so is your own request text — *"make it shorter"* can never become a file name. Only when the agent cannot be reached does the plugin fall back to the first real line of the note, and the title is always visible in the confirmation before it is written.

### If tokens do not appear one by one

Streaming is **off by default** (it needs one thing on the Hermes side that is easy to forget), and the chat panel now says under every answer how it actually arrived: *streamed live*, *one piece — something is buffering the stream*, *streaming refused — delivered whole*, or *delivered whole (streaming is off)*.

Four things stop it, in order of likelihood:

1. **The setting is off.** Settings → *Stream answers*, then press **Verify streaming**. The report tells you whether events arrive, how long the first token took — or exactly which side refused.
2. **CORS.** Streaming is a browser request, so Hermes has to allow this app's origin. On the machine running the gateway, add to `~/.hermes/.env`:
   `API_SERVER_CORS_ORIGINS=app://obsidian.md,capacitor://localhost,http://localhost`
   then `hermes gateway stop && hermes gateway`. Desktop, iOS and Android each present a different origin, so keep all three.
3. **A proxy is buffering.** nginx needs `proxy_buffering off;` on the API route, and Cloudflare or a tunnel must have buffering disabled. The plugin detects this: the answer arrives in one piece, it says so, and *Verify streaming* names the cause.
4. **The server ignores `stream: true`** and answers with JSON — *Verify streaming* says exactly that instead of calling the answer empty.

Every refusal is written to the error log as well (Settings → Diagnostics), with the endpoint, so the reason is still there afterwards.

## Copying, moving and deleting notes

Ask in the chat — *"move the boiler note into Archive"*, *"duplicate the template for each room"*, *"delete the 2025 drafts"* — or run **Hermes: Copy, move or delete notes**. The division of labour is deliberate:

1. **Hermes plans it.** Your request plus the real note paths go to the agent, which returns a literal plan (`move`, `copy`, `delete` with exact paths). It never touches the vault itself.
2. **The plugin validates it against your vault.** Every path is resolved against notes that actually exist; anything it cannot do becomes a line with a reason instead of a guess.
3. **You approve it.** A modal lists each operation with a tick box — untick anything you do not want — and deletions offer *Move to trash* (the default) or *Delete permanently*.

What it refuses, on purpose:

* overwriting an existing note — a destination that is taken is skipped, never clobbered;
* notes that are not Markdown, and anything inside `.obsidian`;
* paths that try to leave the vault (`..`);
* ambiguous names (two notes called the same thing) — a path such as `House/Kitchen renovation.md` is the way to disambiguate;
* more than 25 operations in one plan.

A move goes through Obsidian's own rename, so **wikilinks and embeds follow the note**. A delete uses Obsidian's own delete, which honours your *Files & Links → Deleted files* preference. Every applied operation is reported in the chat, and every failure is written to the error log.

Two settings under **Files**: *Copy, move and delete notes* (on by default — turn it off to remove the capability entirely) and *Deleting a note* (trash or permanent, which just preselects the radio button in the modal).

## Mobile

Hermes Agent Notes is `isDesktopOnly: false` and was written for mobile from the start:

* Obsidian's native `requestUrl` for every normal call — no CORS, no browser cleartext-traffic restrictions, identical on iOS and Android.
* No Node.js imports anywhere (the usual reason plugins crash on mobile).
* No auto-focus on mobile, so the keyboard never covers a dialog; 16px inputs so iOS does not zoom the viewport; 44px touch targets; responsive layout; clipboard fallback for older WebViews.
* The chat panel is a normal sidebar view, so it works on phones and tablets. Its working indicator is a pure CSS animation and is switched off automatically for *reduce motion*.

The vault-convention scan reads from Obsidian's cache and takes ~20 ms on a 585-note vault.

## Data, privacy and safety

* Settings — including the API key and any extra headers — live in `<vault>/.obsidian/plugins/hermes-agent-notes/data.json`. Keep the vault private and prefer a key you can rotate.
* Only two things leave the vault: the conventions summary and the notes you explicitly send as context (trimmed to ~12 000 characters). The scan itself never leaves your machine.
* The plugin never touches a note you did not ask it to change, and every write goes through the preview.
* Requests go only to the Hermes URL you configure. Session reporting is opt-in and exists so long runs appear in Hermes session history.

## Settings file and backup

Settings normally live in `<vault>/.obsidian/plugins/hermes-agent-notes/data.json`. Two extra files keep them safe:

| File | Where | Purpose |
| --- | --- | --- |
| Automatic backup | `.obsidian/plugins/hermes-agent-notes/settings-backup.json` | Written (debounced, ~1.2 s) after every settings change when *Automatic backup file* is on — the default. Recovers your setup if the plugin folder is wiped by a reinstall or a sync conflict. |
| Exported settings | `<default folder>/Hermes Agent Notes settings.json` | Written only when you press **Export to the vault**. A visible file you can read, version or move between machines. |

**Restore** — either pick a JSON file from the vault (**Restore from a file…**) or read the automatic backup back (**Restore automatic backup**). Imports are validated: unknown keys and values of the wrong type are skipped and reported in the notice, so a stale or hand-edited file cannot half-break your setup. Caches (the vault analysis, the last connection state) are never exported or imported — they are rebuilt.

Both files contain your **API key and any extra headers** in plain text, because that is the point of a backup. Keep the vault (and anything synced from it) private, or export to a folder you control.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Connection failed — could not reach Hermes** | Is `hermes gateway` running with `API_SERVER_ENABLED=true`? Is the host/port right, and reachable from this device? |
| **HTTP 401 / rejected the request** | The API key does not match `API_SERVER_KEY` on the host. |
| **HTTP 404** | Wrong base URL, or a profile prefix set while the gateway is not running in multi-profile mode. Remove any `/v1` suffix from the URL. Also: a profile that does not exist yet (or one whose API server is not listening) answers 404 — create it on the Hermes host first, the plugin cannot do that for you. |
| **HTTP 429** | Too many concurrent runs on the Hermes side — retry, or raise `gateway.api_server.max_concurrent_runs`. |
| **No model in the dropdown** | Harmless: `/v1/models` advertises one agent name. Press *Test connection* and use that name. |
| **Streaming was refused** | Add the `API_SERVER_CORS_ORIGINS` line above and restart the gateway, or turn streaming off. |
| **Phone cannot reach the instance at all** | Plain HTTP to another machine is blocked on mobile. Use HTTPS — Tailscale, Cloudflare Tunnel or a TLS reverse proxy. Loopback (`http://127.0.0.1:…`, Hermes running on the same device) is the one exception. |
| **The URL changes every time I restart the tunnel** | That is a quick tunnel. A *named* Cloudflare tunnel (`cloudflared tunnel create` + `tunnel route dns` + the service step for your OS) and an ngrok **static domain** both keep one URL, and both run as services — see [A permanent URL](#a-permanent-url-cloudflare-tunnel-named). |
| **cloudflared is not on my PATH** | On Windows, reopen the terminal after `winget install`, or call `C:\Cloudflared\bin\cloudflared.exe` by full path. On Linux, the service runs as root — `sudo cloudflared --config /home/<user>/.cloudflared/config.yml service install` if the config lives in your home. |
| **The tunnel is up but the plugin still fails** | Check the layers in this order: `hermes gateway status` (the API server itself), the tunnel service (`cloudflared tunnel info hermes`, or `ngrok` service status), then the host — a sleeping machine drops the tunnel. `curl https://your-host/health` from a phone on mobile data tells you which layer is down. |
| **Over WireGuard, can a phone connect?** | Not with plain HTTP — iOS and Android refuse cleartext to a non-loopback address even over a VPN, so the phone needs TLS in front (Caddy with a DNS-01 certificate) or Tailscale, which is WireGuard with certificates included. Desktop works with `http://10.8.0.1:8642` directly. Also check that `API_SERVER_HOST` is set to the VPN address, not `127.0.0.1`, or nothing on the tunnel can reach the API server. |
| **On a phone, `127.0.0.1` / `localhost` will not save** | Deliberate: on a phone that address points at the phone itself, so nothing could reach Hermes. Use your Tailscale/Cloudflare/ngrok URL. If Hermes really does run on that device (Termux on Android), press *Save anyway* under the field. |
| **HTTP 403 behind Cloudflare Access** | Add the `CF-Access-Client-Id` / `CF-Access-Client-Secret` service token headers under *Extra request headers*. |
| **No tokens appear / the answer arrives all in one piece** | Streaming is off by default, or Hermes is not allowing this app's origin, or something between you and it is buffering. Press **Verify streaming** in the settings — it reports which of the four causes it is, and the reason is also written to the error log. |
| **Something failed and you are on a phone (no console)** | Settings → Hermes Agent Notes → **Diagnostics → Show recent errors**, with *Copy all* for a bug report. The same text is in `<vault>/.obsidian/plugins/hermes-agent-notes/errors.log` — newest kept, the file is capped at 64 KB and drops its oldest half when full. |
| **Insert / Append says "no active note"** | Fixed: the note is resolved with `getActiveFile()`, so *Append* works even while the chat panel has focus. If it still says that, no note is open in Obsidian at all. |
| **Fetch models / Test connection hangs and the page looks frozen** | Fixed by the **Connection check timeout** (default 15 s) — no request can hang forever any more. Raise it if your instance is just slow, or check the URL and that the gateway is up. |
| **The note ignores my model choice** | Hermes uses its own default model unless you also set a **provider override** (or enable `gateway.platforms.api_server.direct_model_requests` on the host). |
| **Notes do not match my style** | Run **Show detected vault conventions** to see what was inferred, raise *Notes to analyse*, then rescan. |
| **Where do I put the prompts I keep retyping?** | Settings → Hermes Agent Notes → **Quick prompts**. They appear as chips above the chat input; typing `!` searches them. `{note}` in a prompt becomes the open note's name, and `@[[Note]]` pulls that note in as a mention. Clicking a chip sends it immediately — while an answer is running it is queued instead. |
| **How do I switch between my local and remote Hermes?** | There is one **Saved setup** slot. Save the connection you use most, change the fields for the other when you need it, and press *Switch to this* to go back. Switching replaces the URL, key, headers, profile prefix, model and provider and clears the advertised model list, because the other endpoint has its own. |
| **Can I find a conversation from yesterday?** | The 🕘 button in the chat header. It searches titles *and* message bodies, shows how long ago each was, and *Restore* puts it back in the panel — the next message simply continues with a new Hermes session. Sessions are capped at 30, newest kept, in `history.json` next to `errors.log`. |
| **The note opened but jumped somewhere odd** | That is **Follow edits**: after an approved edit the note opens at the first changed line. Switch it off under **Follow edits** if you would rather stay where you were. |
| **Do my Obsidian conversations mix with my other Hermes work?** | Yes by default — the plugin talks to your main profile, so vault prompts and answers sit in the same session store and memory as everything else. Give the vault its own profile to keep it in one folder: see [Keeping vault work in its own Hermes profile](#keeping-vault-work-in-its-own-hermes-profile). |
| **Where is that text stored, and can I see it?** | With **Report the conversation to Hermes sessions** on, each conversation is a Hermes session — visible with `hermes sessions` and session search, and stored in the profile's `state.db`. Switch that setting off and nothing is written server-side at all. |

## Development

The published setup guide lives in `docs/index.html` — a single self-contained page (inline CSS/JS, no external assets) served by GitHub Pages from the `docs/` folder on `main`. Keep the version badge in its header in step with `manifest.json` when you cut a release.

```bash
npm install
npm run dev      # esbuild watch build
npm run build    # tsc --noEmit + esbuild production
npm test         # unit tests + API/SSE tests against a mock Hermes server
```

`npm test` bundles the tested modules with `scripts/obsidian-stub.mjs` standing in for the Obsidian runtime (`js-yaml` stands in for its YAML parser — test-only), then runs:

* `scripts/selftest.mjs` — URL handling, file-name sanitising, model-output unwrapping, frontmatter split/merge, the syntax validator, prompt construction, the vault-convention scan, and real writes against an in-memory vault.
* `scripts/mock-server-test.mjs` — the shipped client against a mock Hermes API server: `/health`, `/v1/models`, `/v1/capabilities`, buffered and SSE completions, headers, and the 401/404 error mapping.
* `scripts/plugin-test.mjs` — boots the real plugin (`onload`) against that mock server and drives `testConnection`, the setup page's quick prompt (buffered and streamed), the auth-failure path and the vault scan end to end.
* `scripts/vault-dryrun.mjs <vaultPath> [sample]` — runs the convention engine over a real vault and prints exactly what Hermes would be told.
* `scripts/setup-labels.sh [owner/repo]` — applies this repo's label taxonomy (idempotent, updates in place, deletes nothing).
* `gen_banner.py` — regenerates `banner.png` (1280×640, needs Pillow). It is the source of the header image; edit the script, not the PNG.

Layout: `src/main.ts` (plugin, commands), `src/settings.ts` (setup page), `src/hermes-client.ts` (API client, transports), `src/vault-rules.ts` (vault scan), `src/prompts.ts` (Obsidian rules + context), `src/note-writer.ts` (names, frontmatter, writes), `src/validate.ts` (syntax checks), `src/ui/*` (modals and chat panel).

## Releasing (BRAT)

BRAT reads the newest **release**, and its assets must be the built files:

```bash
# 1. bump the version in package.json, manifest.json and versions.json
npm run build
git commit -am "Release v0.1.1"

# 2. tag and publish with the three files attached
git tag v0.1.1 && git push origin main --tags
gh release create v0.1.1 --title "v0.1.1 — <summary>" --notes "<release notes>" \
  main.js manifest.json styles.css
```

Pushing a tag also triggers `.github/workflows/release.yml`, which rebuilds and attaches the assets automatically. `main.js` is committed on purpose — Obsidian loads it directly.

## Author

<table>
  <tr><td><b>Author</b></td><td>Jean-Pierre Hermans — <a href="https://github.com/jphermans">JPHsystems</a>, Belgium</td></tr>
  <tr><td><b>GitHub</b></td><td><a href="https://github.com/jphermans">@jphermans</a></td></tr>
  <tr><td><b>Repository</b></td><td><a href="https://github.com/jphermans/hermes-obsidian">jphermans/hermes-obsidian</a></td></tr>
  <tr><td><b>Other plugin</b></td><td><a href="https://github.com/jphermans/obsidian-quick-calculator">obsidian-quick-calculator</a></td></tr>
  <tr><td><b>Built against</b></td><td><a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> by Nous Research — the API server surface (<code>/v1/chat/completions</code>, <code>/health</code>, <code>/v1/models</code>)</td></tr>
  <tr><td><b>Licence</b></td><td>MIT — see <a href="LICENSE">LICENSE</a></td></tr>
</table>

Bug reports and feature ideas are welcome in [Issues](https://github.com/jphermans/hermes-obsidian/issues) — include your Obsidian version, your Hermes version, and whether the instance is local or remote (and over which route), since those decide most diagnoses.

## Licence

MIT — see [LICENSE](LICENSE).
