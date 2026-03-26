interface SyntheticResponseEvent {
  event: string;
  data: Record<string, unknown>;
}

type NormalizedContentPart = Record<string, unknown> & {
  type: string;
  text?: string;
};

type NormalizedOutputItem = Record<string, unknown> & {
  id: string;
  type: string;
  status?: string;
  arguments?: string;
};

interface NormalizedOutputEntry {
  item: NormalizedOutputItem;
  parts: NormalizedContentPart[];
}

export async function maybeMimicResponsesStreaming(
  response: Response,
  enabled: boolean,
  includeObfuscationInStreaming: boolean,
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

        const sseEvents = buildSyntheticResponseEvents(
          parsed,
          includeObfuscationInStreaming,
        );
        if (!sseEvents) {
          throw new Error("Upstream response did not match responses shape.");
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

export function buildSyntheticResponseEvents(
  responsePayload: Record<string, unknown>,
  includeObfuscationInStreaming: boolean,
): SyntheticResponseEvent[] | null {
  const rawOutput = responsePayload.output;
  if (!Array.isArray(rawOutput)) {
    return null;
  }

  const responseId =
    typeof responsePayload.id === "string" && responsePayload.id.trim().length > 0
      ? responsePayload.id
      : `resp_mimic_${Date.now()}`;
  const createdAt =
    typeof responsePayload.created_at === "number" &&
    Number.isFinite(responsePayload.created_at)
      ? responsePayload.created_at
      : Math.floor(Date.now() / 1000);
  const object =
    typeof responsePayload.object === "string" && responsePayload.object.length > 0
      ? responsePayload.object
      : "response";

  const normalizedOutput = rawOutput
    .map((item, outputIndex) => normalizeOutputItem(item, outputIndex))
    .filter((entry): entry is NormalizedOutputEntry => entry !== null)
    .map((entry) => entry.item);

  const completedResponse: Record<string, unknown> = {
    ...responsePayload,
    id: responseId,
    object,
    created_at: createdAt,
    output: normalizedOutput,
  };

  const inProgressResponse = omitUndefinedProperties({
    ...completedResponse,
    status: "in_progress",
    output: [],
    usage: null,
    completed_at: undefined,
  });

  const events: SyntheticResponseEvent[] = [
    createEnvelopeEvent("response.created", {
      response: inProgressResponse,
    }),
    createEnvelopeEvent("response.in_progress", {
      response: inProgressResponse,
    }),
  ];

  rawOutput.forEach((item, outputIndex) => {
    const normalized = normalizeOutputItem(item, outputIndex);
    if (!normalized) {
      return;
    }

    const { item: normalizedItem, parts } = normalized;

    if (normalizedItem.type === "message") {
      events.push(
        createEnvelopeEvent("response.output_item.added", {
          response_id: responseId,
          output_index: outputIndex,
          item: {
            ...normalizedItem,
            status: "in_progress",
            content: [],
          },
        }),
      );

      parts.forEach((part, contentIndex) => {
        events.push(
          createEnvelopeEvent("response.content_part.added", {
            response_id: responseId,
            item_id: normalizedItem.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part: buildAddedContentPart(part),
          }),
        );

        if (part.type === "output_text") {
          const text = part.text ?? "";
          const deltaEvent = buildOutputTextDeltaEvent(
            responseId,
            normalizedItem.id,
            outputIndex,
            contentIndex,
            text,
            includeObfuscationInStreaming,
          );
          if (deltaEvent) {
            events.push(deltaEvent);
          }

          events.push(
            createEnvelopeEvent("response.output_text.done", {
              response_id: responseId,
              item_id: normalizedItem.id,
              output_index: outputIndex,
              content_index: contentIndex,
              text,
            }),
          );
        }

        events.push(
          createEnvelopeEvent("response.content_part.done", {
            response_id: responseId,
            item_id: normalizedItem.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part,
          }),
        );
      });

      events.push(
        createEnvelopeEvent("response.output_item.done", {
          response_id: responseId,
          output_index: outputIndex,
          item: normalizedItem,
        }),
      );
      return;
    }

    if (normalizedItem.type === "function_call") {
      const argumentsText = normalizedItem.arguments ?? "";
      events.push(
        createEnvelopeEvent("response.output_item.added", {
          response_id: responseId,
          output_index: outputIndex,
          item: {
            ...normalizedItem,
            status: "in_progress",
            arguments: "",
          },
        }),
      );

      if (argumentsText.length > 0) {
        events.push(
          createEnvelopeEvent("response.function_call_arguments.delta", {
            response_id: responseId,
            item_id: normalizedItem.id,
            output_index: outputIndex,
            delta: argumentsText,
            ...(includeObfuscationInStreaming
              ? { obfuscation: createObfuscation() }
              : {}),
          }),
        );
      }

      events.push(
        createEnvelopeEvent("response.function_call_arguments.done", {
          response_id: responseId,
          item_id: normalizedItem.id,
          output_index: outputIndex,
          arguments: argumentsText,
        }),
      );
    } else {
      events.push(
        createEnvelopeEvent("response.output_item.added", {
          response_id: responseId,
          output_index: outputIndex,
          item: {
            ...normalizedItem,
            status:
              typeof normalizedItem.status === "string"
                ? "in_progress"
                : normalizedItem.status,
          },
        }),
      );
    }

    events.push(
      createEnvelopeEvent("response.output_item.done", {
        response_id: responseId,
        output_index: outputIndex,
        item: normalizedItem,
      }),
    );
  });

  const terminalStatus =
    typeof completedResponse.status === "string" && completedResponse.status.length > 0
      ? completedResponse.status
      : "completed";
  const terminalEvent =
    terminalStatus === "completed"
      ? "response.completed"
      : `response.${terminalStatus}`;

  events.push(
    createEnvelopeEvent(terminalEvent, {
      response: completedResponse,
    }),
  );

  return events;
}

function createEnvelopeEvent(
  event: string,
  payload: Record<string, unknown>,
): SyntheticResponseEvent {
  return {
    event,
    data: {
      type: event,
      event_id: createEventId(),
      ...payload,
    },
  };
}

function buildOutputTextDeltaEvent(
  responseId: string,
  itemId: string,
  outputIndex: number,
  contentIndex: number,
  text: string,
  includeObfuscationInStreaming: boolean,
): SyntheticResponseEvent | null {
  if (text.length === 0) {
    return null;
  }

  return createEnvelopeEvent("response.output_text.delta", {
    response_id: responseId,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    delta: text,
    ...(includeObfuscationInStreaming
      ? { obfuscation: createObfuscation() }
      : {}),
  });
}

function normalizeOutputItem(
  value: unknown,
  outputIndex: number,
): NormalizedOutputEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const type =
    typeof item.type === "string" && item.type.length > 0 ? item.type : "message";

  if (type === "message") {
    const normalizedId = normalizeId(item.id, `msg_mimic_${outputIndex}`);
    const role =
      typeof item.role === "string" && item.role.length > 0 ? item.role : "assistant";
    const parts = normalizeMessageContent(item.content);

    return {
      item: {
        ...omitUndefinedProperties({
          ...item,
          role,
          status:
            typeof item.status === "string" && item.status.length > 0
              ? item.status
              : "completed",
          content: parts,
        }),
        id: normalizedId,
        type: "message",
      },
      parts,
    };
  }

  if (type === "function_call") {
    const normalizedId = normalizeId(item.id, `fc_mimic_${outputIndex}`);
    const argumentsValue =
      typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});

    return {
      item: {
        ...omitUndefinedProperties({
          ...item,
          call_id: normalizeId(item.call_id, `call_mimic_${outputIndex}`),
          name: typeof item.name === "string" ? item.name : "",
          arguments: argumentsValue,
          status:
            typeof item.status === "string" && item.status.length > 0
              ? item.status
              : "completed",
        }),
        id: normalizedId,
        type: "function_call",
        arguments: argumentsValue,
      },
      parts: [],
    };
  }

  return {
    item: {
      ...omitUndefinedProperties({
        ...item,
        status:
          typeof item.status === "string" && item.status.length > 0
            ? item.status
            : "completed",
      }),
      id: normalizeId(item.id, `${type}_mimic_${outputIndex}`),
      type,
    },
    parts: [],
  };
}

function normalizeMessageContent(value: unknown): NormalizedContentPart[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      return [
        {
          type: "output_text",
          text: value,
          annotations: [],
        },
      ];
    }

    return [];
  }

  return value.flatMap((part) => {
    if (typeof part === "string") {
      return [
        {
          type: "output_text",
          text: part,
          annotations: [],
        },
      ];
    }

    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      return [];
    }

    const record = part as Record<string, unknown>;
    const type =
      typeof record.type === "string" && record.type.length > 0
        ? record.type
        : "output_text";

    if (type === "output_text") {
      const normalizedPart: NormalizedContentPart = {
        ...omitUndefinedProperties({
          ...record,
          text: typeof record.text === "string" ? record.text : "",
          annotations: Array.isArray(record.annotations) ? record.annotations : [],
        }),
        type: "output_text",
      };

      return [
        normalizedPart,
      ];
    }

    return [{ ...omitUndefinedProperties(record), type }];
  });
}

function buildAddedContentPart(part: NormalizedContentPart): NormalizedContentPart {
  if (part.type !== "output_text") {
    return part;
  }

  return {
    ...part,
    text: "",
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

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function omitUndefinedProperties(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries);
}

function createEventId(): string {
  return `event_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createObfuscation(): string {
  return Math.random().toString(36).slice(2, 18);
}
