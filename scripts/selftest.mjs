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

// --- mentions --------------------------------------------------------------

test("a mention being typed is found at the cursor", () => {
  assert.deepEqual(hermes.detectMention("Look at @Kit", 12), { start: 8, end: 12, query: "Kit" });
  assert.deepEqual(hermes.detectMention("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(hermes.detectMention("@[[Kit", 6), { start: 0, end: 6, query: "Kit" });
  const full = "@[[Kitchen renovation]]";
  assert.deepEqual(hermes.detectMention(full, full.length), {
    start: 0,
    end: full.length,
    query: "Kitchen renovation",
  });
  assert.deepEqual(hermes.detectMention("@[[Kitchen renovation]] more", 23), {
    start: 0,
    end: 23,
    query: "Kitchen renovation",
  });
});

test("a mention stops at whitespace, after the brackets, and inside an email", () => {
  assert.equal(hermes.detectMention("@Kit chen", 9), null, "space should end the mention");
  assert.equal(hermes.detectMention("@[[Kit]] and more", 18), null, "cursor after ]] is not a mention");
  assert.equal(hermes.detectMention("me@example.com", 14), null, "email is not a mention");
  assert.equal(hermes.detectMention("no mention here", 15), null);
});

test("completing a mention inserts Obsidian's @[[link]] form", () => {
  const bare = "See @Kit";
  const open = hermes.completeMention(bare, hermes.detectMention(bare, bare.length), "Kitchen renovation");
  assert.equal(open.text, "See @[[Kitchen renovation]] ");
  assert.equal(open.cursor, open.text.length, "the caret must land after the inserted name");

  const bracketedText = "A @[[Kit]] B";
  const bracketed = hermes.completeMention(
    bracketedText,
    hermes.detectMention(bracketedText, 10),
    "Kitchen renovation"
  );
  assert.equal(bracketed.text, "A @[[Kitchen renovation]] B", "no double space, second ] replaced");

  const middleText = "See @Kit now";
  const middle = hermes.completeMention(
    middleText,
    hermes.detectMention(middleText, 8),
    "Boiler service"
  );
  assert.equal(middle.text, "See @[[Boiler service]] now");
  assert.equal(middle.cursor, middle.text.length - 4, "the caret stops before the trailing text");
});

test("mentions are extracted once each, in order", () => {
  const text = "Compare @[[Kitchen renovation]] with @[[Boiler service]] and @[[Kitchen renovation]]";
  assert.deepEqual(hermes.extractMentionedTitles(text), ["Kitchen renovation", "Boiler service"]);
  assert.deepEqual(hermes.extractMentionedTitles("nothing here"), []);
  assert.deepEqual(hermes.extractMentionedTitles("@[[unclosed"), []);
});

test("mention syntax is converted to plain wikilinks for the model", () => {
  assert.equal(
    hermes.stripMentionSyntax("Compare @[[Kitchen renovation]] and @[[Boiler service]]"),
    "Compare [[Kitchen renovation]] and [[Boiler service]]"
  );
});

const CANDIDATES = [
  { basename: "Kitchen renovation", path: "House/Kitchen renovation.md" },
  { basename: "Boiler service", path: "Home/Boiler service.md" },
  { basename: "Kitchen renovation", path: "Archive/Kitchen renovation.md" },
];

test("a mentioned title resolves to the right note", () => {
  assert.equal(hermes.matchMentionedFile(CANDIDATES.slice(0, 2), "Kitchen renovation")?.path, "House/Kitchen renovation.md");
  assert.equal(hermes.matchMentionedFile(CANDIDATES.slice(0, 2), "kitchen renovation")?.path, "House/Kitchen renovation.md");
  assert.equal(hermes.matchMentionedFile(CANDIDATES.slice(0, 2), "boiler")?.path, "Home/Boiler service.md");
  assert.equal(
    hermes.matchMentionedFile(CANDIDATES.slice(0, 2), "House/Kitchen renovation.md")?.path,
    "House/Kitchen renovation.md"
  );
  assert.equal(hermes.matchMentionedFile(CANDIDATES.slice(0, 2), "nowhere"), null);
});

test("an ambiguous mention is refused rather than guessed", () => {
  assert.equal(hermes.matchMentionedFile(CANDIDATES, "Kitchen renovation"), null, "two notes share the name");
  assert.equal(
    hermes.matchMentionedFile(CANDIDATES, "Archive/Kitchen renovation.md")?.path,
    "Archive/Kitchen renovation.md",
    "a path disambiguates"
  );
});

test("note suggestions put prefix matches first and respect the limit", () => {
  const names = ["Boiler service", "Kitchen renovation", "Kitchen tiling", "Bathroom", "Kitchen lighting"];
  const some = hermes.suggestNotes(CANDIDATES, "kit");
  assert.ok(some.length <= 8 && some.length > 0);
  assert.ok(some.every((file) => /kitchen/i.test(file.basename)), "only matching notes are offered");

  const limited = hermes.suggestNotes(
    names.map((basename) => ({ basename, path: basename + ".md" })),
    "kitchen",
    2
  );
  assert.equal(limited.length, 2);
  assert.deepEqual(
    limited.map((file) => file.basename).sort(),
    ["Kitchen lighting", "Kitchen renovation"].sort(),
    "alphabetical among equal scores"
  );
  assert.equal(hermes.suggestNotes(CANDIDATES, "", 2).length, 2, "an empty query offers notes");
  assert.equal(hermes.suggestNotes(CANDIDATES, "zzz").length, 0);
});

// --- slash commands --------------------------------------------------------

test("slash commands are recognised only at the start of the line", () => {
  assert.equal(hermes.isCommandInput("/note"), true);
  assert.equal(hermes.isCommandInput("/"), true);
  assert.equal(hermes.isCommandInput("/note kitchen"), false, "the command word is finished");
  assert.equal(hermes.isCommandInput("hi /note"), false);
});

test("the command list filters as you type", () => {
  assert.ok(hermes.filterCommands("/").length >= 8, "an empty query lists everything");
  assert.deepEqual(hermes.filterCommands("/no").map((command) => command.name), ["note"]);
  assert.deepEqual(hermes.filterCommands("/zz").length, 0);
});

test("running a command expands to a message the normal pipeline handles", () => {
  const note = hermes.runCommand("/note leak in the basement");
  assert.equal(note.kind, "message");
  assert.equal(note.text, "Create a new note about: leak in the basement");
  assert.ok(hermes.looksLikeNewNoteRequest(note.text), "the expanded text must trigger the new-note path");

  const fix = hermes.runCommand("/fix");
  assert.equal(fix.kind, "message");
  assert.ok(fix.text.indexOf("Fix the Markdown and Obsidian formatting") === 0, fix.text);
  assert.ok(fix.text.indexOf("{rest}") < 0, "no placeholder may survive");

  const improve = hermes.runCommand("/improve make it shorter");
  assert.ok(improve.text.indexOf("shorter") >= 0, improve.text);
  assert.ok(improve.text.indexOf("{rest}") < 0, improve.text);
});

test("action commands and unknown commands are told apart", () => {
  assert.deepEqual(hermes.runCommand("/clear"), { kind: "action", action: "clear", command: hermes.SLASH_COMMANDS[5] });
  assert.equal(hermes.runCommand("/settings").action, "settings");
  assert.equal(hermes.runCommand("/help").action, "help");
  assert.equal(hermes.runCommand("/nope").kind, "unknown");
  assert.equal(hermes.runCommand("just a message"), null);
  assert.equal(hermes.runCommand("// not a command"), null);
});

// --- error log -------------------------------------------------------------

test("the error log rotates instead of growing forever", () => {
  let text = "";
  for (let index = 0; index < 300; index++) {
    text += JSON.stringify({ at: "2026-09-14T10:00:0" + (index % 10) + "Z", source: "test", message: "failure " + index }) + "\n";
  }
  assert.ok(text.length > 2000, "precondition: the log is over the cap");
  const rotated = hermes.rotateLog(text, 2000);
  assert.ok(rotated.length <= 2000, "rotated size: " + rotated.length);
  assert.ok(rotated.indexOf("failure 299") >= 0, "the newest entry must survive");
  assert.ok(rotated.indexOf("failure 0\n") < 0, "the oldest entry must be dropped");
  const parsed = hermes.parseErrorLog(rotated);
  assert.equal(parsed[parsed.length - 1].message, "failure 299", "the log stays parseable after rotation");
});

test("a truncated tail line is skipped, newest last, with a limit", () => {
  const text =
    hermes.formatErrorEntry({ at: "2026-09-14T10:00:00Z", source: "Test connection", message: "one" }) +
    hermes.formatErrorEntry({ at: "2026-09-14T10:00:01Z", source: "Chat", message: "two", detail: "ECONNREFUSED" }) +
    '{"at":"2026-09-14T10:00:02Z","sou';
  const all = hermes.parseErrorLog(text);
  assert.equal(all.length, 2, "the half-written line is ignored");
  assert.equal(all[1].source, "Chat");
  assert.equal(all[1].detail, "ECONNREFUSED");
  assert.deepEqual(hermes.parseErrorLog(text, 1).map((entry) => entry.message), ["two"]);
  assert.ok(hermes.formatErrorEntry({ at: "x", source: "y", message: "z" }).endsWith("\n"));
});

test("the error log serialises writes and never rejects", async () => {
  let file = "";
  let writes = 0;
  const log = new hermes.ErrorLog({
    read: async () => file,
    write: async (next) => {
      writes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      file = next;
    },
  });

  await Promise.all([
    log.record({ at: "a", source: "s1", message: "first" }),
    log.record({ at: "b", source: "s2", message: "second" }),
    log.record({ at: "c", source: "s3", message: "third" }),
  ]);
  assert.deepEqual(
    (await log.read()).map((entry) => entry.message),
    ["first", "second", "third"],
    "concurrent records must not interleave or reorder"
  );
  assert.equal(writes, 3);

  await log.clear();
  assert.deepEqual(await log.read(), []);
});

test("a broken log does not break the caller", async () => {
  const log = new hermes.ErrorLog({
    read: async () => {
      throw new Error("disk gone");
    },
    write: async () => {
      throw new Error("disk gone");
    },
  });
  await log.record({ at: "a", source: "s", message: "m" });
  assert.deepEqual(await log.read(), []);
  await log.clear();
});

test("describeForLog copes with anything thrown", () => {
  assert.equal(hermes.describeForLog(new Error("boom")), "boom");
  assert.equal(hermes.describeForLog("plain"), "plain");
  assert.equal(hermes.describeForLog({ code: 401 }), '{"code":401}');
  assert.equal(hermes.describeForLog(null), "null");
});

// --- note titles -----------------------------------------------------------

test("a note is never titled after the assistant or with a stand-in", () => {
  const rejected = [
    "Hermes",
    "hermes answer",
    "# Hermes",
    "Hermes:",
    "Hermes reply",
    "Hermes agent notes",
    "AI note",
    "Answer",
    "Note",
    "Untitled",
    "new note",
    "",
    "   ",
    "summary by hermes",
  ];
  for (const bad of rejected) {
    assert.equal(hermes.isPlaceholderTitle(bad), true, "should be rejected: " + JSON.stringify(bad));
  }
  const allowed = ["Kitchen renovation", "Boiler service 2026", "Lead times in the workshop", "Hermeneutics", "Hermesstraat 12"];
  for (const good of allowed) {
    assert.equal(hermes.isPlaceholderTitle(good), false, "should be allowed: " + good);
  }
});

test("a title the note declares is used, but never a placeholder one", () => {
  assert.equal(hermes.declaredTitle("---\ntitle: Hermes answer\n---\n\n# Roof inspection\n\nbody"), "Roof inspection");
  assert.equal(hermes.declaredTitle("---\ntitle: Hermes answer\n---\n\nbody only"), "");
  assert.equal(hermes.declaredTitle("# Kitchen renovation\n\nbody"), "Kitchen renovation");
  assert.equal(hermes.declaredTitle("---\ntitle: Untitled\n---\n\n# Hermes summary\n\nbody"), "");
  assert.equal(hermes.declaredTitle("nothing to see"), "");
});

test("with no title of its own, the note is named after its content", () => {
  assert.equal(hermes.contentTitle("Lead times are growing in the workshop."), "Lead times are growing in the workshop");
  assert.equal(hermes.contentTitle("> [!note] Boiler pressure is low\n\nbody"), "Boiler pressure is low");
  assert.equal(hermes.contentTitle("```\ncode only\n```"), "", "code is not a title");
  assert.equal(hermes.contentTitle("Hermes answer\n\nreal text"), "real text");
});

test("titleFromNote refuses the request text as a title", () => {
  const long = "one two three four five six seven eight nine ten eleven twelve";
  assert.equal(hermes.titleFromNote("no heading here", long), "no heading here");
  assert.equal(hermes.titleFromNote("body without title", "make it shorter"), "body without title");
  assert.equal(hermes.titleFromNote("", "Kitchen renovation"), "Kitchen renovation");
  assert.equal(hermes.titleFromNote("", "Hermes answer"), "Untitled note");
  assert.equal(hermes.titleFromNote("", "make it shorter"), "Untitled note");
  assert.equal(hermes.titleFromNote("", "What links should this note have?"), "Untitled note");
  assert.equal(hermes.titleFromNote("", ""), "Untitled note");
});

test("normalizeTitle strips the wrappers a model adds", () => {
  assert.equal(hermes.normalizeTitle("## **`Kitchen renovation`**"), "Kitchen renovation");
  assert.equal(hermes.normalizeTitle('  "Boiler service:"  '), "Boiler service");
  assert.equal(hermes.normalizeTitle("title: Roof inspection"), "Roof inspection");
  assert.equal(hermes.normalizeTitle("Kitchen   renovation\nsecond line"), "Kitchen renovation");
  assert.equal(hermes.normalizeTitle(""), "");
});

test("titleUserPrompt tells the agent what a title may not be", () => {
  const prompt = hermes.titleUserPrompt("# Kitchen renovation\n\nbody");
  assert.ok(prompt.indexOf("Answer with the title only") === 0, prompt);
  assert.ok(prompt.indexOf("Hermes") >= 0, "the refusal list must mention the assistant name");
  assert.ok(prompt.indexOf("# Kitchen renovation") >= 0, "the note must be included");
});

// --- streaming: what the user is told ---------------------------------------

test("the transport label tells the truth about streaming", () => {
  assert.equal(hermes.transportLabel({ streamed: true, buffered: false, fellBack: false }), "streamed live");
  assert.ok(
    hermes.transportLabel({ streamed: true, buffered: true, fellBack: false }).indexOf("buffering") >= 0,
    "a buffered stream must be called out"
  );
  assert.ok(hermes.transportLabel({ streamed: false, buffered: false, fellBack: true }).indexOf("refused") >= 0);
  assert.ok(hermes.transportLabel({ streamed: false, buffered: false, fellBack: false }).indexOf("streaming is off") >= 0);
});

// --- copy, move and delete --------------------------------------------------

test("a file-operation plan is read from the model's JSON", () => {
  const plan = hermes.parseFileOps(
    '```json\n{"ops":[{"op":"move","from":"A.md","to":"Archive/A.md"},{"op":"delete","from":"B.md"}],"note":"tidying"}\n```'
  );
  assert.equal(plan.ops.length, 2);
  assert.equal(plan.ops[0].op, "move");
  assert.equal(plan.ops[0].to, "Archive/A.md");
  assert.equal(plan.ops[1].op, "delete");
  assert.equal(plan.note, "tidying");

  const bare = hermes.parseFileOps(
    '[{"op":"rename","from":"A.md","to":"B.md"},{"op":"duplicate","from":"C.md","to":"D.md"},{"op":"remove","from":"E.md"}]'
  );
  assert.deepEqual(bare.ops.map((op) => op.op), ["move", "copy", "delete"]);

  assert.deepEqual(hermes.parseFileOps("I could not find that note.").ops, []);
  assert.deepEqual(hermes.parseFileOps("").ops, []);

  const many = [];
  for (let index = 0; index < 40; index++) many.push({ op: "delete", from: "note-" + index + ".md" });
  many.push({ op: "delete", from: "note-0.md" });
  const capped = hermes.parseFileOps(JSON.stringify({ ops: many }));
  assert.equal(capped.ops.length, hermes.MAX_FILE_OPS, "the plan must be capped");
  assert.ok(capped.dropped >= 15, "dropped: " + capped.dropped);
});

const VAULT_FILES = [
  { basename: "Kitchen renovation", path: "House/Kitchen renovation.md" },
  { basename: "Boiler service", path: "Home/Boiler service.md" },
  { basename: "Draft 2025", path: "Draft 2025.md" },
  { basename: "photo", path: "Attachments/photo.png" },
  { basename: "readme", path: ".obsidian/plugins/x/readme.md" },
];

test("file operations are resolved against the real vault", () => {
  const valid = hermes.validateFileOps([{ op: "move", from: "Boiler service", to: "Archive/Boiler service" }], VAULT_FILES);
  assert.equal(valid[0].skip, undefined);
  assert.equal(valid[0].from, "Home/Boiler service.md");
  assert.equal(valid[0].to, "Archive/Boiler service.md");
  assert.ok(valid[0].label.indexOf("Move") === 0, valid[0].label);

  // A folder the vault actually has means "into that folder"; a bare word that is
  // not a folder is a new name.
  const FOLDERS = ["Archive", "House"];
  assert.equal(
    hermes.validateFileOps([{ op: "copy", from: "Boiler service", to: "Archive" }], VAULT_FILES, FOLDERS)[0].to,
    "Archive/Boiler service.md"
  );
  assert.equal(
    hermes.validateFileOps([{ op: "copy", from: "Boiler service", to: "Archive/" }], VAULT_FILES, FOLDERS)[0].to,
    "Archive/Boiler service.md"
  );
  assert.equal(
    hermes.validateFileOps([{ op: "move", from: "Boiler service", to: "Archive/Boiler plant" }], VAULT_FILES, FOLDERS)[0].to,
    "Archive/Boiler plant.md",
    "a path without an extension is a note path, not a folder"
  );
  assert.equal(
    hermes.validateFileOps([{ op: "copy", from: "Boiler service", to: "Boiler copy" }], VAULT_FILES, FOLDERS)[0].to,
    "Boiler copy.md",
    "a word the vault has no folder for is a name, not a folder"
  );

  // A new name is cleaned rather than refused.
  const cleaned = hermes.validateFileOps([{ op: "move", from: "Draft 2025", to: "Draft 2025: final?" }], VAULT_FILES);
  assert.equal(cleaned[0].skip, undefined, JSON.stringify(cleaned[0]));
  assert.ok(cleaned[0].to.indexOf(":") < 0 && cleaned[0].to.indexOf("?") < 0, cleaned[0].to);
  assert.ok(cleaned[0].to.endsWith(".md"), cleaned[0].to);
});

test("a file operation that cannot run says why instead of guessing", () => {
  const cases = [
    [{ op: "move", from: "Nowhere", to: "Archive/Nowhere" }, "no note matches"],
    [{ op: "move", from: "Kitchen renovation", to: "Home/Boiler service.md" }, "already exists"],
    [{ op: "move", from: "Kitchen renovation", to: "House/Kitchen renovation.md" }, "already is"],
    [{ op: "delete", from: "photo" }, "only Markdown"],
    [{ op: "delete", from: ".obsidian/plugins/x/readme.md" }, "off limits"],
    [{ op: "move", from: "Kitchen renovation", to: "../../outside.md" }, "not valid"],
    [{ op: "move", from: "Kitchen renovation" }, "no destination"],
  ];
  for (const entry of cases) {
    const result = hermes.validateFileOps([entry[0]], VAULT_FILES);
    assert.ok(
      result[0].skip && result[0].skip.indexOf(entry[1]) >= 0,
      JSON.stringify(result[0]) + " should mention " + entry[1]
    );
  }

  // Two operations cannot claim the same destination.
  const clash = hermes.validateFileOps(
    [
      { op: "move", from: "Boiler service", to: "Archive/Twin.md" },
      { op: "move", from: "Draft 2025", to: "Archive/Twin.md" },
    ],
    VAULT_FILES
  );
  assert.equal(clash[0].skip, undefined);
  assert.ok(clash[1].skip && clash[1].skip.indexOf("already exists") >= 0, JSON.stringify(clash[1]));
});

test("the plan listing puts the notes the request names first", () => {
  const files = [
    { basename: "Alpha", path: "Alpha.md" },
    { basename: "Boiler service", path: "Home/Boiler service.md" },
    { basename: "Charlie", path: "Charlie.md" },
  ];
  const listing = hermes.planListing(files, "move the boiler note into Archive");
  assert.equal(listing[0], "Home/Boiler service.md");
  assert.equal(listing.length, 3);
  assert.equal(hermes.planListing(files, "x", 2).length, 2);
});

test("file-operation requests are told apart from questions", () => {
  assert.equal(hermes.looksLikeFileOpRequest("move the boiler note into Archive"), true);
  assert.equal(hermes.looksLikeFileOpRequest("delete the draft note"), true);
  assert.equal(hermes.looksLikeFileOpRequest("copy [[Kitchen renovation]] to Archive"), true);
  assert.equal(hermes.looksLikeFileOpRequest("What links should this note have?"), false);
  assert.equal(hermes.looksLikeFileOpRequest("How do I delete notes in Obsidian?"), false);
  assert.equal(hermes.looksLikeFileOpRequest("summarise this note"), false);
  assert.equal(hermes.looksLikeFileOpRequest(""), false);
});

test("the summary counts only what will really happen", () => {
  const ops = hermes.validateFileOps(
    [
      { op: "move", from: "Boiler service", to: "Archive/Boiler service" },
      { op: "copy", from: "Draft 2025", to: "Archive/Draft 2025" },
      { op: "delete", from: "Nowhere" },
    ],
    VAULT_FILES
  );
  const summary = hermes.summarizeFileOps(ops);
  assert.ok(summary.indexOf("1 moved") >= 0, summary);
  assert.ok(summary.indexOf("1 copied") >= 0, summary);
  assert.ok(summary.indexOf("1 skipped") >= 0, summary);
});

// --- line diff (the review window) ------------------------------------------

test("an unchanged note has no diff", () => {
  const same = hermes.diffLines("# A\n\nbody\n", "# A\n\nbody\n");
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
  assert.equal(same.coarse, false);
  assert.equal(hermes.summarizeDiff(same), "No changes.");
  assert.equal(hermes.contentChanged("a", "a"), false);
  assert.equal(hermes.contentChanged("a", "b"), true);
});

test("changed, added and removed lines are counted", () => {
  const before = "# Kitchen renovation\n\nBudget is tight.\nStatus: draft\n";
  const after = "# Kitchen renovation\n\nBudget is tight for now.\nStatus: approved\nExtra: yes\n";
  const diff = hermes.diffLines(before, after);
  assert.equal(diff.coarse, false);
  assert.equal(diff.removed, 2, "the two replaced lines count as removed");
  assert.equal(diff.added, 3, "the two replacements plus the new line");
  assert.equal(hermes.summarizeDiff(diff), "3 lines added, 2 lines removed");
  const same = diff.lines.filter((line) => line.type === "same").map((line) => line.text);
  assert.deepEqual(same, ["# Kitchen renovation", ""], "untouched lines are preserved in order");
});

test("a one-line edit in a long note stays cheap and precise", () => {
  const lines = [];
  for (let index = 0; index < 400; index++) lines.push("line " + index);
  const before = lines.join("\n");
  const after = lines.slice().map((line, index) => (index === 200 ? "line 200 changed" : line)).join("\n");
  const diff = hermes.diffLines(before, after);
  assert.equal(diff.coarse, false, "common top and bottom are trimmed before aligning");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.lines.length, 401, "every line is still represented");
  assert.equal(diff.lines.filter((line) => line.type === "same").length, 399);
});

test("the displayed diff keeps context and collapses the rest", () => {
  const lines = [];
  for (let index = 0; index < 30; index++) lines.push("line " + index);
  const before = lines.join("\n");
  const after = lines.slice().map((line, index) => (index === 15 ? "line 15 changed" : line)).join("\n");
  const shown = hermes.diffForDisplay(hermes.diffLines(before, after), 2);
  assert.ok(shown.length < 12, "only the change and its context are shown: " + shown.length);
  assert.ok(shown.some((line) => line.type === "remove"), "the old line is shown");
  assert.ok(shown.some((line) => line.type === "add"), "the new line is shown");
  assert.equal(shown.filter((line) => line.text === "…").length, 2, "the two skipped regions are marked");
  const only = shown.filter((line) => line.type !== "same");
  assert.equal(only.length, 2, JSON.stringify(shown));
});

test("an enormous change is declared coarse instead of pretending", () => {
  const before = [];
  const after = [];
  for (let index = 0; index < 1300; index++) {
    before.push("old " + index);
    after.push("new " + index);
  }
  const diff = hermes.diffLines(before.join("\n"), after.join("\n"));
  assert.equal(diff.coarse, true);
  assert.deepEqual(diff.lines, []);
  assert.ok(hermes.summarizeDiff(diff).indexOf("too large") >= 0, hermes.summarizeDiff(diff));
  assert.deepEqual(hermes.diffForDisplay(diff), [], "a coarse diff displays nothing");
});

// --- the queue --------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("queued work runs one job at a time, in order", async () => {
  const queue = new hermes.SerialQueue();
  const log = [];
  const first = queue.run("first", async () => {
    log.push("first:start");
    await wait(30);
    log.push("first:end");
    return 1;
  });
  const second = queue.run("second", async () => {
    log.push("second:start");
    await wait(10);
    log.push("second:end");
    return 2;
  });
  const third = queue.run("third", async () => {
    log.push("third:start");
    log.push("third:end");
    return 3;
  });

  assert.equal(queue.isBusy(), true, "the first job starts immediately");
  assert.equal(queue.activeLabel(), "first");
  assert.deepEqual(queue.waiting().map((entry) => entry.label), ["second", "third"]);

  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(
    log,
    ["first:start", "first:end", "second:start", "second:end", "third:start", "third:end"],
    "no interleaving: " + log.join(", ")
  );
  assert.equal(queue.isBusy(), false);
  assert.deepEqual(queue.waiting(), []);
});

test("a failing job does not strand the ones behind it", async () => {
  const queue = new hermes.SerialQueue();
  const results = [];
  const failing = queue.run("bad", async () => {
    throw new Error("boom");
  });
  const following = queue.run("good", async () => "fine");
  results.push(await failing.then(() => "resolved", (error) => "rejected: " + error.message));
  results.push(await following);
  assert.deepEqual(results, ["rejected: boom", "fine"]);
  assert.equal(queue.isBusy(), false, "the queue drained despite the failure");
});

test("a job that has not started can be cancelled, and the queue is told about it", async () => {
  const queue = new hermes.SerialQueue();
  let changes = 0;
  const unsubscribe = queue.onChange(() => {
    changes++;
  });
  const running = queue.run("running", async () => {
    await wait(20);
    return "done";
  });
  const waiting = queue.run("waiting", async () => "never");
  const id = queue.waiting()[0].id;
  assert.equal(queue.cancel(id), true, "the waiting job is cancelled");
  assert.equal(queue.cancel("job-does-not-exist"), false);
  assert.deepEqual(queue.waiting(), []);
  assert.ok(changes > 0, "listeners were notified");
  await assert.rejects(() => waiting, (error) => error.message.indexOf("Cancelled") >= 0);
  assert.equal(await running, "done", "the running job is never interrupted");
  unsubscribe();
  assert.equal(queue.cancelWaiting(), 0);
});

test("everything waiting can be dropped at once", async () => {
  const queue = new hermes.SerialQueue();
  const running = queue.run("running", async () => {
    await wait(15);
    return "kept";
  });
  const a = queue.run("a", async () => "a");
  const b = queue.run("b", async () => "b");
  assert.equal(queue.cancelWaiting(), 2);
  await assert.rejects(() => a);
  await assert.rejects(() => b);
  assert.equal(await running, "kept");
});

// --- quick prompts ----------------------------------------------------------

test("quick prompts are cleaned up and capped", () => {
  const cleaned = hermes.normalizeQuickPrompts([
    { id: "a", label: "One", prompt: "  do a thing  " },
    { prompt: "" },
    null,
    { id: "a", label: "duplicate id", prompt: "second" },
    { prompt: "no label here" },
  ]);
  assert.equal(cleaned.length, 2, JSON.stringify(cleaned));
  assert.equal(cleaned[0].prompt, "do a thing", "whitespace is trimmed");
  assert.equal(cleaned[1].label, "no label here", "a missing label falls back to the prompt");
  assert.deepEqual(hermes.normalizeQuickPrompts("nonsense"), []);

  const many = [];
  for (let index = 0; index < 60; index++) many.push({ id: "p" + index, label: "p", prompt: "prompt " + index });
  assert.equal(hermes.normalizeQuickPrompts(many).length, hermes.MAX_QUICK_PROMPTS);
});

test("typing ! searches quick prompts", () => {
  assert.equal(hermes.quickPromptQuery("!"), "");
  assert.equal(hermes.quickPromptQuery("!sum"), "sum");
  assert.equal(hermes.quickPromptQuery("!sum more"), null, "a space ends the lookup");
  assert.equal(hermes.quickPromptQuery("hello"), null);

  const prompts = hermes.defaultQuickPrompts();
  assert.equal(hermes.filterQuickPrompts(prompts, "summarise")[0].label, "Summarise this note");
  assert.equal(hermes.filterQuickPrompts(prompts, "").length, prompts.length);
  assert.equal(hermes.filterQuickPrompts(prompts, "zzz").length, 0);
  assert.ok(hermes.filterQuickPrompts(prompts, "tag")[0].label.indexOf("tag") >= 0);
});

test("a quick prompt can name the open note", () => {
  assert.equal(hermes.fillQuickPrompt("Summarise @[[{note}]].", "Kitchen renovation"), "Summarise @[[Kitchen renovation]].");
  assert.equal(hermes.fillQuickPrompt("Summarise {note}.", ""), "Summarise this note.");
});

// --- chat history -----------------------------------------------------------

test("history sessions are titled, bounded and searchable", () => {
  const entries = [
    { role: "assistant", content: "hello" },
    { role: "user", content: "Move the boiler note into Archive\nand tell me why" },
  ];
  assert.equal(hermes.sessionTitle(entries), "Move the boiler note into Archive");
  assert.equal(hermes.sessionTitle([{ role: "assistant", content: "only an answer" }]), "Untitled conversation");
  assert.equal(hermes.sessionTitle([{ role: "user", content: "x".repeat(90) }]).length, 58, "long titles are shortened");

  const cleaned = hermes.normalizeHistory([
    { id: "s1", at: 5, entries: [{ role: "user", content: "first" }, { role: "nope", content: "dropped" }] },
    { id: "s1", at: 6, entries: [{ role: "user", content: "duplicate id" }] },
    { at: 7, entries: [] },
    "junk",
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].entries.length, 1, "invalid entries are dropped");

  const sessions = [];
  for (let index = 0; index < 40; index++) {
    sessions.push({ id: "s" + index, title: "session " + index, at: index, entries: [{ role: "user", content: "body " + index }] });
  }
  const trimmed = hermes.trimSessions(sessions);
  assert.equal(trimmed.length, hermes.MAX_HISTORY_SESSIONS);
  assert.equal(trimmed[0].id, "s39", "newest first");
  assert.ok(trimmed.every((session) => session.id !== "s0"), "the oldest are dropped");

  const updated = hermes.upsertSession(trimmed, { id: "s39", title: "renamed", at: 99, entries: [{ role: "user", content: "new" }] });
  assert.equal(updated.length, trimmed.length, "an existing session is replaced, not duplicated");
  assert.equal(updated[0].title, "renamed");
  assert.equal(updated[0].at, 99);

  assert.equal(hermes.searchSessions(trimmed, "session 12").length, 1);
  assert.equal(hermes.searchSessions(trimmed, "body 12").length, 1, "the message bodies are searched too");
  assert.equal(hermes.searchSessions(trimmed, "nothing here").length, 0);
  assert.equal(hermes.searchSessions(trimmed, "").length, trimmed.length);
  assert.equal(hermes.removeSession(trimmed, "s39").length, trimmed.length - 1);

  const now = 100 * 60 * 60 * 1000;
  assert.ok(hermes.describeSession({ id: "x", title: "t", at: now - 20000, entries: [] }, now).indexOf("just now") >= 0);
  assert.ok(hermes.describeSession({ id: "x", title: "t", at: now - 7200000, entries: [] }, now).indexOf("hours ago") >= 0);
  assert.ok(hermes.describeSession({ id: "x", title: "t", at: 0, entries: [] }, now).indexOf("unknown") >= 0);
});

// --- connection profiles ----------------------------------------------------

test("a connection profile captures and restores the connection", () => {
  const base = Object.assign({}, hermes.DEFAULT_SETTINGS);
  const capture = hermes.captureProfile(base, "Local", 1000);
  assert.equal(capture.name, "Local");
  assert.equal(capture.baseUrl, base.baseUrl);

  const moved = Object.assign({}, base, { baseUrl: "https://hermes.example.com", apiKey: "other", provider: "x" });
  hermes.applyProfile(moved, capture);
  assert.equal(moved.baseUrl, base.baseUrl, "the URL comes back");
  assert.equal(moved.provider, "", "the provider comes back too");

  assert.equal(hermes.profileMatches(base, capture), true);
  assert.equal(hermes.profileMatches(moved, capture), true, "moved was restored");
  const different = Object.assign({}, base, { apiKey: "another-key" });
  assert.equal(hermes.profileMatches(different, capture), false);
});

test("profiles are bounded, replaceable by name, and never leak the key", () => {
  const base = Object.assign({}, hermes.DEFAULT_SETTINGS, { apiKey: "super-secret-key" });
  const one = hermes.captureProfile(base, "Server", 10);
  let list = hermes.upsertProfile([], one);
  assert.equal(list.length, 1);
  list = hermes.upsertProfile(list, hermes.captureProfile(base, "server", 20));
  assert.equal(list.length, 1, "the same name replaces the existing profile");
  assert.equal(list[0].at, 20, "the newest version wins");
  assert.equal(list[0].id, one.id, "and it keeps its id, so references stay valid");

  const description = hermes.describeProfile(one);
  assert.ok(description.indexOf("super-secret-key") < 0, "the key must never appear: " + description);
  assert.ok(description.indexOf("key set") >= 0, description);
  assert.ok(description.indexOf("127.0.0.1:8642") >= 0, "the host is shown: " + description);

  assert.equal(hermes.findProfile(list, one.id)?.name, "Server");
  assert.equal(hermes.findProfile(list, "nope"), null);
  assert.equal(hermes.removeProfile(list, one.id).length, 0);

  const cleaned = hermes.normalizeProfiles([{ name: "no url" }, { baseUrl: "  http://a:1  ", name: "A" }, "junk"]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].baseUrl, "http://a:1");
  let many = [];
  for (let index = 0; index < 20; index++) {
    many = hermes.upsertProfile(many, hermes.captureProfile(base, "p" + index, index));
  }
  assert.equal(many.length, hermes.MAX_PROFILES);
});

test("the first changed line is where the cursor belongs", () => {
  assert.equal(hermes.firstChangedLine("a\nb\nc", "a\nB\nc"), 1);
  assert.equal(hermes.firstChangedLine("a\nb", "a\nb"), 0, "no change means the top");
  assert.equal(hermes.firstChangedLine("a\nb", "a\nb\nc"), 2, "an added line at the end");
  assert.equal(hermes.firstChangedLine("a\nb\nc", "a\nc"), 1, "a removed line");
  assert.equal(hermes.firstChangedLine("", "x"), 0);
});

// --- report ---------------------------------------------------------------

console.log("selftest: " + passed + " passed, " + failed + " failed");
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log("  ✗ " + failure);
  process.exit(1);
}
