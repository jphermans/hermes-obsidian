/**
 * Shared types for the Hermes Agent Notes plugin.
 * This module imports only types, so it stays safe to use from every other module
 * (including the desktop + mobile code paths).
 */

import type { QuickPrompt } from "./quick-prompts";
import type { ConnectionProfile } from "./profiles";
import { defaultQuickPrompts } from "./quick-prompts";

export type FilenameStyle = "keep" | "title" | "kebab" | "snake";

/** How Obsidian reaches the Hermes API server. */
export type AccessMode = "local" | "lan" | "tailscale" | "wireguard" | "cloudflare" | "ngrok" | "custom";

export interface FrontmatterKeyInfo {
  key: string;
  count: number;
  types: string[];
  samples: string[];
}

export interface VaultConventions {
  /** Epoch ms of the scan. */
  at: number;
  /** Notes that existed in the vault when the scan ran. */
  totalNotes: number;
  /** Notes whose content was actually read for the analysis. */
  scanned: number;
  folders: { path: string; notes: number }[];
  frontmatterUsed: number;
  keys: FrontmatterKeyInfo[];
  tags: {
    total: number;
    style: string;
    samples: string[];
    inFrontmatter: number;
    inline: number;
  };
  /** Whether string values in frontmatter are quoted. */
  quoting: { quoted: number; unquoted: number };
  links: { wiki: number; markdown: number; embed: number };
  headings: { notesWithH1: number; samples: string[] };
  filenames: { separator: string; samples: string[]; avgWords: number };
  callouts: string[];
  unknown?: boolean;
}

export interface ConnectionState {
  ok: boolean;
  at: number;
  detail: string;
  model?: string;
  models?: string[];
}

export interface HermesAgentNotesSettings {
  // --- Connection ---------------------------------------------------------
  baseUrl: string;
  /** Which route this URL uses — drives the guided setup and its warnings. */
  accessMode: AccessMode;
  /** Optional multi-profile prefix (`/p/<profile>`). Empty = default profile. */
  profile: string;
  apiKey: string;
  /** Extra request headers, one `Name: value` per line (Cloudflare Access, proxies). */
  extraHeaders: string;
  model: string;
  /** Optional provider slug sent with each request (needed to override the model). */
  provider: string;
  /** -1 = do not send a temperature at all. */
  temperature: number;
  /** Seconds-scale limit for /health, /v1/models and /v1/capabilities. */
  probeTimeoutMs: number;
  /** Limit for a full answer; agent turns can take minutes. 0 = wait forever. */
  chatTimeoutMs: number;
  /** SSE streaming needs browser CORS on the Hermes side; off = safe everywhere. */
  streaming: boolean;
  /** Scope Hermes long-term memory / session history to this vault. */
  reportSession: boolean;

  // --- Note writing -------------------------------------------------------
  defaultFolder: string;
  filenameStyle: FilenameStyle;
  openAfterCreate: boolean;
  /** Ask for frontmatter from the detected vault properties. */
  autoFrontmatter: boolean;
  /** Drop the assistant's caveats when an answer is written into a note. */
  stripCaveats: boolean;
  /** Copy, move and delete notes on request, always with approval. */
  allowFileOps: boolean;
  /** Deletions go to the trash unless this is on. */
  permanentDelete: boolean;
  /** Prompts you fire from the chips above the chat input. */
  quickPrompts: QuickPrompt[];
  /** Saved connections, switchable in one click. */
  profiles: ConnectionProfile[];
  /** After an approved edit, open the note where the change is. */
  trackEdits: boolean;
  /** Which setup-page tab was open last, so reopening lands in the same place. */
  settingsTab: string;
  includeActiveNote: boolean;
  maxHistoryMessages: number;

  // --- Vault conventions --------------------------------------------------
  conventionsEnabled: boolean;
  conventionsSample: number;
  conventionsNotesListed: number;
  conventionsCacheMinutes: number;

  // --- Cache --------------------------------------------------------------
  conventions: VaultConventions | null;
  connection: ConnectionState | null;
  availableModels: string[];

  // --- Persistence --------------------------------------------------------
  /** Mirror the settings to a backup file next to the plugin on every change. */
  autoBackup: boolean;
}

export const DEFAULT_SETTINGS: HermesAgentNotesSettings = {
  baseUrl: "http://127.0.0.1:8642",
  accessMode: "local",
  profile: "",
  apiKey: "",
  extraHeaders: "",
  model: "hermes-agent",
  provider: "",
  temperature: -1,
  probeTimeoutMs: 15000,
  chatTimeoutMs: 300000,
  streaming: false,
  reportSession: true,

  defaultFolder: "",
  filenameStyle: "keep",
  openAfterCreate: true,
  autoFrontmatter: true,
  stripCaveats: true,
  allowFileOps: true,
  permanentDelete: false,
  quickPrompts: defaultQuickPrompts(),
  profiles: [],
  trackEdits: true,
  settingsTab: "connection",
  includeActiveNote: true,
  maxHistoryMessages: 12,

  conventionsEnabled: true,
  conventionsSample: 120,
  conventionsNotesListed: 60,
  conventionsCacheMinutes: 30,

  conventions: null,
  connection: null,
  availableModels: [],

  autoBackup: true,
};
