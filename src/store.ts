import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type SteamFreeItem,
  type SteamFreeSettings
} from "./steam-free.js";
import {
  ensureSteamFreeSeenItemColumns,
  markSteamFreeExpired,
  markSteamFreeSeen,
  seenSteamFreeItemIds,
  steamFreeSeenItemsToExpire,
  steamFreeSetting,
  steamFreeSettings,
  type SteamFreeSeenItem
} from "./steam-free-store.js";
export type { SteamFreeSeenItem } from "./steam-free-store.js";
import { resolveVoiceSettings, type VoiceSettings } from "./voice.js";
const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_allowed_roles (
  role_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_channel_whitelist (
  channel_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_allowed_roles (
  role_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_free_runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_free_seen_items (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  original_price TEXT,
  final_price TEXT,
  review_summary TEXT,
  review_percent INTEGER,
  capsule_url TEXT,
  claim_until_at TEXT,
  message_id TEXT,
  expired_at TEXT,
  first_seen_at TEXT NOT NULL,
  notified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temp_voice_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  trigger_channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT,
  trigger_type TEXT NOT NULL,
  task_type TEXT NOT NULL,
  model_alias TEXT,
  fallback_chain TEXT,
  status TEXT NOT NULL,
  error_type TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_request_logs_created_at_idx ON ai_request_logs(created_at);

CREATE TABLE IF NOT EXISTS ai_response_messages (
  request_log_id INTEGER NOT NULL REFERENCES ai_request_logs(id) ON DELETE CASCADE,
  message_id TEXT PRIMARY KEY,
  segment_index INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_response_messages_request_idx ON ai_response_messages(request_log_id, segment_index);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  entrypoint TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  old_value TEXT,
  new_value TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 5;
const RUNTIME_SETTING_KEYS = new Set([
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
]);
const SELECTOR_LIMIT = 25;
const RESPONSE_MESSAGE_COLUMNS = ["request_log_id", "message_id", "segment_index", "created_at"];
const ROLE_COLUMNS = ["role_id", "created_by", "created_at"];
const RUNTIME_SETTING_COLUMNS = ["key", "value", "updated_by", "updated_at"];
const STEAM_SEEN_COLUMNS = [
  "app_id", "name", "url", "original_price", "final_price", "review_summary", "review_percent",
  "capsule_url", "claim_until_at", "message_id", "expired_at", "first_seen_at", "notified_at"
];


function migrateSchema(db: DatabaseSync): void {
  const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const removedTables = [
    "messages",
    "message_fts",
    "message_fts_data",
    "message_fts_idx",
    "message_fts_content",
    "message_fts_docsize",
    "message_fts_config",
    "message_embeddings",
    "attachments",
    "attachment_extractions",
    "backfill_jobs",
    "backfill_targets",
    "url_fetch_logs",
    "deleted_messages",
    "agent_pending_actions"
  ];
  const hasRemovedTables = removedTables.some((table) => tableExists(db, table));
  const channelColumns = tableColumns(db, "ai_channel_whitelist");
  const expectedChannelColumns = ["channel_id", "created_by", "created_at"];
  const needsChannelRebuild = channelColumns.length > 0 && channelColumns.join("\0") !== expectedChannelColumns.join("\0");
  const needsAllowedRolesRebuild = !tableColumnsMatch(db, "ai_allowed_roles", ROLE_COLUMNS);
  const needsSettingsRolesRebuild = !tableColumnsMatch(db, "settings_allowed_roles", ROLE_COLUMNS);
  const needsVoiceSettingsRebuild = !tableColumnsMatch(db, "voice_runtime_settings", RUNTIME_SETTING_COLUMNS);
  const needsSteamSettingsRebuild = !tableColumnsMatch(db, "steam_free_runtime_settings", RUNTIME_SETTING_COLUMNS);
  const needsAiSettingsRebuild = !tableColumnsMatch(db, "ai_runtime_settings", RUNTIME_SETTING_COLUMNS);
  const needsSteamSeenRebuild = !tableColumnsMatch(db, "steam_free_seen_items", STEAM_SEEN_COLUMNS);
  const needsRetainedTableRebuild = needsAllowedRolesRebuild || needsSettingsRolesRebuild ||
    needsVoiceSettingsRebuild || needsSteamSettingsRebuild || needsAiSettingsRebuild || needsSteamSeenRebuild;

  const responseColumns = tableColumns(db, "ai_response_messages");
  const needsResponseRebuild = responseColumns.length > 0 && !responseMessageSchemaValid(db);

  const needsMigration = currentVersion < SCHEMA_VERSION || hasRemovedTables || needsChannelRebuild ||
    needsResponseRebuild || needsRetainedTableRebuild;
  if (!needsMigration) {
    assertDatabaseHealthy(db);
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (needsAllowedRolesRebuild) rebuildRoleTable(db, "ai_allowed_roles");
    if (needsSettingsRolesRebuild) rebuildRoleTable(db, "settings_allowed_roles");
    if (needsVoiceSettingsRebuild) rebuildRuntimeSettingsTable(db, "voice_runtime_settings");
    if (needsSteamSettingsRebuild) rebuildRuntimeSettingsTable(db, "steam_free_runtime_settings");
    if (needsAiSettingsRebuild) rebuildRuntimeSettingsTable(db, "ai_runtime_settings");
    if (needsSteamSeenRebuild) rebuildSteamSeenTable(db);

    if (needsChannelRebuild) {
      db.exec("DROP TABLE IF EXISTS ai_channel_whitelist_v5");
      db.exec(`
        CREATE TABLE ai_channel_whitelist_v5 (
          channel_id TEXT PRIMARY KEY,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO ai_channel_whitelist_v5 (channel_id, created_by, created_at)
        SELECT channel_id, created_by, created_at
        FROM ai_channel_whitelist
        ORDER BY created_at
      `);
      db.exec("DROP TABLE ai_channel_whitelist");
      db.exec("ALTER TABLE ai_channel_whitelist_v5 RENAME TO ai_channel_whitelist");
    }
    if (needsResponseRebuild) {
      const canCopyResponses = RESPONSE_MESSAGE_COLUMNS.every((column) => responseColumns.includes(column));
      db.exec("DROP TABLE IF EXISTS ai_response_messages_v5");
      db.exec(`
        CREATE TABLE ai_response_messages_v5 (
          request_log_id INTEGER NOT NULL REFERENCES ai_request_logs(id) ON DELETE CASCADE,
          message_id TEXT PRIMARY KEY,
          segment_index INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      if (canCopyResponses) {
        db.exec(`
          INSERT OR IGNORE INTO ai_response_messages_v5
            (request_log_id, message_id, segment_index, created_at)
          SELECT response.request_log_id, response.message_id, response.segment_index, response.created_at
          FROM ai_response_messages response
          JOIN ai_request_logs logs ON logs.id = response.request_log_id
        `);
      }
      db.exec("DROP TABLE ai_response_messages");
      db.exec("ALTER TABLE ai_response_messages_v5 RENAME TO ai_response_messages");
      db.exec(`
        CREATE INDEX ai_response_messages_request_idx
        ON ai_response_messages(request_log_id, segment_index)
      `);
    }

    for (const table of removedTables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare("DELETE FROM ai_runtime_settings WHERE key IN ('ai_base_url', 'ai_api_key', 'ai_embedding_model', 'ai_agent_enabled', 'ai_agent_probe_model')").run();
    db.prepare(`
      INSERT INTO ai_runtime_settings (key, value, updated_by, updated_at)
      VALUES ('ai_enabled', 'false', NULL, ?)
      ON CONFLICT(key) DO UPDATE SET value = 'false', updated_by = NULL, updated_at = excluded.updated_at
    `).run(now());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original insert error.
    }
    throw error;
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  assertDatabaseHealthy(db);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(table));
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  if (!tableExists(db, table)) return [];
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}
function tableColumnsMatch(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  return tableColumns(db, table).join("\0") === expected.join("\0");
}

function rebuildRoleTable(db: DatabaseSync, table: "ai_allowed_roles" | "settings_allowed_roles"): void {
  const replacement = `${table}_v5`;
  db.exec(`DROP TABLE IF EXISTS ${replacement}`);
  db.exec(`
    CREATE TABLE ${replacement} (
      role_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT OR IGNORE INTO ${replacement} (role_id, created_by, created_at)
    SELECT role_id, created_by, created_at
    FROM ${table}
    ORDER BY created_at
  `);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
}

function rebuildRuntimeSettingsTable(
  db: DatabaseSync,
  table: "voice_runtime_settings" | "steam_free_runtime_settings" | "ai_runtime_settings"
): void {
  const replacement = `${table}_v5`;
  db.exec(`DROP TABLE IF EXISTS ${replacement}`);
  db.exec(`
    CREATE TABLE ${replacement} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT OR REPLACE INTO ${replacement} (key, value, updated_by, updated_at)
    SELECT key, value, updated_by, updated_at
    FROM ${table}
    ORDER BY updated_at
  `);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
}

function rebuildSteamSeenTable(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS steam_free_seen_items_v5");
  db.exec(`
    CREATE TABLE steam_free_seen_items_v5 (
      app_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      original_price TEXT,
      final_price TEXT,
      review_summary TEXT,
      review_percent INTEGER,
      capsule_url TEXT,
      claim_until_at TEXT,
      message_id TEXT,
      expired_at TEXT,
      first_seen_at TEXT NOT NULL,
      notified_at TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT OR REPLACE INTO steam_free_seen_items_v5
      (app_id, name, url, original_price, final_price, review_summary, review_percent, capsule_url,
       claim_until_at, message_id, expired_at, first_seen_at, notified_at)
    SELECT app_id, name, url, original_price, final_price, review_summary, review_percent, capsule_url,
           claim_until_at, message_id, expired_at, first_seen_at, notified_at
    FROM steam_free_seen_items
    ORDER BY notified_at
  `);
  db.exec("DROP TABLE steam_free_seen_items");
  db.exec("ALTER TABLE steam_free_seen_items_v5 RENAME TO steam_free_seen_items");
}

function responseMessageSchemaValid(db: DatabaseSync): boolean {
  const columns = tableColumns(db, "ai_response_messages");
  if (columns.join("\0") !== RESPONSE_MESSAGE_COLUMNS.join("\0")) return false;
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(ai_response_messages)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  return foreignKeys.some((foreignKey) =>
    foreignKey.table === "ai_request_logs" &&
    foreignKey.from === "request_log_id" &&
    foreignKey.to === "id" &&
    foreignKey.on_delete.toUpperCase() === "CASCADE"
  );
}


function assertDatabaseHealthy(db: DatabaseSync): void {
  const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") throw new Error(`sqlite_integrity_check_failed:${integrity}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) throw new Error(`sqlite_foreign_key_check_failed:${foreignKeys.length}`);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(schema);
    ensureSteamFreeSeenItemColumns(this.db);
    migrateSchema(this.db);
    this.pruneAiRequestLogs();
  }

  listAllowedRoles(): string[] {
    return this.db.prepare("SELECT role_id FROM ai_allowed_roles ORDER BY role_id").all().map((row) => String((row as { role_id: unknown }).role_id));
  }

  listAllowedChannels(): string[] {
    return this.db.prepare("SELECT channel_id FROM ai_channel_whitelist ORDER BY channel_id").all().map((row) => String((row as { channel_id: unknown }).channel_id));
  }

  listSettingsAllowedRoles(): string[] {
    return this.db.prepare("SELECT role_id FROM settings_allowed_roles ORDER BY role_id").all().map((row) => String((row as { role_id: unknown }).role_id));
  }

  adminStats(): {
    aiRequestLogs: number;
    aiResponseMessages: number;
    auditLogs: number;
    allowedChannels: number;
    allowedRoles: number;
    settingsRoles: number;
  } {
    return {
      aiRequestLogs: this.tableCount("ai_request_logs"),
      aiResponseMessages: this.tableCount("ai_response_messages"),
      auditLogs: this.tableCount("audit_logs"),
      allowedChannels: this.listAllowedChannels().length,
      allowedRoles: this.listAllowedRoles().length,
      settingsRoles: this.listSettingsAllowedRoles().length
    };
  }

  tableCount(table: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: unknown }).count);
  }

  setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM ai_runtime_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  voiceSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM voice_runtime_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  voiceSettings(): VoiceSettings {
    return resolveVoiceSettings({
      enabled: this.voiceSetting("enabled"),
      trigger_channel_id: this.voiceSetting("trigger_channel_id"),
      name_template: this.voiceSetting("name_template"),
      user_limit: this.voiceSetting("user_limit"),
      owner_manage: this.voiceSetting("owner_manage")
    });
  }

  steamFreeSetting(key: string): string | undefined {
    return steamFreeSetting(this.db, key);
  }

  steamFreeSettings(): SteamFreeSettings {
    return steamFreeSettings(this.db);
  }


  seenSteamFreeItemIds(): string[] {
    return seenSteamFreeItemIds(this.db);
  }

  markSteamFreeSeen(item: SteamFreeItem, messageId: string | null = null): boolean {
    return markSteamFreeSeen(this.db, item, messageId);
  }

  steamFreeSeenItemsToExpire(checkedAt = Date.now()): SteamFreeSeenItem[] {
    return steamFreeSeenItemsToExpire(this.db, checkedAt);
  }

  markSteamFreeExpired(appId: string): void {
    markSteamFreeExpired(this.db, appId);
  }

  addRole(roleId: string, actor: UserRef): boolean {
    if (!this.db.prepare("SELECT 1 FROM ai_allowed_roles WHERE role_id = ?").get(roleId) && this.tableCount("ai_allowed_roles") >= SELECTOR_LIMIT) {
      throw new Error("ai_allowed_roles_limit_reached");
    }
    const changed = this.db.prepare("INSERT OR IGNORE INTO ai_allowed_roles (role_id, created_by, created_at) VALUES (?, ?, ?)").run(roleId, actor.id, now()).changes > 0;
    this.audit(actor, "ai-settings", "allow_role", "role", roleId, changed ? null : roleId, roleId, changed ? "ok" : "no_change");
    return changed;
  }

  removeRole(roleId: string, actor: UserRef): boolean {
    const changed = this.db.prepare("DELETE FROM ai_allowed_roles WHERE role_id = ?").run(roleId).changes > 0;
    this.audit(actor, "ai-settings", "deny_role", "role", roleId, changed ? roleId : null, null, changed ? "ok" : "no_change");
    return changed;
  }

  addChannel(channelId: string, actor: UserRef): boolean {
    if (!this.db.prepare("SELECT 1 FROM ai_channel_whitelist WHERE channel_id = ?").get(channelId) && this.tableCount("ai_channel_whitelist") >= SELECTOR_LIMIT) {
      throw new Error("ai_channel_whitelist_limit_reached");
    }
    const changed = this.db.prepare(`
      INSERT OR IGNORE INTO ai_channel_whitelist
        (channel_id, created_by, created_at)
      VALUES (?, ?, ?)
    `).run(channelId, actor.id, now()).changes > 0;
    this.audit(actor, "ai-settings", "allow_channel", "channel", channelId, changed ? null : channelId, channelId, changed ? "ok" : "no_change");
    return changed;
  }

  removeChannel(channelId: string, actor: UserRef): boolean {
    const changed = this.db.prepare("DELETE FROM ai_channel_whitelist WHERE channel_id = ?").run(channelId).changes > 0;
    this.audit(actor, "ai-settings", "deny_channel", "channel", channelId, changed ? channelId : null, null, changed ? "ok" : "no_change");
    return changed;
  }

  addSettingsRole(roleId: string, actor: UserRef): boolean {
    if (!this.db.prepare("SELECT 1 FROM settings_allowed_roles WHERE role_id = ?").get(roleId) && this.tableCount("settings_allowed_roles") >= SELECTOR_LIMIT) {
      throw new Error("settings_allowed_roles_limit_reached");
    }
    const changed = this.db.prepare("INSERT OR IGNORE INTO settings_allowed_roles (role_id, created_by, created_at) VALUES (?, ?, ?)").run(roleId, actor.id, now()).changes > 0;
    this.audit(actor, "admin", "allow_settings_role", "role", roleId, changed ? null : roleId, roleId, changed ? "ok" : "no_change");
    return changed;
  }

  removeSettingsRole(roleId: string, actor: UserRef): boolean {
    const changed = this.db.prepare("DELETE FROM settings_allowed_roles WHERE role_id = ?").run(roleId).changes > 0;
    this.audit(actor, "admin", "deny_settings_role", "role", roleId, changed ? roleId : null, null, changed ? "ok" : "no_change");
    return changed;
  }

  setRuntimeSetting(key: string, value: string, actor: UserRef): void {
    if (!RUNTIME_SETTING_KEYS.has(key)) throw new Error(`runtime_setting_not_allowed:${key}`);
    const oldValue = this.setting(key);
    this.db.prepare(`
      INSERT INTO ai_runtime_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(key, value, actor.id, now());
    this.audit(actor, "ai-settings", "set_runtime_setting", "setting", key, redact(key, oldValue), redact(key, value), "ok");
  }

  setVoiceSetting(key: string, value: string, actor: UserRef): void {
    const oldValue = this.voiceSetting(key);
    this.db.prepare(`
      INSERT INTO voice_runtime_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(key, value, actor.id, now());
    this.audit(actor, "settings", "set_voice_setting", "setting", key, oldValue ?? null, value, "ok");
  }

  setSteamFreeSetting(key: string, value: string, actor?: UserRef): void {
    const oldValue = this.steamFreeSetting(key);
    this.db.prepare(`
      INSERT INTO steam_free_runtime_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(key, value, actor?.id ?? null, now());
    if (actor) this.audit(actor, "settings", "set_steam_free_setting", "setting", key, oldValue ?? null, value, "ok");
  }

  addTempVoiceChannel(channelId: string, guildId: string, ownerId: string, triggerChannelId: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO temp_voice_channels (channel_id, guild_id, owner_id, trigger_channel_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(channelId, guildId, ownerId, triggerChannelId, now());
  }

  removeTempVoiceChannel(channelId: string): void {
    this.db.prepare("DELETE FROM temp_voice_channels WHERE channel_id = ?").run(channelId);
  }

  tempVoiceChannel(channelId: string): { channelId: string; ownerId: string } | undefined {
    const row = this.db.prepare("SELECT channel_id, owner_id FROM temp_voice_channels WHERE channel_id = ?").get(channelId) as { channel_id: string; owner_id: string } | undefined;
    return row ? { channelId: row.channel_id, ownerId: row.owner_id } : undefined;
  }

  listTempVoiceChannelIds(): string[] {
    return this.db.prepare("SELECT channel_id FROM temp_voice_channels ORDER BY created_at").all().map((row) => String((row as { channel_id: unknown }).channel_id));
  }

  audit(actor: UserRef, entrypoint: string, action: string, targetType: string, targetId: string | null, oldValue: string | null, newValue: string | null, result: string): void {
    this.db.prepare(`
      INSERT INTO audit_logs
        (actor_id, actor_name, entrypoint, action, target_type, target_id, old_value, new_value, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(actor.id, actor.name, entrypoint, action, targetType, targetId, oldValue, newValue, result, now());
  }

  logAiRequest(input: {
    actorId: string;
    channelId: string;
    sourceMessageId: string | null;
    triggerType: string;
    taskType: string;
    modelAlias?: string;
    status: string;
    errorType?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }): number {
    this.pruneAiRequestLogs();
    const result = this.db.prepare(`
      INSERT INTO ai_request_logs
        (actor_id, channel_id, source_message_id, trigger_type, task_type, model_alias, fallback_chain, status, error_type, latency_ms, input_tokens, output_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.actorId,
      input.channelId,
      input.sourceMessageId,
      input.triggerType,
      input.taskType,
      input.modelAlias ?? null,
      null,
      input.status,
      input.errorType ?? null,
      input.latencyMs ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      now()
    );
    return Number(result.lastInsertRowid);
  }

  recordAiResponseMessages(requestLogId: number, messageIds: string[], createdAt = now()): void {
    if (!messageIds.length || messageIds.some((messageId) => !messageId)) {
      throw new Error("ai_response_messages_invalid");
    }
    if (new Set(messageIds).size !== messageIds.length) {
      throw new Error("ai_response_messages_duplicate");
    }
    const request = this.db.prepare("SELECT status FROM ai_request_logs WHERE id = ?").get(requestLogId) as { status: string } | undefined;
    if (request?.status !== "ok") throw new Error("ai_response_request_not_successful");
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(`
        INSERT INTO ai_response_messages (request_log_id, message_id, segment_index, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [segmentIndex, messageId] of messageIds.entries()) {
        insert.run(requestLogId, messageId, segmentIndex, createdAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original insert error.
      }
      throw error;
    }
  }

  aiResponseChain(messageId: string): { requestLogId: number; sourceMessageId: string; channelId: string; responseMessageIds: string[] } | undefined {
    const row = this.db.prepare(`
      SELECT response.request_log_id, logs.channel_id, logs.source_message_id
      FROM ai_response_messages response
      JOIN ai_request_logs logs ON logs.id = response.request_log_id
      WHERE response.message_id = ? AND logs.status = 'ok'
    `).get(messageId) as { request_log_id: number; channel_id: string; source_message_id: string | null } | undefined;
    if (!row?.source_message_id) return undefined;
    const responseMessageIds = this.db.prepare(`
      SELECT message_id
      FROM ai_response_messages
      WHERE request_log_id = ?
      ORDER BY segment_index
    `).all(row.request_log_id).map((item) => String((item as { message_id: unknown }).message_id));
    return {
      requestLogId: row.request_log_id,
      sourceMessageId: row.source_message_id,
      channelId: row.channel_id,
      responseMessageIds
    };
  }

  pruneAiRequestLogs(): number {
    return Number(this.db.prepare("DELETE FROM ai_request_logs WHERE datetime(created_at) < datetime('now', '-180 days')").run().changes);
  }

  close(): void {
    this.db.close();
  }
}

type UserRef = { id: string; name: string | null };

export function now(): string {
  return new Date().toISOString();
}

function redact(key: string, value?: string | null): string | null {
  if (value == null) return null;
  return /key|password|secret/i.test(key) ? "[redacted]" : value;
}
