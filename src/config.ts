import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ProviderConfig,
  ProviderModelConfig,
  ProxyConfig,
} from "./types";

const DEFAULT_TOKEN_ENDPOINT =
  "https://nwgateway-appdev.kepler-prod.shared.banksvcs.net/token";

const providerModelSchema = z.object({
  modelAlias: z.string().optional().default(""),
});

const providerSchema = z.object({
  routePrefix: z.string().default(""),
  upstreamTemplate: z.string().default(""),
  defaultModel: z.string().default(""),
  models: z.record(providerModelSchema).default({}),
  disableStreaming: z.boolean().default(false),
  stripRequestProperties: z.array(z.string()).default([]),
  tokenLimitPerMinute: z.number().int().nonnegative().default(0),
});

const proxySchema = z.object({
  convertToken: z.boolean().default(false),
  tokenEndpoint: z.string().default(DEFAULT_TOKEN_ENDPOINT),
  rateLimitEnabled: z.boolean().default(false),
  debugPath: z.string().nullable().optional(),
  providers: z.record(providerSchema).default({}),
});

type JsonObject = Record<string, unknown>;

export async function loadConfig(rootDir: string): Promise<AppConfig> {
  const environmentName = getEnvironmentName();
  const appSettingsPath = path.join(rootDir, "config.json");
  const envSettingsPath = path.join(rootDir, `config.${environmentName}.json`);

  const baseConfig = await readJsonFile(appSettingsPath, true);
  const envConfig = await readJsonFile(envSettingsPath, false);
  const mergedConfig = deepMerge(baseConfig, envConfig);

  applyDoubleUnderscoreEnv(mergedConfig, process.env);

  const parsed = proxySchema.parse(mergedConfig);
  const proxy = mapProxyConfig(parsed);

  const portOverride = parsePort(process.env.PORT);
  const hostOverride = process.env.HOST?.trim();

  return {
    environmentName,
    host: hostOverride && hostOverride.length > 0 ? hostOverride : "localhost",
    port: portOverride ?? 4000,
    proxy,
  };
}

function mapProxyConfig(source: z.infer<typeof proxySchema>): ProxyConfig {
  const providers: Record<string, ProviderConfig> = {};

  for (const [providerName, provider] of Object.entries(source.providers)) {
    if (!provider.routePrefix.trim() || !provider.upstreamTemplate.trim()) {
      continue;
    }

    const models: Record<string, ProviderModelConfig> = {};
    const modelAliasLookup: Record<string, string> = {};
    for (const [modelNameRaw, modelConfig] of Object.entries(provider.models)) {
      const modelName = modelNameRaw.trim();
      if (!modelName) {
        continue;
      }

      const aliasRaw = modelConfig.modelAlias?.trim() ?? "";
      const alias = aliasRaw.length > 0 ? aliasRaw : undefined;

      models[modelName] = alias ? { modelAlias: alias } : {};

      if (alias) {
        const normalizedAlias = alias.toLowerCase();
        if (normalizedAlias && normalizedAlias !== modelName.toLowerCase()) {
          modelAliasLookup[normalizedAlias] = modelName;
        }
      }
    }

    providers[providerName] = {
      routePrefix: normalizeRoutePrefix(provider.routePrefix),
      upstreamTemplate: provider.upstreamTemplate.trim(),
      defaultModel: provider.defaultModel.trim(),
      models,
      modelAliasLookup,
      disableStreaming: provider.disableStreaming,
      stripRequestProperties: provider.stripRequestProperties
        .map((property) => property.trim())
        .filter((property) => property.length > 0),
      tokenLimitPerMinute: provider.tokenLimitPerMinute,
    };
  }

  const debugPath = source.debugPath?.trim();

  return {
    convertToken: source.convertToken,
    tokenEndpoint: source.tokenEndpoint.trim() || DEFAULT_TOKEN_ENDPOINT,
    rateLimitEnabled: source.rateLimitEnabled,
    debugPath: debugPath && debugPath.length > 0 ? debugPath : undefined,
    providers,
  };
}

function normalizeRoutePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "";
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }

  return withSlash;
}

function getEnvironmentName(): string {
  return (
    process.env.ASPNETCORE_ENVIRONMENT ??
    process.env.BUN_ENV ??
    process.env.NODE_ENV ??
    "Production"
  );
}

async function readJsonFile(
  filePath: string,
  required: boolean,
): Promise<JsonObject> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error(`JSON root must be an object: ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if (!required && isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];

    if (isJsonObject(baseValue) && isJsonObject(value)) {
      result[key] = deepMerge(baseValue, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function applyDoubleUnderscoreEnv(
  target: JsonObject,
  env: NodeJS.ProcessEnv,
): void {
  for (const [rawKey, rawValue] of Object.entries(env)) {
    if (!rawValue || !rawKey.includes("__")) {
      continue;
    }

    const pathSegments = rawKey.split("__").filter((segment) => segment.length);
    if (pathSegments.length === 0) {
      continue;
    }

    setByPathCaseInsensitive(target, pathSegments, parseEnvValue(rawValue));
  }
}

function setByPathCaseInsensitive(
  target: JsonObject,
  pathSegments: string[],
  value: unknown,
): void {
  let cursor: JsonObject = target;

  for (let i = 0; i < pathSegments.length - 1; i += 1) {
    const segment = pathSegments[i];
    if (!segment) {
      return;
    }

    const actualSegment = findExistingKey(cursor, segment) ?? segment;
    const existingValue = cursor[actualSegment];
    if (!isJsonObject(existingValue)) {
      cursor[actualSegment] = {};
    }

    cursor = cursor[actualSegment] as JsonObject;
  }

  const lastSegment = pathSegments[pathSegments.length - 1];
  if (!lastSegment) {
    return;
  }
  const actualLastSegment = findExistingKey(cursor, lastSegment) ?? lastSegment;
  cursor[actualLastSegment] = value;
}

function findExistingKey(
  target: JsonObject,
  lookup: string,
): string | undefined {
  const lookupLower = lookup.toLowerCase();
  return Object.keys(target).find((key) => key.toLowerCase() === lookupLower);
}

function parseEnvValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value.length === 0) {
    return "";
  }

  const normalized = value.toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }
  }

  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
