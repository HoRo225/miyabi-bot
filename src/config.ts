import { resolve } from "node:path";

const DEFAULT_AI_BASE_URL = "http://9router:20128";
const DEFAULT_AI_MODEL = "gemini/gemini-3.6-flash";

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
  replyMentionUser: boolean;
  invalidDiscordIds?: string[];
  invalidRoleIds?: {
    admin: string[];
    aiSettings: string[];
  };
  roleAuthorization?: RoleAuthorizationState;
};

export type DiscordIdErrorCode = "DISCORD-ID-001" | "DISCORD-ID-002" | null;
export type RoleScopeName = "admin" | "aiSettings";
export type RoleScopeValidation = { valid: boolean; errorCode: DiscordIdErrorCode };
export type RoleAuthorizationState = Record<RoleScopeName, RoleScopeValidation>;

export type EnvLike = Record<string, string | undefined>;

export function parseIds(value = ""): Set<string> {
  return new Set(value.split(",").map((id) => id.trim()).filter(Boolean));
}

export const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isValidDiscordId(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value.trim());
}

export function parseDiscordIds(value = ""): { ids: Set<string>; invalid: string[] } {
  const ids = new Set<string>();
  const invalid: string[] = [];
  for (const item of value.split(",").map((id) => id.trim()).filter(Boolean)) {
    if (isValidDiscordId(item)) ids.add(item);
    else invalid.push(item);
  }
  return { ids, invalid };
}

export function roleScopeValidation(config: Pick<Config, "invalidRoleIds" | "roleAuthorization">, scope: RoleScopeName): RoleScopeValidation {
  const configured = config.roleAuthorization?.[scope];
  if (configured) return configured;
  const malformed = config.invalidRoleIds?.[scope]?.length ?? 0;
  return { valid: malformed === 0, errorCode: malformed === 0 ? null : "DISCORD-ID-001" };
}

export function roleScopeIsValid(config: Pick<Config, "invalidRoleIds" | "roleAuthorization">, scope: RoleScopeName): boolean {
  return roleScopeValidation(config, scope).valid;
}

function envFlag(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return !["0", "false", "no"].includes(value.toLowerCase());
}

function envText(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveAiProviderConfig(env: EnvLike): { baseUrl: string; apiKey: string; model: string } {
  return {
    baseUrl: envText(env, "AI_BASE_URL") ?? DEFAULT_AI_BASE_URL,
    apiKey: envText(env, "AI_API_KEY") ?? "",
    model: envText(env, "AI_MODEL") ?? DEFAULT_AI_MODEL
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

export function loadConfig(): Config {
  const aiProvider = resolveAiProviderConfig(process.env);
  const invalidDiscordIds: string[] = [];
  const invalidRoleIds: { admin: string[]; aiSettings: string[] } = { admin: [], aiSettings: [] };
  const parseEnvIds = (key: string, roleScope?: RoleScopeName): Set<string> => {
    const parsed = parseDiscordIds(process.env[key]);
    invalidDiscordIds.push(...parsed.invalid.map((value) => key + "=" + value));
    if (roleScope) invalidRoleIds[roleScope].push(...parsed.invalid);
    return parsed.ids;
  };
  const guildValue = requiredEnvAny("DISCORD_GUILD_IDS", "DISCORD_GUILD_ID");
  const guilds = parseDiscordIds(guildValue);
  const clientIdValue = requiredEnv("DISCORD_CLIENT_ID").trim();
  if (!isValidDiscordId(clientIdValue)) {
    invalidDiscordIds.push("DISCORD_CLIENT_ID=" + clientIdValue);
    throw new Error("DISCORD_CLIENT_ID is not a valid Discord ID");
  }
  invalidDiscordIds.push(...guilds.invalid.map((value) => "DISCORD_GUILD_IDS=" + value));
  if (!guilds.ids.size) throw new Error("DISCORD_GUILD_IDS contains no valid Discord IDs");
  return {
    token: requiredEnv("DISCORD_TOKEN"),
    clientId: clientIdValue,
    guildIds: [...guilds.ids],
    adminUserIds: parseEnvIds("ADMIN_USER_IDS"),
    adminRoleIds: parseEnvIds("ADMIN_ROLE_IDS", "admin"),
    aiSettingsUserIds: parseEnvIds("AI_SETTINGS_USER_IDS"),
    aiSettingsRoleIds: parseEnvIds("AI_SETTINGS_ROLE_IDS", "aiSettings"),
    databasePath: databasePath(process.env.DATABASE_URL ?? "file:./data/bot.sqlite"),
    aiBaseUrl: aiProvider.baseUrl,
    aiApiKey: aiProvider.apiKey,
    aiModel: aiProvider.model,
    replyMentionUser: envFlag("REPLY_MENTION_USER", true),
    ...(invalidDiscordIds.length ? { invalidDiscordIds: [...new Set(invalidDiscordIds)] } : {}),
    ...((invalidRoleIds.admin.length || invalidRoleIds.aiSettings.length) ? {
      invalidRoleIds: {
        admin: [...new Set(invalidRoleIds.admin)],
        aiSettings: [...new Set(invalidRoleIds.aiSettings)]
      }
    } : {})
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
