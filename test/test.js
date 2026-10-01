"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const M = require("../index.js");

test("CLI version/help work without a config file", () => {
  const v = execFileSync(process.execPath, [path.join(__dirname, "..", "index.js"), "version"], { cwd: "/tmp", encoding: "utf8" });
  assert.match(v, /modelgate 0\.\d+\.\d+/);
  const h = execFileSync(process.execPath, [path.join(__dirname, "..", "index.js"), "help"], { cwd: "/tmp", encoding: "utf8" });
  assert.match(h, /usage: modelgate/);
});

/* ---------- mock backends ---------- */

function startOpenAI(port, behavior) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        if (req.url === "/chat/completions" || req.url === "/v1/chat/completions") {
          const body = JSON.parse(d || "{}");
          if (behavior === "fail500") return fail(res, 500, "internal boom");
          if (behavior === "rate") return fail(res, 429, "rate limited");
          if (behavior === "auth") return fail(res, 401, "bad key");
          if (body.stream) return streamOpenAI(res, body);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            id: "chatcmpl-mock", object: "chat.completion", model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "hi from " + body.model }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }));
        }
        res.writeHead(404); res.end("nf");
      });
    });
    s.listen(port, () => resolve(s));
  });
}

function streamOpenAI(res, body) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "He" } }] }) + "\n\n");
  res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] }) + "\n\n");
  res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
  res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

function startAnthropic(port, behavior) {
  return Promise.resolve(new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        if (req.url === "/messages" || req.url === "/v1/messages") {
          const body = JSON.parse(d || "{}");
          if (behavior === "fail500") return fail(res, 500, "boom");
          if (behavior === "auth") return fail(res, 401, "no key");
          if (body.stream) return streamAnthropic(res, body);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            id: "msg_mock", type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: "hello from claude " + body.model }],
            stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 6 },
          }));
        }
        res.writeHead(404); res.end("nf");
      });
    });
    s.listen(port, () => resolve(s));
  }));
}

function streamAnthropic(res, body) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m1", model: body.model, role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } }) + "\n\n");
  res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n\n");
  res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bon" } }) + "\n\n");
  res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jour" } }) + "\n\n");
  res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n");
  res.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) + "\n\n");
  res.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
  res.end();
}

function fail(res, code, msg) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: msg } }));
}

const log = () => {};
function cfg(port, extra) {
  return Object.assign({
    timeoutMs: 5000, retries: 0, backoffMs: 5,
    breaker: { failures: 3, cooldownMs: 100 },
    aliases: {}, pricing: {},
  }, extra || {});
}

/* ---------- unit: conversions ---------- */

test("anthropic request -> internal (system + tools + stop)", () => {
  const out = M.anthropicReqToInternal({
    system: "You are terse.",
    model: "claude-1",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stop_sequences: ["\n\n"],
    tools: [{ name: "f", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
    tool_choice: { type: "auto" },
  });
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content, "hi");
  assert.deepEqual(out.stop, ["\n\n"]);
  assert.equal(out.tools[0].function.name, "f");
  assert.equal(out.tool_choice, "auto");
});

test("internal -> anthropic (merges consecutive roles)", () => {
  const out = M.internalReqToAnthropic({
    messages: [
      { role: "system", content: "be nice" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "q" },
    ],
    max_tokens: 50,
    __targetModel: "claude-x",
  });
  assert.equal(out.system, "be nice");
  assert.equal(out.model, "claude-x");
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, "a\n\nb");
});

test("anthropic resp -> internal (tool_use)", () => {
  const out = M.anthropicRespToInternal({
    id: "m9", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "t1", name: "f", input: { x: 1 } }],
    stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 9 },
  }, "p/m");
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "f");
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(out.usage.completion_tokens, 9);
});

test("internal resp -> anthropic (finish_reason map)", () => {
  const out = M.internalRespToAnthropic({
    id: "c1", model: "p/m",
    choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.equal(out.stop_reason, "max_tokens");
  assert.equal(out.usage.input_tokens, 1);
  assert.equal(out.content[0].text, "done");
});

/* ---------- SSE parse ---------- */

test("sseBlocks splits multi-event blocks", async () => {
  const blocks = "data: {\"a\":1}\n\n\n\nevent: x\ndata: {\"b\":2}\n\n";
  const seen = [];
  for await (const b of M.sseBlocks(Readable.from([blocks]))) seen.push(b);
  assert.equal(seen.length, 2);
  const e1 = M.parseSseBlock(seen[0]);
  assert.deepEqual(JSON.parse(e1.data), { a: 1 });
  assert.equal(M.parseSseBlock(seen[1]).event, "x");
});

const Readable = require("node:stream").Readable;

async function collect(gen) {
  const a = [];
  for await (const x of gen) a.push(x);
  return a;
}

/* ---------- routing + failover (integration) ---------- */

test("routes to first working provider", async (t) => {
  const a = await startOpenAI(19001, "ok");
  const b = await startOpenAI(19002, "ok");
  t.after(() => { a.close(); b.close(); });
  const c = cfg(1, { providers: [
    { name: "p1", baseURL: "http://127.0.0.1:19001/v1", apiKey: "k", protocol: "openai", models: ["m"] },
    { name: "p2", baseURL: "http://127.0.0.1:19002/v1", apiKey: "k", protocol: "openai", models: ["m"] },
  ] });
  const brk = new M.CircuitBreaker(c.breaker);
  const st = new M.Stats();
  const out = await M.route(c, log, st, brk, { messages: [{ role: "user", content: "hi" }], stream: false, model: "m" }, "openai", null);
  assert.ok(!out.attempts);
  assert.equal(out.backend, "p1/m");
  assert.equal(out.data.choices[0].message.content, "hi from m");
});

test("fails over when first provider 500s", async (t) => {
  const a = await startOpenAI(19011, "fail500");
  const b = await startOpenAI(19012, "ok");
  t.after(() => { a.close(); b.close(); });
  const c = cfg(1, { providers: [
    { name: "p1", baseURL: "http://127.0.0.1:19011/v1", apiKey: "k", protocol: "openai", models: ["m"] },
    { name: "p2", baseURL: "http://127.0.0.1:19012/v1", apiKey: "k", protocol: "openai", models: ["m"] },
  ] });
  const brk = new M.CircuitBreaker(c.breaker);
  const out = await M.route(c, log, new M.Stats(), brk, { messages: [{ role: "user", content: "hi" }], stream: false, model: "m" }, "openai", null);
  assert.equal(out.backend, "p2/m");
  assert.ok(!("data" in out) || out.data, "response data present");
  assert.equal(out.attempts.length, 1, "p1 failure should be reported");
  assert.equal(out.attempts[0].provider, "p1");
  assert.equal(out.attempts[0].kind, "server");
  assert.match(out.data.choices[0].message.content, /hi from m/);
});

test("does NOT fail over on auth error (all same class) but reports attempt", async (t) => {
  const a = await startOpenAI(19021, "auth");
  t.after(() => a.close());
  const c = cfg(1, { providers: [
    { name: "p1", baseURL: "http://127.0.0.1:19021/v1", apiKey: "k", protocol: "openai", models: ["m"] },
  ] });
  const out = await M.route(c, log, new M.Stats(), new M.CircuitBreaker(c.breaker), { messages: [{ role: "user", content: "hi" }], stream: false, model: "m" }, "openai", null);
  assert.ok(out.attempts);
  assert.equal(out.attempts[0].kind, "auth");
});

test("protocol bridge: openai client -> anthropic backend", async (t) => {
  const a = await startAnthropic(19031, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [
    { name: "cl", baseURL: "http://127.0.0.1:19031", apiKey: "k", protocol: "anthropic", models: ["claude-x"] },
  ] });
  const out = await M.route(c, log, new M.Stats(), new M.CircuitBreaker(c.breaker), { messages: [{ role: "user", content: "hi" }], stream: false, model: "claude-x" }, "openai", null);
  assert.ok(!out.attempts);
  assert.equal(out.backend, "cl/claude-x");
  assert.match(out.data.choices[0].message.content, /hello from claude/);
});

test("protocol bridge: anthropic client -> openai backend", async (t) => {
  const a = await startOpenAI(19041, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [
    { name: "po", baseURL: "http://127.0.0.1:19041/v1", apiKey: "k", protocol: "openai", models: ["gpt-x"] },
  ] });
  const internal = M.anthropicReqToInternal({ system: "be brief", model: "gpt-x", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
  const out = await M.route(c, log, new M.Stats(), new M.CircuitBreaker(c.breaker), internal, "anthropic", null);
  assert.ok(!out.attempts);
  assert.equal(out.backend, "po/gpt-x");
  const ant = M.internalRespToAnthropic(out.data);
  assert.equal(ant.stop_reason, "end_turn");
});

/* ---------- circuit breaker ---------- */

test("circuit breaker opens after N failures and blocks", async (t) => {
  const a = await startOpenAI(19051, "fail500");
  t.after(() => a.close());
  const c = cfg(1, { retries: 0, providers: [
    { name: "p1", baseURL: "http://127.0.0.1:19051/v1", apiKey: "k", protocol: "openai", models: ["m"] },
  ] });
  const brk = new M.CircuitBreaker({ failures: 2, cooldownMs: 200 });
  const st = new M.Stats();
  // two failures should open it
  await M.route(c, log, st, brk, { messages: [{ role: "user", content: "x" }], stream: false, model: "m" }, "openai", null);
  await M.route(c, log, st, brk, { messages: [{ role: "user", content: "x" }], stream: false, model: "m" }, "openai", null);
  assert.equal(brk.allow("p1"), false);
  // now it should be skipped (no real call) -> attempts empty-ish, but no success
  const out3 = await M.route(c, log, st, brk, { messages: [{ role: "user", content: "x" }], stream: false, model: "m" }, "openai", null);
  assert.ok(out3.attempts.length === 0, "skipped provider should not produce attempts");
  // cooldown resets
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(brk.allow("p1"), true);
});

/* ---------- cost + stats ---------- */

test("cost tracked from usage + pricing", async (t) => {
  const a = await startOpenAI(19061, "ok");
  t.after(() => a.close());
  const c = cfg(1, {
    pricing: { "p1/m": { input: 0.01, output: 0.02 } },
    providers: [{ name: "p1", baseURL: "http://127.0.0.1:19061/v1", apiKey: "k", protocol: "openai", models: ["m"] }],
  });
  const st = new M.Stats();
  const out = await M.route(c, log, st, new M.CircuitBreaker(c.breaker), { messages: [{ role: "user", content: "x" }], stream: false, model: "m" }, "openai", null);
  // usage: in=10 out=4 -> 10/1e6*0.01 + 4/1e6*0.02 = 0.0000001 + 0.00000008 = 0.00000018
  assert.ok(Math.abs(out.cost - 0.00000018) < 1e-9, "cost=" + out.cost);
  const snap = st.snapshot(null);
  assert.equal(snap.total.costUsd, 0); // rounded to 6dp -> 0.000000
  assert.equal(snap.total.tokensIn, 10);
  assert.equal(snap.total.tokensOut, 4);
});

test("stats snapshot shape", async (t) => {
  const a = await startOpenAI(19071, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [{ name: "p1", baseURL: "http://127.0.0.1:19071/v1", apiKey: "k", protocol: "openai", models: ["m"] }] });
  const st = new M.Stats();
  const brk = new M.CircuitBreaker(c.breaker);
  await M.route(c, log, st, brk, { messages: [{ role: "user", content: "x" }], stream: false, model: "m" }, "openai", null);
  const snap = st.snapshot(brk);
  assert.ok(snap.total.requests >= 1);
  assert.equal(snap.providers.length, 1);
  assert.equal(snap.providers[0].key, "p1/m");
});

/* ---------- aliases + provider override ---------- */

test("resolveTargets honors explicit provider/model ref", () => {
  const c = cfg(1, { providers: [
    { name: "p1", baseURL: "http://x", models: ["m"] },
    { name: "p2", baseURL: "http://y", models: ["m"] },
  ] });
  const t = M.resolveTargets(c, "p2/m", null);
  assert.equal(t.length, 1);
  assert.equal(t[0].provider.name, "p2");
});

test("resolveTargets expands alias", () => {
  const c = cfg(1, { aliases: { fast: ["p1/m", "p2/m"] }, providers: [
    { name: "p1", baseURL: "http://x", models: ["m"] },
    { name: "p2", baseURL: "http://y", models: ["m"] },
  ] });
  const t = M.resolveTargets(c, "fast", null);
  assert.equal(t.length, 2);
});

test("resolveTargets provider override narrows", () => {
  const c = cfg(1, { providers: [
    { name: "p1", baseURL: "http://x", models: ["m"] },
    { name: "p2", baseURL: "http://y", models: ["m"] },
  ] });
  const t = M.resolveTargets(c, "m", "p2");
  assert.equal(t.length, 1);
  assert.equal(t[0].provider.name, "p2");
});

/* ---------- streaming ---------- */

test("openai backend stream -> openai SSE (client openai)", async (t) => {
  const a = await startOpenAI(19081, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [{ name: "p1", baseURL: "http://127.0.0.1:19081/v1", apiKey: "k", protocol: "openai", models: ["m"] }] });
  const brk = new M.CircuitBreaker(c.breaker);
  const out = await M.route(c, log, new M.Stats(), brk, { messages: [{ role: "user", content: "x" }], stream: true, model: "m" }, "openai", null);
  assert.ok(out.stream);
  const events = [];
  for await (const ev of M.streamToEvents(out.stream, out.backendProto, out.backendModel)) events.push(ev);
  const sse = await collect(M.eventsToOpenAISSE(events, out.backend, "chatcmpl-test"));
  const joined = sse.join("");
  assert.match(joined, /"content":"He"/);
  assert.match(joined, /"content":"llo"/);
  assert.match(joined, /finish_reason/);
  assert.match(joined, /\[DONE\]/);
});

test("anthropic backend stream -> anthropic SSE (client anthropic)", async (t) => {
  const a = await startAnthropic(19091, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [{ name: "cl", baseURL: "http://127.0.0.1:19091", apiKey: "k", protocol: "anthropic", models: ["claude-s"] }] });
  const internal = M.anthropicReqToInternal({ model: "claude-s", max_tokens: 30, stream: true, messages: [{ role: "user", content: "hi" }] });
  const out = await M.route(c, log, new M.Stats(), new M.CircuitBreaker(c.breaker), internal, "anthropic", null);
  assert.ok(out.stream);
  const events = [];
  for await (const ev of M.streamToEvents(out.stream, out.backendProto, out.backendModel)) events.push(ev);
  const sse = await collect(M.eventsToAnthropicSSE(events, "claude-s", "msg-test"));
  const joined = sse.join("");
  assert.match(joined, /message_start/);
  assert.match(joined, /"text_delta"/);
  assert.match(joined, /message_stop/);
  assert.match(joined, /"bon"/);
});

test("cross-protocol stream: anthropic backend -> openai client", async (t) => {
  const a = await startAnthropic(19101, "ok");
  t.after(() => a.close());
  const c = cfg(1, { providers: [{ name: "cl", baseURL: "http://127.0.0.1:19101", apiKey: "k", protocol: "anthropic", models: ["claude-s"] }] });
  const out = await M.route(c, log, new M.Stats(), new M.CircuitBreaker(c.breaker), { messages: [{ role: "user", content: "hi" }], stream: true, model: "claude-s" }, "openai", null);
  const events = [];
  for await (const ev of M.streamToEvents(out.stream, out.backendProto, out.backendModel)) events.push(ev);
  const sse = (await collect(M.eventsToOpenAISSE(events, out.backend, "chatcmpl-x"))).join("");
  assert.match(sse, /"content":"bon"/);
  assert.match(sse, /"content":"jour"/);
  assert.match(sse, /\[DONE\]/);
});
