export async function maybeMimicChatCompletionsStreaming(
  response: Response,
  enabled: boolean,
  includeUsageInStreaming: boolean,
): Promise<Response> {
  if (!enabled || !response.ok) {
    return response;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  const parsed = safeParseJsonObject(await response.clone().text());
  if (!parsed) {
    return response;
  }

  const sseEvents = buildSyntheticChatCompletionEvents(
    parsed,
    includeUsageInStreaming,
  );
  if (!sseEvents) {
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
    start(controller) {
      for (const event of sseEvents) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function buildSyntheticChatCompletionEvents(
  completion: Record<string, unknown>,
  includeUsageInStreaming: boolean,
): string[] | null {
  const rawChoices = completion.choices;
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
    return null;
  }

  const id =
    typeof completion.id === "string" && completion.id.trim().length > 0
      ? completion.id
      : `chatcmpl-mimic-${Date.now()}`;
  const created =
    typeof completion.created === "number" &&
    Number.isFinite(completion.created)
      ? completion.created
      : Math.floor(Date.now() / 1000);
  const model = typeof completion.model === "string" ? completion.model : "";
  const systemFingerprint =
    typeof completion.system_fingerprint === "string"
      ? completion.system_fingerprint
      : undefined;
  const serviceTier =
    typeof completion.service_tier === "string"
      ? completion.service_tier
      : undefined;

  const chunks: string[] = [];

  const buildChunk = (
    choices: Record<string, unknown>[],
    usage: Record<string, unknown> | null,
  ): Record<string, unknown> => {
    const chunk: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices,
    };

    if (serviceTier) {
      chunk.service_tier = serviceTier;
    }

    if (systemFingerprint) {
      chunk.system_fingerprint = systemFingerprint;
    }

    if (includeUsageInStreaming) {
      chunk.usage = usage;
    }

    return chunk;
  };

  const emitChunk = (
    index: number,
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): void => {
    chunks.push(
      JSON.stringify(
        buildChunk(
          [
            {
              index,
              delta,
              logprobs: null,
              finish_reason: finishReason,
            },
          ],
          null,
        ),
      ),
    );
  };

  rawChoices.forEach((rawChoice, fallbackIndex) => {
    if (typeof rawChoice !== "object" || rawChoice === null) {
      return;
    }

    const choice = rawChoice as Record<string, unknown>;
    const index =
      typeof choice.index === "number" && Number.isFinite(choice.index)
        ? choice.index
        : fallbackIndex;
    const finishReason =
      typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";

    const message =
      typeof choice.message === "object" &&
      choice.message !== null &&
      !Array.isArray(choice.message)
        ? (choice.message as Record<string, unknown>)
        : {};

    const role =
      typeof message.role === "string" && message.role.trim().length > 0
        ? message.role
        : "assistant";
    const normalizedContent = normalizeDeltaContent(message.content);
    const payloadDelta: Record<string, unknown> = { role };

    if (normalizedContent !== undefined && normalizedContent.length > 0) {
      payloadDelta.content = normalizedContent;
    }

    if (typeof message.refusal === "string" && message.refusal.length > 0) {
      payloadDelta.refusal = message.refusal;
    }

    if (message.tool_calls !== undefined) {
      const toolCalls = normalizeToolCallsDelta(message.tool_calls);
      if (toolCalls.length > 0) {
        payloadDelta.tool_calls = toolCalls;
      }
    }

    if (
      typeof message.function_call === "object" &&
      message.function_call !== null
    ) {
      const functionCall = normalizeFunctionCallDelta(message.function_call);
      if (Object.keys(functionCall).length > 0) {
        payloadDelta.function_call = functionCall;
      }
    }

    if (Object.keys(payloadDelta).length > 0) {
      emitChunk(index, payloadDelta, null);
    }

    emitChunk(index, {}, finishReason);
  });

  if (
    includeUsageInStreaming &&
    typeof completion.usage === "object" &&
    completion.usage !== null &&
    !Array.isArray(completion.usage)
  ) {
    chunks.push(
      JSON.stringify(buildChunk([], completion.usage as Record<string, unknown>)),
    );
  }

  return chunks;
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

function normalizeToolCallsDelta(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, fallbackIndex) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }

    const toolCall = entry as Record<string, unknown>;
    const normalized: Record<string, unknown> = {
      index:
        typeof toolCall.index === "number" && Number.isFinite(toolCall.index)
          ? toolCall.index
          : fallbackIndex,
    };

    if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
      normalized.id = toolCall.id;
    }

    if (typeof toolCall.type === "string" && toolCall.type.length > 0) {
      normalized.type = toolCall.type;
    }

    if (
      typeof toolCall.function === "object" &&
      toolCall.function !== null &&
      !Array.isArray(toolCall.function)
    ) {
      const fn = normalizeFunctionCallDelta(toolCall.function);
      if (Object.keys(fn).length > 0) {
        normalized.function = fn;
      }
    }

    return [normalized];
  });
}

function normalizeFunctionCallDelta(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const functionCall = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  if (
    typeof functionCall.name === "string" &&
    functionCall.name.length > 0
  ) {
    normalized.name = functionCall.name;
  }

  if (typeof functionCall.arguments === "string") {
    normalized.arguments = functionCall.arguments;
  }

  return normalized;
}

function normalizeDeltaContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts = value.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }

    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      return [];
    }

    const record = part as Record<string, unknown>;

    if (typeof record.text === "string") {
      return [record.text];
    }

    return [];
  });

  return textParts.length > 0 ? textParts.join("") : undefined;
}
