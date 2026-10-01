# modelgate

Zero-dependency AI model failover router.

One OpenAI-compatible endpoint. Behind it, a priority-ordered list of providers and models. When a model is **denied, down, rate-limited, or errors out**, modelgate automatically moves to the next one. No client changes needed.

Built because frontier model access gets restricted (e.g. Google restricting Gemini 4.0 over safety concerns) and you don't want every integration to break when one model is denied.

## Install

```sh
git clone https://github.com/fiyasis/modelgate
cd modelgate
cp config.example.json config.json   # fill in your providers + keys
```

No `npm install` required. Node >= 18 (uses global `fetch`).

## Start

```sh
node index.js start                # listens on 127.0.0.1:8787
node index.js start --port 9000    # custom port
node index.js start --config ./prod.json
```

## Use it (any OpenAI client)

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"any","messages":[{"role":"user","content":"hi"}]}'
```

- `model` can be any of your configured model IDs, or omitted to use the first healthy one.
- Streaming (`"stream": true`) passes through untouched.
- Response `model` field is rewritten to `provider/model` so you always see which one answered.

### SDK example (OpenAI Python)

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="ignored")
print(client.chat.completions.create(model="any", messages=[{"role": "user", "content": "hi"}]))
```

## CLI commands

```sh
node index.js models               # ping every provider/model, show OK/FAIL + latency
node index.js chat "hello world"   # one-shot chat through the failover chain
node index.js version
```

## Config

```json
{
  "port": 8787,
  "timeoutMs": 60000,
  "retries": 1,
  "providers": [
    { "name": "primary",  "baseURL": "https://api.a.com/v1", "apiKey": "sk-...", "models": ["model-1", "model-2"] },
    { "name": "fallback", "baseURL": "https://api.b.com/v1", "apiKey": "sk-...", "models": ["model-3"] }
  ]
}
```

- `providers` order = failover priority.
- `"models": ["*"]` = accept whatever model ID the client asks for.
- `retries` = extra attempts per model before moving on (default 1).
- Every denied/failed model is logged to stderr (use `-q` to silence).

## Endpoints

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions`| Chat with automatic failover         |
| GET    | `/v1/models`          | List configured models               |
| GET    | `/health`             | Health + provider list               |
| GET    | `/`                   | Service info                         |

## Response headers

- `x-modelgate-provider`, `x-modelgate-model` — which backend answered (stream + JSON).
- `x-modelgate-version` — server version.

If every provider fails, you get HTTP 502 with the full attempt list:

```json
{ "error": { "message": "all providers failed", "attempts": [ ... ] } }
```

## License

MIT
