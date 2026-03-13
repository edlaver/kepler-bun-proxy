import path from "node:path";
import { parseArgs } from "util";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { maybeMimicChatCompletionsStreaming } from "./chat-completions-streaming";
import { ConfigStore } from "./config-store";
import { DebugLogger } from "./debug-logger";
import { TokenCounter } from "./token-counter";
import {
  type InternalTokenRateLimitEvent,
  TokenRateLimiter,
  type TokenLimitSnapshot,
} from "./token-rate-limiter";
import { TokenService } from "./token-service";
import type { ProviderConfig } from "./types";

interface ProviderMatch {
  name: string;
  provider: ProviderConfig;
}

interface PreparedRequestBody {
  forwardBody: Uint8Array;
  payloadForTokenCount: string | undefined;
  resolvedModel: string | undefined;
  bodyWasMutated: boolean;
  mimicStreamingForClient: boolean;
  includeUsageInStreaming: boolean;
  includeObfuscationInStreaming: boolean;
}

const configStore = await ConfigStore.create(process.cwd());
const debugEnabled = getDebugFlag();
const tokenCounter = new TokenCounter();
const debugLogger = new DebugLogger(() =>
  debugEnabled ? configStore.getConfig().proxy.debugPath : undefined,
);
const tokenRateLimiter = new TokenRateLimiter(
  async (event: InternalTokenRateLimitEvent) => {
    if (!debugLogger.isEnabled()) {
      return;
    }

    await debugLogger.logEvent({
      title: "RateLimit/InternalTokens",
      details: [
        `Provider: ${event.providerKey}`,
        `Required tokens: ${event.requiredTokens}`,
        `Available tokens: ${event.availableTokens}`,
        `Limit per minute: ${event.limitPerMinute}`,
      ],
    });
  },
);
const tokenService = new TokenService(
  () => configStore.getConfig().proxy.tokenEndpoint,
);

const app = new Hono();

app.get("*", async (c, next) => {
  const requestUrl = new URL(c.req.raw.url);
  const pathname = requestUrl.pathname;

  if (!pathname.toLowerCase().endsWith("/v1/models")) {
    await next();
    return;
  }

  const proxyConfig = configStore.getConfig().proxy;
  const providerMatch = resolveProvider(proxyConfig.providers, pathname);
  if (!providerMatch) {
    await next();
    return;
  }

  const pathWithoutPrefix = removePrefix(
    pathname,
    providerMatch.provider.routePrefix,
  );
  if (pathWithoutPrefix.toLowerCase() !== "/v1/models") {
    await next();
    return;
  }

  const data = buildModelList(providerMatch.provider).map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: providerMatch.name,
  }));

  return c.json({ object: "list", data });
});

app.all("*", async (c) => {
  const config = configStore.getConfig();
  const proxyConfig = config.proxy;
  const request = c.req.raw;
  const requestUrl = new URL(request.url);
  const providerMatch = resolveProvider(
    proxyConfig.providers,
    requestUrl.pathname,
  );
  if (!providerMatch) {
    return c.text("Not Found", 404);
  }

  const preparedBody = await prepareRequestBody(
    request,
    providerMatch.provider,
    requestUrl.pathname,
  );

  let tokenLimitSnapshot: TokenLimitSnapshot | null = null;
  if (
    proxyConfig.rateLimitEnabled &&
    providerMatch.provider.tokenLimitPerMinute > 0
  ) {
    if (preparedBody.payloadForTokenCount) {
      const tokens = tokenCounter.countTokens(
        preparedBody.payloadForTokenCount,
      );
      await tokenRateLimiter.waitForTokens(
        providerMatch.name,
        providerMatch.provider.tokenLimitPerMinute,
        tokens,
        request.signal,
      );
    }

    tokenLimitSnapshot = tokenRateLimiter.getUsageSnapshot(providerMatch.name);
  }

  const model =
    preparedBody.resolvedModel ?? providerMatch.provider.defaultModel;
  const destinationPrefix = providerMatch.provider.upstreamTemplate.replace(
    /\{model\}/gi,
    model,
  );
  const upstreamUrl = buildUpstreamUrl(
    destinationPrefix,
    requestUrl.pathname,
    providerMatch.provider.routePrefix,
    requestUrl.search,
  );

  const incomingHeaders = new Headers(request.headers);
  const originalAuth = incomingHeaders.get("authorization");

  const baseHeaders = new Headers(incomingHeaders);
  baseHeaders.delete("host");
  if (preparedBody.bodyWasMutated) {
    baseHeaders.set(
      "content-length",
      preparedBody.forwardBody.byteLength.toString(),
    );
    baseHeaders.delete("transfer-encoding");
  }

  const sendOnce = async (forceRefresh: boolean): Promise<Response> => {
    const headers = new Headers(baseHeaders);
    if (proxyConfig.convertToken && originalAuth) {
      const token = await tokenService.getToken(
        originalAuth,
        forceRefresh,
        request.signal,
      );
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
    }

    setTokenLimitHeaders(headers, tokenLimitSnapshot);

    const body = shouldIncludeBody(request.method, preparedBody.forwardBody)
      ? new Uint8Array(preparedBody.forwardBody)
      : undefined;

    if (debugLogger.isEnabled()) {
      await debugLogger.logRequest({
        method: request.method,
        uri: upstreamUrl,
        headers,
        body,
      });
    }

    const response = await proxy(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });

    if (response.status === 429) {
      const message = `[RateLimit/Upstream429] Upstream rate limit response received for provider "${providerMatch.name}" (${request.method} ${upstreamUrl}).`;
      console.warn(message);

      if (debugLogger.isEnabled()) {
        await debugLogger.logEvent({
          title: "RateLimit/Upstream429",
          details: [
            `Provider: ${providerMatch.name}`,
            `Method: ${request.method}`,
            `Uri: ${upstreamUrl}`,
          ],
        });
      }
    }

    const enrichedResponse = withTokenLimitHeaders(
      response,
      tokenLimitSnapshot,
    );
    const finalResponse = await maybeMimicChatCompletionsStreaming(
      enrichedResponse,
      preparedBody.mimicStreamingForClient,
      preparedBody.includeUsageInStreaming,
      preparedBody.includeObfuscationInStreaming,
    );

    if (!debugLogger.isEnabled()) {
      return finalResponse;
    }

    const responseBody = new Uint8Array(
      await finalResponse.clone().arrayBuffer(),
    );
    await debugLogger.logResponse({
      status: finalResponse.status,
      statusText: finalResponse.statusText,
      uri: upstreamUrl,
      headers: finalResponse.headers,
      body: responseBody,
    });

    return finalResponse;
  };

  if (!proxyConfig.convertToken || !originalAuth) {
    return sendOnce(false);
  }

  const firstResponse = await sendOnce(false);
  if (firstResponse.status !== 401 && firstResponse.status !== 403) {
    return firstResponse;
  }

  firstResponse.body?.cancel();
  return sendOnce(true);
});

const bootConfig = configStore.getConfig();
const server = Bun.serve({
  idleTimeout: 0, // Disable idle timeout to allow long-running requests
  fetch: app.fetch,
  hostname: bootConfig.host,
  port: bootConfig.port,
});

console.info(
  `Proxy listening on http://${server.hostname}:${server.port} (${bootConfig.environmentName})`,
);

const debugPath = debugEnabled ? bootConfig.proxy.debugPath : undefined;
if (debugEnabled && debugPath) {
  const fullDebugPath = path.resolve(process.cwd(), debugPath);
  console.info(`Debug logging: enabled (${fullDebugPath})`);
} else {
  console.info("Debug logging: disabled");
}

const initialConfig = configStore.getConfig();
registerProviderLimits(
  tokenRateLimiter,
  initialConfig.proxy.providers,
  initialConfig.proxy.rateLimitEnabled,
);

function resolveProvider(
  providers: Record<string, ProviderConfig>,
  pathname: string,
): ProviderMatch | null {
  let longestMatchLength = 0;
  let match: ProviderMatch | null = null;

  for (const [name, provider] of Object.entries(providers)) {
    if (!provider.routePrefix) {
      continue;
    }

    if (!startsWithRoutePrefix(pathname, provider.routePrefix)) {
      continue;
    }

    if (provider.routePrefix.length > longestMatchLength) {
      longestMatchLength = provider.routePrefix.length;
      match = { name, provider };
    }
  }

  return match;
}

function registerProviderLimits(
  rateLimiter: TokenRateLimiter,
  providers: Record<string, ProviderConfig>,
  rateLimitEnabled: boolean,
): void {
  if (!rateLimitEnabled) {
    return;
  }

  for (const [name, provider] of Object.entries(providers)) {
    if (provider.tokenLimitPerMinute > 0) {
      rateLimiter.registerLimit(name, provider.tokenLimitPerMinute);
    }
  }
}

function startsWithRoutePrefix(pathname: string, routePrefix: string): boolean {
  const normalizedPath = pathname.toLowerCase();
  const normalizedPrefix = routePrefix.toLowerCase();

  if (!normalizedPath.startsWith(normalizedPrefix)) {
    return false;
  }

  if (normalizedPath.length === normalizedPrefix.length) {
    return true;
  }

  return normalizedPath[normalizedPrefix.length] === "/";
}

async function prepareRequestBody(
  request: Request,
  provider: ProviderConfig,
  pathname: string,
): Promise<PreparedRequestBody> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const defaultModel = provider.defaultModel || undefined;
  const isChatCompletionsRequest = isChatCompletionsPath(pathname);

  if (rawBody.byteLength === 0) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: undefined,
      resolvedModel: defaultModel,
      bodyWasMutated: false,
      mimicStreamingForClient: false,
      includeUsageInStreaming: false,
      includeObfuscationInStreaming: false,
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: undefined,
      resolvedModel: defaultModel,
      bodyWasMutated: false,
      mimicStreamingForClient: false,
      includeUsageInStreaming: false,
      includeObfuscationInStreaming: false,
    };
  }

  const decoder = new TextDecoder();
  const rawText = decoder.decode(rawBody);
  const parsed = safeParseJsonObject(rawText);
  if (!parsed) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: undefined,
      resolvedModel: defaultModel,
      bodyWasMutated: false,
      mimicStreamingForClient: false,
      includeUsageInStreaming: false,
      includeObfuscationInStreaming: false,
    };
  }

  const streamRequested = parsed.stream === true;
  const includeUsageInStreaming = readIncludeUsageFromStreamOptions(parsed);
  const includeObfuscationInStreaming =
    readIncludeObfuscationFromStreamOptions(parsed);
  const mimicStreamingForClient =
    isChatCompletionsRequest &&
    provider.mimicStreaming &&
    !provider.disableStreaming &&
    streamRequested;

  const currentModel =
    typeof parsed.model === "string" ? parsed.model : undefined;
  let resolvedModel = currentModel?.trim() || provider.defaultModel;
  if (resolvedModel) {
    const aliasTarget = provider.modelAliasLookup[resolvedModel.toLowerCase()];
    if (aliasTarget) {
      resolvedModel = aliasTarget;
    }
  }

  let updated = false;
  if (resolvedModel && parsed.model !== resolvedModel) {
    parsed.model = resolvedModel;
    updated = true;
  }

  const disableStreaming =
    provider.disableStreaming && isChatCompletionsRequest;
  if (disableStreaming) {
    if (parsed.stream !== false) {
      parsed.stream = false;
      updated = true;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "stream_options")) {
      delete parsed.stream_options;
      updated = true;
    }
  }

  if (mimicStreamingForClient) {
    if (parsed.stream !== false) {
      parsed.stream = false;
      updated = true;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "stream_options")) {
      delete parsed.stream_options;
      updated = true;
    }
  }

  for (const propertyName of provider.stripRequestProperties) {
    if (!propertyName) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, propertyName)) {
      delete parsed[propertyName];
      updated = true;
    }
  }

  if (!updated) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: rawText,
      resolvedModel: resolvedModel || undefined,
      bodyWasMutated: false,
      mimicStreamingForClient,
      includeUsageInStreaming,
      includeObfuscationInStreaming,
    };
  }

  const updatedPayload = JSON.stringify(parsed);
  const encoder = new TextEncoder();

  return {
    forwardBody: encoder.encode(updatedPayload),
    payloadForTokenCount: updatedPayload,
    resolvedModel: resolvedModel || undefined,
    bodyWasMutated: true,
    mimicStreamingForClient,
    includeUsageInStreaming,
    includeObfuscationInStreaming,
  };
}

function isChatCompletionsPath(pathname: string): boolean {
  return pathname.toLowerCase().endsWith("/chat/completions");
}

function readIncludeUsageFromStreamOptions(
  payload: Record<string, unknown>,
): boolean {
  const streamOptions = payload.stream_options;
  if (
    typeof streamOptions !== "object" ||
    streamOptions === null ||
    Array.isArray(streamOptions)
  ) {
    return false;
  }

  return (streamOptions as Record<string, unknown>).include_usage === true;
}

function readIncludeObfuscationFromStreamOptions(
  payload: Record<string, unknown>,
): boolean {
  const streamOptions = payload.stream_options;
  if (
    typeof streamOptions !== "object" ||
    streamOptions === null ||
    Array.isArray(streamOptions)
  ) {
    return true;
  }

  return (streamOptions as Record<string, unknown>).include_obfuscation !== false;
}

function safeParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildUpstreamUrl(
  destinationPrefix: string,
  incomingPathname: string,
  routePrefix: string,
  search: string,
): string {
  const destination = new URL(destinationPrefix);
  const pathWithoutPrefix = removePrefix(incomingPathname, routePrefix);
  destination.pathname = joinPath(destination.pathname, pathWithoutPrefix);
  destination.search = search;
  return destination.toString();
}

function removePrefix(pathname: string, prefix: string): string {
  if (!pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
    return pathname;
  }

  const trimmed = pathname.slice(prefix.length);
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinPath(basePath: string, suffixPath: string): string {
  if (!suffixPath || suffixPath === "/") {
    return normalizePath(basePath);
  }

  const normalizedBase = normalizePath(basePath).replace(/\/+$/g, "");
  const normalizedSuffix = suffixPath.startsWith("/")
    ? suffixPath
    : `/${suffixPath}`;

  return `${normalizedBase}${normalizedSuffix}`.replace(/\/{2,}/g, "/");
}

function buildModelList(provider: ProviderConfig): string[] {
  const items: string[] = [];
  const seen = new Set<string>();

  for (const [modelName, modelConfig] of Object.entries(provider.models)) {
    const trimmedName = modelName.trim();
    if (trimmedName && !seen.has(trimmedName)) {
      items.push(trimmedName);
      seen.add(trimmedName);
    }

    const alias = modelConfig.modelAlias?.trim();
    if (alias && !seen.has(alias)) {
      items.push(alias);
      seen.add(alias);
    }
  }

  return items;
}

function normalizePath(value: string): string {
  if (!value) {
    return "/";
  }

  return value.startsWith("/") ? value : `/${value}`;
}

function shouldIncludeBody(method: string, body: Uint8Array): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return false;
  }
  return body.byteLength > 0;
}

function setTokenLimitHeaders(
  headers: Headers,
  snapshot: TokenLimitSnapshot | null,
): void {
  if (!snapshot) {
    return;
  }

  headers.set("x-token-limit-per-minute-used", snapshot.used.toString());
  headers.set(
    "x-token-limit-per-minute-available",
    snapshot.available.toString(),
  );
}

function withTokenLimitHeaders(
  response: Response,
  snapshot: TokenLimitSnapshot | null,
): Response {
  if (!snapshot) {
    return response;
  }

  const headers = new Headers(response.headers);
  setTokenLimitHeaders(headers, snapshot);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getDebugFlag(): boolean {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      debug: {
        type: "boolean",
        short: "d",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return Boolean(values.debug);
}
