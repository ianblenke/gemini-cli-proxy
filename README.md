# gemini-cli-proxy

An OpenAI-compatible API proxy that uses your existing Google Gemini Advanced (Ultra) quota via OAuth credentials. Instead of paying per-token through Vertex AI or Google AI Studio, this proxy authenticates with the same credentials as the `gemini` CLI and calls Google's API directly.

Runs as a Docker container. Supports chat completions, streaming, thinking/reasoning, and function/tool calling.

## Prerequisites

- Docker and Docker Compose
- An authenticated `gemini` CLI session (`~/.gemini/oauth_creds.json` must exist)
- The Google OAuth client ID and secret from the [gemini CLI source code](https://github.com/google-gemini/gemini-cli)

To create the OAuth credentials, install and authenticate the gemini CLI:

```bash
npm install -g @google/gemini-cli
gemini
# Follow the browser-based login flow
```

## Setup

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
GEMINI_CONFIG_PATH=/home/youruser/.gemini
PORT=8080
PROXY_API_KEY=your-secret-key-here
GOOGLE_OAUTH_CLIENT_ID=<from gemini CLI source>
GOOGLE_OAUTH_CLIENT_SECRET=<from gemini CLI source>
```

## Usage

```bash
make up      # Build and start
make down    # Stop and remove
make logs    # Follow container logs
make test    # Run integration tests
```

## API

### List Models

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

### Chat Completion

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Thinking/Reasoning

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Solve this step by step: 17 * 23"}],
    "thinking": {"budget_tokens": 2048}
  }'
```

Thinking tokens appear as `reasoning_content` in the response message (non-streaming) or as `reasoning_content` deltas (streaming).

### Function Calling

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "What is the weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"location": {"type": "string"}},
          "required": ["location"]
        }
      }
    }]
  }'
```

Tool calls are returned in standard OpenAI format with `finish_reason: "tool_calls"`.

## Available Models

| Model | Description |
|-------|-------------|
| `gemini-2.5-flash` | Fast, default model |
| `gemini-2.5-pro` | Most capable |
| `gemini-2.5-flash-lite` | Fastest, cheapest |
| `gemini-3-pro-preview` | Next-gen preview |
| `gemini-3-flash-preview` | Next-gen fast preview |

## Using from Other Services

Any OpenAI-compatible client can connect by setting the base URL and API key:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<host-ip>:8080/v1",
    api_key="your-proxy-api-key",
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

For another Docker Compose service on the same host:

```yaml
environment:
  - OPENAI_API_BASE=http://<host-ip>:8080/v1
  - OPENAI_API_KEY=your-proxy-api-key
```

## Authentication

Set `PROXY_API_KEY` in `.env` to require a Bearer token on all API requests. When unset, the proxy is open to anyone who can reach it. The health endpoint (`/health/readiness`) is always unauthenticated.

## How It Works

The proxy reads OAuth credentials from `~/.gemini/oauth_creds.json` (the same file the `gemini` CLI uses), refreshes the access token automatically, and calls Google's `cloudcode-pa.googleapis.com` API directly. This bypasses the `gemini` CLI entirely — the CLI uses an `ink` (React-based terminal UI) that cannot run headlessly in Docker.

The OAuth client ID and secret are the same public "installed application" credentials embedded in the [gemini CLI source code](https://github.com/google-gemini/gemini-cli). They are passed via environment variables to avoid committing them to the repository.
