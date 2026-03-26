# kepler-bun-proxy

TypeScript/Bun/Hono reverse proxy that forwards standard OpenAI requests to the Kepler AI API gateway provider in the expected URL format, with token handling, rate limiting, and optional debug logging.

## Run

Copy config.example.json to config.json and update with your provider details before running.

```bash
bun install
bun run start
```

Proxy listens on `http://localhost:4000` by default.

## Harness config examples

Example harness configuration files live in `harness-config-examples/`.

- `harness-config-examples/opencode.jsonc` provides a ready-to-use OpenCode config wired to this proxy on `http://localhost:4000/v1/`.
- Copy and adapt these examples for your local harness setup.

## Config

- Required: `config.json`
- Optional overlay: `config.{ASPNETCORE_ENVIRONMENT|BUN_ENV|NODE_ENV}.json`
- Environment overrides using `__` nesting are supported (example: `providers__openai__stripRequestProperties=["max_tokens"]`).

Config is a single, top-level object (no `Proxy` wrapper). Key highlights:

- `convertToken` (boolean)
- `tokenEndpoint` (string)
- `rateLimitEnabled` (boolean; defaults to `false` when omitted)
- `debugPath` (string, optional; used only when `--debug`/`-d` is provided)
- `providers` (record of providers)
- Provider settings include `routePrefix`, `upstreamTemplate`, `defaultModel`,
  `modelAliases`, `disableStreaming`, `mimicStreaming`, `tokenLimitPerMinute`,
  and `stripRequestProperties`.
- `mimicStreaming` can synthesize OpenAI-compatible SSE responses for both
  `/v1/chat/completions` and `/v1/responses` when the upstream returns JSON.

## Scripts

- `bun run dev`
- `bun run start`
- `bun run start -- --debug` (enables request/response Markdown logging when `debugPath` is set)
- `bun run build` (builds a single-file executable and copies `config.json` to `dist/config.json`)
- `bun run typecheck`
