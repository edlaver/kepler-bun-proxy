interface SyntheticAnthropicMessageEvent {
  event: string;
  data: Record<string, unknown>;
}

type AnthropicContentBlock = Record<string, unknown> & {
  type: string;
};

export async function maybeMimicAnthropicMessagesStreaming(
  response: Response,
  enabled: boolean,
): Promise<Response> {
  if (!enabled || !response.ok) {
    return response;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.delete("content-length");
  headers.delete("content-encoding");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const parsed = safeParseJsonObject(await response.text());
        if (!parsed) {
          throw new Error("Upstream response was not a JSON object.");
        }

        const sseEvents = buildSyntheticAnthropicMessageEvents(parsed);
        if (!sseEvents) {
          throw new Error("Upstream response did not match Anthropic message shape.");
        }

        for (const event of sseEvents) {
          controller.enqueue(
            encoder.encode(
              `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ),
          );
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function buildSyntheticAnthropicMessageEvents(
  messagePayload: Record<string, unknown>,
): SyntheticAnthropicMessageEvent[] | null {
  const rawContent = messagePayload.content;
  if (!Array.isArray(rawContent)) {
    return null;
  }

  const messageId = normalizeId(messagePayload.id, `msg_mimic_${Date.now()}`);
  const role =
    typeof messagePayload.role === "string" && messagePayload.role.length > 0
      ? messagePayload.role
      : "assistant";
  const type =
    typeof messagePayload.type === "string" && messagePayload.type.length > 0
      ? messagePayload.type
      : "message";
  const normalizedContent = rawContent
    .map((entry) => normalizeContentBlock(entry))
    .filter((entry): entry is AnthropicContentBlock => entry !== null);

  const message = omitUndefinedProperties({
    ...messagePayload,
    id: messageId,
    type,
    role,
    content: normalizedContent,
  });
  const usage =
    typeof message.usage === "object" &&
    message.usage !== null &&
    !Array.isArray(message.usage)
      ? (message.usage as Record<string, unknown>)
      : undefined;
  const events: SyntheticAnthropicMessageEvent[] = [
    createEvent("message_start", {
      message: omitUndefinedProperties({
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: buildMessageStartUsage(usage),
      }),
    }),
  ];

  normalizedContent.forEach((block, index) => {
    events.push(...buildContentBlockEvents(block, index));
  });

  events.push(
    createEvent("message_delta", omitUndefinedProperties({
      delta: {
        stop_reason:
          typeof message.stop_reason === "string" ? message.stop_reason : null,
        stop_sequence:
          typeof message.stop_sequence === "string" ? message.stop_sequence : null,
      },
      usage: buildMessageDeltaUsage(usage),
    })),
  );
  events.push(createEvent("message_stop", {}));

  return events;
}

function buildContentBlockEvents(
  block: AnthropicContentBlock,
  index: number,
): SyntheticAnthropicMessageEvent[] {
  if (block.type === "text") {
    const text = typeof block.text === "string" ? block.text : "";

    return [
      createEvent("content_block_start", {
        index,
        content_block: {
          type: "text",
          text: "",
        },
      }),
      ...(text.length > 0
        ? [
            createEvent("content_block_delta", {
              index,
              delta: {
                type: "text_delta",
                text,
              },
            }),
          ]
        : []),
      createEvent("content_block_stop", {
        index,
      }),
    ];
  }

  if (block.type === "thinking") {
    const thinking = typeof block.thinking === "string" ? block.thinking : "";
    const signature = typeof block.signature === "string" ? block.signature : "";

    return [
      createEvent("content_block_start", {
        index,
        content_block: {
          type: "thinking",
          thinking: "",
          signature: "",
        },
      }),
      ...(thinking.length > 0
        ? [
            createEvent("content_block_delta", {
              index,
              delta: {
                type: "thinking_delta",
                thinking,
              },
            }),
          ]
        : []),
      ...(signature.length > 0
        ? [
            createEvent("content_block_delta", {
              index,
              delta: {
                type: "signature_delta",
                signature,
              },
            }),
          ]
        : []),
      createEvent("content_block_stop", {
        index,
      }),
    ];
  }

  if (block.type === "tool_use" || block.type === "server_tool_use") {
    const input = "input" in block ? block.input : {};
    const serializedInput =
      input === undefined ? "" : safeJsonStringify(input) ?? "";

    return [
      createEvent("content_block_start", {
        index,
        content_block: {
          ...block,
          input: {},
        },
      }),
      createEvent("content_block_delta", {
        index,
        delta: {
          type: "input_json_delta",
          partial_json: "",
        },
      }),
      ...(serializedInput.length > 0
        ? [
            createEvent("content_block_delta", {
              index,
              delta: {
                type: "input_json_delta",
                partial_json: serializedInput,
              },
            }),
          ]
        : []),
      createEvent("content_block_stop", {
        index,
      }),
    ];
  }

  return [
    createEvent("content_block_start", {
      index,
      content_block: block,
    }),
    createEvent("content_block_stop", {
      index,
    }),
  ];
}

function buildMessageStartUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  const startUsage = { ...usage };
  if (
    typeof startUsage.output_tokens === "number" &&
    Number.isFinite(startUsage.output_tokens)
  ) {
    startUsage.output_tokens = 0;
  }

  return startUsage;
}

function buildMessageDeltaUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  const entries = Object.entries(usage).filter(([key]) =>
    key.toLowerCase().startsWith("output_"),
  );

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeContentBlock(value: unknown): AnthropicContentBlock | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const block = value as Record<string, unknown>;
  const type =
    typeof block.type === "string" && block.type.length > 0 ? block.type : "text";

  if (type === "text") {
    return {
      ...block,
      type: "text",
      text: typeof block.text === "string" ? block.text : "",
    };
  }

  if (type === "thinking") {
    return omitUndefinedProperties({
      ...block,
      type: "thinking",
      thinking: typeof block.thinking === "string" ? block.thinking : "",
      signature: typeof block.signature === "string" ? block.signature : undefined,
    }) as AnthropicContentBlock;
  }

  return {
    ...block,
    type,
  };
}

function createEvent(
  event: string,
  payload: Record<string, unknown>,
): SyntheticAnthropicMessageEvent {
  return {
    event,
    data: {
      type: event,
      ...payload,
    },
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

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function omitUndefinedProperties(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries);
}
