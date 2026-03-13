import { describe, expect, test } from "bun:test";
import {
  buildSyntheticChatCompletionEvents,
  maybeMimicChatCompletionsStreaming,
} from "./chat-completions-streaming";

describe("buildSyntheticChatCompletionEvents", () => {
  test("emits OpenAI-style chunk fields and usage trailer", () => {
    const events = buildSyntheticChatCompletionEvents(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "gpt-4o-mini",
        system_fingerprint: "fp_abc",
        service_tier: "default",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
        },
      },
      true,
    );

    expect(events).not.toBeNull();
    expect(events).toHaveLength(4);

    const parsedEvents = events!.map((event) => JSON.parse(event));

    expect(parsedEvents[0]).toEqual({
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-4o-mini",
      service_tier: "default",
      system_fingerprint: "fp_abc",
      usage: null,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });

    expect(parsedEvents[1]).toEqual({
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-4o-mini",
      service_tier: "default",
      system_fingerprint: "fp_abc",
      usage: null,
      choices: [
        {
          index: 0,
          delta: {
            content: "Hello",
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });

    expect(parsedEvents[2]).toEqual({
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-4o-mini",
      service_tier: "default",
      system_fingerprint: "fp_abc",
      usage: null,
      choices: [
        {
          index: 0,
          delta: {},
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    });

    expect(parsedEvents[3]).toEqual({
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-4o-mini",
      service_tier: "default",
      system_fingerprint: "fp_abc",
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
      choices: [],
    });
  });

  test("normalizes tool call deltas with indexes", () => {
    const events = buildSyntheticChatCompletionEvents(
      {
        id: "chatcmpl-456",
        created: 1_700_000_001,
        model: "gpt-5.1-2025-11-13",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_X53UdzCsGJh9AmO5GFa5LbLD",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"filePath":"--filename---"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      false,
    );

    expect(events).not.toBeNull();
    expect(events).toHaveLength(3);

    const parsedEvents = events!.map((event) => JSON.parse(event));
    expect(parsedEvents[1]).toEqual({
      id: "chatcmpl-456",
      object: "chat.completion.chunk",
      created: 1_700_000_001,
      model: "gpt-5.1-2025-11-13",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_X53UdzCsGJh9AmO5GFa5LbLD",
                type: "function",
                function: {
                  name: "read",
                  arguments: '{"filePath":"--filename---"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
  });
});

describe("maybeMimicChatCompletionsStreaming", () => {
  test("returns SSE with [DONE] terminator", async () => {
    const response = new Response(
      JSON.stringify({
        id: "chatcmpl-123",
        created: 1_700_000_000,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": "123",
          "content-encoding": "gzip",
        },
      },
    );

    const streamed = await maybeMimicChatCompletionsStreaming(
      response,
      true,
      false,
    );

    expect(streamed.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(streamed.headers.get("cache-control")).toBe("no-cache");
    expect(streamed.headers.get("connection")).toBe("keep-alive");
    expect(streamed.headers.has("content-length")).toBe(false);
    expect(streamed.headers.has("content-encoding")).toBe(false);

    const body = await streamed.text();
    expect(body).toContain("data: ");
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
