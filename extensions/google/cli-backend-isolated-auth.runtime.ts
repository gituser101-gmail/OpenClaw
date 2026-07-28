import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const GEMINI_CLI_AMBIENT_AUTH_ENV = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
]);
const GEMINI_CLI_UNSAFE_AUTH_ENV = [
  "GOOGLE_GENAI_USE_GCA",
  "CLOUD_SHELL",
  "GEMINI_CLI_USE_COMPUTE_ADC",
] as const;
const GEMINI_CLI_TRUSTED_TRANSPORT_ENV = new Set([
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_API_KEY_AUTH_MECHANISM",
  "GOOGLE_GENAI_API_VERSION",
]);

export const GEMINI_CLI_ISOLATED_ENV_BARRIERS: Record<string, string> = {
  GOOGLE_GENAI_USE_GCA: "false",
  CLOUD_SHELL: "false",
  GEMINI_CLI_USE_COMPUTE_ADC: "false",
  GEMINI_TELEMETRY_LOG_PROMPTS: "false",
};

export type GeminiCliIsolatedAuthContext = {
  workspaceDir?: string;
  baseEnv?: Record<string, string>;
  systemSettingsPath?: string;
  isolatedCompletionPrompt?: string;
  isolatedCompletionSystemPrompt?: string;
};

type GeminiCliAmbientAuth = {
  selectedType?: string;
  envOverrides: Record<string, string>;
  safeSettings: Record<string, unknown>;
};

type GeminiCliAmbientEnv = {
  auth: Record<string, string>;
  transport: Record<string, string>;
  unsafeAuth: Record<string, string>;
  telemetryEnabled?: boolean;
};

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function assertGeminiCliLiteralIsolatedPrompt(ctx: GeminiCliIsolatedAuthContext): boolean {
  if (ctx.isolatedCompletionSystemPrompt === undefined) {
    return false;
  }
  const prompt = ctx.isolatedCompletionPrompt;
  if (prompt === undefined) {
    return false;
  }
  // Gemini CLI preprocesses these forms before inference and has no raw-input
  // flag. Reject them rather than read a resource or alter the user's bytes.
  // Gemini intentionally treats Unicode whitespace as a path character. Only
  // ASCII whitespace terminates its native @ parser, so \S would miss includes.
  if (/(?<!\\)@(?=[^ \t\n\r])/u.test(prompt)) {
    throw new Error("Gemini CLI isolated completion cannot safely pass native @-include syntax.");
  }
  if (prompt.startsWith("/") && !prompt.startsWith("//") && !prompt.startsWith("/*")) {
    throw new Error("Gemini CLI isolated completion cannot safely pass native /command syntax.");
  }
  return true;
}

export async function readGeminiCliJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const normalized = normalizeString(filePath);
  if (!normalized) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(normalized, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Gemini CLI system settings must be a JSON object: ${normalized}`);
    }
    return { ...parsed };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

export function projectGeminiCliSafeSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const privacy = isRecord(settings.privacy) ? settings.privacy : undefined;
  if (typeof privacy?.usageStatisticsEnabled === "boolean") {
    projected.privacy = { usageStatisticsEnabled: privacy.usageStatisticsEnabled };
  }
  const telemetry = isRecord(settings.telemetry) ? settings.telemetry : undefined;
  const safeTelemetry: Record<string, boolean> = {};
  if (typeof telemetry?.enabled === "boolean") {
    safeTelemetry.enabled = telemetry.enabled;
  }
  if (typeof telemetry?.logPrompts === "boolean") {
    safeTelemetry.logPrompts = telemetry.logPrompts;
  }
  if (Object.keys(safeTelemetry).length > 0) {
    projected.telemetry = safeTelemetry;
  }
  return projected;
}

function resolveGeminiCliAmbientHome(ctx: GeminiCliIsolatedAuthContext): string {
  return (
    normalizeString(ctx.baseEnv?.GEMINI_CLI_HOME) ??
    normalizeString(process.env.GEMINI_CLI_HOME) ??
    os.homedir()
  );
}

function projectGeminiCliTrustedTransportEnv(
  ctx: GeminiCliIsolatedAuthContext,
  ambientEnv: GeminiCliAmbientEnv,
): Record<string, string> {
  return Object.fromEntries(
    [...GEMINI_CLI_TRUSTED_TRANSPORT_ENV].map((name) => [
      name,
      normalizeString(ctx.baseEnv?.[name]) ??
        normalizeString(process.env[name]) ??
        normalizeString(ambientEnv.transport[name]) ??
        "",
    ]),
  );
}

async function readGeminiCliAmbientAuthEnv(
  filePath: string,
): Promise<GeminiCliAmbientEnv | undefined> {
  try {
    const parsed = parseDotEnv(await fs.readFile(filePath, "utf8"));
    const telemetryValue = parsed.GEMINI_TELEMETRY_ENABLED?.trim().toLowerCase();
    return {
      auth: Object.fromEntries(
        Object.entries(parsed).filter(([key]) => GEMINI_CLI_AMBIENT_AUTH_ENV.has(key)),
      ),
      transport: Object.fromEntries(
        Object.entries(parsed).filter(([key]) => GEMINI_CLI_TRUSTED_TRANSPORT_ENV.has(key)),
      ),
      unsafeAuth: Object.fromEntries(
        Object.entries(parsed).filter(([key]) =>
          GEMINI_CLI_UNSAFE_AUTH_ENV.includes(key as (typeof GEMINI_CLI_UNSAFE_AUTH_ENV)[number]),
        ),
      ),
      ...(telemetryValue
        ? { telemetryEnabled: telemetryValue === "true" || telemetryValue === "1" }
        : {}),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function loadGeminiCliAmbientEnv(
  ctx: GeminiCliIsolatedAuthContext,
): Promise<GeminiCliAmbientEnv> {
  const home = resolveGeminiCliAmbientHome(ctx);
  for (const candidate of [path.join(home, ".gemini", ".env"), path.join(home, ".env")]) {
    const env = await readGeminiCliAmbientAuthEnv(candidate);
    if (env !== undefined) {
      return env;
    }
  }
  return { auth: {}, transport: {}, unsafeAuth: {} };
}

export async function resolveGeminiCliTrustedTransportEnv(
  ctx: GeminiCliIsolatedAuthContext,
): Promise<Record<string, string>> {
  return projectGeminiCliTrustedTransportEnv(ctx, await loadGeminiCliAmbientEnv(ctx));
}

export async function resolveGeminiCliAmbientAuth(
  ctx: GeminiCliIsolatedAuthContext,
): Promise<GeminiCliAmbientAuth> {
  const home = resolveGeminiCliAmbientHome(ctx);
  const settings = await readGeminiCliJsonObject(path.join(home, ".gemini", "settings.json"));
  const systemSettings = await readGeminiCliJsonObject(ctx.systemSettingsPath);
  const userSecurity = isRecord(settings.security) ? settings.security : undefined;
  const userAuth = userSecurity && isRecord(userSecurity.auth) ? userSecurity.auth : undefined;
  const systemSecurity = isRecord(systemSettings.security) ? systemSettings.security : undefined;
  const systemAuth =
    systemSecurity && isRecord(systemSecurity.auth) ? systemSecurity.auth : undefined;
  const ambientEnv = await loadGeminiCliAmbientEnv(ctx);
  const selectedType = normalizeString(
    typeof systemAuth?.selectedType === "string"
      ? systemAuth.selectedType
      : typeof userAuth?.selectedType === "string"
        ? userAuth.selectedType
        : undefined,
  );
  const enforcedType = normalizeString(
    typeof systemAuth?.enforcedType === "string" ? systemAuth.enforcedType : undefined,
  );
  if (enforcedType && enforcedType !== "gemini-api-key" && enforcedType !== "vertex-ai") {
    throw new Error(
      "Gemini CLI isolated completion supports only API-key or Vertex auth; Code Assist auth can inject administrator-required tools.",
    );
  }
  const envValue = (name: string): string | undefined =>
    normalizeString(ctx.baseEnv?.[name]) ??
    normalizeString(process.env[name]) ??
    normalizeString(ambientEnv.auth[name]) ??
    normalizeString(ambientEnv.unsafeAuth[name]);
  // Gemini CLI selects auth from selectedType or its auth env, then compares
  // enforcedType. Do not turn the policy constraint into credential selection.
  const effectiveAuthType =
    selectedType ??
    (envValue("GOOGLE_GENAI_USE_GCA") === "true"
      ? "oauth-personal"
      : envValue("GOOGLE_GENAI_USE_VERTEXAI") === "true"
        ? "vertex-ai"
        : // Gemini CLI consumes GOOGLE_API_KEY only after Vertex auth is selected;
          // unlike GEMINI_API_KEY, it is not itself an auth-type selector.
          envValue("GEMINI_API_KEY")
          ? "gemini-api-key"
          : envValue("CLOUD_SHELL") === "true" || envValue("GEMINI_CLI_USE_COMPUTE_ADC") === "true"
            ? "compute-default-credentials"
            : undefined);
  if (effectiveAuthType !== "gemini-api-key" && effectiveAuthType !== "vertex-ai") {
    throw new Error(
      "Gemini CLI isolated completion supports only API-key or Vertex auth; Code Assist auth can inject administrator-required tools.",
    );
  }
  if (enforcedType !== undefined && enforcedType !== effectiveAuthType) {
    throw new Error(
      `Gemini CLI system settings enforce ${enforcedType} auth, but isolated completion resolved ${effectiveAuthType}.`,
    );
  }
  const envOverrides: Record<string, string> = {
    ...Object.fromEntries([...GEMINI_CLI_AMBIENT_AUTH_ENV].map((name) => [name, ""])),
    ...GEMINI_CLI_ISOLATED_ENV_BARRIERS,
    ...projectGeminiCliTrustedTransportEnv(ctx, ambientEnv),
  };
  for (const name of GEMINI_CLI_AMBIENT_AUTH_ENV) {
    const value = envValue(name);
    if (value) {
      envOverrides[name] = value;
    }
  }
  const applicationCredentials = normalizeString(envOverrides.GOOGLE_APPLICATION_CREDENTIALS);
  if (applicationCredentials && !path.isAbsolute(applicationCredentials)) {
    const workspaceDir = normalizeString(ctx.workspaceDir);
    if (!workspaceDir) {
      throw new Error(
        "Gemini isolated completion cannot resolve relative GOOGLE_APPLICATION_CREDENTIALS without a workspace.",
      );
    }
    envOverrides.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
      workspaceDir,
      applicationCredentials,
    );
  }
  const safeSettings = projectGeminiCliSafeSettings(settings);
  if (ambientEnv.telemetryEnabled === false) {
    const telemetry = isRecord(safeSettings.telemetry) ? safeSettings.telemetry : {};
    safeSettings.telemetry = { ...telemetry, enabled: false };
  }
  return { selectedType, envOverrides, safeSettings };
}
