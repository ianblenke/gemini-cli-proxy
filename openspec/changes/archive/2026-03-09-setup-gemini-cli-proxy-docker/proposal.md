## Why

The user wants to expose an OpenAI-compatible API that leverages their existing **Gemini Advanced (Google Ultra)** quota, which is authenticated via the `gemini` CLI. This avoids the per-token costs of Vertex AI and Google AI Studio. The proxy must internally execute the `gemini` command to use the CLI's existing session and credentials.

## What Changes

- Add a `Dockerfile` to create a proxy image that includes the `gemini` CLI.
- Implement a Node.js proxy (`server.js`) that translates OpenAI Chat Completion requests into `gemini -p <prompt> -o json` calls.
- Add a `docker-compose.yml` that orchestrates the proxy and mounts the user's `~/.gemini/` directory.
- Add a `Makefile` for lifecycle management (`make up`, `make down`, `make test`).
- Implement integration tests that verify the proxy's behavior against spec scenarios.

## Capabilities

### New Capabilities
- `openai-to-gemini-cli-proxy`: An API endpoint that translates OpenAI requests to the `gemini` CLI.
- `quota-leverage`: Uses the user's existing Gemini Ultra quota via local CLI authentication.
- `service-management`: Standardized lifecycle commands via `Makefile`.

### Modified Capabilities
- None

## Impact

- New `Dockerfile`, `server.js`, `package.json`, and `docker-compose.yml` in the root directory.
- Requires `~/.gemini/` credentials on the host.
- Uses the `gemini` CLI as the underlying inference engine.
