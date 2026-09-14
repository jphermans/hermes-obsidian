/**
 * Shared types for the Hermes Agent Notes plugin.
 * This module imports nothing, so it is safe to use from every other module
 * (including the desktop + mobile code paths).
 */

export type FilenameStyle = "keep" | "title" | "kebab" | "snake";

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
  /** SSE streaming needs browser CORS on the Hermes side; off = safe everywhere. */
  streaming: boolean;
  /** Scope Hermes long-term memory / session history to this vault. */
  reportSession: boolean;

  // --- Note writing -------------------------------------------------------
  defaultFolder: string;
  filenameStyle: FilenameStyle;
  openAfterCreate: boolean;
  autoFrontmatter: boolean;
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
}

export const DEFAULT_SETTINGS: HermesAgentNotesSettings = {
  baseUrl: "http://127.0.0.1:8642",
  profile: "",
  apiKey: "",
  extraHeaders: "",
  model: "hermes-agent",
  provider: "",
  temperature: -1,
  streaming: false,
  reportSession: true,

  defaultFolder: "",
  filenameStyle: "keep",
  openAfterCreate: true,
  autoFrontmatter: true,
  includeActiveNote: true,
  maxHistoryMessages: 12,

  conventionsEnabled: true,
  conventionsSample: 120,
  conventionsNotesListed: 60,
  conventionsCacheMinutes: 30,

  conventions: null,
  connection: null,
  availableModels: [],
};
