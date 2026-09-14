/**
 * Guided remote-access presets.
 *
 * Obsidian on a phone cannot reach a plain-HTTP API server on another machine,
 * so "not local" means "put HTTPS in front of it". These presets tell the user
 * exactly which command to run, what the URL will look like, and which headers
 * that route needs.
 */

import type { AccessMode } from "./types";

export interface RemotePreset {
  id: AccessMode;
  label: string;
  summary: string;
  /** Commands to run on the Hermes host, in order. */
  commands: string[];
  /** Shape of the URL to paste into the plugin, when it is predictable. */
  urlTemplate?: string;
  /** Extra headers this route needs (Cloudflare Access service tokens). */
  requiredHeaders: string[];
  /** Headers that are useful but not mandatory (ngrok's interstitial skip). */
  optionalHeaders: string[];
  /** Notes and gotchas for this route. */
  notes: string[];
  /** Section id of this route's walkthrough on the published guide. */
  docAnchor: string;
  /** Two or three words, for links and lists where the full label is too long. */
  shortLabel: string;
  /** True when a phone can use this route as-is. */
  mobileSafe: boolean;
}

export const REMOTE_PRESETS: RemotePreset[] = [
  {
    id: "local",
    label: "Local — Hermes runs on the same device as Obsidian",
    summary: "Default. The API server listens on http://127.0.0.1:8642 and only this machine can reach it.",
    commands: ["hermes config set API_SERVER_ENABLED true", "hermes gateway"],
    urlTemplate: "http://127.0.0.1:8642",
    requiredHeaders: [],
    optionalHeaders: [],
    notes: [
      "Works on desktop, and on a phone only if Hermes itself runs on that phone (for example Termux on Android).",
      "The API server stays unreachable from the network — the safest default.",
    ],
    docAnchor: "same",
    shortLabel: "Same machine",
    mobileSafe: true,
  },
  {
    id: "lan",
    label: "Another computer on my own network (plain HTTP)",
    summary: "Hermes on a desktop or server in the same house, reached over the local network.",
    commands: [
      "# on the machine running Hermes",
      "#   ~/.hermes/.env:  API_SERVER_HOST=0.0.0.0",
      "hermes gateway stop && hermes gateway",
    ],
    urlTemplate: "http://192.168.1.10:8642",
    requiredHeaders: [],
    optionalHeaders: [],
    notes: [
      "Desktop only. iOS and Android refuse plain-HTTP requests to another machine, so phones need one of the HTTPS routes below.",
      "Only do this on a network you trust: the API server is a full agent with terminal access.",
    ],
    docAnchor: "lan",
    shortLabel: "LAN (plain HTTP)",
    mobileSafe: false,
  },
  {
    id: "tailscale",
    label: "Tailscale — private HTTPS, reachable anywhere",
    summary: "Nothing is exposed to the internet; every device signed into your tailnet gets a stable HTTPS address.",
    commands: ["# on the machine running Hermes", "tailscale serve --bg 8642"],
    urlTemplate: "https://your-machine.your-tailnet.ts.net",
    requiredHeaders: [],
    optionalHeaders: [],
    notes: [
      "Install Tailscale and sign in on the phone too — the address only resolves inside your tailnet.",
      "The URL is printed by `tailscale serve`; Tailscale issues the certificate, so no extra proxy is needed.",
    ],
    docAnchor: "tailscale",
    shortLabel: "Tailscale",
    mobileSafe: true,
  },
  {
    id: "wireguard",
    label: "WireGuard — your own VPN, no third party",
    summary:
      "Run WireGuard on the Hermes host and connect your devices to it. No account anywhere, nothing public, and the API server answers on its private VPN address.",
    commands: [
      "# on the machine running Hermes (Linux server)",
      "sudo apt install wireguard        # dnf install wireguard-tools · pacman -S wireguard-tools",
      "wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub",
      "# /etc/wireguard/wg0.conf (server) — paste the two keys, repeat [Peer] per device",
      "#   [Interface]",
      "#   Address = 10.8.0.1/24",
      "#   ListenPort = 51820",
      "#   PrivateKey = <contents of server.key>",
      "#   [Peer]",
      "#   PublicKey = <that device's public key>",
      "#   AllowedIPs = 10.8.0.2/32",
      "sudo wg-quick up wg0 && sudo systemctl enable wg-quick@wg0",
      "sudo ufw allow 51820/udp          # UDP 51820 is the only port to open",
      "# listen on the VPN address, or the VPN cannot reach the API server",
      "#   ~/.hermes/.env:  API_SERVER_HOST=10.8.0.1",
      "hermes gateway stop && hermes gateway",
    ],
    urlTemplate: "http://10.8.0.1:8642",
    requiredHeaders: [],
    optionalHeaders: [],
    notes: [
      "Desktop works with this URL as-is. A phone still refuses plain HTTP to a non-loopback address, so phones need HTTPS on top: a TLS proxy on the host (Caddy with a DNS-01 certificate) or Tailscale, which is WireGuard with the coordination and certificates handled for you.",
      "Client side: install the WireGuard app (App Store, Play Store, wireguard.com/install), import a [Peer] block whose Endpoint is the host's public address, and set PersistentKeepalive = 25 so the NAT hole stays open.",
      "The VPN reaches the whole host, not just the API server: keep AllowedIPs tight (10.8.0.0/24), open only UDP 51820, and treat the private keys like passwords.",
    ],
    docAnchor: "wireguard",
    shortLabel: "WireGuard VPN",
    mobileSafe: false,
  },
  {
    id: "cloudflare",
    label: "Cloudflare Tunnel — public HTTPS hostname",
    summary: "A public https:// address without opening a port on your router.",
    commands: [
      "# quick tunnel (random URL, good for a first test)",
      "cloudflared tunnel --url http://127.0.0.1:8642",
      "",
      "# named tunnel (stable hostname)",
      "cloudflared tunnel create hermes",
      "cloudflared tunnel route dns hermes hermes.example.com",
      "cloudflared tunnel run hermes",
    ],
    urlTemplate: "https://hermes.example.com",
    requiredHeaders: ["CF-Access-Client-Id: <id>.access", "CF-Access-Client-Secret: <secret>"],
    optionalHeaders: [],
    notes: [
      "A quick tunnel gets a new random trycloudflare.com URL every restart — use a named tunnel for anything permanent.",
      "Put Cloudflare Access (service token) in front of it. The API key alone guards a full agent with terminal access.",
      "The Access headers only apply when Access protects the hostname; press Insert below and fill in the real id and secret.",
    ],
    docAnchor: "cloudflare",
    shortLabel: "Cloudflare Tunnel",
    mobileSafe: true,
  },
  {
    id: "ngrok",
    label: "ngrok — public HTTPS URL in one command",
    summary: "Fastest way to get an https:// URL for testing from your phone.",
    commands: [
      "# free plan: one random URL per session",
      "ngrok http 8642",
      "",
      "# with a reserved domain for a stable URL",
      "ngrok http --url=your-name.ngrok.app 8642",
    ],
    urlTemplate: "https://your-name.ngrok.app",
    requiredHeaders: [],
    optionalHeaders: ["ngrok-skip-browser-warning: true"],
    notes: [
      "ngrok's free tier puts an interstitial page in front of browsers; the header above makes the plugin skip it. Copy the URL from the ngrok dashboard or terminal output.",
      "Do not use `--basic-auth`: its Authorization header would replace your Hermes API key, and the plugin would lose the key it needs.",
      "Anyone with the URL can reach the API server, so keep the session short and use a reserved domain you can shut down.",
    ],
    docAnchor: "ngrok",
    shortLabel: "ngrok",
    mobileSafe: true,
  },
  {
    id: "custom",
    label: "Custom HTTPS reverse proxy (Caddy, nginx, VPS)",
    summary: "You already terminate TLS yourself; the plugin just needs the https:// URL.",
    commands: [
      "# Caddyfile on the host — automatic certificate",
      "hermes.example.com {",
      "    reverse_proxy 127.0.0.1:8642",
      "}",
    ],
    urlTemplate: "https://hermes.example.com",
    requiredHeaders: [],
    optionalHeaders: [],
    notes: [
      "Keep the API server bound to 127.0.0.1 and let the proxy be the only way in.",
      "If the proxy wants its own credentials, put them in Extra request headers (a header named Authorization replaces the API key).",
    ],
    docAnchor: "proxy",
    shortLabel: "TLS reverse proxy",
    mobileSafe: true,
  },
];

export function presetFor(mode: AccessMode): RemotePreset {
  const preset = REMOTE_PRESETS.find((entry) => entry.id === mode);
  return preset || REMOTE_PRESETS[0];
}

export function isLocalMode(mode: AccessMode): boolean {
  return mode === "local";
}

/** Header names of a set of `Name: value` lines, lower-cased. */
function headerNames(text: string): string[] {
  const names: string[] = [];
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    names.push(trimmed.slice(0, colon).trim().toLowerCase());
  }
  return names;
}

/**
 * Appends the header lines that are not already present (matched by name), so
 * pressing Insert twice never duplicates anything.
 */
export function mergeHeaderLines(
  existing: string,
  lines: string[]
): { text: string; added: string[]; skipped: string[] } {
  const present = headerNames(existing);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const name = headerNames(line)[0];
    if (!name) continue;
    if (present.indexOf(name) >= 0) {
      skipped.push(line);
      continue;
    }
    present.push(name);
    added.push(line);
  }
  const base = (existing || "").replace(/[\n]+$/, "");
  const merged = added.length === 0 ? base : (base ? base + "\n" : "") + added.join("\n");
  return { text: merged, added, skipped };
}
