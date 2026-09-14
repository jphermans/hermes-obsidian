/**
 * Minimal, dependency-free client for the Hermes Agent API server
 * (OpenAI-compatible surface, enabled with API_SERVER_ENABLED=true).
 *
 * Transport strategy
 * ------------------
 * - Default: Obsidian `requestUrl`. It is a native HTTP client, so it works on
 *   desktop *and* mobile and needs no CORS configuration on the Hermes side.
 * - Optional: `fetch` + SSE for live token/tool-progress streaming. That is a
 *   browser request, so Hermes must allow the Obsidian origin via
 *   API_SERVER_CORS_ORIGINS. If it fails, the caller falls back to requestUrl.
 */

import { Platform, requestUrl } from "obsidian";
import type { HermesAgentNotesSettings } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  content: string;
  usage?: ChatUsage;
  model?: string;
  streamed: boolean;
}

export type HermesErrorKind =
  | "config"
  | "network"
  | "auth"
  | "rate-limit"
  | "server"
  | "client"
  | "aborted";

export class HermesError extends Error {
  kind: HermesErrorKind;
  status: number | null;

  constructor(message: string, kind: HermesErrorKind, status: number | null = null) {
    super(message);
    this.name = "HermesError";
    this.kind = kind;
    this.status = status;
  }
}

export interface ChatOptions {
  system?: string;
  temperature?: number;
  /** Enables server-side session history + detached delegation. */
  sessionId?: string;
  /** Stable long-term-memory scope (X-Hermes-Session-Key). */
  sessionKey?: string;
  signal?: AbortSignal;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:[/]{2}/i;
const TRAILING_SLASH_RE = /[/]+$/;
const TRAILING_V1_RE = /[/]v1$/i;
const PRIVATE_HOST_RE = /^(localhost|127[.]|10[.]|192[.]168[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|169[.]254[.]|\[?::1\]?)/i;

/** Authority part of a URL or bare `host:port` string (no userinfo). */
function authorityOf(value: string): string {
  const scheme = value.indexOf("://");
  const rest = scheme >= 0 ? value.slice(scheme + 3) : value;
  let end = rest.length;
  for (const stop of ["/", "?", "#"]) {
    const index = rest.indexOf(stop);
    if (index >= 0 && index < end) end = index;
  }
  const authority = rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  return at >= 0 ? authority.slice(at + 1) : authority;
}

/** Explicit port, or "" when the URL leaves it out. */
export function portOfUrl(value: string): string {
  const authority = authorityOf(value);
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return "";
  const port = authority.slice(colon + 1);
  return /^[0-9]+$/.test(port) ? port : "";
}

export function hostOfUrl(value: string): string {
  const hostPort = authorityOf(value);
  const colon = hostPort.lastIndexOf(":");
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  return host.toLowerCase();
}

/** Same device: the only HTTP target a phone may talk to. */
export function isLoopbackHost(host: string): boolean {
  if (!host) return true;
  return /^(localhost|127[.]|\[?::1\]?$)/i.test(host) || host === "[::1]";
}

/**
 * Loopback, private LAN, mDNS and single-label hosts are treated as local — they
 * are reached over plain HTTP; any other hostname defaults to HTTPS.
 */
export function looksLocalHost(host: string): boolean {
  if (!host) return true;
  if (PRIVATE_HOST_RE.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  return host.indexOf(".") < 0;
}

/**
 * `http://host:8642/` / `host:8642/v1` / `hermes.example.com` -> a usable base.
 *
 * The port is optional: with no port the request goes to 80/443, which is what
 * a tunnel or reverse proxy serving the API server on 443 expects. When no
 * scheme is given, a public hostname becomes https (unless it names a port
 * other than 443), while loopback and LAN addresses stay on http.
 */
export function normalizeBaseUrl(raw: string): string {
  let value = (raw || "").trim();
  if (!value) return "http://127.0.0.1:8642";
  if (!SCHEME_RE.test(value)) {
    const host = hostOfUrl(value);
    const port = portOfUrl(value);
    const scheme = !looksLocalHost(host) && (port === "" || port === "443") ? "https" : "http";
    value = scheme + "://" + value;
  }
  value = value.replace(TRAILING_SLASH_RE, "");
  value = value.replace(TRAILING_V1_RE, "");
  value = value.replace(TRAILING_SLASH_RE, "");
  return value;
}

export function cleanProfile(raw: string): string {
  return (raw || "").trim().replace(/^[/]+/, "").replace(TRAILING_SLASH_RE, "");
}

export interface Endpoints {
  /** Base URL as entered, normalised. */
  root: string;
  /** Root with an optional `/p/<profile>` prefix. */
  scoped: string;
  /** OpenAI-compatible base (`.../v1`). */
  v1: string;
}

export function endpointsFor(baseUrl: string, profile: string): Endpoints {
  const root = normalizeBaseUrl(baseUrl);
  const prof = cleanProfile(profile);
  const scoped = prof && prof.toLowerCase() !== "default" ? root + "/p/" + prof : root;
  return { root, scoped, v1: scoped + "/v1" };
}

/** The origins Obsidian presents when a plugin uses browser fetch (streaming). */
export function obsidianOrigins(): string[] {
  return ["app://obsidian.md", "capacitor://localhost", "http://localhost"];
}

/**
 * Parses the `Name: value` header lines from the settings field. Blank lines
 * and #-comments are ignored; malformed lines are dropped rather than sent.
 */
export function parseExtraHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!name || !value) continue;
    headers[name] = value;
  }
  return headers;
}

function hostOf(url: string): string {
  return hostOfUrl(url.indexOf("://") >= 0 ? url : "http://" + url);
}

/**
 * Mobile OSes refuse cleartext HTTP to other machines (iOS ATS, Android network
 * security config). Returns a warning for that exact situation, otherwise "".
 */
export function cleartextWarning(url: string): string {
  if (!Platform.isMobile) return "";
  if (!url || url.slice(0, 7).toLowerCase() !== "http://") return "";
  const host = hostOf(url);
  if (!host || isLoopbackHost(host)) return "";
  return (
    "This device is on mobile and the URL uses plain HTTP to another machine, which iOS and Android block. " +
    "Reach Hermes over HTTPS instead — Tailscale (`tailscale serve`), Cloudflare Tunnel, or a TLS reverse proxy."
  );
}

/** Nudge towards HTTPS when a public plain-HTTP host cannot be reached. */
function httpsHint(url: string): string {
  if (cleartextWarning(url)) return "";
  if (!url || url.slice(0, 7).toLowerCase() !== "http://") return "";
  const host = hostOf(url);
  if (!host || isLoopbackHost(host)) return "";
  return " If that host serves HTTPS, use https://" + host + " — the port can be left out when a proxy or tunnel terminates TLS on 443.";
}


function firstLine(text: string, limit = 300): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError";
}

function httpError(status: number, body: string, url: string): HermesError {
  const detail = firstLine(body) || "no response body";
  if (status === 401 || status === 403) {
    return new HermesError(
      "Hermes rejected the request (HTTP " + status + "). The API key does not match API_SERVER_KEY on the Hermes host.",
      "auth",
      status
    );
  }
  if (status === 404) {
    return new HermesError(
      "HTTP 404 from " + url + ". Check the base URL, and the profile prefix if you set one (/p/<profile>).",
      "config",
      status
    );
  }
  if (status === 429) {
    return new HermesError(
      "Hermes is busy (HTTP 429): too many concurrent runs. Retry in a moment, or raise gateway.api_server.max_concurrent_runs on the host.",
      "rate-limit",
      status
    );
  }
  if (status >= 500) {
    return new HermesError("Hermes failed (HTTP " + status + "): " + detail, "server", status);
  }
  return new HermesError("Hermes refused the request (HTTP " + status + "): " + detail, "client", status);
}

function networkError(err: unknown, url: string): HermesError {
  if (isAbortError(err)) return new HermesError("Stopped.", "aborted");
  const msg = err instanceof Error ? err.message : String(err);
  const hint = cleartextWarning(url) || httpsHint(url);
  return new HermesError("Could not reach Hermes at " + url + " — " + msg + (hint ? " " + hint : ""), "network");
}

function streamNetworkError(err: unknown, url: string, origins: string[]): HermesError {
  if (isAbortError(err)) return new HermesError("Stopped.", "aborted");
  const msg = err instanceof Error ? err.message : String(err);
  const cleartext = cleartextWarning(url);
  return new HermesError(
    "Streaming request to " + url + " failed — " + msg +
      ". Streaming is a browser request, so Hermes must allow this app's origin: set API_SERVER_CORS_ORIGINS=" +
      origins.join(",") + " in the Hermes .env and restart `hermes gateway` (or turn streaming off)." +
      (cleartext ? " " + cleartext : ""),
    "network"
  );
}

export function describeError(err: unknown): string {
  if (err instanceof HermesError) {
    if (err.kind === "network") {
      return (
        err.message +
        " Check that `hermes gateway` is running there with API_SERVER_ENABLED=true, that the host/port are right, and that this device can reach them."
      );
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class HermesClient {
  settings: HermesAgentNotesSettings;

  constructor(settings: HermesAgentNotesSettings) {
    this.settings = settings;
  }

  endpoints(): Endpoints {
    return endpointsFor(this.settings.baseUrl, this.settings.profile);
  }

  url(path: string): string {
    return this.endpoints().scoped + path;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = Object.assign(
      { "Content-Type": "application/json" },
      parseExtraHeaders(this.settings.extraHeaders),
      extra || {}
    );
    const key = (this.settings.apiKey || "").trim();
    // A user-supplied Authorization header (proxy auth) wins over the bearer key.
    if (key && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = "Bearer " + key;
    }
    return headers;
  }

  private sessionHeaders(options: ChatOptions): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.settings.reportSession && options.sessionId) {
      headers["X-Hermes-Session-Id"] = options.sessionId;
    }
    if (options.sessionKey) {
      headers["X-Hermes-Session-Key"] = options.sessionKey.slice(0, 256);
    }
    return headers;
  }

  private async getJson(path: string): Promise<{ status: number; text: string; json: any }> {
    const url = this.url(path);
    let res;
    try {
      res = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
    } catch (err) {
      throw networkError(err, url);
    }
    let json: any = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = null;
    }
    return { status: res.status, text: res.text, json };
  }

  /** GET /health — cheap liveness probe, no auth required. */
  async health(): Promise<{ ok: boolean; status: number; detail: string }> {
    const res = await this.getJson("/health");
    const ok = res.status === 200;
    const status = res.json && typeof res.json.status === "string" ? res.json.status : null;
    return {
      ok,
      status: res.status,
      detail: ok ? (status ? "status: " + status : "HTTP 200") : "HTTP " + res.status + " " + firstLine(res.text, 120),
    };
  }

  /** GET /v1/models — the agent advertises itself as a model. */
  async models(): Promise<string[]> {
    const res = await this.getJson("/v1/models");
    if (res.status >= 400) throw httpError(res.status, res.text, this.url("/v1/models"));
    const data = res.json && Array.isArray(res.json.data) ? res.json.data : [];
    return data
      .map((entry: any) => (entry && typeof entry.id === "string" ? entry.id : ""))
      .filter((id: string) => id.length > 0);
  }

  /** GET /v1/capabilities — Hermes-native feature flags. */
  async capabilities(): Promise<any> {
    const res = await this.getJson("/v1/capabilities");
    if (res.status >= 400) throw httpError(res.status, res.text, this.url("/v1/capabilities"));
    return res.json;
  }

  private payload(messages: ChatMessage[], options: ChatOptions, stream: boolean): Record<string, unknown> {
    const out: ChatMessage[] = [];
    if (options.system) out.push({ role: "system", content: options.system });
    for (const message of messages) out.push({ role: message.role, content: message.content });
    const payload: Record<string, unknown> = {
      model: (this.settings.model || "hermes-agent").trim() || "hermes-agent",
      messages: out,
      stream,
    };
    const provider = (this.settings.provider || "").trim();
    if (provider) payload.provider = provider;
    const temperature = typeof options.temperature === "number" ? options.temperature : this.settings.temperature;
    if (typeof temperature === "number" && temperature >= 0) payload.temperature = temperature;
    return payload;
  }

  /** POST /v1/chat/completions (non-streaming, native transport). */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const url = this.endpoints().v1 + "/chat/completions";
    let res;
    try {
      res = await requestUrl({
        url,
        method: "POST",
        headers: this.headers(this.sessionHeaders(options)),
        body: JSON.stringify(this.payload(messages, options, false)),
        throw: false,
      });
    } catch (err) {
      throw networkError(err, url);
    }
    if (res.status >= 400) throw httpError(res.status, res.text, url);
    let json: any = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new HermesError("Hermes returned a non-JSON response: " + firstLine(res.text), "server", res.status);
    }
    const choice = json && json.choices ? json.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
    if (!content.trim()) {
      const reason = choice && choice.finish_reason ? " (finish_reason: " + choice.finish_reason + ")" : "";
      throw new HermesError("Hermes returned an empty answer" + reason + ".", "server", res.status);
    }
    return { content, usage: json.usage, model: json.model, streamed: false };
  }

  /**
   * POST /v1/chat/completions with stream:true over fetch + SSE.
   * Throws a network error (with the CORS hint) when the browser transport is
   * blocked; callers fall back to `chat()`.
   */
  async chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
    onDelta: (delta: string, full: string) => void
  ): Promise<ChatResult> {
    const url = this.endpoints().v1 + "/chat/completions";
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(this.sessionHeaders(options)),
        body: JSON.stringify(this.payload(messages, options, true)),
        signal: options.signal,
      });
    } catch (err) {
      throw streamNetworkError(err, url, obsidianOrigins());
    }
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      throw httpError(response.status, body, url);
    }
    if (!response.body) {
      throw new HermesError("This environment cannot read a streaming response.", "network");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: ChatUsage | undefined;
    let model: string | undefined;
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0 && !line.startsWith(":")) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
            } else if (data.length > 0) {
              try {
                const parsed = JSON.parse(data);
                if (parsed && typeof parsed.model === "string") model = parsed.model;
                if (parsed && parsed.usage) usage = parsed.usage;
                const choice = parsed && parsed.choices ? parsed.choices[0] : null;
                const delta =
                  choice && choice.delta && typeof choice.delta.content === "string"
                    ? choice.delta.content
                    : choice && choice.message && typeof choice.message.content === "string"
                      ? choice.message.content
                      : "";
                if (delta) {
                  content += delta;
                  onDelta(delta, content);
                }
              } catch {
                /* keep-alive or partial frame — ignored on purpose */
              }
            }
          }
        }
        if (done) break;
        index = buffer.indexOf("\n");
      }
    }

    if (!content.trim()) throw new HermesError("Hermes returned an empty answer.", "server");
    return { content, usage, model, streamed: true };
  }
}
