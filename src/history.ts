/**
 * Chat history: what you talked about, kept on disk so it survives a reload and
 * can be searched or restored. Bounded like the error log — newest kept.
 */

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface HistorySession {
  id: string;
  /** First user line, shortened — how the session is listed. */
  title: string;
  /** Last time this session was written. */
  at: number;
  entries: HistoryEntry[];
}

export const MAX_HISTORY_SESSIONS = 30;
export const MAX_HISTORY_CHARS = 400_000;
export const MAX_SESSION_ENTRIES = 200;

export function sessionTitle(entries: HistoryEntry[]): string {
  for (const entry of entries) {
    if (entry.role !== "user") continue;
    const line = entry.content.split("\n")[0].trim();
    if (line.length === 0) continue;
    return line.length > 60 ? line.slice(0, 57).trim() + "…" : line;
  }
  return "Untitled conversation";
}

export function normalizeHistory(input: unknown): HistorySession[] {
  if (!Array.isArray(input)) return [];
  const sessions: HistorySession[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { id?: unknown; at?: unknown; entries?: unknown };
    const entries: HistoryEntry[] = [];
    if (Array.isArray(record.entries)) {
      for (const item of record.entries) {
        if (!item || typeof item !== "object") continue;
        const entry = item as { role?: unknown; content?: unknown };
        const role = entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : null;
        const content = typeof entry.content === "string" ? entry.content : "";
        if (!role || content.length === 0) continue;
        entries.push({ role, content });
      }
    }
    if (entries.length === 0) continue;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : "session-" + (sessions.length + 1);
    if (sessions.some((entry) => entry.id === id)) continue;
    sessions.push({
      id,
      title: sessionTitle(entries.slice(0, MAX_SESSION_ENTRIES)),
      at: typeof record.at === "number" ? record.at : 0,
      entries: entries.slice(-MAX_SESSION_ENTRIES),
    });
    if (sessions.length >= MAX_HISTORY_SESSIONS) break;
  }
  return sessions;
}

/** Newest first, dropping the oldest until the store fits the budget. */
export function trimSessions(sessions: HistorySession[]): HistorySession[] {
  const sorted = sessions.slice().sort((a, b) => b.at - a.at).slice(0, MAX_HISTORY_SESSIONS);
  let total = 0;
  const kept: HistorySession[] = [];
  for (const session of sorted) {
    const size = session.entries.reduce((sum, entry) => sum + entry.content.length, 0);
    if (kept.length > 0 && total + size > MAX_HISTORY_CHARS) break;
    total += size;
    kept.push(session);
  }
  return kept;
}

/** Saves or replaces one session, newest first, bounded. */
export function upsertSession(sessions: HistorySession[], session: HistorySession): HistorySession[] {
  if (session.entries.length === 0) return sessions;
  const others = sessions.filter((entry) => entry.id !== session.id);
  return trimSessions([{ ...session, entries: session.entries.slice(-MAX_SESSION_ENTRIES) }, ...others]);
}

export function removeSession(sessions: HistorySession[], id: string): HistorySession[] {
  return sessions.filter((entry) => entry.id !== id);
}

/** Case-insensitive search over titles and message bodies. */
export function searchSessions(sessions: HistorySession[], query: string): HistorySession[] {
  const wanted = (query || "").trim().toLowerCase();
  if (wanted.length === 0) return sessions.slice();
  return sessions.filter(
    (session) =>
      session.title.toLowerCase().indexOf(wanted) >= 0 ||
      session.entries.some((entry) => entry.content.toLowerCase().indexOf(wanted) >= 0)
  );
}

export function describeSession(session: HistorySession, now: number): string {
  const when = session.at > 0 ? relativeTime(session.at, now) : "unknown time";
  const count = session.entries.length;
  return when + " · " + count + (count === 1 ? " message" : " messages");
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}
