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

const DEFAULT_AI_RUNTIME_LIMITS: AiRuntimeLimits = {
  cooldownSeconds: 10,
  maxInFlight: 2,
  queueMax: 5,
  queueTimeoutSeconds: 120,
  recentContextMessages: 50,
  attachmentMaxBytes: 10 * 1024 * 1024,
  responseMaxChars: 12_000
};

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

export { DEFAULT_AI_RUNTIME_LIMITS };
