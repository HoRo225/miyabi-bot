import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "./store.js";

const LEGACY_TABLES = [
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

function tableExists(store: Store, table: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table));
}
function tableColumns(store: Store, table: string): string[] {
  return (store.db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>)
    .map((column) => column.name);
}


function createLegacyDatabase(databasePath: string): void {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT,
      author_id TEXT NOT NULL,
      author_name TEXT,
      content TEXT,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      edited_flag INTEGER NOT NULL DEFAULT 0,
      referenced_message_id TEXT,
      message_url TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE message_fts USING fts5(message_id UNINDEXED, channel_id UNINDEXED, content, tokenize = 'trigram');
    CREATE TABLE message_embeddings (message_id TEXT PRIMARY KEY, model TEXT NOT NULL, embedding_json TEXT);
    CREATE TABLE attachments (attachment_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT);
    CREATE TABLE attachment_extractions (id INTEGER PRIMARY KEY, attachment_id TEXT NOT NULL, message_id TEXT NOT NULL, extracted_text TEXT);
    CREATE TABLE backfill_jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE backfill_targets (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, channel_id TEXT NOT NULL);
    CREATE TABLE ai_allowed_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE ai_channel_whitelist (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      include_threads INTEGER NOT NULL DEFAULT 1,
      memory_enabled INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );
    CREATE TABLE settings_allowed_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE voice_runtime_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
    );
    CREATE TABLE steam_free_runtime_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
    );
    CREATE TABLE steam_free_seen_items (
      guild_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
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
      notified_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, app_id)
    );
    CREATE TABLE temp_voice_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      trigger_channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE ai_runtime_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
    );
    CREATE TABLE ai_request_logs (
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
    CREATE TABLE audit_logs (
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
    CREATE TABLE url_fetch_logs (id INTEGER PRIMARY KEY);
    CREATE TABLE deleted_messages (id INTEGER PRIMARY KEY);
    CREATE TABLE agent_pending_actions (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 4;
  `);
  legacy.prepare("INSERT INTO ai_channel_whitelist VALUES (?, ?, ?, ?, ?, ?)").run(
    "guild-kept", "channel-kept", 1, 1, "admin", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO ai_allowed_roles VALUES (?, ?, ?, ?)").run(
    "guild-kept", "role-kept", "admin", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO settings_allowed_roles VALUES (?, ?, ?, ?)").run(
    "guild-kept", "settings-kept", "admin", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO steam_free_runtime_settings VALUES (?, ?, ?, ?, ?)").run(
    "guild-kept", "interval_minutes", "30", "admin", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare(
    "INSERT INTO steam_free_seen_items (guild_id, app_id, name, url, first_seen_at, notified_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "guild-kept", "app-kept", "Kept free game", "https://example.test/app-kept",
    "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO temp_voice_channels VALUES (?, ?, ?, ?, ?)").run(
    "temp-voice", "guild-kept", "owner-kept", "trigger-kept", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO ai_runtime_settings VALUES (?, ?, ?, ?, ?)").run(
    "guild-kept", "ai_enabled", "true", null, "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO ai_runtime_settings VALUES (?, ?, ?, ?, ?)").run(
    "guild-kept", "ai_model", "kept-model", null, "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO voice_runtime_settings VALUES (?, ?, ?, ?, ?)").run(
    "guild-kept", "enabled", "false", "admin", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO ai_request_logs (actor_id, channel_id, source_message_id, trigger_type, task_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "user", "channel-kept", "question-1", "mention", "answer", "ok", "2026-08-02T00:00:00.000Z"
  );
  legacy.prepare("INSERT INTO audit_logs (actor_id, entrypoint, action, target_type, result, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "admin", "settings", "legacy", "setting", "ok", "2026-08-02T00:00:00.000Z"
  );
  legacy.close();
}

test("schema v5 removes long-term message state and preserves allowed settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-schema-v5-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    createLegacyDatabase(databasePath);
    const store = new Store(databasePath);
    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    for (const table of LEGACY_TABLES) assert.equal(tableExists(store, table), false, `removed table recreated: ${table}`);
    assert.deepEqual(tableColumns(store, "ai_channel_whitelist"), ["channel_id", "created_by", "created_at"]);
    assert.deepEqual(tableColumns(store, "ai_allowed_roles"), ["role_id", "created_by", "created_at"]);
    assert.deepEqual(tableColumns(store, "settings_allowed_roles"), ["role_id", "created_by", "created_at"]);
    assert.deepEqual(tableColumns(store, "voice_runtime_settings"), ["key", "value", "updated_by", "updated_at"]);
    assert.deepEqual(tableColumns(store, "steam_free_runtime_settings"), ["key", "value", "updated_by", "updated_at"]);
    assert.deepEqual(tableColumns(store, "ai_runtime_settings"), ["key", "value", "updated_by", "updated_at"]);
    assert.deepEqual(tableColumns(store, "steam_free_seen_items"), [
      "app_id", "name", "url", "original_price", "final_price", "review_summary", "review_percent",
      "capsule_url", "claim_until_at", "message_id", "expired_at", "first_seen_at", "notified_at"
    ]);
    assert.deepEqual(tableColumns(store, "ai_response_messages"), [
      "request_log_id", "message_id", "segment_index", "created_at"
    ]);
    assert.deepEqual(store.listAllowedChannels(), ["channel-kept"]);
    assert.deepEqual(store.listAllowedRoles(), ["role-kept"]);
    assert.deepEqual(store.listSettingsAllowedRoles(), ["settings-kept"]);
    assert.deepEqual(store.tempVoiceChannel("temp-voice"), { channelId: "temp-voice", ownerId: "owner-kept" });
    assert.equal(store.steamFreeSetting("interval_minutes"), "30");
    assert.deepEqual(store.seenSteamFreeItemIds(), ["app-kept"]);
    assert.equal(store.setting("ai_enabled"), "false");
    assert.equal(store.setting("ai_model"), "kept-model");
    assert.equal(store.voiceSetting("enabled"), "false");
    assert.equal(store.tableCount("ai_request_logs"), 1);
    assert.equal(store.tableCount("audit_logs"), 1);
    assert.equal(store.tableCount("ai_response_messages"), 0);
    assert.equal((store.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    store.close();

    const reopened = new Store(databasePath);
    for (const table of LEGACY_TABLES) assert.equal(tableExists(reopened, table), false, `removed table recreated after reopen: ${table}`);
    const reopenedResponseColumns = (reopened.db.prepare("PRAGMA table_info(ai_response_messages)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.deepEqual(reopenedResponseColumns, ["request_log_id", "message_id", "segment_index", "created_at"]);
    assert.equal(reopened.setting("ai_enabled"), "false");
    reopened.db.prepare("UPDATE ai_runtime_settings SET value = 'true' WHERE key = 'ai_enabled'").run();
    reopened.close();

    const secondReopen = new Store(databasePath);
    assert.equal(secondReopen.setting("ai_enabled"), "true");
    secondReopen.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema v5 removes stale artifacts after a prior v5 startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-schema-v5-stale-artifacts-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    const initial = new Store(databasePath);
    initial.db.exec([
      "CREATE TABLE url_fetch_logs (id INTEGER PRIMARY KEY);",
      "CREATE TABLE deleted_messages (id INTEGER PRIMARY KEY);",
      "CREATE TABLE agent_pending_actions (id INTEGER PRIMARY KEY);"
    ].join("\n"));
    initial.close();

    const reopened = new Store(databasePath);
    for (const table of ["url_fetch_logs", "deleted_messages", "agent_pending_actions"]) {
      assert.equal(tableExists(reopened, table), false, "stale table survived v5 reopen: " + table);
    }
    assert.equal((reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    assert.equal((reopened.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema v5 converges a legacy response metadata table", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-response-convergence-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    const initial = new Store(databasePath);
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX IF EXISTS ai_response_messages_request_idx;
      DROP TABLE ai_response_messages;
      CREATE TABLE ai_response_messages (
        request_log_id INTEGER NOT NULL,
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 5;
    `);
    const createdAt = new Date().toISOString();
    const request = legacy.prepare(`
      INSERT INTO ai_request_logs
        (actor_id, channel_id, source_message_id, trigger_type, task_type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("user", "channel", "legacy-question", "mention", "answer", "ok", createdAt);
    legacy.prepare(`
      INSERT INTO ai_response_messages
        (request_log_id, message_id, channel_id, segment_index, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(Number(request.lastInsertRowid), "legacy-answer", "channel", 0, createdAt);
    legacy.close();

    const repaired = new Store(databasePath);
    const columns = (repaired.db.prepare("PRAGMA table_info(ai_response_messages)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(columns, ["request_log_id", "message_id", "segment_index", "created_at"]);
    assert.deepEqual(repaired.aiResponseChain("legacy-answer"), {
      requestLogId: Number(request.lastInsertRowid),
      sourceMessageId: "legacy-question",
      channelId: "channel",
      responseMessageIds: ["legacy-answer"]
    });
    const foreignKeys = repaired.db.prepare("PRAGMA foreign_key_list(ai_response_messages)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    assert.ok(foreignKeys.some((foreignKey) =>
      foreignKey.table === "ai_request_logs" &&
      foreignKey.from === "request_log_id" &&
      foreignKey.to === "id" &&
      foreignKey.on_delete === "CASCADE"
    ));
    repaired.db.prepare("DELETE FROM ai_request_logs WHERE id = ?").run(Number(request.lastInsertRowid));
    assert.equal(repaired.tableCount("ai_response_messages"), 0);
    assert.equal((repaired.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.deepEqual(repaired.db.prepare("PRAGMA foreign_key_check").all(), []);
    repaired.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai response metadata links all segments and cascades with request retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-ai-response-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    const store = new Store(databasePath);
    const requestLogId = store.logAiRequest({
      actorId: "user",
      channelId: "channel",
      sourceMessageId: "question",
      triggerType: "mention",
      taskType: "answer",
      modelAlias: "gemini/gemini-3.6-flash",
      status: "ok"
    });
    assert.equal(typeof requestLogId, "number");
    store.recordAiResponseMessages(requestLogId, ["answer-1", "answer-2"], "2026-08-02T00:00:00.000Z");
    assert.deepEqual(store.aiResponseChain("answer-2"), {
      requestLogId,
      sourceMessageId: "question",
      channelId: "channel",
      responseMessageIds: ["answer-1", "answer-2"]
    });
    assert.throws(() => store.recordAiResponseMessages(requestLogId, ["answer-1"]));

    const errorLogId = store.logAiRequest({
      actorId: "user",
      channelId: "channel",
      sourceMessageId: "error-question",
      triggerType: "mention",
      taskType: "answer",
      status: "error",
      errorType: "provider"
    });
    assert.throws(() => store.recordAiResponseMessages(errorLogId, ["error-answer"]));
    assert.equal(store.aiResponseChain("error-answer"), undefined);
    assert.equal(store.tableCount("ai_response_messages"), 2);

    const oldCreatedAt = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString();
    const oldLog = store.db.prepare(
      "INSERT INTO ai_request_logs (actor_id, channel_id, source_message_id, trigger_type, task_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("user", "channel", "old-question", "mention", "answer", "ok", oldCreatedAt);
    store.recordAiResponseMessages(Number(oldLog.lastInsertRowid), ["old-answer"], oldCreatedAt);
    assert.equal(store.pruneAiRequestLogs(), 1);
    assert.equal(store.aiResponseChain("old-answer"), undefined);
    assert.equal(store.tableCount("ai_response_messages"), 2);

    store.db.prepare("DELETE FROM ai_request_logs WHERE id = ?").run(requestLogId);
    assert.equal(store.aiResponseChain("answer-1"), undefined);
    assert.equal(store.tableCount("ai_response_messages"), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
