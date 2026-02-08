import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { ConfigStore } from "./config-store";
import { DebugLogger } from "./debug-logger";
import { TokenCounter } from "./token-counter";
import { TokenRateLimiter } from "./token-rate-limiter";
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
}

const configStore = await ConfigStore.create(process.cwd());
const tokenCounter = new TokenCounter();
const tokenRateLimiter = new TokenRateLimiter();
const tokenService = new TokenService(
  () => configStore.getConfig().proxy.tokenEndpoint,
);
const debugLogger = new DebugLogger(
  () => configStore.getConfig().proxy.debugPath,
);

const app = new Hono();

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

  if (
    providerMatch.provider.tokenLimitPerMinute > 0 &&
    preparedBody.payloadForTokenCount
  ) {
    const tokens = tokenCounter.countTokens(preparedBody.payloadForTokenCount);
    await tokenRateLimiter.waitForTokens(
      providerMatch.name,
      providerMatch.provider.tokenLimitPerMinute,
      tokens,
      request.signal,
    );
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

    if (!debugLogger.isEnabled()) {
      return response;
    }

    const responseBody = new Uint8Array(await response.clone().arrayBuffer());
    await debugLogger.logResponse({
      status: response.status,
      statusText: response.statusText,
      uri: upstreamUrl,
      headers: response.headers,
      body: responseBody,
    });

    return response;
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
  fetch: app.fetch,
  hostname: bootConfig.host,
  port: bootConfig.port,
});

console.info(
  `Proxy listening on http://${server.hostname}:${server.port} (${bootConfig.environmentName})`,
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

  if (rawBody.byteLength === 0) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: undefined,
      resolvedModel: defaultModel,
      bodyWasMutated: false,
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return {
      forwardBody: rawBody,
      payloadForTokenCount: undefined,
      resolvedModel: defaultModel,
      bodyWasMutated: false,
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
    };
  }

  const currentModel =
    typeof parsed.model === "string" ? parsed.model : undefined;
  let resolvedModel = currentModel?.trim() || provider.defaultModel;
  if (resolvedModel) {
    const aliasTarget = provider.modelAliases[resolvedModel.toLowerCase()];
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
    provider.disableStreaming &&
    pathname.toLowerCase().endsWith("/chat/completions");
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
    };
  }

  const updatedPayload = JSON.stringify(parsed);
  const encoder = new TextEncoder();

  return {
    forwardBody: encoder.encode(updatedPayload),
    payloadForTokenCount: updatedPayload,
    resolvedModel: resolvedModel || undefined,
    bodyWasMutated: true,
  };
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
