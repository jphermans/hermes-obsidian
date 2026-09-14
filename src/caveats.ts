/**
 * Strips the assistant's own caveats from an answer before it is written into a
 * note — the "Let me know if you'd like more", "Note: I can only see the vault
 * conventions you shared" style tail (and the occasional "Sure, here's…" head).
 *
 * Two safety rules keep this from eating real content:
 *  - a block is only treated as a caveat when it matches a pattern AND carries a
 *    first/second-person marker, so a note ending in "Note: the boiler is 12
 *    years old." survives;
 *  - blocks containing a code fence are never touched.
 */

/** Phrases that only an assistant says — enough on their own. */
const STRONG_CAVEAT_PATTERNS = [
  "let me know",
  "feel free",
  "i hope",
  "hope this",
  "hope that",
  "i can only see",
  "i only see",
  "i don't have access",
  "i do not have access",
  "i cannot see",
  "i can't see",
  "i haven't",
  "i have not",
  "i'm not able",
  "i am not able",
  "want me to",
  "would you like",
  "happy to",
  "just say the word",
  "tell me if",
  "caveat",
  "disclaimer",
  "this is based on",
  "this assumes",
  "assuming that",
];

/** Ambiguous wording (a real note may say "Note:") — needs a person marker too. */
const WEAK_CAVEAT_PATTERNS = [
  "note:",
  "note that",
  "please note",
  "keep in mind",
  "bear in mind",
  "that said",
  "just a note",
  "one thing to note",
  "important:",
  "warning:",
  "be aware",
  "if you'd like",
  "if you would like",
  "if you want",
  "if you need",
  "if there's",
];

const CAVEAT_PATTERNS = STRONG_CAVEAT_PATTERNS.concat(WEAK_CAVEAT_PATTERNS);

const PREAMBLE_PATTERNS = [
  "sure,",
  "sure!",
  "certainly",
  "absolutely",
  "of course",
  "here's",
  "here is",
  "below is",
  "the following",
];

const PERSON_MARKERS = [" i ", "i'", " i,", " me ", " my ", " you ", " you'", " your ", " you,", "i'll", "i've"];

function looksAssistantDirected(text: string): boolean {
  const padded = " " + text.toLowerCase() + " ";
  return PERSON_MARKERS.some((marker) => padded.indexOf(marker) >= 0);
}

function startsWithAny(text: string, patterns: string[]): boolean {
  const lower = text.trim().toLowerCase();
  return patterns.some((pattern) => lower.indexOf(pattern) === 0);
}

function containsAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((pattern) => lower.indexOf(pattern) >= 0);
}

function isCaveatBlock(block: string): boolean {
  if (block.indexOf("```") >= 0) return false;
  if (!containsAny(block, CAVEAT_PATTERNS)) return false;
  // "let me know…" is unmistakably the assistant; "note:" could be the user's own note.
  return startsWithAny(block, STRONG_CAVEAT_PATTERNS) || looksAssistantDirected(block);
}

/** Splits a block into sentences, keeping the terminators. */
function splitSentences(block: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < block.length; i++) {
    const character = block.charAt(i);
    current += character;
    if (character === "." || character === "!" || character === "?") {
      const next = block.charAt(i + 1);
      if (next === "" || next === " " || next === "\n") {
        parts.push(current);
        current = "";
      }
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function isCaveatSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  if (trimmed.indexOf("```") >= 0 || trimmed.indexOf("[[") >= 0) return false;
  if (!containsAny(trimmed, CAVEAT_PATTERNS)) return false;
  return startsWithAny(trimmed, STRONG_CAVEAT_PATTERNS) || looksAssistantDirected(trimmed);
}

export interface CleanedAnswer {
  text: string;
  /** The chunks that were dropped, for an honest notice ("dropped 1 caveat line"). */
  removed: string[];
}

export function stripCaveats(input: string): CleanedAnswer {
  const original = (input || "").trim();
  if (!original) return { text: original, removed: [] };

  const blocks = original
    .split("\n\n")
    .map((block) => block.replace(/[\s]+$/, ""))
    .filter((block) => block.length > 0);
  const removed: string[] = [];

  // trailing: whole caveat blocks, then caveat sentences at the end of the last block
  while (blocks.length > 1 && isCaveatBlock(blocks[blocks.length - 1])) {
    removed.push(blocks.pop() as string);
  }
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    if (last.indexOf("```") < 0) {
      const sentences = splitSentences(last);
      let kept = sentences.slice();
      while (kept.length > 1 && isCaveatSentence(kept[kept.length - 1])) {
        removed.push(kept.pop() as string);
      }
      if (kept.length !== sentences.length) blocks[blocks.length - 1] = kept.join("").trim();
    }
  }

  // leading: a short purely conversational opener
  while (blocks.length > 1 && startsWithAny(blocks[0], PREAMBLE_PATTERNS)) {
    const first = blocks[0].trim();
    const words = first.split(" ").filter((word) => word.length > 0).length;
    const endsWithColon = first.endsWith(":");
    if (words > 14 || (!endsWithColon && !startsWithAny(first, ["sure", "certainly", "absolutely", "of course"]))) break;
    removed.push(blocks.shift() as string);
  }

  const text = blocks.join("\n\n").trim();
  if (text.length === 0) return { text: original, removed: [] };
  return { text, removed };
}
