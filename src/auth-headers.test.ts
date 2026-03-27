import { describe, expect, test } from "bun:test";
import {
  normalizeUpstreamHeadersForProvider,
  resolveSourceAuthorizationHeader,
} from "./auth-headers";

describe("resolveSourceAuthorizationHeader", () => {
  test("uses Authorization as-is when present", () => {
    const headers = new Headers({
      authorization: "Bearer converted-token",
      "x-api-key": "source-token",
    });

    expect(resolveSourceAuthorizationHeader(headers, "anthropic")).toBe(
      "Bearer converted-token",
    );
  });

  test("maps Anthropic x-api-key to Bearer authorization", () => {
    const headers = new Headers({
      "x-api-key": "source-token",
    });

    expect(resolveSourceAuthorizationHeader(headers, "anthropic")).toBe(
      "Bearer source-token",
    );
  });

  test("ignores x-api-key for OpenAI providers", () => {
    const headers = new Headers({
      "x-api-key": "source-token",
    });

    expect(resolveSourceAuthorizationHeader(headers, "openai")).toBeNull();
  });
});

describe("normalizeUpstreamHeadersForProvider", () => {
  test("rewrites Anthropic x-api-key auth to Authorization and strips x-api-key", () => {
    const headers = normalizeUpstreamHeadersForProvider(
      new Headers({
        "x-api-key": "source-token",
        "anthropic-version": "2023-06-01",
      }),
      "anthropic",
    );

    expect(headers.get("authorization")).toBe("Bearer source-token");
    expect(headers.has("x-api-key")).toBeFalse();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  test("keeps existing Authorization for Anthropic and still strips x-api-key", () => {
    const headers = normalizeUpstreamHeadersForProvider(
      new Headers({
        authorization: "Bearer source-token",
        "x-api-key": "should-not-forward",
      }),
      "anthropic",
    );

    expect(headers.get("authorization")).toBe("Bearer source-token");
    expect(headers.has("x-api-key")).toBeFalse();
  });
});
