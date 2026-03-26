import { describe, expect, test } from "bun:test";
import {
  buildSyntheticResponseEvents,
  maybeMimicResponsesStreaming,
} from "./responses-streaming";

describe("buildSyntheticResponseEvents", () => {
  test("emits OpenAI Responses-format text events", () => {
    const events = buildSyntheticResponseEvents(
      {
        id: "resp_123",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: "gpt-4.1",
        output: [
          {
            id: "msg_123",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Hello",
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        },
      },
      true,
    );

    expect(events).not.toBeNull();
    expect(events).toHaveLength(9);
    if (!events) {
      throw new Error("Expected synthetic response events.");
    }

    const [created, inProgress, outputAdded, contentAdded, delta, textDone, contentDone, outputDone, completed] =
      events;
    if (
      !created ||
      !inProgress ||
      !outputAdded ||
      !contentAdded ||
      !delta ||
      !textDone ||
      !contentDone ||
      !outputDone ||
      !completed
    ) {
      throw new Error("Expected all synthetic response events to be present.");
    }

    expect(created.event).toBe("response.created");
    expect(created.data).toMatchObject({
      type: "response.created",
      response: {
        id: "resp_123",
        object: "response",
        created_at: 1_700_000_000,
        status: "in_progress",
        output: [],
        usage: null,
      },
    });
    expect(created.data.event_id).toEqual(expect.any(String));

    expect(inProgress.event).toBe("response.in_progress");

    expect(outputAdded).toMatchObject({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        response_id: "resp_123",
        output_index: 0,
        item: {
          id: "msg_123",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      },
    });

    expect(contentAdded).toMatchObject({
      event: "response.content_part.added",
      data: {
        response_id: "resp_123",
        item_id: "msg_123",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "",
          annotations: [],
        },
      },
    });

    expect(delta).toMatchObject({
      event: "response.output_text.delta",
      data: {
        response_id: "resp_123",
        item_id: "msg_123",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      },
    });
    expect(delta.data.obfuscation).toEqual(expect.any(String));

    expect(textDone).toMatchObject({
      event: "response.output_text.done",
      data: {
        response_id: "resp_123",
        item_id: "msg_123",
        output_index: 0,
        content_index: 0,
        text: "Hello",
      },
    });

    expect(contentDone).toMatchObject({
      event: "response.content_part.done",
      data: {
        response_id: "resp_123",
        item_id: "msg_123",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "Hello",
          annotations: [],
        },
      },
    });

    expect(outputDone).toMatchObject({
      event: "response.output_item.done",
      data: {
        response_id: "resp_123",
        output_index: 0,
        item: {
          id: "msg_123",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Hello",
              annotations: [],
            },
          ],
        },
      },
    });

    expect(completed).toMatchObject({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_123",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          model: "gpt-4.1",
          output: [
            {
              id: "msg_123",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Hello",
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
          },
        },
      },
    });
  });

  test("emits function call argument events", () => {
    const events = buildSyntheticResponseEvents(
      {
        id: "resp_456",
        object: "response",
        created_at: 1_700_000_001,
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_123",
            call_id: "call_123",
            name: "read_file",
            arguments: '{"path":"notes.txt"}',
            status: "completed",
          },
        ],
      },
      false,
    );

    expect(events).not.toBeNull();
    expect(events).toHaveLength(7);
    if (!events) {
      throw new Error("Expected synthetic response events.");
    }

    const outputAdded = events[2];
    const delta = events[3];
    const argumentsDone = events[4];
    const outputDone = events[5];
    if (!outputAdded || !delta || !argumentsDone || !outputDone) {
      throw new Error("Expected function call events to be present.");
    }

    expect(outputAdded).toMatchObject({
      event: "response.output_item.added",
      data: {
        response_id: "resp_456",
        output_index: 0,
        item: {
          id: "fc_123",
          call_id: "call_123",
          type: "function_call",
          name: "read_file",
          arguments: "",
          status: "in_progress",
        },
      },
    });

    expect(delta).toMatchObject({
      event: "response.function_call_arguments.delta",
      data: {
        response_id: "resp_456",
        item_id: "fc_123",
        output_index: 0,
        delta: '{"path":"notes.txt"}',
      },
    });
    expect(delta.data.obfuscation).toBeUndefined();

    expect(argumentsDone).toMatchObject({
      event: "response.function_call_arguments.done",
      data: {
        response_id: "resp_456",
        item_id: "fc_123",
        output_index: 0,
        arguments: '{"path":"notes.txt"}',
      },
    });

    expect(outputDone).toMatchObject({
      event: "response.output_item.done",
      data: {
        response_id: "resp_456",
        output_index: 0,
        item: {
          id: "fc_123",
          call_id: "call_123",
          type: "function_call",
          name: "read_file",
          arguments: '{"path":"notes.txt"}',
          status: "completed",
        },
      },
    });
  });
});

describe("maybeMimicResponsesStreaming", () => {
  test("returns SSE with Responses event names", async () => {
    const response = new Response(
      JSON.stringify({
        id: "resp_123",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        output: [
          {
            id: "msg_123",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Hello",
                annotations: [],
              },
            ],
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

    const streamed = await maybeMimicResponsesStreaming(response, true, true);

    expect(streamed.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(streamed.headers.get("cache-control")).toBe("no-cache");
    expect(streamed.headers.get("connection")).toBe("keep-alive");
    expect(streamed.headers.has("content-length")).toBe(false);
    expect(streamed.headers.has("content-encoding")).toBe(false);

    const body = await streamed.text();
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.completed");
    expect(body).not.toContain("[DONE]");
  });
});
