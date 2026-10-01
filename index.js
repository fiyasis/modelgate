#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = "0.2.0";

/* ============================ config ============================ */

function loadConfig(configPath) {
  const p = configPath || process.env.MODELGATE_CONFIG || path.join(process.cwd(), "config.json");
  if (!fs.existsSync(p)) {
    console.error(`[modelgate] config not found: ${p}`);
    console.error("[modelgate] copy config.example.json to config.json and fill in your keys.");
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    console.error('[modelgate] config must define a non-empty "providers" array.');
    process.exit(1);
  }
  cfg.port = cfg.port || 8787;
  cfg.timeoutMs = cfg.timeoutMs || 60000;
  cfg.retries = cfg.retries === undefined ? 1 : cfg.retries;
  cfg.backoffMs = cfg.backoffMs || 500;
  cfg.breaker = Object.assign({ failures: 3, cooldownMs: 30000 }, cfg.breaker);
  cfg.aliases = cfg.aliases || {};
  cfg.pricing = cfg.pricing || {};
  for (const pr of cfg.providers) {
    if (!pr.name) pr.name = pr.baseURL;
    pr.protocol = pr.protocol === "anthropic" ? "anthropic" : "openai";
    if (!Array.isArray(pr.models) || pr.models.length === 0) pr.models = ["*"];
  }
  return cfg;
}

function makeLog(cfg) {
  if (cfg.quiet) return () => {};
  return (msg) => process.stderr.write(`[modelgate] ${new Date().toISOString()} ${msg}\n`);
}

/* ========================= circuit breaker ====================== */

class CircuitBreaker {
  constructor({ failures = 3, cooldownMs = 30000 }) {
    this.failures = failures;
    this.cooldownMs = cooldownMs;
    this.state = new Map();
  }

  _s(k) {
    if (!this.state.has(k)) this.state.set(k, { status: "closed", count: 0, until: 0 });
    return this.state.get(k);
  }

  allow(k) {
    const s = this._s(k);
    if (s.status === "open") {
      if (Date.now() >= s.until) {
        s.status = "half";
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(k) {
    const s = this._s(k);
    s.status = "closed";
    s.count = 0;
  }

  recordFailure(k) {
    const s = this._s(k);
    if (s.status === "half" || ++s.count >= this.failures) {
      s.status = "open";
      s.until = Date.now() + this.cooldownMs;
      s.count = 0;
      return true;
    }
    return false;
  }

  reset() {
    this.state.clear();
  }

  snapshot() {
    const out = [];
    for (const [k, s] of this.state) {
      if (s.status !== "closed" || s.count > 0) {
        out.push({ key: k, status: s.status, failures: s.count, openUntil: s.until || null });
      }
    }
    return out;
  }
}

/* ===================== protocol: conversions ===================== */

const STOP_OPENAI_TO_ANTHROPIC = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
const STOP_ANTHROPIC_TO_OPENAI = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };

function anthropicReqToInternal(req) {
  const messages = [];
  if (typeof req.system === "string" && req.system) messages.push({ role: "system", content: req.system });
  else if (Array.isArray(req.system) && req.system.length) {
    const text = req.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of req.messages || []) {
    let content = m.content;
    if (Array.isArray(content)) {
      const parts = content.filter((b) => b && b.type === "text").map((b) => b.text);
      content = parts.join("\n");
    }
    messages.push({ role: m.role, content: content == null ? "" : content });
  }
  const out = {
    messages,
    model: req.model,
    max_tokens: req.max_tokens || 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: !!req.stream,
  };
  if (req.stop_sequences) out.stop = Array.isArray(req.stop_sequences) ? req.stop_sequences : [req.stop_sequences];
  if (req.stop_sequence && !req.stop_sequences) out.stop = [req.stop_sequence];
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
    }));
  }
  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return out;
}

function internalReqToAnthropic(req) {
  const system = (req.messages || []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  const rest = (req.messages || []).filter((m) => m.role !== "system");
  const merged = [];
  for (const m of rest) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += "\n\n" + c;
    else merged.push({ role: m.role, content: c });
  }
  const out = {
    model: req.__targetModel,
    messages: merged.length ? merged : [{ role: "user", content: "" }],
    max_tokens: req.max_tokens || 4096,
    stream: !!req.stream,
  };
  if (system.length) out.system = system.join("\n\n");
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
  }
  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc === "required") out.tool_choice = { type: "any" };
    else if (typeof tc === "object" && tc.type === "function") out.tool_choice = { type: "tool", name: tc.function.name };
  }
  return out;
}

function anthropicRespToInternal(resp, model) {
  const content = resp.content || [];
  let text = "";
  const toolCalls = [];
  for (const b of content) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
  }
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: resp.id || "msg_" + Date.now(),
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: STOP_ANTHROPIC_TO_OPENAI[resp.stop_reason] || "stop", logprobs: null }],
    usage: {
      prompt_tokens: (resp.usage && resp.usage.input_tokens) || 0,
      completion_tokens: (resp.usage && resp.usage.output_tokens) || 0,
      total_tokens: ((resp.usage && (resp.usage.input_tokens + resp.usage.output_tokens)) || 0),
    },
  };
}

function internalRespToAnthropic(resp) {
  const ch = (resp.choices && resp.choices[0]) || {};
  const m = ch.message || {};
  const content = [];
  if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
      content.push({ type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function.name, input });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: resp.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: resp.model || "",
    content,
    stop_reason: STOP_OPENAI_TO_ANTHROPIC[ch.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: (resp.usage && resp.usage.prompt_tokens) || 0,
      output_tokens: (resp.usage && resp.usage.completion_tokens) || 0,
    },
  };
}

/* ===================== protocol: SSE streams ===================== */

async function* sseBlocks(body) {
  let buf = "";
  for await (const chunk of body) {
    buf += Buffer.from(chunk).toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) yield block;
    }
  }
  if (buf.trim()) yield buf;
}

function parseSseBlock(block) {
  const ev = { event: "message", data: "" };
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) ev.event = line.slice(6).trim();
    else if (line.startsWith("data:")) ev.data += (ev.data ? "\n" : "") + line.slice(5).trim();
  }
  return ev;
}

async function* streamToEvents(backendStream, backendProto, model) {
  if (backendProto === "openai") {
    let sawStart = false;
    for await (const block of sseBlocks(backendStream)) {
      const ev = parseSseBlock(block);
      if (ev.data === "[DONE]") break;
      let j;
      try { j = JSON.parse(ev.data); } catch (_) { continue; }
      if (!sawStart) { sawStart = true; yield { type: "start" }; }
      const ch = (j.choices || [])[0];
      if (j.usage) yield { type: "usage", in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
      if (ch && ch.delta && ch.delta.content) yield { type: "delta", text: ch.delta.content };
      if (ch && ch.finish_reason) { yield { type: "finish", reason: ch.finish_reason }; break; }
    }
    if (sawStart) yield { type: "done" };
    return;
  }
  for await (const block of sseBlocks(backendStream)) {
    const ev = parseSseBlock(block);
    if (!ev.data) continue;
    let j;
    try { j = JSON.parse(ev.data); } catch (_) { continue; }
    switch (j.type) {
      case "message_start":
        yield { type: "start", model: (j.message && j.message.model) || model, in: (j.message && j.message.usage && j.message.usage.input_tokens) || 0 };
        break;
      case "content_block_delta":
        if (j.delta && j.delta.type === "text_delta" && j.delta.text) yield { type: "delta", text: j.delta.text };
        break;
      case "message_delta":
        if (j.delta && j.delta.stop_reason) yield { type: "finish", reason: j.delta.stop_reason };
        if (j.usage && j.usage.output_tokens != null) yield { type: "usage", out: j.usage.output_tokens };
        break;
      case "message_stop":
        yield { type: "done" };
        break;
      case "error":
        throw new Error((j.error && j.error.message) || "stream error");
    }
  }
  yield { type: "done" };
}

async function* eventsToOpenAISSE(events, model, id) {
  let started = false;
  let usage = { in: 0, out: 0 };
  const base = { id, object: "chat.completion.chunk", model, created: Math.floor(Date.now() / 1000) };
  for await (const ev of events) {
    if (ev.type === "start") continue;
    if (ev.type === "usage") { if (ev.in) usage.in = ev.in; if (ev.out) usage.out = ev.out; continue; }
    if (ev.type === "delta") {
      if (!started) { started = true; yield sseChunk(base, { index: 0, delta: { role: "assistant", content: "" } }); }
      yield sseChunk(base, { index: 0, delta: { content: ev.text } });
    } else if (ev.type === "finish") {
      yield sseChunk(base, { index: 0, delta: {}, finish_reason: STOP_ANTHROPIC_TO_OPENAI[ev.reason] || "stop" });
    } else if (ev.type === "done") {
      if (usage.in || usage.out) {
        yield sseChunk({ ...base, choices: [] }, null, { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out });
      }
      yield "data: [DONE]\n\n";
      return;
    }
  }
  yield "data: [DONE]\n\n";
}

function sseChunk(base, choice, usage) {
  const obj = { ...base, choices: choice ? [choice] : base.choices || [] };
  if (usage) obj.usage = usage;
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function* eventsToAnthropicSSE(events, model, id) {
  let started = false;
  let blockOpen = false;
  let usageIn = 0, usageOut = 0;
  let finishReason = null;
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for await (const ev of events) {
    if (ev.type === "start") {
      started = true;
      if (ev.in) usageIn = ev.in;
      yield sse("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: usageIn, output_tokens: 0 } },
      });
    } else if (ev.type === "delta") {
      if (!blockOpen) { blockOpen = true; yield sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); }
      yield sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.text } });
    } else if (ev.type === "usage") {
      if (ev.in != null && !usageIn) usageIn = ev.in;
      if (ev.out != null) usageOut = ev.out;
    } else if (ev.type === "finish") {
      finishReason = ev.reason;
    } else if (ev.type === "done") {
      if (started) {
        if (blockOpen) { yield sse("content_block_stop", { type: "content_block_stop", index: 0 }); blockOpen = false; }
        yield sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: STOP_OPENAI_TO_ANTHROPIC[finishReason] || "end_turn", stop_sequence: null },
          usage: { output_tokens: usageOut },
        });
        yield sse("message_stop", { type: "message_stop" });
      }
      return;
    }
  }
  if (started) {
    if (blockOpen) yield sse("content_block_stop", { type: "content_block_stop", index: 0 });
    yield sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usageOut } });
    yield sse("message_stop", { type: "message_stop" });
  }
}

/* =========================== routing ============================ */

class CallError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // "auth" | "rate" | "server" | "network" | "client"
  }
}

function classifyError(err, resStatus) {
  const status = resStatus || err.status || 0;
  let kind = "network";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate";
  else if (status >= 500) kind = "server";
  else if (status === 400) kind = /model/i.test(err.message || "") ? "server" : "client";
  return new CallError(err.message, status, kind);
}

function resolveTargets(cfg, requestedModel, overrideProvider) {
  const byName = new Map(cfg.providers.map((p) => [p.name, p]));
  const targets = [];
  const seen = new Set();
  const push = (providerName, model) => {
    const pr = byName.get(providerName);
    if (!pr) return;
    const key = `${providerName}/${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ provider: pr, model });
  };
  const bare = (m) => (m && m.includes("/") && byName.has(m.split("/")[0]) ? m.split("/").slice(1).join("/") : m);

  if (overrideProvider) {
    const m = requestedModel ? bare(requestedModel) : null;
    for (const pr of cfg.providers) {
      if (pr.name !== overrideProvider) continue;
      if (m) { push(pr.name, m); return targets; }
      for (const cm of pr.models) if (cm !== "*") push(pr.name, cm);
      return targets;
    }
    return targets;
  }
  if (requestedModel && byName.has(requestedModel.split("/")[0]) && requestedModel.includes("/")) {
    push(requestedModel.split("/")[0], bare(requestedModel));
    return targets;
  }
  if (requestedModel && cfg.aliases[requestedModel]) {
    for (const ref of cfg.aliases[requestedModel]) {
      if (ref.includes("/")) push(ref.split("/")[0], bare(ref));
      else {
        for (const pr of cfg.providers) if (pr.models.includes(ref) || pr.models.includes("*")) push(pr.name, ref);
      }
    }
    return targets;
  }
  for (const pr of cfg.providers) {
    if (requestedModel && (pr.models.includes(requestedModel) || pr.models.includes(bare(requestedModel) || requestedModel))) {
      push(pr.name, requestedModel || pr.models.find((m) => m !== "*") || "gpt-4o-mini");
    } else if (pr.models.includes("*")) {
      push(pr.name, requestedModel || "gpt-4o-mini");
    }
  }
  return targets.slice(0, 24);
}

function computeCost(cfg, providerName, model, usage) {
  const entry = cfg.pricing[`${providerName}/${model}`] || cfg.pricing[model] || null;
  if (!entry || !usage) return 0;
  const tin = (usage.prompt_tokens || usage.input_tokens || 0) / 1e6;
  const tout = (usage.completion_tokens || usage.output_tokens || 0) / 1e6;
  return (tin * (entry.input || 0)) + (tout * (entry.output || 0));
}

/* ============================ stats ============================= */

class Stats {
  constructor() {
    this.per = new Map();
    this.total = { requests: 0, ok: 0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: Date.now() };
  }
  hit(key, { ok, ms, tokensIn = 0, tokensOut = 0, cost = 0 }) {
    if (!this.per.has(key)) this.per.set(key, { key, requests: 0, ok: 0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, lastMs: 0, lastSeen: 0 });
    const s = this.per.get(key);
    s.requests++;
    if (ok) s.ok++; else s.errors++;
    s.tokensIn += tokensIn;
    s.tokensOut += tokensOut;
    s.costUsd = Math.round((s.costUsd + cost) * 1e6) / 1e6;
    s.lastMs = ms;
    s.lastSeen = Date.now();
    this.total.requests++;
    if (ok) this.total.ok++; else this.total.errors++;
    this.total.tokensIn += tokensIn;
    this.total.tokensOut += tokensOut;
    this.total.costUsd = Math.round((this.total.costUsd + cost) * 1e6) / 1e6;
  }
  snapshot(breakers) {
    return {
      uptimeSec: Math.floor((Date.now() - this.total.startedAt) / 1000),
      total: this.total,
      providers: Array.from(this.per.values()),
      breakers: breakers ? breakers.snapshot() : [],
    };
  }
}

/* =========================== backend call ======================= */

async function callBackend(cfg, log, target, internalReq, clientProto) {
  const { provider, model } = target;
  const started = Date.now();
  const url =
    provider.protocol === "anthropic"
      ? provider.baseURL.replace(/\/$/, "") + "/messages"
      : provider.baseURL.replace(/\/$/, "") + "/chat/completions";
  const isAnthropicBackend = provider.protocol === "anthropic";
  const payload = isAnthropicBackend ? internalReqToAnthropic({ ...internalReq, __targetModel: model }) : { ...internalReq, model };
  const headers = { "content-type": "application/json" };
  if (isAnthropicBackend) {
    headers["x-api-key"] = provider.apiKey || "";
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const elapsed = Date.now() - started;
    if (internalReq.stream) {
      return { stream: res.body, elapsed, backendProto: provider.protocol, backendModel: model, backend: `${provider.name}/${model}` };
    }
    const data = await res.json();
    const converted = isAnthropicBackend ? anthropicRespToInternal(data, `${provider.name}/${model}`) : { ...data, model: data.model || `${provider.name}/${model}` };
    return { data: converted, elapsed, backend: `${provider.name}/${model}` };
  } catch (err) {
    const elapsed = Date.now() - started;
    const e = new Error(`${err.name === "AbortError" ? "timeout after " + cfg.timeoutMs + "ms" : err.message} (${elapsed}ms)`);
    e.status = err.status || 0;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function route(cfg, log, stats, breakers, internalReq, clientProto, overrideProvider) {
  const targets = resolveTargets(cfg, internalReq.model || null, overrideProvider);
  const attempts = [];
  if (!targets.length) {
    throw new CallError(`no provider matches model "${internalReq.model || ""}"`, 404, "client");
  }
  for (const target of targets) {
    const key = `${target.provider.name}/${target.model}`;
    if (!breakers.allow(target.provider.name)) {
      log(`skip ${target.provider.name}: circuit open`);
      continue;
    }
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      log(`trying ${key} (attempt ${attempt + 1}/${cfg.retries + 1})`);
      const t0 = Date.now();
      try {
        const out = await callBackend(cfg, log, target, internalReq, clientProto);
        const usage = out.data && out.data.usage;
        const usageIn = usage ? usage.prompt_tokens || 0 : 0;
        const usageOut = usage ? usage.completion_tokens || 0 : 0;
        const cost = computeCost(cfg, target.provider.name, target.model, out.data ? out.data.usage : null);
        breakers.recordSuccess(target.provider.name);
        stats.hit(key, { ok: true, ms: Date.now() - t0, tokensIn: usageIn, tokensOut: usageOut, cost });
        log(`ok ${key} in ${out.elapsed}ms`);
        return Object.assign({}, out, { cost, usageIn, usageOut }, attempts.length ? { attempts } : {});
      } catch (err) {
        const ce = classifyError(err);
        attempts.push({ provider: target.provider.name, model: target.model, error: ce.message, status: ce.status, kind: ce.kind });
        log(`fail ${key}: [${ce.kind}] ${ce.message}`);
        const opened = breakers.recordFailure(target.provider.name);
        if (opened) log(`circuit OPEN for ${target.provider.name} (${cfg.breaker.cooldownMs}ms)`);
        stats.hit(key, { ok: false, ms: Date.now() - t0 });
        if (ce.kind === "client") break;
        if (ce.kind === "auth" || ce.kind === "rate") break;
        if (attempt < cfg.retries) {
          const wait = cfg.backoffMs * Math.pow(2, attempt);
          log(`retry in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
  }
  return { attempts };
}

/* =========================== server ============================= */

function json(res, code, obj, extraHeaders) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ "content-type": "application/json", "content-length": buf.length, "x-modelgate-version": VERSION }, extraHeaders || {}));
  res.end(buf);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch (e) { reject(new Error("invalid json body")); }
    });
    req.on("error", reject);
  });
}

function dashboardHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>modelgate</title>
<meta http-equiv="refresh" content="5">
<style>body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#101014;color:#e8e6dc;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 4px} .sub{color:#8a887f;font-size:12px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #26262c}
th{color:#8a887f;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
.ok{color:#7fd18a}.err{color:#ff8f6b}.open{color:#ffbd2e}.half{color:#7fb2ff}
.card{display:inline-block;background:#1a1a20;border:1px solid #26262c;border-radius:10px;padding:10px 16px;margin:0 10px 10px 0}
.card b{font-size:18px;display:block}.card span{color:#8a887f;font-size:11px;text-transform:uppercase;letter-spacing:.08em}</style></head>
<body><h1>modelgate <span style="color:#8a887f">v__VERSION__</span></h1><div class="sub">auto-refresh 5s · <a href="/stats" style="color:#7fb2ff">/stats</a> · <a href="/v1/models" style="color:#7fb2ff">/v1/models</a></div>
<div id="cards"></div><table id="t"><thead><tr><th>provider/model</th><th>req</th><th>ok</th><th>err</th><th>tokens in</th><th>tokens out</th><th>cost $</th><th>last ms</th><th>breaker</th></tr></thead><tbody></tbody></table>
<script>
async function refresh(){
  const s = await (await fetch("/stats")).json();
  document.getElementById("cards").innerHTML =
    '<div class="card"><b>'+s.total.requests+'</b><span>requests</span></div>' +
    '<div class="card"><b>'+(s.total.tokensIn+s.total.tokensOut)+'</b><span>tokens</span></div>' +
    '<div class="card"><b>$'+s.total.costUsd.toFixed(4)+'</b><span>cost</span></div>' +
    '<div class="card"><b>'+Math.floor(s.uptimeSec/60)+'m</b><span>uptime</span></div>';
  const bm = {}; for (const b of s.breakers) bm[b.key]=b;
  const tb = document.querySelector("#t tbody"); tb.innerHTML="";
  for (const p of s.providers){
    const b = bm[p.key];
    const bs = b ? '<span class="'+(b.status==="open"?"open":"half")+'">'+b.status+(b.status==="open"?" "+Math.max(0,Math.ceil((b.openUntil-Date.now())/1000))+"s":"")+'</span>' : '<span class="ok">closed</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = '<td>'+p.key+'</td><td>'+p.requests+'</td><td class="ok">'+p.ok+'</td><td class="err">'+p.errors+'</td><td>'+p.tokensIn+'</td><td>'+p.tokensOut+'</td><td>'+p.costUsd.toFixed(4)+'</td><td>'+(p.lastMs||"-")+'</td><td>'+bs+'</td>';
    tb.appendChild(tr);
  }
}
refresh(); setInterval(refresh, 5000);
</script></body></html>`.replace(/__VERSION__/g, VERSION);
}

function serve(cfg) {
  const log = makeLog(cfg);
  const stats = new Stats();
  const breakers = new CircuitBreaker(cfg.breaker);
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    try {
      if (req.method === "GET" && url === "/health") {
        return json(res, 200, { ok: true, version: VERSION, providers: cfg.providers.map((p) => ({ name: p.name, protocol: p.protocol, models: p.models })) });
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
        const data = [];
        for (const pr of cfg.providers) {
          for (const m of pr.models) {
            data.push({ id: m === "*" ? `${pr.name}/any` : m, object: "model", created: 0, owned_by: `${pr.name} (${pr.protocol})` });
          }
        }
        for (const a of Object.keys(cfg.aliases)) data.push({ id: a, object: "model", created: 0, owned_by: "alias" });
        return json(res, 200, { object: "list", data });
      }
      if (req.method === "GET" && url === "/stats") {
        return json(res, 200, stats.snapshot(breakers));
      }
      if (req.method === "GET" && url === "/") {
        const buf = Buffer.from(dashboardHtml());
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": buf.length });
        return res.end(buf);
      }
      if (req.method === "POST" && url === "/admin/reset") {
        breakers.reset();
        return json(res, 200, { ok: true, message: "circuit breakers reset" });
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        let body;
        try { body = await readBody(req); }
        catch (e) { return json(res, 400, { error: { message: e.message } }); }
        if (!Array.isArray(body.messages) || !body.messages.length) {
          return json(res, 400, { error: { message: "messages[] is required" } });
        }
        const override = req.headers["x-modelgate-provider"] || null;
        const out = await route(cfg, log, stats, breakers, body, "openai", override);
        if (out.attempts) {
          return json(res, 502, { error: { message: "all providers failed", attempts: out.attempts } }, { "x-modelgate-attempts": String(out.attempts.length) });
        }
        const xh = { "x-modelgate-provider": out.backend.split("/")[0], "x-modelgate-model": out.backend, "x-modelgate-ms": String(out.elapsed), "x-modelgate-cost-usd": out.cost.toFixed(6) };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...xh });
          const id = "chatcmpl-mg-" + Date.now().toString(36);
          let streamErr = null;
          try {
            for await (const s of eventsToOpenAISSE(streamToEvents(out.stream, out.backendProto, out.backendModel), out.backend, id)) {
              res.write(s);
            }
          } catch (e) {
            log(`stream error: ${e.message}`);
            streamErr = e;
          }
          if (streamErr) res.write(`data: ${JSON.stringify({ error: { message: streamErr.message } })}\n\n`);
          return res.end();
        }
        const data = { ...out.data, model: out.backend };
        return json(res, 200, data, xh);
      }
      if (req.method === "POST" && (url === "/v1/messages" || url === "/messages")) {
        let req2;
        try { req2 = await readBody(req); }
        catch (e) { return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: e.message } }); }
        if (!Array.isArray(req2.messages) || !req2.messages.length) {
          return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages[] is required" } });
        }
        const internal = anthropicReqToInternal(req2);
        if (!internal.model && req2.model) internal.model = req2.model;
        const override = req.headers["x-modelgate-provider"] || null;
        const out = await route(cfg, log, stats, breakers, internal, "anthropic", override);
        if (out.attempts) {
          return json(res, 502, { type: "error", error: { type: "api_error", message: "all providers failed", attempts: out.attempts } }, { "x-modelgate-attempts": String(out.attempts.length) });
        }
        const xh = { "x-modelgate-provider": out.backend.split("/")[0], "x-modelgate-model": out.backend, "x-modelgate-ms": String(out.elapsed), "x-modelgate-cost-usd": out.cost.toFixed(6), "request-id": "req_mg_" + Date.now() };
        if (internal.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...xh });
          const id = "msg_mg_" + Date.now().toString(36);
          try {
            for await (const s of eventsToAnthropicSSE(streamToEvents(out.stream, out.backendProto, out.backendModel), out.backendModel || "modelgate", id)) {
              res.write(s);
            }
          } catch (e) {
            log(`stream error: ${e.message}`);
            res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } })}\n\n`);
          }
          return res.end();
        }
        return json(res, 200, internalRespToAnthropic(out.data), xh);
      }
      return json(res, 404, { error: { message: "not found" } });
    } catch (e) {
      if (e instanceof CallError && e.status === 404) {
        return json(res, 404, { error: { message: e.message } });
      }
      log(`unhandled: ${e.stack || e.message}`);
      if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
      res.end();
    }
  });
  server.listen(cfg.port, () => {
    log(`listening on http://127.0.0.1:${cfg.port} (v${VERSION})`);
    log(`providers (priority order): ${cfg.providers.map((p) => `${p.name}[${p.protocol}]`).join(" -> ")}`);
    log(`dashboard: http://127.0.0.1:${cfg.port}/  ·  stats: /stats`);
  });
}

/* ============================ CLI =============================== */

async function cmdModels(cfg) {
  const log = makeLog(cfg);
  const breakers = new CircuitBreaker(cfg.breaker);
  const stats = new Stats();
  console.log("provider/model             result");
  console.log("-".repeat(64));
  for (const pr of cfg.providers) {
    for (const m of pr.models) {
      const model = m === "*" ? "gpt-4o-mini" : m;
      const body = { messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 16, stream: false };
      const out = await route(cfg, log, stats, breakers, { ...body, model }, "openai", pr.name);
      const key = `${pr.name}/${model}`.padEnd(26);
      if (out.attempts) {
        console.log(`${key} FAIL ${out.attempts.map((a) => a.kind).join(",")}`);
      } else {
        const text = ((out.data.choices || [])[0] || {}).message?.content || "";
        console.log(`${key} OK   ${out.elapsed}ms  "${String(text).slice(0, 30).replace(/\n/g, " ")}"`);
      }
    }
  }
}

async function cmdChat(cfg, prompt, model) {
  const log = makeLog(cfg);
  const breakers = new CircuitBreaker(cfg.breaker);
  const stats = new Stats();
  const body = { messages: [{ role: "user", content: prompt }], max_tokens: 512, stream: false };
  if (model) body.model = model;
  const out = await route(cfg, log, stats, breakers, body, "openai", null);
  if (out.attempts) {
    console.error("all providers failed:");
    for (const a of out.attempts) console.error(`  ${a.provider}/${a.model}: [${a.kind}] ${a.error}`);
    process.exit(1);
  }
  console.log((out.data.choices || [])[0]?.message?.content || "");
  console.error(`\n[modelgate] via ${out.backend} in ${out.elapsed}ms, cost $${out.cost.toFixed(6)}`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "start";
  if (cmd === "version" || cmd === "--version") { console.log(`modelgate ${VERSION}`); return; }
  if (cmd === "help" || cmd === "--help") {
    console.log("usage: modelgate [start|models|chat \"msg\"] [--config path] [--port n] [--model m] [-q]");
    return;
  }
  const cfgIdx = args.indexOf("--config");
  const configPath = cfgIdx !== -1 ? args[cfgIdx + 1] : process.env.MODELGATE_CONFIG;
  const cfg = loadConfig(configPath);
  cfg.quiet = args.includes("-q") || args.includes("--quiet");
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) cfg.port = parseInt(args[portIdx + 1], 10);

  if (cmd === "start") serve(cfg);
  else if (cmd === "models") cmdModels(cfg).catch((e) => { console.error(e.message); process.exit(1); });
  else if (cmd === "chat") {
    const rest = args.slice(1);
    const parts = [];
    let model = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config") { i++; continue; }
      if (rest[i] === "--model") { model = rest[i + 1]; i++; continue; }
      if (rest[i] === "-q" || rest[i] === "--quiet") continue;
      parts.push(rest[i]);
    }
    const msg = parts.join(" ").trim();
    if (!msg) { console.error('usage: modelgate chat "your prompt" [--model name]'); process.exit(1); }
    cmdChat(cfg, msg, model).catch((e) => { console.error(e.message); process.exit(1); });
  }
  else {
    console.error("usage: modelgate [start|models|chat \"msg\"] [--config path] [--port n] [--model m] [-q]");
    process.exit(1);
  }
}

module.exports = { loadConfig, CircuitBreaker, anthropicReqToInternal, internalReqToAnthropic, anthropicRespToInternal, internalRespToAnthropic, sseBlocks, parseSseBlock, streamToEvents, eventsToOpenAISSE, eventsToAnthropicSSE, resolveTargets, classifyError, computeCost, Stats, CallError, callBackend, route, VERSION };

if (require.main === module) main();
