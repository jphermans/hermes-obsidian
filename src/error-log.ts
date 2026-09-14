/**
 * A small, bounded on-disk record of what went wrong. On a phone there is no
 * console, so this log is the only way a user can see why a call failed — and
 * paste it into a bug report. Writes are serialised and the file is rotated, so
 * logging can never grow without limit or interleave half-written lines.
 *
 * Pattern (bounded log + serialised appends) taken from
 * UltimateAI-org/aitoolsforobsidian's error log.
 */

export interface ErrorEntry {
  /** ISO timestamp. */
  at: string;
  /** Where it happened, e.g. "Test connection". */
  source: string;
  message: string;
  detail?: string;
}

export const ERROR_LOG_MAX_BYTES = 64 * 1024;
export const ERROR_LOG_MAX_ENTRIES = 200;

export function formatErrorEntry(entry: ErrorEntry): string {
  return JSON.stringify(entry) + "\n";
}

/** Drops the oldest ~half so the text fits under the cap again. */
export function rotateLog(text: string, maxBytes: number = ERROR_LOG_MAX_BYTES): string {
  if (text.length <= maxBytes) return text;
  const cut = text.length - Math.floor(maxBytes / 2);
  const newline = text.indexOf("\n", cut);
  return newline >= 0 ? text.slice(newline + 1) : text.slice(cut);
}

/** Newest last; a half-written trailing line is skipped rather than crashing. */
export function parseErrorLog(text: string, limit: number = ERROR_LOG_MAX_ENTRIES): ErrorEntry[] {
  const entries: ErrorEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ErrorEntry>;
      if (parsed && typeof parsed.message === "string" && parsed.message.length > 0) {
        entries.push({
          at: typeof parsed.at === "string" ? parsed.at : "",
          source: typeof parsed.source === "string" ? parsed.source : "unknown",
          message: parsed.message,
          detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
        });
      }
    } catch {
      // ignore: only the tail can be truncated
    }
  }
  return entries.slice(Math.max(0, entries.length - limit));
}

export interface ErrorLogIO {
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
}

export class ErrorLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(private io: ErrorLogIO, private maxBytes: number = ERROR_LOG_MAX_BYTES) {}

  /** Never rejects: a broken log must not break the feature that failed. */
  record(entry: ErrorEntry): Promise<void> {
    const line = formatErrorEntry(entry);
    this.chain = this.chain
      .then(async () => {
        const current = await this.io.read();
        await this.io.write(rotateLog(current + line, this.maxBytes));
      })
      .catch(() => undefined);
    return this.chain;
  }

  read(limit: number = ERROR_LOG_MAX_ENTRIES): Promise<ErrorEntry[]> {
    return this.chain
      .then(async () => parseErrorLog(await this.io.read(), limit))
      .catch(() => [] as ErrorEntry[]);
  }

  clear(): Promise<void> {
    this.chain = this.chain.then(() => this.io.write("")).catch(() => undefined);
    return this.chain;
  }
}

/** One line of context for a thrown value, whatever it is. */
export function describeForLog(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}
