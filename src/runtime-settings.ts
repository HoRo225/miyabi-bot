import type { Config } from "./config.js";

/**
 * Runtime knobs that are intentionally read from the Store at admission time.
 *
 * Keeping these values here gives the command/settings layer and the AI worker
 * one canonical default and range definition. Invalid values are ignored and
 * fall back to the configured default.
 */
export type AiRuntimeLimits = {
  cooldownSeconds: number;
  maxInFlight: number;
  queueMax: number;
  queueTimeoutSeconds: number;
  recentContextMessages: number;
  attachmentMaxBytes: number;
  responseMaxChars: number;
};

export type ResolvedRuntimeSettings = { replyMentionUser: boolean } & AiRuntimeLimits;

type RuntimeSettingsStore = {
  setting(key: string): string | undefined;
};

export const AI_RUNTIME_SETTING_KEYS = [
  "ai_enabled",
  "ai_9router_key_id",
  "ai_model",
  "attachment_max_mb",
  "ai_cooldown_seconds",
  "ai_max_in_flight",
  "ai_queue_max",
  "ai_queue_timeout_seconds",
  "ai_recent_context_limit",
  "ai_response_max_chars",
  "reply_mention_user"
] as const;

export type AiRuntimeSettingKey = (typeof AI_RUNTIME_SETTING_KEYS)[number];

const DEFAULT_AI_RUNTIME_LIMITS: AiRuntimeLimits = {
  cooldownSeconds: 10,
  maxInFlight: 2,
  queueMax: 5,
  queueTimeoutSeconds: 120,
  recentContextMessages: 50,
  attachmentMaxBytes: 10 * 1024 * 1024,
  responseMaxChars: 12_000
};

const INTEGER_SETTING_RULES: Record<string, { minimum: number; maximum: number }> = {
  attachment_max_mb: { minimum: 1, maximum: 25 },
  ai_cooldown_seconds: { minimum: 1, maximum: 60 },
  ai_max_in_flight: { minimum: 1, maximum: 10 },
  ai_queue_max: { minimum: 1, maximum: 10 },
  ai_queue_timeout_seconds: { minimum: 30, maximum: 300 },
  ai_recent_context_limit: { minimum: 1, maximum: 50 },
  ai_response_max_chars: { minimum: 2_000, maximum: 12_000 }
};

const BOOLEAN_SETTINGS = new Set(["ai_enabled", "reply_mention_user"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBooleanSetting(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

/** Validate a complete batch before any Store write occurs. */
export function validateAiRuntimeSettings(entries: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!(AI_RUNTIME_SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(`runtime_setting_not_allowed:${key}`);
    }
    if (typeof value !== "string") throw new Error(`runtime_setting_invalid:${key}`);
    if (BOOLEAN_SETTINGS.has(key)) {
      if (parseBooleanSetting(value) === null) throw new Error(`runtime_setting_invalid:${key}`);
      continue;
    }
    if (key === "ai_model") {
      if (!MODEL_ID_PATTERN.test(value.trim())) throw new Error("runtime_setting_invalid:ai_model");
      continue;
    }
    if (key === "ai_9router_key_id") {
      if (value.trim() && !KEY_ID_PATTERN.test(value.trim())) throw new Error("runtime_setting_invalid:ai_9router_key_id");
      continue;
    }
    const rule = INTEGER_SETTING_RULES[key];
    if (!rule) throw new Error(`runtime_setting_not_allowed:${key}`);
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < rule.minimum || parsed > rule.maximum) {
      throw new Error(`runtime_setting_invalid:${key}`);
    }
  }
}

function settingNumber(
  store: RuntimeSettingsStore,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = store.setting(key);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function aiRuntimeLimitsFromStore(store: RuntimeSettingsStore): AiRuntimeLimits {
  const attachmentMaxMb = settingNumber(
    store,
    "attachment_max_mb",
    DEFAULT_AI_RUNTIME_LIMITS.attachmentMaxBytes / (1024 * 1024),
    1,
    25
  );
  return {
    cooldownSeconds: settingNumber(store, "ai_cooldown_seconds", DEFAULT_AI_RUNTIME_LIMITS.cooldownSeconds, 1, 60),
    maxInFlight: settingNumber(store, "ai_max_in_flight", DEFAULT_AI_RUNTIME_LIMITS.maxInFlight, 1, 10),
    queueMax: settingNumber(store, "ai_queue_max", DEFAULT_AI_RUNTIME_LIMITS.queueMax, 1, 10),
    queueTimeoutSeconds: settingNumber(
      store,
      "ai_queue_timeout_seconds",
      DEFAULT_AI_RUNTIME_LIMITS.queueTimeoutSeconds,
      30,
      300
    ),
    recentContextMessages: settingNumber(
      store,
      "ai_recent_context_limit",
      DEFAULT_AI_RUNTIME_LIMITS.recentContextMessages,
      1,
      50
    ),
    attachmentMaxBytes: attachmentMaxMb * 1024 * 1024,
    responseMaxChars: settingNumber(
      store,
      "ai_response_max_chars",
      DEFAULT_AI_RUNTIME_LIMITS.responseMaxChars,
      2_000,
      12_000
    )
  };
}

function settingBoolean(store: RuntimeSettingsStore, key: string, fallback: boolean): boolean {
  const raw = store.setting(key);
  if (raw === undefined) return fallback;
  return !["", "0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function runtimeSettingsFromStore(
  store: RuntimeSettingsStore,
  config: Config
): ResolvedRuntimeSettings {
  return {
    replyMentionUser: settingBoolean(store, "reply_mention_user", config.replyMentionUser),
    ...aiRuntimeLimitsFromStore(store)
  };
}

export { DEFAULT_AI_RUNTIME_LIMITS, INTEGER_SETTING_RULES };
