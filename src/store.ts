import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isLikelyImageAttachment } from "./guards.js";
import {
  boundedContextMessages,
  cosineSimilarity,
  ftsQueryFromText,
  parseEmbeddingJson,
  promptSource,
  twoCharacterHanTerms,
  uniquePromptRefs,
  type MemorySearchResult,
  type PromptMessageRef
} from "./memory.js";
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
type StoredAttachment = {
  attachmentId: string;
  messageId: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  lastSeenUrl: string;
  proxyUrl: string | null;
};

export type StoredMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  authorId: string;
  authorName: string | null;
  content: string | null;
  createdAt: string;
  editedAt: string | null;
  editedFlag: boolean;
  referencedMessageId: string | null;
  messageUrl: string;
  attachments: StoredAttachment[];
};

type BackfillJobStart = {
  id: number;
  targetCount: number;
};

export type BackfillTarget = {
  id: number;
  jobId: number;
  channelId: string;
  parentChannelId: string | null;
  type: string;
  oldestFetchedMessageId: string | null;
  fetchedMessageCount: number;
  retryCount: number;
};

export type BackfillStatus = {
  job: {
    id: number;
    status: string;
    scope: string;
    updatedAt: string;
    lastError: string | null;
  };
  counts: {
    total: number;
    completed: number;
    running: number;
    pending: number;
    failed: number;
    skipped: number;
    fetched: number;
  };
  current?: {
    channelId: string;
    type: string;
    fetchedMessageCount: number;
    lastError: string | null;
  };
};

export type AgentActionRisk = "write" | "destructive";

export type AgentPendingAction = {
  actionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  requesterId: string;
  requesterName: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  risk: AgentActionRisk;
  status: string;
  expiresAt: string;
};

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
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

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  channel_id UNINDEXED,
  author_name,
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  embedding_json TEXT,
  dimension INTEGER,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  last_seen_url TEXT,
  proxy_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachment_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  extracted_text TEXT,
  extraction_method TEXT,
  extracted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_allowed_roles (
  role_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_channel_whitelist (
  channel_id TEXT PRIMARY KEY,
  include_threads INTEGER NOT NULL DEFAULT 1,
  memory_enabled INTEGER NOT NULL DEFAULT 0,
  backfill_enabled INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  scope TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS backfill_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  parent_channel_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  oldest_fetched_message_id TEXT,
  fetched_message_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

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

CREATE TABLE IF NOT EXISTS agent_pending_actions (
  action_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_name TEXT,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('write', 'destructive')),
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_by TEXT,
  result_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_pending_actions_expiry_idx
ON agent_pending_actions(status, expires_at);
`;

const SCHEMA_VERSION = 3;
const RUNTIME_SETTING_KEYS = new Set([
  "ai_enabled",
  "ai_agent_enabled",
  "ai_agent_probe_model",
  "ai_9router_key_id",
  "ai_model",
  "attachment_max_mb",
  "reply_mention_user",
  "summary_message_limit"
]);
const SELECTOR_LIMIT = 25;

function migrateSchema(db: DatabaseSync): void {
  const embeddingColumns = new Set((db.prepare("PRAGMA table_info(message_embeddings)").all() as Array<{ name: string }>).map((column) => column.name));
  const pendingColumns = [
    ["pending_model", "TEXT"],
    ["pending_retry_count", "INTEGER NOT NULL DEFAULT 0"],
    ["pending_error", "TEXT"],
    ["pending_updated_at", "TEXT"]
  ] as const;
  const missingPendingColumns = pendingColumns.filter(([name]) => !embeddingColumns.has(name));
  const ftsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'message_fts'").get() as { sql?: string } | undefined)?.sql ?? "";

  db.exec("BEGIN");
  try {
    for (const [name, definition] of missingPendingColumns) {
      db.exec(`ALTER TABLE message_embeddings ADD COLUMN ${name} ${definition}`);
    }
    if (missingPendingColumns.length) {
      db.exec(`
        UPDATE message_embeddings
        SET pending_model = CASE WHEN status = 'completed' THEN NULL ELSE model END,
            pending_retry_count = CASE WHEN status = 'completed' THEN 0 ELSE retry_count END,
            pending_error = CASE WHEN status = 'completed' THEN NULL ELSE last_error END,
            pending_updated_at = CASE WHEN status = 'completed' THEN NULL ELSE updated_at END
      `);
    }
    if (!/tokenize\s*=\s*['"]?trigram/i.test(ftsSql)) {
      db.exec("DROP TABLE message_fts");
      db.exec(`
        CREATE VIRTUAL TABLE message_fts USING fts5(
          message_id UNINDEXED,
          channel_id UNINDEXED,
          author_name,
          content,
          tokenize = 'trigram'
        )
      `);
      db.exec(`
        INSERT INTO message_fts (message_id, channel_id, author_name, content)
        SELECT m.message_id,
               m.channel_id,
               m.author_name,
               trim(coalesce(m.content, '') || CASE WHEN e.content IS NULL THEN '' ELSE char(10) || e.content END)
        FROM messages m
        LEFT JOIN (
          SELECT message_id, group_concat(extracted_text, char(10)) AS content
          FROM attachment_extractions
          GROUP BY message_id
        ) e ON e.message_id = m.message_id
      `);
    }
    db.exec("DROP TABLE IF EXISTS url_fetch_logs");
    db.exec("DROP TABLE IF EXISTS deleted_messages");
    db.prepare("DELETE FROM ai_runtime_settings WHERE key IN ('ai_base_url', 'ai_api_key', 'ai_embedding_model')").run();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(schema);
    migrateSchema(this.db);
    ensureSteamFreeSeenItemColumns(this.db);
    this.pruneAiRequestLogs();
    this.pruneAgentPendingActions();
  }

  listAllowedRoles(): string[] {
    return this.db.prepare("SELECT role_id FROM ai_allowed_roles ORDER BY role_id").all().map((row) => String((row as { role_id: unknown }).role_id));
  }

  listAllowedChannels(): string[] {
    return this.db.prepare("SELECT channel_id FROM ai_channel_whitelist ORDER BY channel_id").all().map((row) => String((row as { channel_id: unknown }).channel_id));
  }

  listMemoryChannels(): string[] {
    return this.db.prepare("SELECT channel_id FROM ai_channel_whitelist WHERE memory_enabled = 1 ORDER BY channel_id").all().map((row) => String((row as { channel_id: unknown }).channel_id));
  }

  listBackfillChannels(): string[] {
    return this.db.prepare("SELECT channel_id FROM ai_channel_whitelist WHERE backfill_enabled = 1 AND memory_enabled = 1 ORDER BY channel_id").all().map((row) => String((row as { channel_id: unknown }).channel_id));
  }

  listSettingsAllowedRoles(): string[] {
    return this.db.prepare("SELECT role_id FROM settings_allowed_roles ORDER BY role_id").all().map((row) => String((row as { role_id: unknown }).role_id));
  }

  adminStats(): {
    messages: number;
    attachments: number;
    aiRequestLogs: number;
    auditLogs: number;
    allowedChannels: number;
    allowedRoles: number;
    settingsRoles: number;
  } {
    return {
      messages: this.tableCount("messages"),
      attachments: this.tableCount("attachments"),
      aiRequestLogs: this.tableCount("ai_request_logs"),
      auditLogs: this.tableCount("audit_logs"),
      allowedChannels: this.listAllowedChannels().length,
      allowedRoles: this.listAllowedRoles().length,
      settingsRoles: this.listSettingsAllowedRoles().length
    };
  }

  tableCount(table: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: unknown }).count);
  }

  activeBackfillJob(): { id: number; status: string } | undefined {
    return this.db.prepare("SELECT id, status FROM backfill_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get() as { id: number; status: string } | undefined;
  }

  activeBackfillJobIds(): number[] {
    return this.db.prepare("SELECT id FROM backfill_jobs WHERE status IN ('queued', 'running') ORDER BY id").all().map((row) => Number((row as { id: unknown }).id));
  }

  startBackfillJob(actor: UserRef): BackfillJobStart {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare(`
        INSERT INTO backfill_jobs (status, scope, started_by, started_at, updated_at)
        VALUES ('queued', 'full', ?, ?, ?)
      `).run(actor.id, timestamp, timestamp);
      const jobId = Number(result.lastInsertRowid);
      let targetCount = 0;
      for (const channelId of this.listBackfillChannels()) {
        if (this.addBackfillTarget(jobId, channelId, null, "channel")) targetCount += 1;
      }
      this.audit(actor, "ai-settings", "start_backfill", "backfill_job", String(jobId), null, String(targetCount), "ok");
      this.db.exec("COMMIT");
      return { id: jobId, targetCount };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addBackfillTarget(jobId: number, channelId: string, parentChannelId: string | null, type: string): boolean {
    const exists = this.db.prepare("SELECT 1 FROM backfill_targets WHERE job_id = ? AND channel_id = ?").get(jobId, channelId);
    if (exists) return false;
    const timestamp = now();
    return this.db.prepare(`
      INSERT INTO backfill_targets
        (job_id, channel_id, parent_channel_id, type, status, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(jobId, channelId, parentChannelId, type, timestamp).changes > 0;
  }

  resetRunningBackfillTargets(jobId: number): void {
    this.db.prepare("UPDATE backfill_targets SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'").run(now(), jobId);
  }

  markBackfillJobRunning(jobId: number): void {
    this.db.prepare("UPDATE backfill_jobs SET status = 'running', updated_at = ?, last_error = NULL WHERE id = ?").run(now(), jobId);
  }

  backfillFetchedCount(jobId: number): number {
    return Number((this.db.prepare("SELECT coalesce(sum(fetched_message_count), 0) AS count FROM backfill_targets WHERE job_id = ?").get(jobId) as { count: unknown }).count);
  }

  finishBackfillJob(jobId: number, forcedStatus?: "partial_limit"): void {
    if (forcedStatus === "partial_limit") {
      this.db.prepare("UPDATE backfill_targets SET status = 'skipped', updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'pending'").run(now(), now(), jobId);
    }
    const failedCount = (this.db.prepare("SELECT count(*) AS count FROM backfill_targets WHERE job_id = ? AND status = 'failed'").get(jobId) as { count: number }).count;
    const status = forcedStatus ?? (failedCount ? "failed" : "completed");
    const lastError = forcedStatus === "partial_limit" ? "message limit reached" : failedCount ? `${failedCount} targets failed` : null;
    this.db.prepare("UPDATE backfill_jobs SET status = ?, updated_at = ?, completed_at = ?, last_error = ? WHERE id = ?").run(
      status,
      now(),
      now(),
      lastError,
      jobId
    );
    const job = this.db.prepare("SELECT started_by FROM backfill_jobs WHERE id = ?").get(jobId) as { started_by: string } | undefined;
    if (job) {
      this.audit({ id: job.started_by, name: null }, "ai-settings", status === "failed" ? "backfill_failed" : status === "partial_limit" ? "backfill_partial_limit" : "backfill_completed", "backfill_job", String(jobId), null, null, status);
    }
  }

  nextBackfillTarget(jobId: number): BackfillTarget | undefined {
    const row = this.db.prepare(`
      SELECT id, job_id, channel_id, parent_channel_id, type, oldest_fetched_message_id, fetched_message_count, retry_count
      FROM backfill_targets
      WHERE job_id = ? AND status = 'pending'
      ORDER BY id
      LIMIT 1
    `).get(jobId) as {
      id: number;
      job_id: number;
      channel_id: string;
      parent_channel_id: string | null;
      type: string;
      oldest_fetched_message_id: string | null;
      fetched_message_count: number;
      retry_count: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      jobId: row.job_id,
      channelId: row.channel_id,
      parentChannelId: row.parent_channel_id,
      type: row.type,
      oldestFetchedMessageId: row.oldest_fetched_message_id,
      fetchedMessageCount: row.fetched_message_count,
      retryCount: row.retry_count
    };
  }

  markBackfillTargetRunning(targetId: number): void {
    this.db.prepare("UPDATE backfill_targets SET status = 'running', started_at = coalesce(started_at, ?), updated_at = ?, last_error = NULL WHERE id = ?").run(now(), now(), targetId);
  }

  markBackfillTargetProgress(targetId: number, oldestFetchedMessageId: string | null, fetchedCount: number): void {
    this.db.prepare(`
      UPDATE backfill_targets
      SET oldest_fetched_message_id = coalesce(?, oldest_fetched_message_id),
          fetched_message_count = fetched_message_count + ?,
          updated_at = ?
      WHERE id = ?
    `).run(oldestFetchedMessageId, fetchedCount, now(), targetId);
  }

  markBackfillTargetCompleted(targetId: number): void {
    this.db.prepare("UPDATE backfill_targets SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?").run(now(), now(), targetId);
  }

  markBackfillTargetFailed(targetId: number, error: string): void {
    const row = this.db.prepare("SELECT retry_count FROM backfill_targets WHERE id = ?").get(targetId) as { retry_count: number } | undefined;
    const retryCount = (row?.retry_count ?? 0) + 1;
    this.db.prepare("UPDATE backfill_targets SET status = ?, retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
      retryCount >= 3 ? "failed" : "pending",
      retryCount,
      error.slice(0, 500),
      now(),
      targetId
    );
  }

  backfillStatus(): BackfillStatus | undefined {
    const job = this.db.prepare("SELECT * FROM backfill_jobs ORDER BY id DESC LIMIT 1").get() as {
      id: number;
      status: string;
      scope: string;
      started_at: string;
      updated_at: string;
      completed_at: string | null;
      last_error: string | null;
    } | undefined;
    if (!job) return undefined;

    const counts = this.db.prepare(`
      SELECT
        count(*) AS total,
        sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        sum(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        sum(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        sum(fetched_message_count) AS fetched
      FROM backfill_targets
      WHERE job_id = ?
    `).get(job.id) as { total: number; completed: number | null; running: number | null; pending: number | null; failed: number | null; skipped: number | null; fetched: number | null };
    const current = this.db.prepare(`
      SELECT channel_id, type, fetched_message_count, last_error
      FROM backfill_targets
      WHERE job_id = ? AND status IN ('running', 'failed')
      ORDER BY status = 'running' DESC, id
      LIMIT 1
    `).get(job.id) as { channel_id: string; type: string; fetched_message_count: number; last_error: string | null } | undefined;

    return {
      job: {
        id: job.id,
        status: job.status,
        scope: job.scope,
        updatedAt: job.updated_at,
        lastError: job.last_error
      },
      counts: {
        total: counts.total,
        completed: counts.completed ?? 0,
        running: counts.running ?? 0,
        pending: counts.pending ?? 0,
        failed: counts.failed ?? 0,
        skipped: counts.skipped ?? 0,
        fetched: counts.fetched ?? 0
      },
      current: current ? {
        channelId: current.channel_id,
        type: current.type,
        fetchedMessageCount: current.fetched_message_count,
        lastError: current.last_error
      } : undefined
    };
  }

  searchMemory(input: {
    query: string;
    currentChannelId: string;
    excludeMessageIds?: string[];
    limit?: number;
    contextRadius?: number;
  }): MemorySearchResult {
    const query = ftsQueryFromText(input.query);
    const substringTerms = twoCharacterHanTerms(input.query);
    const limit = input.limit ?? 20;
    if (!query && !substringTerms.length) return { query: "", hits: [], contextMessages: [], sources: [] };

    const excludeMessageIds = input.excludeMessageIds ?? [];
    const exactChannelIds = [input.currentChannelId];
    const ftsHits = query ? this.searchMemoryScope(query, exactChannelIds, limit, excludeMessageIds) : [];
    const substringHits = substringTerms.length
      ? this.searchMemorySubstringScope(substringTerms, exactChannelIds, limit, excludeMessageIds)
      : [];
    const hits = uniquePromptRefs([...ftsHits, ...substringHits]).slice(0, limit);
    const contextMessages = boundedContextMessages(
      uniquePromptRefs(hits.flatMap((hit) => this.contextForMessage(hit.id, input.contextRadius ?? 5))),
      hits,
      limit
    );
    const sources = hits.slice(0, 3).map((hit) => `<#${hit.channelId ?? "unknown"}> / ${hit.authorName ?? hit.authorId} / ${hit.createdAt} / ${hit.url}`);
    return { query: query ?? substringTerms.join(" OR "), hits, contextMessages, sources };
  }

  searchSemanticMemory(input: {
    embedding: number[];
    model: string;
    currentChannelId: string;
    excludeMessageIds?: string[];
    limit?: number;
    contextRadius?: number;
  }): MemorySearchResult {
    const limit = input.limit ?? 20;
    const excludeMessageIds = input.excludeMessageIds ?? [];
    const hits = this.searchSemanticMemoryScope(input.embedding, input.model, [input.currentChannelId], limit, excludeMessageIds);
    const contextMessages = boundedContextMessages(
      uniquePromptRefs(hits.flatMap((hit) => this.contextForMessage(hit.id, input.contextRadius ?? 5))),
      hits,
      limit
    );
    const sources = hits.slice(0, 3).map(promptSource);
    return { query: "embedding", hits, contextMessages, sources };
  }

  recentMessages(channelId: string, limit: number, excludeMessageIds: string[] = []): PromptMessageRef[] {
    if (!channelId) return [];
    const excluded = excludeMessageIds.filter(Boolean);
    const excludeClause = excluded.length ? `AND message_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    return this.db.prepare(`
      SELECT message_id, channel_id, parent_channel_id, author_id, author_name, content, created_at, message_url
      FROM messages
      WHERE channel_id = ?
        ${excludeClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(channelId, ...excluded, limit).reverse().map((row) => this.promptRefFromRow(row));
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

  rememberMessage(message: StoredMessage): void {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO messages
          (message_id, guild_id, channel_id, parent_channel_id, author_id, author_name, content, created_at, edited_at, edited_flag, referenced_message_id, message_url, has_attachments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          parent_channel_id = excluded.parent_channel_id,
          author_id = excluded.author_id,
          author_name = excluded.author_name,
          content = excluded.content,
          edited_at = excluded.edited_at,
          edited_flag = excluded.edited_flag,
          referenced_message_id = excluded.referenced_message_id,
          message_url = excluded.message_url,
          has_attachments = excluded.has_attachments
      `).run(
        message.messageId,
        message.guildId,
        message.channelId,
        message.parentChannelId,
        message.authorId,
        message.authorName,
        message.content,
        message.createdAt,
        message.editedAt,
        message.editedFlag ? 1 : 0,
        message.referencedMessageId,
        message.messageUrl,
        message.attachments.length ? 1 : 0
      );
      this.deleteRemovedAttachments(message.messageId, message.attachments.map((attachment) => attachment.attachmentId));
      for (const attachment of message.attachments) {
        this.db.prepare(`
          INSERT INTO attachments
            (attachment_id, message_id, filename, content_type, size_bytes, last_seen_url, proxy_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(attachment_id) DO UPDATE SET
            message_id = excluded.message_id,
            filename = excluded.filename,
            content_type = excluded.content_type,
            size_bytes = excluded.size_bytes,
            last_seen_url = excluded.last_seen_url,
            proxy_url = excluded.proxy_url,
            updated_at = excluded.updated_at
        `).run(
          attachment.attachmentId,
          attachment.messageId,
          attachment.filename,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.lastSeenUrl,
          attachment.proxyUrl,
          timestamp,
          timestamp
        );
      }
      this.refreshMessageFts(message.messageId);
      this.queueMessageEmbedding(message.messageId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteRememberedMessage(messageId: string): boolean {
    if (!this.db.prepare("SELECT 1 FROM messages WHERE message_id = ?").get(messageId)) return false;

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM attachment_extractions WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM message_embeddings WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM message_fts WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM messages WHERE message_id = ?").run(messageId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveAttachmentExtraction(input: {
    attachmentId: string;
    messageId: string;
    filename: string | null;
    contentType: string | null;
    sizeBytes: number;
    extractedText: string;
    extractionMethod: string;
  }): void {
    this.db.prepare("DELETE FROM attachment_extractions WHERE attachment_id = ?").run(input.attachmentId);
    this.db.prepare(`
      INSERT INTO attachment_extractions
        (attachment_id, message_id, filename, content_type, size_bytes, extracted_text, extraction_method, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.attachmentId,
      input.messageId,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.extractedText,
      input.extractionMethod,
      now()
    );
    this.refreshMessageFts(input.messageId);
    this.queueMessageEmbedding(input.messageId);
  }

  private deleteRemovedAttachments(messageId: string, attachmentIds: string[]): void {
    if (!attachmentIds.length) {
      this.db.prepare("DELETE FROM attachment_extractions WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
      return;
    }
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM attachment_extractions WHERE message_id = ? AND attachment_id NOT IN (${placeholders})`).run(messageId, ...attachmentIds);
    this.db.prepare(`DELETE FROM attachments WHERE message_id = ? AND attachment_id NOT IN (${placeholders})`).run(messageId, ...attachmentIds);
  }

  private refreshMessageFts(messageId: string): void {
    const row = this.db.prepare("SELECT message_id, channel_id, author_name, content FROM messages WHERE message_id = ?").get(messageId) as {
      message_id: string;
      channel_id: string;
      author_name: string | null;
      content: string | null;
    } | undefined;
    if (!row) return;

    const extractionRows = this.db.prepare("SELECT extracted_text FROM attachment_extractions WHERE message_id = ?").all(messageId) as Array<{ extracted_text: string | null }>;
    const content = [row.content, ...extractionRows.map((item) => item.extracted_text)].filter(Boolean).join("\n");
    this.db.prepare("DELETE FROM message_fts WHERE message_id = ?").run(messageId);
    this.db.prepare("INSERT INTO message_fts (message_id, channel_id, author_name, content) VALUES (?, ?, ?, ?)").run(
      row.message_id,
      row.channel_id,
      row.author_name,
      content
    );
  }

  private embeddingTextForMessage(messageId: string): string {
    const row = this.db.prepare("SELECT content FROM message_fts WHERE message_id = ?").get(messageId) as { content: string | null } | undefined;
    return (row?.content ?? "").replace(/\s+/g, " ").trim();
  }

  private queueMessageEmbedding(messageId: string): void {
    if (!this.embeddingTextForMessage(messageId)) {
      this.db.prepare("DELETE FROM message_embeddings WHERE message_id = ?").run(messageId);
      return;
    }
    this.db.prepare(`
      INSERT INTO message_embeddings
        (message_id, model, embedding_json, dimension, status, retry_count, last_error, updated_at,
         pending_model, pending_retry_count, pending_error, pending_updated_at)
      VALUES (?, '', NULL, NULL, 'pending', 0, NULL, ?, '', 0, NULL, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        status = CASE WHEN message_embeddings.embedding_json IS NULL THEN 'pending' ELSE message_embeddings.status END,
        pending_model = '',
        pending_retry_count = 0,
        pending_error = NULL,
        pending_updated_at = excluded.pending_updated_at
    `).run(messageId, now(), now());
  }

  pendingMessageEmbeddings(model: string, limit: number): Array<{ messageId: string; text: string }> {
    this.db.prepare(`
      UPDATE message_embeddings
      SET pending_model = NULL, pending_retry_count = 0, pending_error = NULL, pending_updated_at = NULL
      WHERE embedding_json IS NOT NULL AND model = ? AND pending_model IS NOT NULL AND pending_model != ''
    `).run(model);
    return this.db.prepare(`
      SELECT e.message_id, message_fts.content
      FROM message_embeddings e
      JOIN message_fts ON message_fts.message_id = e.message_id
      WHERE length(trim(message_fts.content)) > 0
        AND e.pending_retry_count < 10
        AND (e.embedding_json IS NULL OR e.model != ? OR e.pending_model = '')
      ORDER BY coalesce(e.pending_updated_at, e.updated_at) ASC
      LIMIT ?
    `).all(model, limit).map((row) => ({
      messageId: String((row as { message_id: unknown }).message_id),
      text: String((row as { content: unknown }).content)
    }));
  }

  saveMessageEmbedding(messageId: string, model: string, embedding: number[]): void {
    this.db.prepare(`
      INSERT INTO message_embeddings
        (message_id, model, embedding_json, dimension, status, retry_count, last_error, updated_at,
         pending_model, pending_retry_count, pending_error, pending_updated_at)
      VALUES (?, ?, ?, ?, 'completed', 0, NULL, ?, NULL, 0, NULL, NULL)
      ON CONFLICT(message_id) DO UPDATE SET
        model = excluded.model,
        embedding_json = excluded.embedding_json,
        dimension = excluded.dimension,
        status = 'completed',
        retry_count = 0,
        last_error = NULL,
        updated_at = excluded.updated_at,
        pending_model = NULL,
        pending_retry_count = 0,
        pending_error = NULL,
        pending_updated_at = NULL
    `).run(messageId, model, JSON.stringify(embedding), embedding.length, now());
  }

  markMessageEmbeddingFailed(messageId: string, model: string, error: string): void {
    this.db.prepare(`
      INSERT INTO message_embeddings
        (message_id, model, embedding_json, dimension, status, retry_count, last_error, updated_at,
         pending_model, pending_retry_count, pending_error, pending_updated_at)
      VALUES (?, '', NULL, NULL, 'failed', 1, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        status = CASE WHEN message_embeddings.embedding_json IS NULL THEN 'failed' ELSE message_embeddings.status END,
        retry_count = CASE WHEN message_embeddings.pending_model = excluded.pending_model THEN message_embeddings.retry_count + 1 ELSE 1 END,
        last_error = excluded.last_error,
        pending_model = excluded.pending_model,
        pending_retry_count = CASE WHEN message_embeddings.pending_model = excluded.pending_model THEN message_embeddings.pending_retry_count + 1 ELSE 1 END,
        pending_error = excluded.pending_error,
        pending_updated_at = excluded.pending_updated_at
    `).run(messageId, error.slice(0, 500), now(), model, error.slice(0, 500), now());
  }

  embeddingBacklogStats(model: string): { pending: number; failed: number } {
    const row = this.db.prepare(`
      SELECT
        sum(CASE WHEN pending_retry_count < 10 AND (embedding_json IS NULL OR message_embeddings.model != ? OR pending_model = '') THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN pending_retry_count >= 10 AND (embedding_json IS NULL OR message_embeddings.model != ? OR pending_model = '') THEN 1 ELSE 0 END) AS failed
      FROM message_embeddings
    `).get(model, model) as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  private searchMemoryScope(query: string, channelIds: string[], limit: number, excludeMessageIds: string[]): PromptMessageRef[] {
    const scope = [...new Set(channelIds.filter(Boolean))];
    if (!scope.length) return [];

    const placeholders = scope.map(() => "?").join(", ");
    const excluded = excludeMessageIds.filter(Boolean);
    const excludeClause = excluded.length ? `AND m.message_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    return this.db.prepare(`
      SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_name, m.content, m.created_at, m.message_url
      FROM message_fts
      JOIN messages m ON m.message_id = message_fts.message_id
      WHERE message_fts MATCH ?
        AND m.channel_id IN (${placeholders})
        ${excludeClause}
      ORDER BY bm25(message_fts)
      LIMIT ?
    `).all(query, ...scope, ...excluded, limit).map((row) => this.promptRefFromRow(row));
  }

  private searchMemorySubstringScope(terms: string[], channelIds: string[], limit: number, excludeMessageIds: string[]): PromptMessageRef[] {
    const scope = [...new Set(channelIds.filter(Boolean))];
    if (!scope.length || !terms.length) return [];

    const placeholders = scope.map(() => "?").join(", ");
    const excluded = excludeMessageIds.filter(Boolean);
    const excludeClause = excluded.length ? `AND m.message_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    const termClause = terms.map(() => "instr(message_fts.content, ?) > 0").join(" OR ");
    return this.db.prepare(`
      SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_name, m.content, m.created_at, m.message_url
      FROM message_fts
      JOIN messages m ON m.message_id = message_fts.message_id
      WHERE m.channel_id IN (${placeholders})
        AND (${termClause})
        ${excludeClause}
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(...scope, ...terms, ...excluded, limit).map((row) => this.promptRefFromRow(row));
  }

  private searchSemanticMemoryScope(embedding: number[], model: string, channelIds: string[], limit: number, excludeMessageIds: string[]): PromptMessageRef[] {
    const scope = [...new Set(channelIds.filter(Boolean))];
    if (!scope.length || !embedding.length) return [];

    const placeholders = scope.map(() => "?").join(", ");
    const excluded = excludeMessageIds.filter(Boolean);
    const excludeClause = excluded.length ? `AND m.message_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    const startedAt = Date.now();
    const rows = this.db.prepare(`
      SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_name, m.content, m.created_at, m.message_url, e.embedding_json
      FROM message_embeddings e
      JOIN messages m ON m.message_id = e.message_id
      WHERE e.model = ?
        AND e.embedding_json IS NOT NULL
        AND m.channel_id IN (${placeholders})
        ${excludeClause}
      ORDER BY m.created_at DESC
    `).all(model, ...scope, ...excluded) as Array<Record<string, unknown>>;

    const hits = rows
      .map((row) => ({
        row,
        score: cosineSimilarity(embedding, parseEmbeddingJson(row.embedding_json))
      }))
      .filter((item): item is { row: Record<string, unknown>; score: number } => typeof item.score === "number")
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => this.promptRefFromRow(item.row));
    const elapsedMs = Date.now() - startedAt;
    if (rows.length > 2_000 || elapsedMs > 500) {
      console.warn(`semantic_memory_slow candidates=${rows.length} elapsed_ms=${elapsedMs}`);
    }
    return hits;
  }

  private contextForMessage(messageId: string, radius: number): PromptMessageRef[] {
    const row = this.db.prepare("SELECT channel_id, created_at FROM messages WHERE message_id = ?").get(messageId) as { channel_id: string; created_at: string } | undefined;
    if (!row) return [];

    const before = this.db.prepare(`
      SELECT message_id, channel_id, parent_channel_id, author_id, author_name, content, created_at, message_url
      FROM messages
      WHERE channel_id = ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(row.channel_id, row.created_at, radius).reverse();
    const center = this.db.prepare(`
      SELECT message_id, channel_id, parent_channel_id, author_id, author_name, content, created_at, message_url
      FROM messages
      WHERE message_id = ?
    `).all(messageId);
    const after = this.db.prepare(`
      SELECT message_id, channel_id, parent_channel_id, author_id, author_name, content, created_at, message_url
      FROM messages
      WHERE channel_id = ? AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(row.channel_id, row.created_at, radius);
    return [...before, ...center, ...after].map((message) => this.promptRefFromRow(message));
  }

  private promptRefFromRow(row: unknown): PromptMessageRef {
    const ref = rowToPromptRef(row);
    const attachments = this.db.prepare(`
      SELECT attachment_id, filename, content_type, size_bytes, last_seen_url
      FROM attachments
      WHERE message_id = ?
      ORDER BY created_at, attachment_id
    `).all(ref.id) as Array<{
      attachment_id: string;
      filename: string | null;
      content_type: string | null;
      size_bytes: number;
      last_seen_url: string;
    }>;
    const extractions = this.db.prepare(`
      SELECT attachment_id, filename, extracted_text
      FROM attachment_extractions
      WHERE message_id = ?
      ORDER BY extracted_at, attachment_id
    `).all(ref.id) as Array<{ attachment_id: string; filename: string | null; extracted_text: string }>;

    const result: PromptMessageRef = { ...ref };
    if (attachments.length) {
      result.attachments = attachments.map((attachment) => [
        attachment.filename ?? attachment.attachment_id,
        attachment.content_type ?? "unknown",
        `${attachment.size_bytes} bytes`,
        attachment.last_seen_url
      ].join(" | "));
      result.imageUrls = attachments
        .filter((attachment) => isLikelyImageAttachment(attachment.filename, attachment.content_type))
        .map((attachment) => attachment.last_seen_url);
    }
    if (extractions.length) {
      result.attachmentExtractions = extractions.map((extraction) => `${extraction.filename ?? extraction.attachment_id}:\n${extraction.extracted_text}`);
    }
    return result;
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
        (channel_id, include_threads, memory_enabled, backfill_enabled, created_by, created_at)
      VALUES (?, 1, 0, 1, ?, ?)
    `).run(channelId, actor.id, now()).changes > 0;
    this.audit(actor, "ai-settings", "allow_channel", "channel", channelId, changed ? null : channelId, channelId, changed ? "ok" : "no_change");
    return changed;
  }

  removeChannel(channelId: string, actor: UserRef): boolean {
    const changed = this.db.prepare("DELETE FROM ai_channel_whitelist WHERE channel_id = ?").run(channelId).changes > 0;
    this.audit(actor, "ai-settings", "deny_channel", "channel", channelId, changed ? channelId : null, null, changed ? "ok" : "no_change");
    return changed;
  }

  setChannelMemoryEnabled(channelId: string, enabled: boolean, actor: UserRef): boolean {
    const oldValue = this.db.prepare("SELECT memory_enabled FROM ai_channel_whitelist WHERE channel_id = ?").get(channelId) as { memory_enabled: number } | undefined;
    if (!oldValue || Boolean(oldValue.memory_enabled) === enabled) return false;
    this.db.prepare("UPDATE ai_channel_whitelist SET memory_enabled = ? WHERE channel_id = ?").run(enabled ? 1 : 0, channelId);
    this.audit(actor, "ai-settings", enabled ? "enable_memory" : "disable_memory", "channel", channelId, String(Boolean(oldValue.memory_enabled)), String(enabled), "ok");
    return true;
  }

  clearChannelMemory(channelId: string, actor: UserRef): number {
    const count = Number((this.db.prepare("SELECT count(*) AS count FROM messages WHERE channel_id = ?").get(channelId) as { count: unknown }).count);
    if (!count) return 0;
    this.db.exec("BEGIN");
    try {
      for (const table of ["attachment_extractions", "attachments", "message_embeddings", "message_fts"] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE message_id IN (SELECT message_id FROM messages WHERE channel_id = ?)`)
          .run(channelId);
      }
      this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(channelId);
      this.audit(actor, "ai-settings", "clear_memory", "channel", channelId, String(count), "0", "ok");
      this.db.exec("COMMIT");
      return count;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  createAgentPendingAction(input: {
    actionId: string;
    guildId: string;
    channelId: string;
    sourceMessageId: string;
    requester: UserRef;
    toolName: string;
    arguments: Record<string, unknown>;
    risk: AgentActionRisk;
    expiresAt: string;
  }): AgentPendingAction {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO agent_pending_actions
        (action_id, guild_id, channel_id, source_message_id, requester_id, requester_name,
         tool_name, arguments_json, risk, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      input.actionId,
      input.guildId,
      input.channelId,
      input.sourceMessageId,
      input.requester.id,
      input.requester.name,
      input.toolName,
      JSON.stringify(input.arguments),
      input.risk,
      input.expiresAt,
      createdAt,
      createdAt
    );
    const action = this.agentPendingAction(input.actionId);
    if (!action) throw new Error("agent_pending_action_create_failed");
    return action;
  }

  agentPendingAction(actionId: string): AgentPendingAction | undefined {
    const row = this.db.prepare(`
      SELECT action_id, guild_id, channel_id, source_message_id, requester_id, requester_name,
             tool_name, arguments_json, risk, status, expires_at
      FROM agent_pending_actions
      WHERE action_id = ?
    `).get(actionId) as {
      action_id: string;
      guild_id: string;
      channel_id: string;
      source_message_id: string;
      requester_id: string;
      requester_name: string | null;
      tool_name: string;
      arguments_json: string;
      risk: AgentActionRisk;
      status: string;
      expires_at: string;
    } | undefined;
    if (!row) return undefined;
    let args: unknown;
    try {
      args = JSON.parse(row.arguments_json);
    } catch {
      return undefined;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    return {
      actionId: row.action_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      sourceMessageId: row.source_message_id,
      requesterId: row.requester_id,
      requesterName: row.requester_name,
      toolName: row.tool_name,
      arguments: args as Record<string, unknown>,
      risk: row.risk,
      status: row.status,
      expiresAt: row.expires_at
    };
  }

  claimAgentPendingAction(actionId: string, requesterId: string, approvedBy: string, at = now()): boolean {
    return this.db.prepare(`
      UPDATE agent_pending_actions
      SET status = 'executing', approved_by = ?, updated_at = ?
      WHERE action_id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?
    `).run(approvedBy, at, actionId, requesterId, at).changes > 0;
  }

  finishAgentPendingAction(actionId: string, status: "completed" | "failed" | "rejected" | "expired", resultCode: string): boolean {
    const expectedStatus = status === "completed" || status === "failed" ? "executing" : "pending";
    return this.db.prepare(`
      UPDATE agent_pending_actions
      SET status = ?, arguments_json = '{}', result_code = ?, updated_at = ?
      WHERE action_id = ? AND status = ?
    `).run(status, resultCode.slice(0, 100), now(), actionId, expectedStatus).changes > 0;
  }

  pruneAgentPendingActions(at = new Date()): void {
    const timestamp = at.toISOString();
    this.db.prepare(`
      UPDATE agent_pending_actions
      SET status = 'expired', arguments_json = '{}', result_code = 'expired', updated_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(timestamp, timestamp);
    const cutoff = new Date(at.getTime() - 24 * 60 * 60_000).toISOString();
    this.db.prepare("DELETE FROM agent_pending_actions WHERE status != 'pending' AND updated_at < ?").run(cutoff);
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
  }): void {
    this.pruneAiRequestLogs();
    this.db.prepare(`
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

function rowToPromptRef(row: unknown): PromptMessageRef {
  const message = row as {
    message_id: string;
    channel_id: string;
    author_id: string;
    author_name: string | null;
    content: string | null;
    created_at: string;
    message_url: string;
  };
  return {
    id: message.message_id,
    channelId: message.channel_id,
    authorId: message.author_id,
    authorName: message.author_name,
    content: message.content ?? "",
    createdAt: message.created_at,
    url: message.message_url
  };
}

function redact(key: string, value?: string | null): string | null {
  if (value == null) return null;
  return /key|password|secret/i.test(key) ? "[redacted]" : value;
}


