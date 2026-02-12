import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

let sequence = 0;

interface RequestLogInput {
  method: string;
  uri: string;
  headers: Headers;
  body: Uint8Array | undefined;
}

interface ResponseLogInput {
  status: number;
  statusText: string;
  uri: string;
  headers: Headers;
  body: Uint8Array | undefined;
}

export class DebugLogger {
  private readonly getDebugPath: () => string | undefined;
  private readonly textDecoder = new TextDecoder();

  constructor(getDebugPath: () => string | undefined) {
    this.getDebugPath = getDebugPath;
  }

  isEnabled(): boolean {
    const debugPath = this.getDebugPath();
    return typeof debugPath === "string" && debugPath.trim().length > 0;
  }

  async logRequest(input: RequestLogInput): Promise<void> {
    const debugPath = this.getDebugPath();
    if (!debugPath?.trim()) {
      return;
    }

    const lines: string[] = [];
    lines.push(
      "# Request",
      "",
      `**Method**: ${input.method}`,
      `**Uri**: ${input.uri}`,
      "",
    );
    appendHeadersTable(lines, input.headers);

    if (input.body && input.body.length > 0) {
      lines.push("", "```json", this.prettyPrintPayload(input.body), "```");
    }

    await this.writeLogFile(debugPath, "request", lines);
  }

  async logResponse(input: ResponseLogInput): Promise<void> {
    const debugPath = this.getDebugPath();
    if (!debugPath?.trim()) {
      return;
    }

    const lines: string[] = [];
    lines.push(
      "# Response",
      "",
      `**Status**: ${input.status} ${input.statusText}`,
      `**Uri**: ${input.uri}`,
      "",
    );
    appendHeadersTable(lines, input.headers);

    if (input.body && input.body.length > 0) {
      lines.push("", "```json", this.prettyPrintPayload(input.body), "```");
    }

    await this.writeLogFile(debugPath, "response", lines);
  }

  private prettyPrintPayload(payload: Uint8Array): string {
    const rawText = this.textDecoder.decode(payload);
    const normalized = rawText.replace(/^\uFEFF/, "").trim();
    if (!normalized) {
      return rawText;
    }
    try {
      return JSON.stringify(JSON.parse(normalized), null, 2);
    } catch {
      return rawText;
    }
  }

  private async writeLogFile(
    debugPath: string,
    suffix: "request" | "response",
    lines: string[],
  ): Promise<void> {
    await mkdir(debugPath, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    sequence += 1;
    const fileName = `${timestamp}-${sequence.toString().padStart(4, "0")}-${suffix}.md`;
    const fullPath = path.join(debugPath, fileName);

    await writeFile(fullPath, lines.join("\n"), "utf8");
  }
}

function appendHeadersTable(lines: string[], headers: Headers): void {
  lines.push("| Header | Value |", "| --- | --- |");

  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    const displayValue =
      normalizedKey === "authorization" ? maskAuthorizationValue(value) : value;
    lines.push(`| ${key} | ${displayValue} |`);
  }
}

function maskAuthorizationValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    const singleToken = parts[0];
    return singleToken ? maskToken(singleToken) : value;
  }

  const [scheme, ...rest] = parts;
  const token = rest.join(" ");
  const maskedToken = maskToken(token);
  if (scheme && scheme.toLowerCase() === "bearer") {
    return `Bearer ${maskedToken}`;
  }

  return scheme ? `${scheme} ${maskedToken}` : maskedToken;
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return token;
  }

  if (trimmed.length <= 4) {
    return `${trimmed.slice(0, 1)}...${trimmed.slice(-1)}`;
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
}

function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const millis = date.getUTCMilliseconds().toString().padStart(3, "0");
  const nanos = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}${nanos}`;
}
