/**
 * Slash commands for the chat input. They stay deliberately thin: a command
 * either expands into a message (which the normal pipeline then handles, vault
 * conventions and all) or triggers an existing plugin action. Nothing here can
 * write to the vault on its own.
 *
 * Idea taken from UltimateAI-org/aitoolsforobsidian's `/` command support.
 */

export type SlashAction = "clear" | "conventions" | "settings" | "context" | "help";

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  /** "message" sends text to Hermes; "action" runs a local plugin action. */
  kind: "message" | "action";
  action?: SlashAction;
  /** For messages: "{rest}" is replaced by what follows the command. */
  template?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "note",
    usage: "/note <topic>",
    description: "Ask Hermes to write a new note about a topic",
    kind: "message",
    template: "Create a new note about: {rest}",
  },
  {
    name: "fix",
    usage: "/fix",
    description: "Fix the Markdown and Obsidian formatting of the open note",
    kind: "message",
    template:
      "Fix the Markdown and Obsidian formatting of the note open in Obsidian. Correct headings, properties, wikilinks, tags and callouts. Return the complete corrected note file only.",
  },
  {
    name: "improve",
    usage: "/improve <instruction>",
    description: "Rewrite the open note, keeping every existing fact",
    kind: "message",
    template:
      "Improve the note open in Obsidian: {rest} Keep every existing property, wikilink and fact. Return the complete note file only.",
  },
  {
    name: "links",
    usage: "/links",
    description: "Which notes should the open note link to, and why",
    kind: "message",
    template: "Which notes should the note open in Obsidian link to? List the wikilinks to add and why.",
  },
  {
    name: "tags",
    usage: "/tags",
    description: "Suggest tags for the open note, following the vault's conventions",
    kind: "message",
    template: "Suggest tags for the note open in Obsidian, following this vault's tag conventions. Explain each one briefly.",
  },
  { name: "clear", usage: "/clear", description: "Start a new conversation", kind: "action", action: "clear" },
  { name: "context", usage: "/context", description: "Toggle sending the open note as context", kind: "action", action: "context" },
  { name: "conventions", usage: "/conventions", description: "Show the detected vault conventions", kind: "action", action: "conventions" },
  { name: "settings", usage: "/settings", description: "Open the plugin settings", kind: "action", action: "settings" },
  { name: "help", usage: "/help", description: "List the available commands", kind: "action", action: "help" },
];

/** True while the user is still typing the command word itself. */
export function isCommandInput(text: string): boolean {
  if (!text.startsWith("/")) return false;
  return text.indexOf(" ") < 0 && text.indexOf("\n") < 0;
}

export function filterCommands(text: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const query = text.startsWith("/") ? text.slice(1).toLowerCase() : "";
  const matches = commands.filter((command) => query.length === 0 || command.name.startsWith(query));
  return matches.length > 0 ? matches : commands.filter((command) => command.name.indexOf(query) >= 0);
}

export type SlashResult =
  | { kind: "message"; text: string; command: SlashCommand }
  | { kind: "action"; action: SlashAction; command: SlashCommand }
  | { kind: "unknown"; name: string };

/**
 * Turns a submitted "/command rest of the line" into something the plugin can
 * act on. Returns null when the text is an ordinary message.
 */
export function runCommand(text: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const space = trimmed.indexOf(" ");
  const name = (space < 0 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
  const command = commands.find((entry) => entry.name === name);
  if (!command) return { kind: "unknown", name };
  if (command.kind === "action" && command.action) return { kind: "action", action: command.action, command };
  return { kind: "message", text: (command.template || "").split("{rest}").join(rest || "").trim(), command };
}
