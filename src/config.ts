import { resolve } from "node:path";

const DEFAULT_AI_BASE_URL = "http://9router:20128";
const DEFAULT_AI_EMBEDDING_MODEL = "gemini/gemini-embedding-2-preview";

export type Config = {
  token: string;
  clientId: string;
  guildIds: string[];
  adminUserIds: Set<string>;
  adminRoleIds: Set<string>;
  aiSettingsUserIds: Set<string>;
  aiSettingsRoleIds: Set<string>;
  databasePath: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiEmbeddingModel: string;
  summaryMessageLimit: number;
  replyMentionUser: boolean;
  attachmentMaxBytes: number;
};

export type EnvLike = Record<string, string | undefined>;

export type RuntimeSettings = {
  summaryMessageLimit: number;
  replyMentionUser: boolean;
  attachmentMaxBytes: number;
};

export function parseIds(value = ""): Set<string> {
  return new Set(value.split(",").map((id) => id.trim()).filter(Boolean));
}

function envFlag(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return !["0", "false", "no"].includes(value.toLowerCase());
}

function envNumber(key: string, defaultValue: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function envText(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveAiProviderConfig(env: EnvLike): { baseUrl: string; apiKey: string; model: string } {
  return {
    baseUrl: envText(env, "AI_BASE_URL") ?? DEFAULT_AI_BASE_URL,
    apiKey: envText(env, "AI_API_KEY") ?? "",
    model: envText(env, "AI_MODEL") ?? ""
  };
}

export function settingBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function settingNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function resolveRuntimeSettings(settings: EnvLike, defaults: RuntimeSettings): RuntimeSettings {
  const attachmentMaxMb = settingNumber(settings.attachment_max_mb, defaults.attachmentMaxBytes / 1024 / 1024);
  return {
    summaryMessageLimit: clampInteger(settingNumber(settings.summary_message_limit, defaults.summaryMessageLimit), 1, 100),
    replyMentionUser: settingBoolean(settings.reply_mention_user, defaults.replyMentionUser),
    attachmentMaxBytes: clampInteger(attachmentMaxMb, 1, 100) * 1024 * 1024
  };
}

export function loadConfig(): Config {
  const aiProvider = resolveAiProviderConfig(process.env);
  return {
    token: requiredEnv("DISCORD_TOKEN"),
    clientId: requiredEnv("DISCORD_CLIENT_ID"),
    guildIds: [...parseIds(requiredEnvAny("DISCORD_GUILD_IDS", "DISCORD_GUILD_ID"))],
    adminUserIds: parseIds(process.env.ADMIN_USER_IDS),
    adminRoleIds: parseIds(process.env.ADMIN_ROLE_IDS),
    aiSettingsUserIds: parseIds(process.env.AI_SETTINGS_USER_IDS),
    aiSettingsRoleIds: parseIds(process.env.AI_SETTINGS_ROLE_IDS),
    databasePath: databasePath(process.env.DATABASE_URL ?? "file:./data/bot.sqlite"),
    aiBaseUrl: aiProvider.baseUrl,
    aiApiKey: aiProvider.apiKey,
    aiModel: aiProvider.model,
    aiEmbeddingModel: envText(process.env, "AI_EMBEDDING_MODEL") ?? DEFAULT_AI_EMBEDDING_MODEL,
    summaryMessageLimit: clampInteger(envNumber("DEFAULT_SUMMARY_MESSAGE_LIMIT", 50), 1, 100),
    replyMentionUser: envFlag("REPLY_MENTION_USER", true),
    attachmentMaxBytes: envNumber("ATTACHMENT_MAX_MB", 10) * 1024 * 1024
  };
}

export function resolveAiEnabledSetting(value: string | undefined): boolean {
  return settingBoolean(value, true);
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredEnvAny(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  throw new Error(`${keys.join(" or ")} is required`);
}

function databasePath(databaseUrl: string): string {
  return resolve(databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl);
}
