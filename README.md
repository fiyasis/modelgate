# modelgate

**The 300-line AI gateway.** One endpoint in front of all your providers — OpenAI-compatible *and* Anthropic-compatible, with auto-failover, circuit breakers, cost tracking and a live dashboard.

OmniRoute has 71k stars, 23,000 files and a `pnpm` monorepo. modelgate has **one file, zero dependencies, no build step** — and it does the one thing you actually need: *never let a denied, down or rate-limited model break your app.*

## Why it exists

Frontier model access gets restricted (Google restricted Gemini 4.0 over safety concerns; API keys get rate-limited; free tiers die). Your app shouldn't die with it. modelgate sits in front of your providers and silently moves every request to the next working one.

## Quick start

```sh
git clone https://github.com/fiyasis/modelgate && cd modelgate
cp config.example.json config.json   # add your providers + keys
node index.js start
```

That's it. No `npm install`, no build, no Docker. Node >= 18.

## Two protocols, fully bridged

Talk to it like OpenAI **or** like Anthropic — the backend can be either. modelgate converts in both directions, JSON *and* streaming:

```sh
# OpenAI client -> any backend
curl localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"hi"}]}'

# Anthropic client -> any backend
curl localhost:8787/v1/messages -H 'content-type: application/json' -H 'x-api-key: whatever' \
  -d '{"model":"fast","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Any OpenAI SDK (`base_url=...`, `api_key="x"`) and any Anthropic SDK (`ANTHROPIC_BASE_URL=...`) just work.

## Config

```json
{
  "port": 8787,
  "timeoutMs": 60000,
  "retries": 1,
  "backoffMs": 500,
  "breaker": { "failures": 3, "cooldownMs": 30000 },
  "aliases": {
    "fast": ["openrouter/nemotron-nano"],
    "smart": ["openrouter/auto", "openrouter/nemotron-nano"]
  },
  "pricing": {
    "openrouter/auto": { "input": 0.0005, "output": 0.0015 }
  },
  "providers": [
    { "name": "openrouter", "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-...", "protocol": "openai",
      "models": ["openrouter/auto", "nemotron-nano", "gpt-4o-mini"] },
    { "name": "anthropic-direct", "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "sk-ant-...", "protocol": "anthropic",
      "models": ["claude-sonnet-4-20250514", "claude-haiku-4-20250514"] },
    { "name": "local-ollama", "baseURL": "http://127.0.0.1:11434/v1",
      "protocol": "openai", "models": ["llama3.2", "qwen2.5"] }
  ]
}
```

- **Provider order = failover priority.** `"models": ["*"]` accepts any model name.
- **`protocol`**: `"openai"` (default) or `"anthropic"` — the wire format of the backend.
- **`aliases`**: your own model names, mapped to provider/model chains. `fast`, `smart`, `cheap`… whatever you want.
- **`pricing`**: USD per 1M tokens, per `provider/model` or per bare model. Drives `/stats` cost.
- **`x-modelgate-provider: <name>`** header forces a specific provider for one request.

## Resilience (3 layers, like the big gateways — in 300 lines)

1. **Retry with exponential backoff** per attempt (`retries`, `backoffMs`).
2. **Circuit breaker per provider** — N consecutive failures (`breaker.failures`) opens the circuit for `breaker.cooldownMs`; requests skip the dead provider entirely instead of timing out. `POST /admin/reset` closes all circuits.
3. **Error classification** — `401/403` (auth) and `429` (rate) don't retry (pointless), `5xx` retries, `400`-bad-model moves on. Every failure is logged with its class.

## Endpoints

| Method | Path                  | What                                     |
| ------ | --------------------- | ---------------------------------------- |
| POST   | `/v1/chat/completions`| OpenAI-compatible chat (JSON + SSE)      |
| POST   | `/v1/messages`        | Anthropic-compatible messages (JSON + SSE) |
| GET    | `/v1/models`          | all configured models + aliases          |
| GET    | `/stats`              | per-provider req/ok/err/tokens/cost/breakers |
| GET    | `/`                   | live dashboard (auto-refresh, 5s)        |
| GET    | `/health`             | health + provider list                   |
| POST   | `/admin/reset`        | close all circuit breakers               |

Response headers on every chat call: `x-modelgate-provider`, `x-modelgate-model`, `x-modelgate-ms`, `x-modelgate-cost-usd`.

If every provider fails: `502` + the full attempt list (which provider/model, what error class).

## CLI

```sh
node index.js start              # run the gateway
node index.js models             # ping every provider/model, OK/FAIL + latency
node index.js chat "hello"       # one-shot through the failover chain
node index.js chat "hi" --model fast
node index.js version
# all accept: --config path  --port n  -q
```

## Tests

```sh
node --test test/    # 19 tests: conversions, SSE, failover, breaker, cost, cross-protocol streams
```

## License

MIT
