import { describe, expect, test } from "bun:test";
import {
  buildSyntheticAnthropicMessageEvents,
  maybeMimicAnthropicMessagesStreaming,
} from "./anthropic-messages-streaming";

describe("buildSyntheticAnthropicMessageEvents", () => {
  test("emits Anthropic Messages-format text events", () => {
    const events = buildSyntheticAnthropicMessageEvents({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text: "Hello",
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 5,
      },
    });

    expect(events).not.toBeNull();
    expect(events).toHaveLength(6);
    if (!events) {
      throw new Error("Expected synthetic Anthropic message events.");
    }

    expect(events[0]).toEqual({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 0,
          },
        },
      },
    });

    expect(events[1]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });

    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      },
    });

    expect(events[3]).toEqual({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 0,
      },
    });

    expect(events[4]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 5,
        },
      },
    });

    expect(events[5]).toEqual({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  });

  test("emits tool_use input deltas and message_stop", () => {
    const events = buildSyntheticAnthropicMessageEvents({
      id: "msg_456",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {
            location: "London",
          },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
    });

    expect(events).not.toBeNull();
    if (!events) {
      throw new Error("Expected synthetic Anthropic message events.");
    }

    expect(events[1]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {},
        },
      },
    });

    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "",
        },
      },
    });

    expect(events[3]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "{\"location\":\"London\"}",
        },
      },
    });

    expect(events[4]).toEqual({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 0,
      },
    });

    expect(events[5]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null,
        },
      },
    });

    expect(events[6]).toEqual({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  });
});

describe("maybeMimicAnthropicMessagesStreaming", () => {
  test("returns SSE with Anthropic event names", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: "Hello",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": "123",
          "content-encoding": "gzip",
        },
      },
    );

    const streamed = await maybeMimicAnthropicMessagesStreaming(response, true);

    expect(streamed.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(streamed.headers.get("cache-control")).toBe("no-cache");
    expect(streamed.headers.get("connection")).toBe("keep-alive");
    expect(streamed.headers.has("content-length")).toBe(false);
    expect(streamed.headers.has("content-encoding")).toBe(false);

    const body = await streamed.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_stop");
    expect(body).not.toContain("[DONE]");
  });
});
