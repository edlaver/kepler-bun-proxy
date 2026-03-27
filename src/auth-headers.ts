import type { ProviderApiFormat } from "./types";

export function resolveTokenConversionAuthorizationHeader(
  headers: Headers,
  sourceHeaderNames: string[],
): string | null {
  for (const sourceHeaderName of sourceHeaderNames) {
    const normalizedHeaderName = sourceHeaderName.trim().toLowerCase();
    if (!normalizedHeaderName) {
      continue;
    }

    const sourceValue = normalizeHeaderValue(headers.get(normalizedHeaderName));
    if (!sourceValue) {
      continue;
    }

    return normalizedHeaderName === "authorization"
      ? sourceValue
      : toBearerAuthorization(sourceValue);
  }

  return null;
}

export function normalizeUpstreamHeadersForProvider(
  headers: Headers,
  apiFormat: ProviderApiFormat,
): Headers {
  const normalized = new Headers(headers);

  if (apiFormat !== "anthropic") {
    return normalized;
  }

  const authorization = resolveAnthropicUpstreamAuthorizationHeader(normalized);
  normalized.delete("x-api-key");

  if (authorization) {
    normalized.set("authorization", authorization);
  } else {
    normalized.delete("authorization");
  }

  return normalized;
}

function normalizeHeaderValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveAnthropicUpstreamAuthorizationHeader(
  headers: Headers,
): string | null {
  const authorization = normalizeHeaderValue(headers.get("authorization"));
  if (authorization) {
    return authorization;
  }

  const apiKey = normalizeHeaderValue(headers.get("x-api-key"));
  if (!apiKey) {
    return null;
  }

  return toBearerAuthorization(apiKey);
}

function toBearerAuthorization(value: string): string {
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}
