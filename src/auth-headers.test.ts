import { describe, expect, test } from "bun:test";
import {
  normalizeUpstreamHeadersForProvider,
  resolveTokenConversionAuthorizationHeader,
} from "./auth-headers";

describe("resolveTokenConversionAuthorizationHeader", () => {
  test("uses Authorization as-is when configured", () => {
    const headers = new Headers({
      authorization: "Bearer converted-token",
      "x-api-key": "source-token",
    });

    expect(
      resolveTokenConversionAuthorizationHeader(headers, ["authorization"]),
    ).toBe("Bearer converted-token");
  });

  test("supports nonstandard auth headers and x-api-key in priority order", () => {
    const headers = new Headers({
      authentication: "raw-authentication-token",
      "x-api-key": "source-token",
    });

    expect(
      resolveTokenConversionAuthorizationHeader(headers, [
        "authentication",
        "x-api-key",
      ]),
    ).toBe("Bearer raw-authentication-token");
  });

  test("falls back to x-api-key when earlier configured headers are absent", () => {
    const headers = new Headers({
      "x-api-key": "source-token",
    });

    expect(
      resolveTokenConversionAuthorizationHeader(headers, [
        "authentication",
        "x-api-key",
      ]),
    ).toBe("Bearer source-token");
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
