## Context

The user has an existing **Gemini Advanced (Google Ultra)** quota via the `gemini` CLI. We need to expose this as an OpenAI-compatible API to allow other projects to use it for free (within the user's quota).

## Goals / Non-Goals

**Goals:**
- Wrap the `gemini` CLI in an OpenAI-compatible HTTP server.
- Use the user's host credentials (`~/.gemini/` and `~/.config/gcloud/`).
- Provide standard service management via `Makefile`.
- **100% Spec Coverage**: Verify with automated tests.

**Non-Goals:**
- Scaling to multiple users (this is a personal proxy).
- Low latency (executing a CLI command is inherently slower than direct API calls).

## Decisions

### 1. Implementation Language: Node.js (Express)
- **Rationale**: Since `gemini-cli` is itself a Node.js application, it's natural to use Node.js to wrap it. This simplifies the Docker environment.

### 2. Execution Strategy: Child Process
- **Rationale**: The proxy will execute `gemini -p "<prompt>" -o json` for each request. This is the simplest way to reuse the existing CLI logic and authentication.

### 3. Authentication: Host Mounting
- **Rationale**: Mount the user's `~/.gemini` and `~/.config/gcloud` directories. The CLI uses these to verify the session.

### 4. Containerization: Custom Dockerfile
- **Rationale**: We need both the `gemini-cli` and our proxy server in the same environment.

## Risks / Trade-offs

- **[Risk]** Parallel requests might be throttled or fail if the CLI session isn't thread-safe.
- **[Mitigation]** Queue requests if necessary, but start with concurrent execution for simplicity.
- **[Trade-off]** Performance will be slower than a direct API call because of the CLI overhead.
