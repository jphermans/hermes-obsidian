/**
 * Test-time stand-in for the `obsidian` runtime module.
 * Only the APIs the tested modules import are implemented; requestUrl is a real
 * HTTP client so the API tests exercise the shipped networking code.
 */

import yaml from "js-yaml";

export class TFile {
  path;
  basename;
  extension;
  parent;

  constructor(path, parent) {
    this.path = path;
    const slash = path.lastIndexOf("/");
    const name = slash < 0 ? path : path.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    this.basename = dot > 0 ? name.slice(0, dot) : name;
    this.extension = dot > 0 ? name.slice(dot + 1) : "";
    this.parent = parent;
  }
}

export class TFolder {
  path;
  children = [];

  constructor(path) {
    this.path = path;
  }
}

export class App {}

export class Notice {
  constructor(message) {
    this.message = message;
  }
  hide() {}
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
  isIosApp: false,
  isAndroidApp: false,
};

/** Test helper: pretend to run on a phone. */
export function setPlatform(values) {
  Object.assign(Platform, values);
}

export function normalizePath(path) {
  const parts = [];
  for (const part of String(path == null ? "" : path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const out = parts.join("/");
  return out.length === 0 ? "/" : out;
}

export function parseYaml(text) {
  return yaml.load(text);
}

export function stringifyYaml(value) {
  return yaml.dump(value, { lineWidth: -1 });
}

export async function requestUrl(request) {
  const options = typeof request === "string" ? { url: request } : request;
  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    headers: Object.fromEntries(response.headers.entries()),
    get json() {
      return JSON.parse(text);
    },
    arrayBuffer: () => new TextEncoder().encode(text).buffer,
  };
}
