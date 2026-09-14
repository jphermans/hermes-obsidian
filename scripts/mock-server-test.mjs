/**
 * Integration test for the shipped Hermes API client against a mock of the
 * Hermes API server (health, /v1/models, /v1/capabilities, /v1/chat/completions
 * both buffered and SSE-streamed, 401 and 404 handling).
 *
 * The client code under test is the exact bundle the plugin ships; only
 * Obsidian's requestUrl is swapped for a real fetch in scripts/obsidian-stub.mjs.
 */

import assert from "node:assert/strict";
import http from "node:http";
import * as hermes from "./.build/tests.mjs";

const KEY = "test-key";
const FULL_ANSWER = "# Kitchen renovation\n\nBody text with [[Boiler service]].";
const seen = [];

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const url = request.url || "";
    const authorized = request.headers.authorization === "Bearer " + KEY;
    seen.push({ url, method: request.method, headers: request.headers, body });

    // Strip an optional /p/<profile> prefix, then route on the exact path so a
    // wrong base URL really returns 404.
    const prefixed = /^\/p\/[^/]+(\/.*)$/.exec(url);
    const route = prefixed ? prefixed[1] : url;

    const sendJson = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (route === "/health") return sendJson(200, { status: "ok" });
    if (route === "/missing/health") return sendJson(404, { error: "not found" });
    if (route === "/v1/capabilities") {
      if (!authorized) return sendJson(401, { error: "unauthorized" });
      return sendJson(200, { object: "hermes.api_server.capabilities", features: { run_events_sse: true } });
    }
    if (route === "/v1/models") {
      if (!authorized) return sendJson(401, { error: "unauthorized" });
      return sendJson(200, { object: "list", data: [{ id: "hermes-agent", object: "model" }] });
    }
    if (route === "/v1/chat/completions") {
      if (!authorized) return sendJson(401, { error: "unauthorized" });
      const payload = JSON.parse(body || "{}");
      if (payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        for (const piece of ["# Kitchen renovation", "\n\nBody text with ", "[[Boiler service]]."]) {
          response.write("data: " + JSON.stringify({ model: "hermes-agent", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        response.write("data: " + JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } }) + "\n\n");
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      return sendJson(200, {
        id: "chatcmpl-test",
        object: "chat.completion",
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: FULL_ANSWER }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
      });
    }
    sendJson(404, { error: "not found" });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = "http://127.0.0.1:" + port;

function makeClient(overrides) {
  const settings = Object.assign({}, hermes.DEFAULT_SETTINGS, { baseUrl, apiKey: KEY, reportSession: true }, overrides || {});
  return { client: new hermes.HermesClient(settings), settings };
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

await test("health reports ok without a key and fails cleanly on a bad path", async () => {
  const { client } = makeClient();
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.status, 200);
  const missing = new hermes.HermesClient(Object.assign({}, hermes.DEFAULT_SETTINGS, { baseUrl: baseUrl + "/missing", apiKey: KEY }));
  const bad = await missing.health();
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 404);
});

await test("models lists the advertised agent name", async () => {
  const { client } = makeClient();
  assert.deepEqual(await client.models(), ["hermes-agent"]);
});

await test("a wrong key is reported as an auth error with the fix in the message", async () => {
  const { client } = makeClient({ apiKey: "wrong" });
  await assert.rejects(
    () => client.models(),
    (error) => {
      assert.equal(error.name, "HermesError");
      assert.equal(error.kind, "auth");
      assert.equal(error.status, 401);
      assert.ok(/API_SERVER_KEY/.test(error.message), error.message);
      return true;
    }
  );
});

await test("a missing endpoint is reported as a configuration error", async () => {
  const { client } = makeClient({ baseUrl: baseUrl + "/missing" });
  await assert.rejects(
    () => client.models(),
    (error) => {
      assert.equal(error.kind, "config");
      assert.equal(error.status, 404);
      assert.ok(/profile prefix/.test(error.message), error.message);
      return true;
    }
  );
});

await test("capabilities are passed through", async () => {
  const { client } = makeClient();
  const capabilities = await client.capabilities();
  assert.equal(capabilities.features.run_events_sse, true);
});

await test("chat returns the answer and hides the default model name", async () => {
  seen.length = 0;
  const { client } = makeClient();
  const result = await client.chat([{ role: "user", content: "Write a note" }], { system: "SYSTEM", sessionId: "obsidian-abc", sessionKey: "obsidian:TestVault:obsidian-abc" });
  assert.equal(result.content, FULL_ANSWER);
  assert.equal(result.streamed, false);
  assert.equal(result.usage.total_tokens, 12);

  const call = seen.find((entry) => entry.url.endsWith("/v1/chat/completions"));
  const payload = JSON.parse(call.body);
  assert.equal(payload.model, "hermes-agent");
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[1].content, "Write a note");
  assert.equal(call.headers.authorization, "Bearer " + KEY);
  assert.equal(call.headers["x-hermes-session-id"], "obsidian-abc");
  assert.equal(call.headers["x-hermes-session-key"], "obsidian:TestVault:obsidian-abc");
  assert.equal("temperature" in payload, false, "temperature -1 must not be sent");
  assert.equal("provider" in payload, false, "no provider unless configured");
});

await test("provider and temperature are sent only when configured", async () => {
  seen.length = 0;
  const { client } = makeClient({ provider: "minimax", temperature: 0.4 });
  await client.chat([{ role: "user", content: "hi" }]);
  const payload = JSON.parse(seen.find((entry) => entry.url.endsWith("/v1/chat/completions")).body);
  assert.equal(payload.provider, "minimax");
  assert.equal(payload.temperature, 0.4);
});

await test("session headers are omitted when reporting is off", async () => {
  seen.length = 0;
  const { client } = makeClient({ reportSession: false });
  await client.chat([{ role: "user", content: "hi" }], { sessionId: "obsidian-abc", sessionKey: "k" });
  const call = seen.find((entry) => entry.url.endsWith("/v1/chat/completions"));
  assert.equal("x-hermes-session-id" in call.headers, false);
  assert.equal(call.headers["x-hermes-session-key"], "k");
});

await test("chatStream reassembles SSE deltas and picks up usage", async () => {
  seen.length = 0;
  const { client } = makeClient({ streaming: true });
  const deltas = [];
  const result = await client.chatStream([{ role: "user", content: "stream this" }], {}, (delta, full) => {
    deltas.push(delta);
    assert.equal(full.endsWith(delta), true);
  });
  assert.equal(deltas.length, 3);
  assert.equal(result.content, FULL_ANSWER);
  assert.equal(result.streamed, true);
  assert.equal(result.usage.total_tokens, 12);
  assert.equal(result.model, "hermes-agent");
  const payload = JSON.parse(seen.find((entry) => entry.url.endsWith("/v1/chat/completions")).body);
  assert.equal(payload.stream, true);
});

await test("chatStream surfaces HTTP failures through the same error mapping", async () => {
  const { client } = makeClient({ apiKey: "wrong", streaming: true });
  await assert.rejects(
    () => client.chatStream([{ role: "user", content: "x" }], {}, () => {}),
    (error) => {
      assert.equal(error.kind, "auth");
      return true;
    }
  );
});

await test("extra request headers are sent, and an explicit Authorization wins", async () => {
  seen.length = 0;
  const { client } = makeClient({ extraHeaders: "CF-Access-Client-Id: abc.access\nX-Custom: hello\n" });
  await client.models();
  const call = seen.find((entry) => entry.url === "/v1/models");
  assert.equal(call.headers["cf-access-client-id"], "abc.access");
  assert.equal(call.headers["x-custom"], "hello");
  assert.equal(call.headers.authorization, "Bearer " + KEY);

  seen.length = 0;
  const { client: proxyClient } = makeClient({ apiKey: "should-not-be-used", extraHeaders: "Authorization: Bearer proxy-token" });
  await proxyClient.health();
  const proxyCall = seen.find((entry) => entry.url === "/health");
  assert.equal(proxyCall.headers.authorization, "Bearer proxy-token");
});

await test("a failed request on mobile explains the cleartext block", async () => {
  hermes.setPlatform({ isMobile: true, isDesktop: false });
  try {
    const client = new hermes.HermesClient(
      Object.assign({}, hermes.DEFAULT_SETTINGS, { baseUrl: "http://0.0.0.0:9", apiKey: KEY })
    );
    await assert.rejects(
      () => client.chat([{ role: "user", content: "x" }]),
      (error) => {
        assert.equal(error.kind, "network");
        assert.ok(/plain HTTP to another machine/.test(error.message), "missing hint: " + error.message);
        return true;
      }
    );
  } finally {
    hermes.setPlatform({ isMobile: false, isDesktop: true });
  }
});

await test("a profile prefix routes to /p/<profile>/v1", async () => {
  seen.length = 0;
  const { client } = makeClient({ profile: "alice" });
  await client.models();
  const call = seen.find((entry) => entry.method === "GET" && entry.url.includes("/v1/models"));
  assert.equal(call.url, "/p/alice/v1/models");
});

await test("normalizeBaseUrl tolerates a pasted /v1 URL", async () => {
  const { client } = makeClient({ baseUrl: baseUrl + "/v1" });
  assert.deepEqual(await client.models(), ["hermes-agent"]);
});

server.close();

console.log("api test: " + passed + " passed, " + failed + " failed");
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log("  ✗ " + failure);
  process.exit(1);
}
