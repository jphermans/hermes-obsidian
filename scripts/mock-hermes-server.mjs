/**
 * Mock of the Hermes API server, shared by the test runners (plain JS — it is
 * imported directly by node, not bundled).
 * Routes: /health, /v1/capabilities, /v1/models, /v1/chat/completions
 * (buffered and SSE), with an optional /p/<profile> prefix, bearer auth and an
 * optional response delay (to exercise client timeouts).
 *
 * @param {{ key?: string, answer?: string, delayMs?: number }} [options]
 * @returns {Promise<{ baseUrl: string, port: number, seen: object[], answer: string, close: () => void }>}
 */

import http from "node:http";

const ANSWER = "# Kitchen renovation\n\nBody text with [[Boiler service]].";
const DELTAS = ["# Kitchen renovation", "\n\nBody text with ", "[[Boiler service]]."];

export async function startMockServer(options = {}) {
  const key = options.key === undefined ? "test-key" : options.key;
  const answer = options.answer || ANSWER;
  const titleAnswer = options.titleAnswer || "Lead times in the workshop";
  const delayMs = options.delayMs || 0;
  const seen = [];

  /**
   * A title request is its own little turn ("Answer with the title only"), so the
   * mock answers it differently — that is what makes the naming path testable.
   */
  function replyFor(payload) {
    const messages = (payload && payload.messages) || [];
    const users = messages.filter((message) => message.role === "user");
    const last = users.length > 0 ? users[users.length - 1] : null;
    const text = last && typeof last.content === "string" ? last.content : "";
    if (text.indexOf("Answer with the title only") >= 0) return titleAnswer;
    return answer;
  }

  function handle(route, authorized, body, sendJson, response) {
    if (route === "/health") return sendJson(200, { status: "ok" });

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
      const reply = replyFor(payload);
      if (payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const pieces = reply === ANSWER ? DELTAS : [reply];
        for (const piece of pieces) {
          response.write("data: " + JSON.stringify({ model: "hermes-agent", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        response.write("data: " + JSON.stringify({ usage: { total_tokens: 12 } }) + "\n\n");
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      return sendJson(200, {
        id: "chatcmpl-test",
        object: "chat.completion",
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
      });
    }

    sendJson(404, { error: "not found" });
  }

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url || "";
      const authorized = !key || request.headers.authorization === "Bearer " + key;
      seen.push({ url, method: request.method, headers: request.headers, body });

      const prefixed = /^\/p\/[^/]+(\/.*)$/.exec(url);
      const route = prefixed ? prefixed[1] : url;
      const sendJson = (status, payload) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (delayMs > 0) setTimeout(() => handle(route, authorized, body, sendJson, response), delayMs);
      else handle(route, authorized, body, sendJson, response);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    baseUrl: "http://127.0.0.1:" + port,
    port,
    seen,
    answer,
    close: () => server.close(),
  };
}
