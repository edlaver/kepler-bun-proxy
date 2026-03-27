import type { ProviderApiFormat } from "./types";

export function resolveSourceAuthorizationHeader(
  headers: Headers,
  apiFormat: ProviderApiFormat,
): string | null {
  const authorization = normalizeHeaderValue(headers.get("authorization"));
  if (authorization) {
    return authorization;
  }

  if (apiFormat !== "anthropic") {
    return null;
  }

  const apiKey = normalizeHeaderValue(headers.get("x-api-key"));
  if (!apiKey) {
    return null;
  }

  return toBearerAuthorization(apiKey);
}

export function normalizeUpstreamHeadersForProvider(
  headers: Headers,
  apiFormat: ProviderApiFormat,
): Headers {
  const normalized = new Headers(headers);

  if (apiFormat !== "anthropic") {
    return normalized;
  }

  const authorization = resolveSourceAuthorizationHeader(normalized, apiFormat);
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

function toBearerAuthorization(value: string): string {
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}
