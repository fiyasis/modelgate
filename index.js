#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = "0.1.0";

function loadConfig(configPath) {
  const p = configPath || process.env.MODELGATE_CONFIG || path.join(process.cwd(), "config.json");
  if (!fs.existsSync(p)) {
    console.error(`[modelgate] config not found: ${p}`);
    console.error('[modelgate] copy config.example.json to config.json and fill in your keys.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    console.error("[modelgate] config must define a non-empty \"providers\" array.");
    process.exit(1);
  }
  cfg.timeoutMs = cfg.timeoutMs || 60000;
  cfg.retries = cfg.retries === undefined ? 1 : cfg.retries;
  for (const pr of cfg.providers) {
    if (!pr.name) pr.name = pr.baseURL;
    if (!Array.isArray(pr.models) || pr.models.length === 0) pr.models = ["*"];
  }
  return cfg;
}

function verbose(cfg) {
  if (cfg.quiet) return () => {};
  return (msg) => process.stderr.write(`[modelgate] ${msg}\n`);
}

async function callProvider(cfg, log, provider, model, body) {
  const url = provider.baseURL.replace(/\/$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const payload = { ...body, model };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`), { status: res.status });
    }
    const elapsed = Date.now() - started;
    if (body.stream) {
      return { stream: res.body, elapsed, provider: provider.name, model };
    }
    const data = await res.json();
    return { data, elapsed, provider: provider.name, model };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    throw Object.assign(new Error(`${err.message} (${elapsed}ms)`), { status: err.status || 0 });
  }
}

function nextModels(cfg) {
  const list = [];
  for (const pr of cfg.providers) {
    for (const m of pr.models) list.push({ pr, m });
  }
  return list;
}

function pickModel(requested, available) {
  if (requested && available) return requested;
  if (requested) return requested;
  return available ? available[0] : "gpt-4o-mini";
}

async function route(cfg, log, body) {
  const attempts = [];
  const targets = nextModels(cfg);
  const want = body.model || null;
  for (const { pr, m } of targets) {
    if (want && m !== "*" && m !== want) continue;
    const model = m === "*" ? (want || "gpt-4o-mini") : m;
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      log(`trying ${pr.name}/${model} (attempt ${attempt + 1}/${cfg.retries + 1})`);
      try {
        const out = await callProvider(cfg, log, pr, model, body);
        log(`ok ${pr.name}/${model} in ${out.elapsed}ms`);
        return out;
      } catch (err) {
        attempts.push({ provider: pr.name, model, error: err.message, status: err.status, ms: 0 });
        log(`fail ${pr.name}/${model}: ${err.message}`);
      }
    }
  }
  return { attempts };
}

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": buf.length,
    "x-modelgate-version": VERSION,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch (e) { reject(new Error("invalid json body")); }
    });
    req.on("error", reject);
  });
}

async function handleChat(cfg, log, req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: { message: e.message } }); }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, { error: { message: "messages[] is required" } });
  }
  const out = await route(cfg, log, body);
  if (out.attempts) {
    return json(res, 502, { error: { message: "all providers failed", attempts: out.attempts } });
  }
  if (out.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-modelgate-provider": out.provider,
      "x-modelgate-model": out.model,
    });
    try {
      for await (const chunk of out.stream) res.write(chunk);
    } catch (e) {
      log(`stream error: ${e.message}`);
    }
    res.end();
    return;
  }
  const data = { ...out.data, model: `${out.provider}/${out.model}` };
  json(res, 200, data);
}

function handleModels(cfg, res) {
  const models = [];
  for (const pr of cfg.providers) {
    for (const m of pr.models) {
      models.push({
        id: m === "*" ? `${pr.name}/any` : m,
        object: "model",
        created: 0,
        owned_by: pr.name,
      });
    }
  }
  json(res, 200, { object: "list", data: models });
}

function serve(cfg) {
  const log = verbose(cfg);
  const port = cfg.port || 8787;
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    try {
      if (req.method === "GET" && url === "/health") {
        return json(res, 200, { ok: true, version: VERSION, providers: cfg.providers.map((p) => p.name) });
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
        return handleModels(cfg, res);
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        return await handleChat(cfg, log, req, res);
      }
      if (req.method === "GET" && url === "/") {
        return json(res, 200, {
          name: "modelgate",
          version: VERSION,
          endpoints: { chat: "POST /v1/chat/completions", models: "GET /v1/models", health: "GET /health" },
          providers: cfg.providers.map((p) => ({ name: p.name, models: p.models })),
        });
      }
      return json(res, 404, { error: { message: "not found" } });
    } catch (e) {
      log(`unhandled: ${e.stack || e.message}`);
      return json(res, 500, { error: { message: e.message } });
    }
  });
  server.listen(port, () => {
    log(`listening on http://127.0.0.1:${port}`);
    log(`providers (priority order): ${cfg.providers.map((p) => p.name).join(" -> ")}`);
  });
}

async function cmdModels(cfg) {
  const log = verbose(cfg);
  console.log("provider/model           result");
  console.log("-".repeat(52));
  for (const pr of cfg.providers) {
    for (const m of pr.models) {
      const model = m === "*" ? "gpt-4o-mini" : m;
      const started = Date.now();
      try {
        const out = await callProvider(cfg, log, pr, model, {
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          max_tokens: 8,
        });
        const text = (out.data.choices?.[0]?.message?.content || "").slice(0, 40).replace(/\n/g, " ");
        console.log(`${(pr.name + "/" + model).padEnd(24)} OK   ${out.elapsed}ms  "${text}"`);
      } catch (err) {
        console.log(`${(pr.name + "/" + model).padEnd(24)} FAIL ${Date.now() - started}ms  ${err.message.slice(0, 40)}`);
      }
    }
  }
}

async function cmdChat(cfg, prompt) {
  const log = verbose(cfg);
  const body = { messages: [{ role: "user", content: prompt }], stream: false };
  const out = await route(cfg, log, body);
  if (out.attempts) {
    console.error("all providers failed:");
    for (const a of out.attempts) console.error(`  ${a.provider}/${a.model}: ${a.error}`);
    process.exit(1);
  }
  const text = out.data.choices?.[0]?.message?.content || "";
  console.log(text);
  console.error(`\n[modelgate] via ${out.provider}/${out.model} in ${out.elapsed}ms`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "start";
  const configPath = args.find((a, i) => args[i - 1] === "--config") || process.env.MODELGATE_CONFIG;
  const cfg = loadConfig(configPath);
  cfg.quiet = args.includes("-q") || args.includes("--quiet");
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) cfg.port = parseInt(args[portIdx + 1], 10);

  if (cmd === "start") serve(cfg);
  else if (cmd === "models") cmdModels(cfg).catch((e) => { console.error(e.message); process.exit(1); });
  else if (cmd === "chat") {
    const rest = args.slice(1);
    const parts = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config") { i++; continue; }
      if (rest[i].startsWith("-")) continue;
      parts.push(rest[i]);
    }
    const msg = parts.join(" ").trim();
    if (!msg) { console.error('usage: modelgate chat "your prompt"'); process.exit(1); }
    cmdChat(cfg, msg).catch((e) => { console.error(e.message); process.exit(1); });
  }
  else if (cmd === "version" || cmd === "--version") console.log(`modelgate ${VERSION}`);
  else {
    console.error(`usage: modelgate [start|models|chat "msg"] [--config path] [--port n] [-q]`);
    process.exit(1);
  }
}

main();
