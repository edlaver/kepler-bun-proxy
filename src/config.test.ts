import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadConfig", () => {
  test("normalizes convertTokenFromHeader arrays and applies defaults", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "kepler-config-"));
    tempDirs.push(tempDir);

    await writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        providers: {
          openai: {
            routePrefix: "/openai",
            upstreamTemplate: "https://api.openai.com",
          },
          anthropic: {
            routePrefix: "/anthropic",
            upstreamTemplate: "https://api.bedrock.com/{model}/v1",
          },
          anthropicCustom: {
            convertTokenFromHeader: [" Authentication ", "x-api-key"],
            routePrefix: "/anthropic-custom",
            upstreamTemplate: "https://api.bedrock.com/{model}/v1",
          },
        },
      }),
    );

    const config = await loadConfig(tempDir);
    const openaiProvider = config.proxy.providers.openai;
    const anthropicProvider = config.proxy.providers.anthropic;
    const anthropicCustomProvider = config.proxy.providers.anthropicCustom;

    expect(openaiProvider).toBeDefined();
    expect(anthropicProvider).toBeDefined();
    expect(anthropicCustomProvider).toBeDefined();

    expect(openaiProvider?.convertTokenFromHeader).toEqual(["authorization"]);
    expect(anthropicProvider?.convertTokenFromHeader).toEqual([
      "authorization",
      "authentication",
      "x-api-key",
    ]);
    expect(anthropicCustomProvider?.convertTokenFromHeader).toEqual([
      "authentication",
      "x-api-key",
    ]);
  });
});
