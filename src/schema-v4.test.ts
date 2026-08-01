import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "./store.js";

test("schema v4 removes agent state without deleting audit history", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-schema-v4-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec([
      "CREATE TABLE agent_pending_actions (action_id TEXT PRIMARY KEY);",
      "CREATE TABLE ai_runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL);",
      "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor_name TEXT, entrypoint TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, old_value TEXT, new_value TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL);",
      "PRAGMA user_version = 3;"
    ].join("\n"));
    legacy.prepare("INSERT INTO agent_pending_actions (action_id) VALUES (?)").run("pending");
    const insertSetting = legacy.prepare("INSERT INTO ai_runtime_settings VALUES (?, ?, NULL, ?)");
    insertSetting.run("ai_agent_enabled", "true", "2026-08-01T00:00:00.000Z");
    insertSetting.run("ai_agent_probe_model", "model", "2026-08-01T00:00:00.000Z");
    insertSetting.run("ai_model", "kept-model", "2026-08-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO audit_logs (actor_id, entrypoint, action, target_type, result, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "admin", "ai-agent", "legacy", "agent_action", "ok", "2026-08-01T00:00:00.000Z"
    );
    legacy.close();

    const store = new Store(databasePath);
    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("agent_pending_actions"), undefined);
    assert.equal(store.setting("ai_agent_enabled"), undefined);
    assert.equal(store.setting("ai_agent_probe_model"), undefined);
    assert.equal(store.setting("ai_model"), "kept-model");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM audit_logs").get() as { count: number }).count, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
