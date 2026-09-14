/**
 * Drives the real plugin class (src/main.ts) against the mock Hermes server:
 * testConnection, the setup page's quick prompt (buffered and streamed), the
 * error path, and the vault scan. This is the end-to-end proof that a prompt
 * typed in Obsidian reaches Hermes and comes back as an answer.
 */

import assert from "node:assert/strict";
import * as hermes from "./.build/tests.mjs";
import { startMockServer } from "./mock-hermes-server.mjs";

const VAULT_NOTES = [
  {
    path: "Kitchen renovation.md",
    content:
      "---\ntitle: Kitchen renovation\ntags: [house, project]\ncreated: 2026-01-05\nstatus: draft\n---\n\n# Kitchen renovation\n\nSee [[Boiler service]]\n\n> [!note] Budget is tight\n",
  },
  {
    path: "Notes/Boiler service.md",
    content: "---\ntitle: Boiler service\n---\n\n# Boiler service\n\nBack to [[Kitchen renovation]]\n",
  },
];

const server = await startMockServer({ key: "test-key" });
const app = hermes.makeAppObject(VAULT_NOTES);

async function makePlugin(overrides) {
  const plugin = new hermes.HermesAgentNotesPlugin(app, { id: "hermes-agent-notes", version: "test" });
  // Boot the plugin for real: onload registers views, commands, the settings tab
  // and the status bar, and mints the session id used by the session headers.
  await plugin.onload();
  plugin.settings = Object.assign(
    {},
    plugin.settings,
    { baseUrl: server.baseUrl, apiKey: "test-key" },
    overrides || {}
  );
  return plugin;
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(name + "\n      " + (error && error.message ? error.message : String(error)));
  }
}

await test("testConnection finds the agent and records it in the settings", async () => {
  const plugin = await makePlugin();
  const state = await plugin.testConnection();
  assert.equal(state.ok, true);
  assert.ok(state.detail.includes("status: ok"), "detail: " + state.detail);
  assert.deepEqual(plugin.settings.availableModels, ["hermes-agent"]);
  assert.equal(plugin.__data.connection.ok, true, "settings were not persisted");
  assert.equal(plugin.endpointLabel(), server.baseUrl);
});

await test("a prompt typed in the setup page is answered end to end", async () => {
  const plugin = await makePlugin();
  server.seen.length = 0;
  const result = await plugin.quickPrompt("Which model are you?");
  assert.equal(result.text, server.answer);
  assert.equal(result.streamed, false);
  assert.equal(result.model, "hermes-agent");
  assert.ok(result.ms >= 0);
  assert.ok(plugin.settings.connection.ok, "a live answer should mark the connection healthy");
  assert.ok(/live prompt/.test(plugin.settings.connection.detail), plugin.settings.connection.detail);

  const call = server.seen.find((entry) => entry.url === "/v1/chat/completions");
  assert.ok(call, "no chat request was sent");
  const payload = JSON.parse(call.body);
  assert.equal(payload.stream, false);
  assert.equal(call.headers.authorization, "Bearer test-key");
  assert.equal(payload.messages[0].role, "system");
  assert.ok(/OBSIDIAN MARKDOWN RULES/.test(payload.messages[0].content), "system prompt lacks the Obsidian rules");
  assert.ok(/VAULT CONVENTIONS/.test(payload.messages[0].content), "system prompt lacks the vault conventions");
  assert.ok(/TestVault/.test(payload.messages[0].content), "system prompt does not name the vault");
  assert.ok(/Kitchen renovation/.test(payload.messages[0].content), "existing note names were not offered for linking");
  assert.ok(payload.messages[1].content.includes("Which model are you?"), "the prompt did not reach the model");
  assert.ok(call.headers["x-hermes-session-id"], "session reporting header missing");
});

await test("the same prompt streams when streaming is turned on", async () => {
  const plugin = await makePlugin({ streaming: true });
  server.seen.length = 0;
  const deltas = [];
  const result = await plugin.quickPrompt("Stream please", (delta, full) => {
    deltas.push(delta);
    assert.ok(full.endsWith(delta));
  });
  assert.equal(result.streamed, true);
  assert.equal(deltas.length, 3, "expected three SSE deltas");
  assert.equal(result.text, server.answer);
  assert.equal(JSON.parse(server.seen.find((entry) => entry.url === "/v1/chat/completions").body).stream, true);
});

await test("a wrong key fails the prompt with an actionable message", async () => {
  const plugin = await makePlugin({ apiKey: "nope", streaming: true });
  await assert.rejects(
    () => plugin.quickPrompt("hello", () => {}),
    (error) => {
      assert.equal(error.kind, "auth");
      assert.ok(/API_SERVER_KEY/.test(error.message), error.message);
      return true;
    }
  );
});

await test("the vault scan feeds the prompt without leaving the vault", async () => {
  const plugin = await makePlugin();
  const conventions = await plugin.getConventions(true);
  assert.equal(conventions.totalNotes, 2);
  assert.equal(conventions.scanned, 2);
  assert.ok(conventions.keys.some((key) => key.key === "title"));
  assert.ok(conventions.links.wiki >= 2, "wikilinks: " + conventions.links.wiki);
  assert.ok(conventions.callouts.includes("note"));
  const cached = await plugin.getConventions();
  assert.equal(cached.at, conventions.at, "the scan should be cached");
});

await test("settings survive a wiped plugin folder via the automatic backup", async () => {
  const plugin = await makePlugin({ autoBackup: false });
  plugin.settings.baseUrl = "https://hermes.example.com";
  plugin.settings.apiKey = "secret-key";
  plugin.settings.extraHeaders = "CF-Access-Client-Id: x";
  await plugin.writeBackup();

  const path = plugin.backupPath();
  assert.equal(path, ".obsidian/plugins/hermes-agent-notes/settings-backup.json");
  assert.ok(await app.vault.adapter.exists(path), "no backup file was written");
  const backup = JSON.parse(await app.vault.adapter.read(path));
  assert.equal(backup.baseUrl, "https://hermes.example.com");
  assert.equal(backup.apiKey, "secret-key");
  assert.equal("conventions" in backup, false, "caches must not be backed up");

  // simulate the plugin data being lost, then restore
  plugin.settings = Object.assign({}, hermes.DEFAULT_SETTINGS);
  assert.equal(plugin.settings.baseUrl, "http://127.0.0.1:8642");
  await plugin.restoreFromBackup();
  assert.equal(plugin.settings.baseUrl, "https://hermes.example.com");
  assert.equal(plugin.settings.apiKey, "secret-key");
  assert.equal(plugin.settings.extraHeaders, "CF-Access-Client-Id: x");
});

await test("export writes a visible settings file into the vault", async () => {
  const plugin = await makePlugin();
  plugin.settings.defaultFolder = "13.00 AI";
  const path = await plugin.exportSettings();
  assert.equal(path, "13.00 AI/Hermes Agent Notes settings.json");
  const exported = JSON.parse(await app.vault.adapter.read(path));
  assert.equal(exported.plugin, "hermes-agent-notes");
  assert.equal(typeof exported.exportedAt, "string");
  assert.equal(exported.baseUrl, server.baseUrl);
  assert.equal(exported.apiKey, "test-key");
});

await test("the automatic backup fires after a change, debounced", async () => {
  const plugin = await makePlugin({ autoBackup: true });
  const path = plugin.backupPath();
  await app.vault.adapter.remove(path);
  assert.equal(await app.vault.adapter.exists(path), false);
  plugin.settings.model = "hermes-agent";
  await plugin.saveSettings();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.ok(await app.vault.adapter.exists(path), "the debounced backup never ran");
  assert.ok(plugin.lastBackupAt > 0, "lastBackupAt was not recorded");
});

await test("an answer saved as a note drops the assistant's caveat", async () => {
  const plugin = await makePlugin({ stripCaveats: true, defaultFolder: "" });
  const answer = "The tiles arrive on Friday.\n\nLet me know if you want me to expand this.";
  await plugin.saveTextAsNote(answer, "Tiles");
  const saved = app.vault
    .getMarkdownFiles()
    .filter((file) => file.basename.startsWith("Lead times in the workshop"));
  assert.ok(saved.length >= 1, "the note was not created");
  const file = saved[saved.length - 1];
  const content = await app.vault.read(file);
  assert.ok(content.indexOf("tiles arrive on Friday") >= 0, content);
  assert.ok(content.indexOf("Let me know") < 0, "the caveat was written into the note: " + content);
  assert.ok(file.basename !== "Tiles", "a title-less answer must be named by the agent, not by the hint");
});

await test("with caveat stripping off, the answer is saved verbatim", async () => {
  const plugin = await makePlugin({ stripCaveats: false, defaultFolder: "" });
  await plugin.saveTextAsNote("Body text.\n\nLet me know if you want more.", "Verbatim");
  const saved = app.vault
    .getMarkdownFiles()
    .filter((file) => file.basename.startsWith("Lead times in the workshop"));
  assert.ok(saved.length >= 1);
  const content = await app.vault.read(saved[saved.length - 1]);
  assert.ok(content.indexOf("Let me know") >= 0, "stripping is off, the text must be untouched");
});

await test("append reaches the open note while the sidebar has focus", async () => {
  const plugin = await makePlugin();
  // Obsidian reports no active MarkdownView here — exactly what happens when the
  // chat panel owns focus — but getActiveFile() still knows the open note.
  app.setActiveFile("Kitchen renovation.md");
  assert.equal(plugin.activeNoteName(), "Kitchen renovation", "the active note was not found");
  await plugin.appendToActiveNote("Appended from the chat panel.\n\nLet me know if you want more.");
  const file = app.vault.getAbstractFileByPath("Kitchen renovation.md");
  const content = await app.vault.read(file);
  assert.ok(content.indexOf("Appended from the chat panel.") >= 0, "nothing was appended: " + content);
  assert.ok(content.indexOf("Let me know") < 0, "the caveat was appended: " + content);
  assert.ok(content.startsWith("---"), "existing frontmatter must survive: " + content);
  assert.ok(content.indexOf("See [[Boiler service]]") >= 0, "existing body must survive: " + content);
  assert.ok(content.indexOf("# Kitchen renovation") >= 0, "the heading must survive: " + content);
});

await test("with nothing open, append says so instead of writing anywhere", async () => {
  const plugin = await makePlugin();
  app.setActiveFile(null);
  assert.equal(plugin.activeNoteFile(), null);
  await plugin.appendToActiveNote("should not be written");
  const files = app.vault.getMarkdownFiles();
  const written = files.filter((file) => file.path.toLowerCase().indexOf("should") >= 0);
  assert.equal(written.length, 0, "a note was created for a request with no active note");
});

await test("a new-note request leaves the open note out of the request", async () => {
  const plugin = await makePlugin();
  app.setActiveFile("Kitchen renovation.md");

  await plugin.runChat([{ role: "user", content: "What links should this note have?" }]);
  const question = server.seen[server.seen.length - 1].body;
  assert.ok(question.indexOf("the note open in Obsidian") >= 0, "a question should carry the open note");

  await plugin.runChat([{ role: "user", content: "Create a new note about lead times" }]);
  const create = server.seen[server.seen.length - 1].body;
  assert.ok(create.indexOf("the note open in Obsidian") < 0, "the open note leaked into a new-note request: " + create.slice(0, 400));
  assert.ok(create.indexOf("OBSIDIAN MARKDOWN RULES") >= 0, "the house rules must still be sent");
  assert.ok(create.indexOf("VAULT CONVENTIONS") >= 0, "the vault conventions must still be sent");
});

await test("a mentioned note travels with the message", async () => {
  const plugin = await makePlugin();
  app.setActiveFile("Kitchen renovation.md");
  await plugin.runChat([{ role: "user", content: "Compare [[Boiler service]] with this note." }], {
    mentionTitles: ["Boiler service"],
  });
  const body = server.seen[server.seen.length - 1].body;
  assert.ok(body.indexOf("notes mentioned in this message") >= 0, "mention block missing: " + body.slice(0, 400));
  assert.ok(body.indexOf("Notes/Boiler service.md") >= 0, "the mentioned note's path is missing");
  assert.ok(body.indexOf("Back to [[Kitchen renovation]]") >= 0, "the mentioned note's content is missing");
});

await test("a mention that matches nothing is reported, not guessed", async () => {
  const plugin = await makePlugin();
  app.setActiveFile("Kitchen renovation.md");
  hermes.notices.length = 0;
  assert.equal((await plugin.resolveMentionedNotes(["Nonexistent note"])).length, 0);
  assert.ok(
    hermes.notices.some((message) => message.indexOf("Not sent with the message") >= 0),
    "the user must be told the note was left out: " + JSON.stringify(hermes.notices)
  );

  const found = await plugin.resolveMentionedNotes(["boiler service"]);
  assert.equal(found.length, 1, "a case-insensitive name should resolve");
  assert.equal(found[0].path, "Notes/Boiler service.md");
});

await test("a failed connection is recorded and can be read back", async () => {
  // Port 9 on the loopback interface: nothing listens there.
  const plugin = await makePlugin({ baseUrl: "http://127.0.0.1:9", probeTimeoutMs: 1500 });
  // The fake adapter is shared by every plugin instance in this file.
  await plugin.clearErrors();
  await plugin.testConnectionWithNotice();

  // recentErrors() goes through the write chain, so it also waits for the record.
  const recent = await plugin.recentErrors(10);
  assert.equal(recent.length, 1, "expected exactly one entry, got: " + JSON.stringify(recent));
  assert.equal(recent[0].source, "Test connection");
  assert.ok(recent[0].message.length > 0, "the entry must carry a message");
  assert.ok(plugin.errorLogPath().endsWith("errors.log"), plugin.errorLogPath());

  const raw = await app.vault.adapter.read(plugin.errorLogPath());
  assert.equal(hermes.parseErrorLog(raw).length, 1, "the file on disk holds the same entry: " + raw);

  await plugin.clearErrors();
  assert.deepEqual(await plugin.recentErrors(5), [], "clearing must empty the log");
});

await test("a successful connection writes nothing to the error log", async () => {
  const plugin = await makePlugin();
  await plugin.clearErrors();
  assert.equal((await plugin.testConnection()).ok, true, "the mock server should be reachable");
  await plugin.testConnectionWithNotice();
  assert.deepEqual(await plugin.recentErrors(5), [], "a healthy connection must stay quiet");
});

await test("a title-less answer is named by the agent, never by the plugin", async () => {
  const titleless = await startMockServer({
    key: "test-key",
    answer: "Body text with [[Boiler service]].",
    titleAnswer: "Boiler service follow-up",
  });
  try {
    const plugin = await makePlugin({ baseUrl: titleless.baseUrl, defaultFolder: "" });
    // A request-shaped hint must never become the file name.
    await plugin.saveTextAsNote("Body text with [[Boiler service]].", "make it shorter");

    const askedForTitle = titleless.seen.some((entry) => entry.body.indexOf("Answer with the title only") >= 0);
    assert.ok(askedForTitle, "the agent was never asked to name the note");

    const files = app.vault.getMarkdownFiles().map((file) => file.path);
    assert.ok(
      files.some((path) => path.indexOf("Boiler service follow-up") >= 0),
      "the agent's title should name the file: " + JSON.stringify(files)
    );
    const bogus = files.filter((path) => /hermes|untitled|make it shorter|Body text/i.test(path));
    assert.equal(bogus.length, 0, "a placeholder or the request text became a file name: " + JSON.stringify(bogus));
  } finally {
    titleless.close();
  }
});

await test("a placeholder title from the agent is refused and the content is used", async () => {
  const cheeky = await startMockServer({
    key: "test-key",
    answer: "Body text.",
    titleAnswer: "Hermes answer",
  });
  try {
    const plugin = await makePlugin({ baseUrl: cheeky.baseUrl, defaultFolder: "" });
    await plugin.saveTextAsNote("Leaking tap in the workshop kitchen.\n\nMore detail follows.", "whatever");
    const files = app.vault.getMarkdownFiles().map((file) => file.path);
    assert.ok(
      files.some((path) => path.indexOf("Leaking tap in the workshop kitchen") >= 0),
      "the content should name the note instead: " + JSON.stringify(files)
    );
    assert.equal(
      files.filter((path) => /hermes/i.test(path)).length,
      0,
      "no file may be named after the assistant: " + JSON.stringify(files)
    );
  } finally {
    cheeky.close();
  }
});

await test("the plugin reports which transport answered", async () => {
  // Default settings have streaming off, and the UI must say so plainly.
  const off = await makePlugin();
  let offInfo = null;
  await off.runChat([{ role: "user", content: "hi" }], { onDelta: () => {}, onTransport: (info) => (offInfo = info) });
  assert.deepEqual(offInfo, { streamed: false, buffered: false, fellBack: false }, JSON.stringify(offInfo));

  // With streaming on, the same call streams against the mock server.
  const on = await makePlugin({ streaming: true });
  let onInfo = null;
  const answer = await on.runChat([{ role: "user", content: "hi" }], { onDelta: () => {}, onTransport: (info) => (onInfo = info) });
  assert.deepEqual(onInfo, { streamed: true, buffered: false, fellBack: false }, JSON.stringify(onInfo));
  assert.ok(answer.indexOf("Kitchen renovation") >= 0, answer);
});

await test("a refused stream falls back, says so, and is logged", async () => {
  // A server (or proxy) that ignores stream:true and answers with JSON.
  const ignoring = await startMockServer({ key: "test-key", ignoreStream: true });
  try {
    const plugin = await makePlugin({ baseUrl: ignoring.baseUrl, streaming: true });
    await plugin.clearErrors();
    let info = null;
    const answer = await plugin.runChat([{ role: "user", content: "hi" }], {
      onDelta: () => {},
      onTransport: (value) => (info = value),
    });
    assert.equal(info.streamed, false, "the fallback must not claim to have streamed");
    assert.equal(info.fellBack, true, JSON.stringify(info));
    assert.ok(answer.indexOf("Kitchen renovation") >= 0, "the answer still arrives: " + answer);

    const log = await plugin.recentErrors(5);
    assert.equal(log.length, 1, "the refusal must be recorded: " + JSON.stringify(log));
    assert.equal(log[0].source, "Streaming");
    assert.ok(log[0].message.indexOf("without streaming") >= 0, log[0].message);
  } finally {
    ignoring.close();
  }
});

// --- copy, move and delete (its own vault, since these tests change files) ---

const fileApp = hermes.makeAppObject([
  {
    path: "Kitchen renovation.md",
    content: "---\ntitle: Kitchen renovation\n---\n\n# Kitchen renovation\n\nSee [[Boiler service]]\n",
  },
  { path: "Notes/Boiler service.md", content: "# Boiler service\n\nBack to [[Kitchen renovation]]\n" },
]);

async function makeFilePlugin() {
  const plugin = new hermes.HermesAgentNotesPlugin(fileApp, { id: "hermes-agent-notes", version: "test" });
  await plugin.onload();
  plugin.settings = Object.assign({}, plugin.settings, { baseUrl: server.baseUrl, apiKey: "test-key" });
  return plugin;
}

function pathsOf() {
  return fileApp.vault.getMarkdownFiles().map((file) => file.path);
}

await test("a move renames the note and its wikilinks follow", async () => {
  const plugin = await makeFilePlugin();
  const ops = hermes.validateFileOps(
    [{ op: "move", from: "Notes/Boiler service.md", to: "Archive/Boiler plant" }],
    fileApp.vault.getMarkdownFiles()
  );
  assert.equal(ops[0].skip, undefined, JSON.stringify(ops[0]));

  const summary = await plugin.applyFileOperations(ops, { permanentDelete: false });
  assert.ok(summary.indexOf("Moved") >= 0, summary);
  assert.ok(pathsOf().indexOf("Archive/Boiler plant.md") >= 0, "missing the new path: " + JSON.stringify(pathsOf()));
  assert.equal(fileApp.vault.getAbstractFileByPath("Notes/Boiler service.md"), null, "the old path is still there");
  assert.deepEqual(fileApp.fileOps.renamed, [{ from: "Notes/Boiler service.md", to: "Archive/Boiler plant.md" }]);

  const kitchen = await fileApp.vault.read(fileApp.vault.getAbstractFileByPath("Kitchen renovation.md"));
  assert.ok(kitchen.indexOf("[[Boiler plant]]") >= 0, "the wikilink did not follow the rename: " + kitchen);
});

await test("a copy leaves the original alone", async () => {
  const plugin = await makeFilePlugin();
  const ops = hermes.validateFileOps(
    [{ op: "copy", from: "Kitchen renovation.md", to: "Archive/Kitchen renovation" }],
    fileApp.vault.getMarkdownFiles()
  );
  const summary = await plugin.applyFileOperations(ops, { permanentDelete: false });
  assert.ok(summary.indexOf("Copied") >= 0, summary);
  const copy = fileApp.vault.getAbstractFileByPath("Archive/Kitchen renovation.md");
  assert.ok(copy, "the copy was not created: " + JSON.stringify(pathsOf()));
  const original = await fileApp.vault.read(fileApp.vault.getAbstractFileByPath("Kitchen renovation.md"));
  const duplicate = await fileApp.vault.read(copy);
  assert.equal(duplicate, original, "the copy should match the original");
  assert.equal(fileApp.fileOps.renamed.length, 1, "a copy must not be a rename");
});

await test("a delete goes to the trash unless it is asked to be permanent", async () => {
  const plugin = await makeFilePlugin();
  const trashed = hermes.validateFileOps([{ op: "delete", from: "Archive/Kitchen renovation.md" }], fileApp.vault.getMarkdownFiles());
  const summary = await plugin.applyFileOperations(trashed, { permanentDelete: false });
  assert.ok(summary.indexOf("trash") >= 0, summary);
  assert.deepEqual(fileApp.fileOps.trashed, ["Archive/Kitchen renovation.md"], "Obsidian's own delete should be used");
  assert.deepEqual(fileApp.fileOps.deleted, [], "nothing may be deleted permanently by default");
  assert.equal(fileApp.vault.getAbstractFileByPath("Archive/Kitchen renovation.md"), null);

  const permanent = hermes.validateFileOps([{ op: "delete", from: "Archive/Boiler plant.md" }], fileApp.vault.getMarkdownFiles());
  await plugin.applyFileOperations(permanent, { permanentDelete: true });
  assert.deepEqual(fileApp.fileOps.deleted, ["Archive/Boiler plant.md"]);
});

await test("a refused operation changes nothing", async () => {
  const plugin = await makeFilePlugin();
  // Create the obstacle inside the test, so it does not depend on what earlier
  // tests left behind.
  await fileApp.vault.create("Target.md", "# Target\n");
  const before = JSON.stringify(pathsOf());
  const ops = hermes.validateFileOps(
    [{ op: "move", from: "Kitchen renovation.md", to: "Target" }],
    fileApp.vault.getMarkdownFiles()
  );
  assert.ok(ops[0].skip && ops[0].skip.indexOf("already exists") >= 0, JSON.stringify(ops[0]));
  const summary = await plugin.applyFileOperations(ops, { permanentDelete: false });
  assert.ok(summary.indexOf("Nothing was changed") >= 0, summary);
  assert.equal(JSON.stringify(pathsOf()), before, "the vault must be untouched");
  assert.equal(fileApp.fileOps.renamed.length, 1, "no extra rename may happen");
});

await test("a second command waits for the first, in order", async () => {
  const plugin = await makePlugin();
  const order = [];
  const first = plugin.queued("First", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("first:end");
  });
  const second = plugin.queued("Second", async () => {
    order.push("second:start");
    order.push("second:end");
  });

  assert.equal(plugin.queue.isBusy(), true, "the first job runs straight away");
  assert.deepEqual(plugin.queue.waiting().map((entry) => entry.label), ["Second"], "the second one waits");

  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(plugin.queue.isBusy(), false, "the queue is empty again");
});

await test("a queued chat turn still gets its answer, after the command", async () => {
  const plugin = await makePlugin();
  let finished = false;
  const blocker = plugin.queued("Slow command", async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    finished = true;
  });
  const answer = await plugin.queued("Chat answer", () => plugin.runChat([{ role: "user", content: "hi" }]));
  assert.equal(finished, true, "the command must finish before the chat turn starts");
  assert.ok(answer.indexOf("Kitchen renovation") >= 0, "the answer still arrives: " + answer);
  await blocker;
});

await test("a conversation is stored, listed, searchable and removable", async () => {
  const plugin = await makePlugin();
  await plugin.clearHistory();
  const entries = [
    { role: "user", content: "Move the boiler note into Archive" },
    { role: "assistant", content: "Done — moved." },
  ];
  await plugin.saveHistory("chat-test-1", entries);
  await plugin.saveHistory("chat-test-1", entries.concat([{ role: "user", content: "and the tiling note" }]));

  let stored = await plugin.listHistory();
  assert.equal(stored.length, 1, "one conversation, updated in place: " + JSON.stringify(stored.map((s) => s.id)));
  assert.equal(stored[0].title, "Move the boiler note into Archive");
  assert.equal(stored[0].entries.length, 3, "the later message was appended");

  await plugin.saveHistory("chat-test-2", [{ role: "user", content: "Something else entirely" }]);
  stored = await plugin.listHistory();
  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, "chat-test-2", "newest first");
  assert.equal(hermes.searchSessions(stored, "tiling").length, 1, "search finds an older message");

  const raw = await app.vault.adapter.read(plugin.historyPath());
  assert.ok(raw.indexOf("chat-test-1") >= 0, "it really is on disk");

  await plugin.deleteHistorySession("chat-test-1");
  assert.equal((await plugin.listHistory()).length, 1);
  await plugin.clearHistory();
  assert.deepEqual(await plugin.listHistory(), []);
});

await test("a saved connection can be switched back to", async () => {
  const plugin = await makePlugin();
  plugin.settings.profiles = [];
  await plugin.saveCurrentAsProfile("Mock server");
  assert.equal(plugin.settings.profiles.length, 1);
  assert.ok(plugin.settings.profiles[0].name === "Mock server", JSON.stringify(plugin.settings.profiles[0]));

  const original = plugin.settings.baseUrl;
  plugin.settings.baseUrl = "https://elsewhere.example.com";
  plugin.settings.apiKey = "another-key";
  await plugin.switchProfile(plugin.settings.profiles[0].id);
  assert.equal(plugin.settings.baseUrl, original, "the saved URL is restored");
  assert.equal(plugin.settings.apiKey, "test-key", "and the saved key");
  assert.deepEqual(plugin.settings.availableModels, [], "the old model list is dropped with the connection");

  await plugin.deleteProfile(plugin.settings.profiles[0].id);
  assert.equal(plugin.settings.profiles.length, 0);
});

server.close();

console.log("plugin test: " + passed + " passed, " + failed + " failed");
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log("  ✗ " + failure);
  process.exit(1);
}
