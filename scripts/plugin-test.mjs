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

server.close();

console.log("plugin test: " + passed + " passed, " + failed + " failed");
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log("  ✗ " + failure);
  process.exit(1);
}
