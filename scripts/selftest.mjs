/**
 * Unit tests for the pure plugin logic: URL handling, file-name sanitising,
 * model-output unwrapping, frontmatter split/merge, the Obsidian syntax
 * validator, prompt construction, the vault-convention scan and real file
 * writes against an in-memory vault.
 *
 * Run with `npm test` (bundles first, see scripts/build-tests.mjs).
 */

import assert from "node:assert/strict";
import * as hermes from "./.build/tests.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(name + "\n      " + (error && error.message ? error.message : String(error)));
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(name + "\n      " + (error && error.message ? error.message : String(error)));
  }
}

const BAD_CHARS = ["/", "\\", ":", "*", "?", '"', "<", ">", "|", "#", "^", "[", "]"];

// --- URLs -----------------------------------------------------------------

test("normalizeBaseUrl adds a scheme and strips trailing /v1", () => {
  assert.equal(hermes.normalizeBaseUrl(""), "http://127.0.0.1:8642");
  assert.equal(hermes.normalizeBaseUrl("http://127.0.0.1:8642/"), "http://127.0.0.1:8642");
  assert.equal(hermes.normalizeBaseUrl("127.0.0.1:8642/v1"), "http://127.0.0.1:8642");
  assert.equal(hermes.normalizeBaseUrl("https://hermes.example.com/hermes/"), "https://hermes.example.com/hermes");
  assert.equal(hermes.normalizeBaseUrl("http://host:8642/p/alice"), "http://host:8642/p/alice");
});

test("endpointsFor builds the profile-prefixed v1 URL", () => {
  assert.equal(hermes.endpointsFor("http://h:8642", "").v1, "http://h:8642/v1");
  assert.equal(hermes.endpointsFor("http://h:8642", "default").v1, "http://h:8642/v1");
  assert.equal(hermes.endpointsFor("http://h:8642", "/bob/").v1, "http://h:8642/p/bob/v1");
  assert.equal(hermes.endpointsFor("http://h:8642/", "alice").v1, "http://h:8642/p/alice/v1");
});

test("normalizeBaseUrl accepts a URL without a port and picks the right scheme", () => {
  // no port + public host -> https on 443
  assert.equal(hermes.normalizeBaseUrl("hermes.example.com"), "https://hermes.example.com");
  assert.equal(hermes.normalizeBaseUrl("hermes.example.com/"), "https://hermes.example.com");
  assert.equal(hermes.normalizeBaseUrl("hermes.example.com/v1"), "https://hermes.example.com");
  assert.equal(hermes.normalizeBaseUrl("hermes.example.com:443"), "https://hermes.example.com:443");
  // an explicit scheme is never overridden
  assert.equal(hermes.normalizeBaseUrl("https://hermes.example.com"), "https://hermes.example.com");
  assert.equal(hermes.normalizeBaseUrl("http://hermes.example.com"), "http://hermes.example.com");
  // a non-standard port means plain HTTP on that port
  assert.equal(hermes.normalizeBaseUrl("hermes.example.com:8642"), "http://hermes.example.com:8642");
  // LAN, loopback and single-label hosts stay on http
  assert.equal(hermes.normalizeBaseUrl("192.168.1.10"), "http://192.168.1.10");
  assert.equal(hermes.normalizeBaseUrl("192.168.1.10:8642"), "http://192.168.1.10:8642");
  assert.equal(hermes.normalizeBaseUrl("myserver"), "http://myserver");
  assert.equal(hermes.normalizeBaseUrl("myserver.local"), "http://myserver.local");
  assert.equal(hermes.normalizeBaseUrl("127.0.0.1"), "http://127.0.0.1");
  assert.equal(hermes.normalizeBaseUrl(""), "http://127.0.0.1:8642");
});

test("port-less URLs build the documented endpoints", () => {
  assert.equal(hermes.portOfUrl("hermes.example.com"), "");
  assert.equal(hermes.portOfUrl("hermes.example.com:443"), "443");
  assert.equal(hermes.portOfUrl("http://[::1]:8642/v1"), "8642");
  assert.equal(hermes.hostOfUrl("http://[::1]:8642/v1"), "[::1]");
  assert.equal(hermes.endpointsFor("hermes.example.com", "").v1, "https://hermes.example.com/v1");
  assert.equal(hermes.endpointsFor("hermes.example.com", "").scoped, "https://hermes.example.com");
  assert.equal(hermes.endpointsFor("hermes.example.com", "alice").v1, "https://hermes.example.com/p/alice/v1");
  const client = new hermes.HermesClient(Object.assign({}, hermes.DEFAULT_SETTINGS, { baseUrl: "hermes.example.com" }));
  assert.equal(client.url("/health"), "https://hermes.example.com/health");
  assert.equal(client.url("/v1/models"), "https://hermes.example.com/v1/models");
  assert.equal(client.url("/v1/chat/completions"), "https://hermes.example.com/v1/chat/completions");
});

test("loopback is safe on a phone, private LAN addresses are not", () => {
  hermes.setPlatform({ isMobile: false, isDesktop: true });
  assert.equal(hermes.cleartextWarning("http://hermes.example.com"), "", "desktop is never warned");
  hermes.setPlatform({ isMobile: true, isDesktop: false });
  assert.ok(hermes.cleartextWarning("http://hermes.example.com").length > 0, "public host on mobile must warn");
  assert.ok(hermes.cleartextWarning("http://192.168.1.10:8642").length > 0, "LAN host on mobile must warn");
  assert.equal(hermes.cleartextWarning("http://127.0.0.1:8642"), "", "loopback is fine on mobile");
  assert.equal(hermes.cleartextWarning("http://localhost:8642"), "");
  assert.equal(hermes.cleartextWarning("https://hermes.example.com"), "", "HTTPS is the fix");
  hermes.setPlatform({ isMobile: false, isDesktop: true });
});

test("obsidianOrigins lists the shapes a plugin can present", () => {
  const origins = hermes.obsidianOrigins();
  assert.ok(origins.includes("app://obsidian.md"));
  assert.ok(origins.includes("capacitor://localhost"));
});

test("parseExtraHeaders reads Name: value lines and drops junk", () => {
  const headers = hermes.parseExtraHeaders(
    "CF-Access-Client-Id: abc.access\n# a comment\n\nX-Custom: value: with colon\nnot a header\n: no name\nEmpty:\n"
  );
  assert.deepEqual(headers, { "CF-Access-Client-Id": "abc.access", "X-Custom": "value: with colon" });
  assert.deepEqual(hermes.parseExtraHeaders(""), {});
  assert.deepEqual(hermes.parseExtraHeaders("X:  padded  "), { X: "padded" });
});

test("cleartextWarning only fires for mobile + remote plain HTTP", () => {
  hermes.setPlatform({ isMobile: false, isDesktop: true });
  assert.equal(hermes.cleartextWarning("http://192.168.1.10:8642/v1"), "", "desktop is never warned");
  hermes.setPlatform({ isMobile: true, isDesktop: false });
  assert.ok(hermes.cleartextWarning("http://192.168.1.10:8642/v1").length > 0, "LAN IP on mobile must warn");
  assert.ok(hermes.cleartextWarning("http://hermes.local:8642").length > 0, ".local is still another machine");
  assert.ok(hermes.cleartextWarning("http://0.0.0.0:9").length > 0);
  assert.equal(hermes.cleartextWarning("http://127.0.0.1:8642"), "", "loopback is fine on mobile");
  assert.equal(hermes.cleartextWarning("http://localhost:8642/v1"), "");
  assert.equal(hermes.cleartextWarning("https://hermes.tailnet.ts.net/v1"), "", "HTTPS is the fix");
  assert.equal(hermes.cleartextWarning(""), "");
  hermes.setPlatform({ isMobile: false, isDesktop: true });
});

// --- file names -----------------------------------------------------------

test("sanitizeFilename removes every character Obsidian cannot store", () => {
  const dirty = 'Report / Q3: "draft" <final>|v2#1^2[3]';
  const clean = hermes.sanitizeFilename(dirty);
  for (const character of BAD_CHARS) {
    assert.ok(!clean.includes(character), "still contains " + character + " → " + clean);
  }
  assert.ok(clean.includes("Report"));
  assert.ok(clean.includes("Q3"));
});

test("sanitizeFilename trims, truncates and never returns empty", () => {
  assert.equal(hermes.sanitizeFilename("  trailing dots...  "), "trailing dots");
  assert.equal(hermes.sanitizeFilename(".hidden"), "hidden");
  assert.equal(hermes.sanitizeFilename(""), "Untitled note");
  assert.equal(hermes.sanitizeFilename("tab\there"), "tabhere");
  assert.equal(hermes.sanitizeFilename("x".repeat(200)).length, 100);
});

test("applyFilenameStyle honours the vault's naming style", () => {
  assert.equal(hermes.applyFilenameStyle("Kitchen Renovation Plan", "kebab"), "kitchen-renovation-plan");
  assert.equal(hermes.applyFilenameStyle("Kitchen Renovation Plan", "snake"), "kitchen_renovation_plan");
  assert.equal(hermes.applyFilenameStyle("kitchen renovation", "title"), "Kitchen Renovation");
  assert.equal(hermes.applyFilenameStyle("keep Me As Is", "keep"), "keep Me As Is");
});

// --- model output ---------------------------------------------------------

test("extractNote unwraps a fence around the whole note", () => {
  const wrapped = "```markdown\n---\ntitle: A\n---\n\n# Body\n\nText.\n```";
  assert.equal(hermes.extractNote(wrapped), "---\ntitle: A\n---\n\n# Body\n\nText.");
});

test("extractNote removes chatty preambles and trailing offers", () => {
  const chatty = "Sure, here's the note:\n\n# Body\n\nSome text.\n\nLet me know if you want changes.";
  const note = hermes.extractNote(chatty);
  assert.ok(note.startsWith("# Body"), "unexpected start: " + note);
  assert.ok(!note.includes("Let me know"), "trailing chatter kept: " + note);
});

test("extractNote keeps real code fences inside the note", () => {
  const note = "```\n# Body\n\ncode:\n\n```js\nconst a = 1;\n```\n```";
  const extracted = hermes.extractNote(note);
  assert.ok(extracted.includes("const a = 1;"), "lost the inner code fence");
  assert.ok(extracted.includes("# Body"));
});

test("titleFromNote prefers frontmatter, then H1, then the prompt", () => {
  assert.equal(hermes.titleFromNote("---\ntitle: Kitchen Plan\n---\n\n# Other\n", "x"), "Kitchen Plan");
  assert.equal(hermes.titleFromNote("# My Heading\n\ntext", "x"), "My Heading");
  assert.equal(hermes.titleFromNote("---\naliases: [Alias One, Alias Two]\n---\n\nbody", "x"), "Alias One");
  const long = "one two three four five six seven eight nine ten eleven twelve";
  assert.ok(hermes.titleFromNote("no heading here", long).split(" ").length <= 9);
});

// --- frontmatter ----------------------------------------------------------

test("splitFrontmatter separates properties from the body", () => {
  const split = hermes.splitFrontmatter("---\ntitle: A\ntags: [x, y]\n---\n\n# Body\n");
  assert.equal(split.present, true);
  assert.equal(split.data.title, "A");
  assert.deepEqual(split.data.tags, ["x", "y"]);
  assert.ok(split.body.startsWith("# Body"));
});

test("splitFrontmatter reports unparseable frontmatter without losing text", () => {
  const broken = "---\n[unclosed\n---\n\nbody text";
  const split = hermes.splitFrontmatter(broken);
  assert.equal(split.present, false);
  assert.ok(split.body.includes("body text"));
  assert.ok(split.body.includes("[unclosed"));
});

test("splitFrontmatter is a no-op when there is no frontmatter", () => {
  const split = hermes.splitFrontmatter("# Just a note\n");
  assert.equal(split.present, false);
  assert.equal(split.body, "# Just a note\n");
});

test("mergeFrontmatter keeps existing values and adds new keys", () => {
  const existing = { title: "Old", tags: ["a"], status: "draft" };
  const incoming = { title: "New", tags: ["b"], created: "2026-01-01" };
  const merged = hermes.mergeFrontmatter(existing, incoming);
  assert.equal(merged.title, "Old");
  assert.deepEqual(merged.tags, ["a"]);
  assert.equal(merged.status, "draft");
  assert.equal(merged.created, "2026-01-01");
  const union = hermes.mergeFrontmatter(existing, incoming, { keepExisting: false, mergeLists: true });
  assert.deepEqual(union.tags, ["a", "b"]);
});

test("serializeNote round-trips through splitFrontmatter", () => {
  const content = hermes.serializeNote({ title: "X", tags: ["a", "b"], created: "2026-09-14" }, "# Body\n\ntext");
  assert.ok(content.startsWith("---\n"));
  const split = hermes.splitFrontmatter(content);
  assert.equal(split.present, true);
  assert.equal(split.data.title, "X");
  assert.deepEqual(split.data.tags, ["a", "b"]);
  assert.ok(split.body.startsWith("# Body"));
  assert.equal(hermes.serializeNote(null, "body"), "body\n");
});

// --- validator ------------------------------------------------------------

const conventions = {
  at: Date.now(),
  totalNotes: 10,
  scanned: 10,
  folders: [{ path: "/", notes: 10 }],
  frontmatterUsed: 9,
  keys: [{ key: "title", count: 9, types: ["text"], samples: ["Kitchen"] }],
  tags: { total: 3, style: "flat, lowercase", samples: ["#house"], inFrontmatter: 6, inline: 4 },
  links: { wiki: 12, markdown: 2, embed: 1 },
  headings: { notesWithH1: 9, samples: ["Kitchen renovation"] },
  filenames: { separator: "spaces between words", samples: ["Kitchen renovation"], avgWords: 2.3 },
  callouts: ["note", "tip"],
};

test("validateNote accepts a clean vault-style note", () => {
  const note = "---\ntitle: Kitchen\ncreated: 2026-09-14\ntags: [house]\n---\n\n# Kitchen\n\nSee [[Boiler service]], #house and > [!note] Remember the tiles.\n\n- [ ] order tiles\n";
  const check = hermes.validateNote(note, "Kitchen", conventions);
  const warnings = check.issues.filter((issue) => issue.level === "warn");
  assert.deepEqual(warnings, [], "unexpected warnings: " + JSON.stringify(warnings));
  assert.equal(check.stats.properties, 3);
  assert.equal(check.stats.wikiLinks, 1);
});

test("validateNote flags .md links, unbalanced brackets and illegal names", () => {
  const check = hermes.validateNote("---\ntitle: A\n---\n\n# A\n\nSee [Other](Notes/Other.md) and [[Broken.\n", "Bad/Name", conventions);
  const messages = check.issues.map((issue) => issue.message).join(" | ");
  assert.ok(/\.md/.test(messages), "missing .md warning: " + messages);
  assert.ok(/Unbalanced/.test(messages), "missing bracket warning: " + messages);
  assert.ok(/characters Obsidian cannot store/.test(messages), "missing file-name warning: " + messages);
});

test("validateNote flags a tab in frontmatter, an unparsed block and an empty body", () => {
  const tabbed = hermes.validateNote("---\ntitle: A\n\tbroken: yes\n---\n\n# A\n", "A", conventions);
  assert.ok(tabbed.issues.some((issue) => /tab character/.test(issue.message)));
  const unparsed = hermes.validateNote("---\n[oops\n---\n\n# A\n", "A", conventions);
  assert.ok(unparsed.issues.some((issue) => /does not parse as YAML/.test(issue.message)));
  const empty = hermes.validateNote("---\ntitle: A\n---\n", "A", conventions);
  assert.ok(empty.issues.some((issue) => /body is empty/.test(issue.message)));
});

// --- prompts --------------------------------------------------------------

test("systemPrompt carries the Obsidian rules and the vault conventions", () => {
  const context = {
    vaultName: "TestVault",
    targetFolder: "Notes",
    notePath: "Notes/Current.md",
    noteTitle: "Current",
    activeNoteContent: "# Current",
    existingNotes: ["Kitchen", "Boiler"],
    folderList: ["Notes", "Daily"],
    includeFrontmatter: true,
    frontmatterTemplate: "---\ntitle: <note title>\n---",
    conventions,
    language: "auto",
  };
  const prompt = hermes.systemPrompt("create", context);
  assert.ok(prompt.includes("OBSIDIAN MARKDOWN RULES"));
  assert.ok(prompt.includes("TestVault"));
  assert.ok(prompt.includes("Target folder for this note: Notes"));
  assert.ok(prompt.includes("[[Note Name]]"));
  assert.ok(prompt.includes("VAULT CONVENTIONS"));
  assert.ok(prompt.includes("title"));
  assert.ok(prompt.includes("Kitchen | Boiler"));
  const noFrontmatter = hermes.systemPrompt("create", Object.assign({}, context, { includeFrontmatter: false }));
  assert.ok(/Do not add frontmatter/.test(noFrontmatter));
});

test("trimHistory keeps the most recent messages", () => {
  const messages = [
    { role: "user", content: "1" },
    { role: "assistant", content: "2" },
    { role: "user", content: "3" },
    { role: "assistant", content: "4" },
    { role: "user", content: "5" },
    { role: "assistant", content: "6" },
  ];
  const trimmed = hermes.trimHistory(messages, 4);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[3].content, "6");
  assert.equal(hermes.trimHistory(messages, 0).length, 6);
});

test("defaultFrontmatterTemplate mirrors the detected properties", () => {
  const detected = Object.assign({}, conventions, {
    keys: [
      { key: "status", count: 5, types: ["text"], samples: ["draft"] },
      { key: "created", count: 5, types: ["date"], samples: ["2026-01-01"] },
      { key: "tags", count: 5, types: ["list"], samples: ["[house]"] },
    ],
  });
  const template = hermes.defaultFrontmatterTemplate(detected);
  assert.ok(template.startsWith("---"));
  assert.ok(template.includes("status: <value>"));
  assert.ok(/created: [0-9]{4}-[0-9]{2}-[0-9]{2}/.test(template));
  assert.ok(template.includes("tags: []"));
  assert.equal(template.split("\n").filter((line) => line === "---").length, 2);
});

// --- vault scan and real writes -------------------------------------------

await testAsync("scanVault reports whether property values are quoted", async () => {
  const app = hermes.makeAppObject([
    { path: "quoted.md", content: '---\ntitle: "Kitchen renovation"\nstatus: "active"\ntags: ["house"]\n---\n\n# A\n' },
  ]);
  const scan = await hermes.scanVault(app, 10);
  assert.ok(scan.quoting.quoted >= 3, JSON.stringify(scan.quoting));
  assert.equal(scan.quoting.unquoted, 0);
  assert.equal(hermes.countQuoting("title: Plain\n- item\n").quoted, 0);
  assert.equal(hermes.countQuoting("title: Plain\n- item\n").unquoted, 2);
});

await testAsync("scanVault learns properties, tags, links, callouts and names", async () => {
  const app = hermes.makeAppObject([
    {
      path: "Kitchen renovation.md",
      content:
        "---\ntitle: Kitchen renovation\ntags: [project/kitchen, house]\ncreated: 2026-01-05\nstatus: draft\n---\n\n# Kitchen renovation\n\nLink to [[Boiler service]] and [[Tiles]]!\n\n> [!note] Budget is tight\n- [ ] order tiles\n",
    },
    {
      path: "Notes/Boiler service.md",
      content: "---\ntitle: Boiler service\ncreated: 2025-11-02\n---\n\n# Boiler service\n\nSee [Other](Notes/Other.md) and [[Kitchen renovation]]\n\nSome #inline-tag here\n",
    },
    { path: "Notes/Tiles.md", content: "No frontmatter, just text with [[Kitchen renovation]]\n" },
    {
      path: "Daily/2026-09-14.md",
      content: "---\ntags:\n  - daily\ncreated: 2026-09-14\n---\n\n# 2026-09-14\n\n> [!tip] Test\n",
    },
  ]);

  const scan = await hermes.scanVault(app, 40);
  assert.equal(scan.totalNotes, 4);
  assert.equal(scan.scanned, 4);
  assert.equal(scan.frontmatterUsed, 3);
  const keys = scan.keys.map((key) => key.key);
  assert.ok(keys.includes("title"), "keys: " + keys.join(", "));
  assert.ok(keys.includes("tags"));
  assert.ok(keys.includes("created"));
  const created = scan.keys.find((key) => key.key === "created");
  assert.ok(created.types.includes("date"), "created typed as " + created.types.join(","));
  assert.ok(scan.tags.total >= 4, "tags: " + scan.tags.total);
  assert.ok(scan.tags.samples.some((tag) => tag.includes("project/kitchen")), "samples: " + scan.tags.samples.join(" "));
  assert.ok(/nested/.test(scan.tags.style), "style: " + scan.tags.style);
  assert.ok(scan.links.wiki >= 4, "wikilinks: " + scan.links.wiki);
  assert.equal(scan.links.markdown, 1);
  assert.ok(scan.callouts.includes("note"));
  assert.ok(scan.callouts.includes("tip"));
  assert.equal(scan.headings.notesWithH1, 3);
  assert.equal(scan.filenames.separator, "spaces between words");
  assert.ok(scan.folders.some((folder) => folder.path === "Notes" && folder.notes === 2));
});

await testAsync("ensureFolder creates nested folders once", async () => {
  const { vault, folders } = hermes.makeApp([]);
  const app = { vault };
  assert.equal(await hermes.ensureFolder(app, ""), "");
  assert.equal(await hermes.ensureFolder(app, "Projects/Kitchen"), "Projects/Kitchen");
  assert.ok(folders.has("Projects"));
  assert.ok(folders.has("Projects/Kitchen"));
  assert.equal(await hermes.ensureFolder(app, "Projects/Kitchen"), "Projects/Kitchen");
});

await testAsync("uniquePath never collides with an existing note", async () => {
  const { vault } = hermes.makeApp([
    { path: "Note.md", content: "a" },
    { path: "Note 1.md", content: "b" },
    { path: "Journal/Day.md", content: "c" },
  ]);
  const app = { vault };
  assert.equal(hermes.uniquePath(app, "", "Note"), "Note 2.md");
  assert.equal(hermes.uniquePath(app, "Journal", "Day"), "Journal/Day 1.md");
  assert.equal(hermes.uniquePath(app, "Fresh", "New"), "Fresh/New.md");
});

await testAsync("writeNote creates, refuses duplicates, overwrites and appends", async () => {
  const { vault } = hermes.makeApp([]);
  const app = { vault };
  const created = await hermes.writeNote(app, "Folder/Note.md", "first\n", "create");
  assert.equal(created.path, "Folder/Note.md");
  assert.equal(await vault.read(created), "first\n");
  await assert.rejects(() => hermes.writeNote(app, "Folder/Note.md", "again\n", "create"));
  await hermes.writeNote(app, "Folder/Note.md", "second\n", "overwrite");
  assert.equal(await vault.read(created), "second\n");
  await hermes.writeNote(app, "Folder/Note.md", "appended\n", "append");
  assert.equal(await vault.read(created), "second\n\nappended\n");
});

// --- remote access presets ------------------------------------------------

test("every access route is complete and unique", () => {
  const ids = hermes.REMOTE_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate preset id");
  for (const id of ["local", "lan", "tailscale", "cloudflare", "ngrok", "custom"]) {
    assert.ok(ids.includes(id), "missing preset: " + id);
  }
  for (const preset of hermes.REMOTE_PRESETS) {
    assert.ok(preset.label.length > 10, preset.id + " label too vague");
    assert.ok(preset.summary.length > 20, preset.id + " summary too short");
    assert.ok(preset.notes.length > 0, preset.id + " has no notes");
    if (preset.id !== "local" && preset.id !== "lan") {
      assert.ok(preset.notes.length >= 1);
    }
  }
});

test("non-local HTTPS routes are marked mobile-safe, plain LAN is not", () => {
  assert.equal(hermes.presetFor("lan").mobileSafe, false, "plain HTTP on LAN must warn about phones");
  assert.equal(hermes.presetFor("local").mobileSafe, true);
  for (const id of ["tailscale", "cloudflare", "ngrok", "custom"]) {
    const preset = hermes.presetFor(id);
    assert.equal(preset.mobileSafe, true, id + " should be usable on a phone");
    assert.ok(preset.urlTemplate && preset.urlTemplate.startsWith("https://"), id + " needs an https template");
    assert.ok(preset.commands.length > 0, id + " has no commands");
  }
});

test("cloudflare carries Access headers and ngrok the interstitial skip", () => {
  const cloudflare = hermes.presetFor("cloudflare");
  assert.deepEqual(cloudflare.requiredHeaders, ["CF-Access-Client-Id: <id>.access", "CF-Access-Client-Secret: <secret>"]);
  const ngrok = hermes.presetFor("ngrok");
  assert.deepEqual(ngrok.optionalHeaders, ["ngrok-skip-browser-warning: true"]);
  assert.equal(ngrok.requiredHeaders.length, 0);
  // ngrok basic-auth would overwrite the Hermes key, so it must not be suggested.
  const allHeaders = ngrok.requiredHeaders.concat(ngrok.optionalHeaders).join("\n").toLowerCase();
  assert.ok(!allHeaders.includes("authorization"), "ngrok preset must not set Authorization");
  assert.ok(ngrok.notes.join(" ").toLowerCase().includes("basic-auth"), "ngrok note must warn about --basic-auth");
});

test("presetFor falls back to local for an unknown mode", () => {
  assert.equal(hermes.presetFor("nonsense").id, "local");
  assert.equal(hermes.presetFor(undefined).id, "local");
});

test("mergeHeaderLines adds missing headers once and keeps existing ones", () => {
  const first = hermes.mergeHeaderLines("", ["CF-Access-Client-Id: a.access", "ngrok-skip-browser-warning: true"]);
  assert.equal(first.text, "CF-Access-Client-Id: a.access\nngrok-skip-browser-warning: true");
  assert.equal(first.added.length, 2);

  const again = hermes.mergeHeaderLines(first.text, ["CF-Access-Client-Id: b.access"]);
  assert.equal(again.added.length, 0, "must not duplicate an existing header");
  assert.equal(again.skipped.length, 1);
  assert.ok(again.text.includes("a.access"), "existing value must be preserved");

  const appended = hermes.mergeHeaderLines("X-Keep: 1", ["Y-New: 2"]);
  assert.equal(appended.text, "X-Keep: 1\nY-New: 2");
  const caseInsensitive = hermes.mergeHeaderLines("cf-access-client-id: a", ["CF-Access-Client-Id: b"]);
  assert.equal(caseInsensitive.added.length, 0, "header names compare case-insensitively");
  assert.equal(hermes.mergeHeaderLines("", []).text, "");
});

// --- settings persistence ------------------------------------------------

test("exportableSettings keeps settings and drops caches", () => {
  const exported = hermes.exportableSettings(
    Object.assign({}, hermes.DEFAULT_SETTINGS, {
      baseUrl: "https://h.example.com",
      conventions: { at: 1, unknown: true },
      connection: { ok: true },
      availableModels: ["x"],
    })
  );
  assert.equal(exported.baseUrl, "https://h.example.com");
  assert.equal(exported.plugin, "hermes-agent-notes");
  assert.equal(typeof exported.exportedAt, "string");
  assert.equal(exported.autoBackup, true);
  for (const key of ["conventions", "connection", "availableModels"]) {
    assert.ok(!(key in exported), key + " must not be exported");
  }
});

test("mergeImportedSettings applies sane values and reports the rest", () => {
  const current = Object.assign({}, hermes.DEFAULT_SETTINGS);
  const result = hermes.mergeImportedSettings(current, {
    baseUrl: "https://hermes.example.com",
    apiKey: "k",
    deep: { a: 1 },
    model: 5,
    streaming: "yes",
    conventions: { at: 1 },
    plugin: "hermes-agent-notes",
    exportedAt: "2026-01-01",
  });
  assert.equal(result.settings.baseUrl, "https://hermes.example.com");
  assert.equal(result.settings.apiKey, "k");
  assert.ok(result.applied.includes("baseUrl"));
  assert.ok(!result.applied.includes("plugin"), "the marker is not a setting");
  assert.ok(result.ignored.includes("deep"), "unknown keys are ignored");
  assert.ok(result.ignored.includes("conventions"), "caches are ignored");
  assert.ok(result.errors.some((entry) => entry.indexOf("model") === 0), result.errors.join("; "));
  assert.ok(result.errors.some((entry) => entry.indexOf("streaming") === 0));
  assert.equal(result.settings.model, hermes.DEFAULT_SETTINGS.model, "a wrong type must not be applied");
  assert.equal(current.baseUrl, "http://127.0.0.1:8642", "the source settings object must not be mutated");

  const junk = hermes.mergeImportedSettings(current, "just a string");
  assert.equal(junk.applied.length, 0);
  assert.ok(junk.errors.length > 0);
  assert.equal(junk.settings.baseUrl, current.baseUrl);
});

test("a loopback URL is refused on mobile, allowed on desktop", () => {
  const message = hermes.loopbackBlockMessage("http://127.0.0.1:8642", true);
  assert.ok(message.length > 0);
  assert.ok(/points at this phone/.test(message), message);
  assert.ok(hermes.loopbackBlockMessage("http://localhost:8642", true).length > 0);
  assert.ok(hermes.loopbackBlockMessage("127.0.0.1:8642", true).length > 0, "no scheme still counts");
  assert.equal(hermes.loopbackBlockMessage("http://127.0.0.1:8642", false), "", "desktop may use loopback");
  assert.equal(hermes.loopbackBlockMessage("https://hermes.example.com", true), "", "a remote route is fine on mobile");
  assert.equal(hermes.loopbackBlockMessage("http://192.168.1.10:8642", true), "", "a LAN address is not loopback");
  assert.equal(hermes.loopbackBlockMessage("", true), "");
});

test("settings file paths are predictable", () => {
  assert.equal(hermes.settingsBackupPath("hermes-agent-notes"), ".obsidian/plugins/hermes-agent-notes/settings-backup.json");
  assert.equal(hermes.settingsBackupPath("hermes-agent-notes/"), ".obsidian/plugins/hermes-agent-notes/settings-backup.json");
  assert.equal(hermes.settingsBackupPath(""), ".obsidian/plugins/hermes-agent-notes/settings-backup.json");
  assert.equal(hermes.settingsExportPath(""), "Hermes Agent Notes settings.json");
  assert.equal(hermes.settingsExportPath("13.00 AI"), "13.00 AI/Hermes Agent Notes settings.json");
  assert.equal(hermes.settingsExportPath("/13.00 AI/"), "13.00 AI/Hermes Agent Notes settings.json");
});

// --- caveat stripping ------------------------------------------------------

test("stripCaveats removes an assistant remark at the end of an answer", () => {
  const answer = "The basement needs a dehumidifier before the plaster goes in.\n\nLet me know if you would like me to turn this into a checklist.";
  const cleaned = hermes.stripCaveats(answer);
  assert.equal(cleaned.text, "The basement needs a dehumidifier before the plaster goes in.");
  assert.equal(cleaned.removed.length, 1);

  const note = hermes.stripCaveats("Kitchen renovation starts in April.\n\nNote: I can only see the vault conventions you shared, not your actual files.");
  assert.equal(note.text, "Kitchen renovation starts in April.");
  assert.equal(note.removed.length, 1);
});

test("stripCaveats removes a caveat sentence inside the last paragraph", () => {
  const cleaned = hermes.stripCaveats("Use [[Boiler service]] for the maintenance log. Keep in mind that I have not verified the dates you gave me.");
  assert.equal(cleaned.text, "Use [[Boiler service]] for the maintenance log.");
  assert.equal(cleaned.removed.length, 1);
});

test("stripCaveats removes a conversational opener", () => {
  const cleaned = hermes.stripCaveats("Sure, here's the summary:\n\n# Kitchen renovation\n\nThe tiles arrive on Friday.");
  assert.equal(cleaned.text, "# Kitchen renovation\n\nThe tiles arrive on Friday.");
  assert.equal(cleaned.removed.length, 1);
});

test("stripCaveats never eats real note content", () => {
  // a factual "Note:" line with no assistant voice stays
  const factual = hermes.stripCaveats("The boiler was installed in 2009.\n\nNote: the warranty expires in 2029.");
  assert.equal(factual.text, "The boiler was installed in 2009.\n\nNote: the warranty expires in 2029.");
  assert.equal(factual.removed.length, 0);

  // a trailing code block is left alone
  const withCode = hermes.stripCaveats("Run this:\n\n```bash\nssh pi5-ai\n```");
  assert.equal(withCode.removed.length, 0);
  assert.ok(withCode.text.indexOf("ssh pi5-ai") >= 0);

  // a wikilink-bearing sentence is never treated as a caveat
  const withLink = hermes.stripCaveats("See [[Supplier contract]] and keep in mind the delivery window.");
  assert.equal(withLink.removed.length, 0);

  // nothing to strip -> identical text
  const clean = hermes.stripCaveats("# Title\n\nJust the note body.");
  assert.equal(clean.text, "# Title\n\nJust the note body.");
  assert.equal(clean.removed.length, 0);
  assert.equal(hermes.stripCaveats("").text, "");
});

// --- new-note intent -------------------------------------------------------

test("a request for a new note is recognised", () => {
  const requests = [
    "Create a new note about the supplier meeting",
    "create a new note",
    "Make a note titled Boiler service 2026",
    "Write a note about lead times",
    "create a file for the monthly checklist",
    "Draft a note summarising the inspection",
  ];
  for (const text of requests) {
    assert.equal(hermes.looksLikeNewNoteRequest(text), true, "not recognised: " + text);
  }
});

test("questions and edits of the open note are not new-note requests", () => {
  const others = [
    "What links should this note have?",
    "Summarise this note and rewrite it in our house style",
    "Fix the Obsidian formatting of this note",
    "Add the delivery dates to this note",
    "How do I create notes in Obsidian?",
    "Why is this note not in the graph?",
    "Append this to the note",
    "",
  ];
  for (const text of others) {
    assert.equal(hermes.looksLikeNewNoteRequest(text), false, "wrongly recognised: " + text);
  }
});

// --- report ---------------------------------------------------------------

console.log("selftest: " + passed + " passed, " + failed + " failed");
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log("  ✗ " + failure);
  process.exit(1);
}
