import { describe, expect, test } from "bun:test";
import { buildUpstreamUrl } from "./upstream-url";

describe("buildUpstreamUrl", () => {
  test("removes configured route segments from the end of the upstream URL", () => {
    const upstreamUrl = buildUpstreamUrl(
      "https://api.bedrock.com/anthropic-claude-sonnet-4-6/v1",
      "/anthropic/v1/messages",
      "/anthropic",
      "",
      ["/messages"],
    );

    expect(upstreamUrl).toBe(
      "https://api.bedrock.com/anthropic-claude-sonnet-4-6/v1",
    );
  });

  test("preserves query strings when stripping route segments", () => {
    const upstreamUrl = buildUpstreamUrl(
      "https://api.bedrock.com/anthropic-claude-sonnet-4-6/v1",
      "/anthropic/v1/messages",
      "/anthropic",
      "?beta=true",
      ["/messages"],
    );

    expect(upstreamUrl).toBe(
      "https://api.bedrock.com/anthropic-claude-sonnet-4-6/v1?beta=true",
    );
  });

  test("leaves the URL unchanged when no configured segment matches the end", () => {
    const upstreamUrl = buildUpstreamUrl(
      "https://api.openai.com",
      "/openai/v1/chat/completions",
      "/openai",
      "",
      ["/messages"],
    );

    expect(upstreamUrl).toBe("https://api.openai.com/v1/chat/completions");
  });
});
