# kepler-bun-proxy

TypeScript/Bun/Hono reverse proxy port of the original .NET YARP service.

## Run

```bash
bun install
bun run start
```

Proxy listens on `http://localhost:4000` by default.

## Config

- Required: `config.json`
- Optional overlay: `config.{ASPNETCORE_ENVIRONMENT|BUN_ENV|NODE_ENV}.json`
- Environment overrides using `__` nesting are supported (example: `providers__openai__stripRequestProperties=["max_tokens"]`).

Config is a single, top-level object (no `Proxy` wrapper). Key highlights:

- `convertToken` (boolean)
- `tokenEndpoint` (string)
- `debugPath` (string, optional)
- `providers` (record of providers)
- Provider settings include `routePrefix`, `upstreamTemplate`, `defaultModel`,
  `modelAliases`, `disableStreaming`, `tokenLimitPerMinute`,
  and `stripRequestProperties`.

## Scripts

- `bun run dev`
- `bun run start`
- `bun run build` (builds a single-file executable and copies `config.json` to `dist/config.json`)
- `bun run typecheck`
