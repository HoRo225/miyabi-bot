import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ChannelType, type Client, type VoiceState } from "discord.js";
import { buildMentionMessages } from "./ai-prompts.js";
import { claimAiRequest, releaseAiRequest } from "./ai-message-runtime.js";
import { runBackfillJob } from "./backfill-runtime.js";
import { ftsQueryFromText, twoCharacterHanTerms, type PromptMessageRef } from "./memory.js";
import { Store, type StoredMessage } from "./store.js";
import { handleVoiceStateUpdate } from "./voice.js";

function storedMessage(messageId: string, channelId: string, content: string, parentChannelId: string | null = null): StoredMessage {
  const second = String(messageId.length % 60).padStart(2, "0");
  return {
    messageId,
    guildId: "guild",
    channelId,
    parentChannelId,
    authorId: "user",
    authorName: "HoRo",
    content,
    createdAt: `2026-07-10T00:00:${second}.000Z`,
    editedAt: null,
    editedFlag: false,
    referencedMessageId: null,
    messageUrl: `https://discord.com/channels/guild/${channelId}/${messageId}`,
    attachments: []
  };
}

test("trigram migration and search stay in the exact current channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-core-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    store.rememberMessage(storedMessage("current", "current", "alpha project 與記憶"));
    store.rememberMessage(storedMessage("other", "other", "alpha project 與記憶"));
    store.rememberMessage(storedMessage("thread", "thread", "alpha project 與記憶", "current"));
    store.rememberMessage(storedMessage("english-number", "current", "OpenAI release build 2026"));

    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.match(String((store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'message_fts'").get() as { sql: string }).sql), /trigram/);
    assert.deepEqual(store.searchMemory({ query: "alpha project", currentChannelId: "current" }).hits.map((item) => item.id), ["current"]);
    assert.deepEqual(store.searchMemory({ query: "記憶", currentChannelId: "current" }).hits.map((item) => item.id), ["current"]);
    assert.deepEqual(store.searchMemory({ query: "OpenAI", currentChannelId: "current" }).hits.map((item) => item.id), ["english-number"]);
    assert.deepEqual(store.searchMemory({ query: "2026", currentChannelId: "current" }).hits.map((item) => item.id), ["english-number"]);
    assert.deepEqual(store.searchMemory({ query: "alpha project", currentChannelId: "current", limit: 1 }).contextMessages.map((item) => item.id), ["current"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embedding retries keep the last completed vector", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-core-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    store.rememberMessage(storedMessage("message", "current", "semantic memory"));
    store.rememberMessage(storedMessage("other-message", "other", "semantic memory"));
    store.saveMessageEmbedding("message", "old-model", [1, 0]);
    store.saveMessageEmbedding("other-message", "old-model", [1, 0]);
    store.markMessageEmbeddingFailed("message", "new-model", "provider unavailable");
    const row = store.db.prepare("SELECT model, embedding_json, status, pending_model, pending_retry_count FROM message_embeddings WHERE message_id = ?").get("message") as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      model: "old-model",
      embedding_json: "[1,0]",
      status: "completed",
      pending_model: "new-model",
      pending_retry_count: 1
    });
    for (let retry = 1; retry < 10; retry += 1) {
      store.markMessageEmbeddingFailed("message", "new-model", "provider unavailable");
    }
    assert.equal((store.db.prepare("SELECT pending_retry_count FROM message_embeddings WHERE message_id = ?").get("message") as { pending_retry_count: number }).pending_retry_count, 10);
    assert.equal(store.pendingMessageEmbeddings("new-model", 10).some((item) => item.messageId === "message"), false);
    assert.deepEqual(store.embeddingBacklogStats("new-model"), { pending: 1, failed: 1 });
    assert.equal((store.db.prepare("SELECT embedding_json FROM message_embeddings WHERE message_id = ?").get("message") as { embedding_json: string }).embedding_json, "[1,0]");
    assert.deepEqual(store.searchSemanticMemory({
      embedding: [1, 0],
      model: "old-model",
      currentChannelId: "current"
    }).hits.map((item) => item.id), ["message"]);
    assert.deepEqual(store.pendingMessageEmbeddings("new-model", 10).map((item) => item.messageId), ["other-message"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime settings reject provider secrets and selector writes fail at 25", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-core-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    const actor = { id: "admin", name: "Admin" };
    store.setRuntimeSetting("ai_model", "model", actor);
    store.setRuntimeSetting("ai_9router_key_id", "f98279fb-7d96-423b-8e80-7a2e3cf7c1db", actor);
    assert.equal(store.setting("ai_9router_key_id"), "f98279fb-7d96-423b-8e80-7a2e3cf7c1db");
    assert.throws(() => store.setRuntimeSetting("ai_api_key", "secret", actor), /runtime_setting_not_allowed/);
    store.addChannel("memory-channel", actor);
    assert.deepEqual(store.listMemoryChannels(), []);
    assert.equal(store.setChannelMemoryEnabled("memory-channel", true, actor), true);
    store.rememberMessage(storedMessage("remembered", "memory-channel", "permanent memory"));
    assert.equal(store.clearChannelMemory("memory-channel", actor), 1);
    assert.equal(store.tableCount("messages"), 0);
    for (let index = 0; index < 25; index += 1) store.addRole(`role-${index}`, actor);
    assert.throws(() => store.addRole("role-25", actor), /limit_reached/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt bounds memory and attachment extraction text", () => {
  const askingMessage: PromptMessageRef = {
    id: "ask",
    channelId: "current",
    authorId: "user",
    authorName: "HoRo",
    content: "問題",
    createdAt: "2026-07-10T00:00:00.000Z",
    url: "https://discord.com/channels/guild/current/ask",
    attachmentExtractions: ["X".repeat(20_000)]
  };
  const memory = Array.from({ length: 30 }, (_, index): PromptMessageRef => ({
    ...askingMessage,
    id: `memory-${index}`,
    content: "M".repeat(2_000),
    attachmentExtractions: []
  }));
  const messages = buildMentionMessages({
    question: "摘要之前的對話",
    askingMessage,
    memory: { query: "摘要", hits: memory, contextMessages: memory, sources: [] }
  });
  const content = String(messages[1].content);
  assert.ok(content.length < 53_000);
  assert.equal([...content].filter((character) => character === "X").length, 12_000);
});

test("Chinese FTS uses bounded trigrams and two-character fallback terms", () => {
  assert.equal(ftsQueryFromText("之前提過這個功能"), '"之前提" OR "前提過" OR "提過這" OR "過這個" OR "這個功" OR "個功能"');
  assert.deepEqual(twoCharacterHanTerms("查 記憶 與 歷史"), ["記憶", "歷史"]);
  assert.equal(ftsQueryFromText("OpenAI API 2026 42"), '"OpenAI" OR "API" OR "2026"');
});

test("legacy migration rebuilds trigram FTS without destroying completed embeddings", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-legacy-"));
  const databasePath = join(dir, "bot.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
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
      CREATE VIRTUAL TABLE message_fts USING fts5(
        message_id UNINDEXED,
        channel_id UNINDEXED,
        author_name,
        content,
        tokenize = 'unicode61'
      );
      CREATE TABLE message_embeddings (
        message_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        embedding_json TEXT,
        dimension INTEGER,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO messages
        (message_id, guild_id, channel_id, author_id, author_name, content, created_at, message_url)
      VALUES ('legacy', 'guild', 'channel', 'user', 'HoRo', '既有中文記憶', '2026-07-01T00:00:00.000Z', 'https://discord.com/legacy');
      INSERT INTO message_fts (message_id, channel_id, author_name, content)
      VALUES ('legacy', 'channel', 'HoRo', '既有中文記憶');
      INSERT INTO message_embeddings
        (message_id, model, embedding_json, dimension, status, retry_count, last_error, updated_at)
      VALUES ('legacy', 'legacy-model', '[1,0]', 2, 'completed', 0, NULL, '2026-07-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = new Store(databasePath);
    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.match((store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'message_fts'").get() as { sql: string }).sql, /trigram/);
    assert.deepEqual({ ...store.db.prepare(`
      SELECT model, embedding_json, dimension, status, pending_model, pending_retry_count
      FROM message_embeddings WHERE message_id = 'legacy'
    `).get() as Record<string, unknown> }, {
      model: "legacy-model",
      embedding_json: "[1,0]",
      dimension: 2,
      status: "completed",
      pending_model: null,
      pending_retry_count: 0
    });
    assert.deepEqual(store.pendingMessageEmbeddings("legacy-model", 10), []);
    assert.deepEqual(store.searchMemory({ query: "中文", currentChannelId: "channel" }).hits.map((item) => item.id), ["legacy"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill never fetches a thread whose exact memory scope is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-backfill-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    const actor = { id: "admin", name: "Admin" };
    store.addChannel("parent", actor);
    store.setChannelMemoryEnabled("parent", true, actor);
    const job = store.startBackfillJob(actor);
    store.addBackfillTarget(job.id, "thread", "parent", "thread");
    const fetched: string[] = [];
    const client = {
      channels: {
        fetch: async (channelId: string) => {
          fetched.push(channelId);
          return { id: channelId, messages: { fetch: async () => new Map() } };
        }
      }
    } as unknown as Client;

    await runBackfillJob(client, store, job.id);
    assert.deepEqual(fetched, ["parent"]);
    assert.equal(store.tableCount("messages"), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill hard-stops after 10,000 remembered messages", async () => {
  let targetAvailable = true;
  let remembered = 0;
  let finalStatus: string | undefined;
  const store: Parameters<typeof runBackfillJob>[1] = {
    resetRunningBackfillTargets: () => undefined,
    markBackfillJobRunning: () => undefined,
    nextBackfillTarget: () => {
      if (!targetAvailable) return undefined;
      targetAvailable = false;
      return { id: 1, jobId: 1, channelId: "channel", parentChannelId: null, type: "channel", oldestFetchedMessageId: null, fetchedMessageCount: 0, retryCount: 0 };
    },
    backfillFetchedCount: () => 0,
    markBackfillTargetRunning: () => undefined,
    listMemoryChannels: () => ["channel"],
    addBackfillTarget: () => false,
    rememberMessage: () => { remembered += 1; },
    markBackfillTargetProgress: () => undefined,
    markBackfillTargetCompleted: () => undefined,
    markBackfillTargetFailed: () => undefined,
    finishBackfillJob: (_jobId: number, status?: string) => { finalStatus = status; }
  };
  const messages = new Map(Array.from({ length: 10_000 }, (_, index) => {
    const id = String(index + 1);
    return [id, {
      id,
      guild: { id: "guild" },
      guildId: "guild",
      channelId: "channel",
      channel: { parentId: null },
      author: { id: "user", username: "HoRo", bot: false },
      webhookId: null,
      content: `message ${id}`,
      createdAt: new Date(1_700_000_000_000 + index),
      editedAt: null,
      reference: null,
      url: `https://discord.com/channels/guild/channel/${id}`,
      attachments: new Map()
    }] as const;
  }));
  const client = {
    channels: {
      fetch: async () => ({
        id: "channel",
        parentId: null,
        messages: { fetch: async () => messages }
      })
    }
  } as unknown as Client;

  await runBackfillJob(client, store, 1);
  assert.equal(remembered, 10_000);
  assert.equal(finalStatus, "partial_limit");
});

test("voice creation coalesces rapid re-entry and compensates a DB failure", async () => {
  let resolveCreate: ((channel: unknown) => void) | undefined;
  let creates = 0;
  let createdName = "";
  let deletes = 0;
  let removes = 0;
  const createdChannel = {
    id: "created",
    delete: async () => { deletes += 1; }
  };
  const createPromise = new Promise<unknown>((resolve) => { resolveCreate = resolve; });
  const guild = {
    id: "guild",
    channels: {
      cache: new Map(),
      create: async (options: { name: string }) => {
        creates += 1;
        createdName = options.name;
        return createPromise;
      }
    }
  };
  const trigger = {
    type: ChannelType.GuildVoice,
    parentId: null,
    permissionOverwrites: { cache: { map: () => [] } }
  };
  const member = {
    id: "user",
    displayName: "伺服器暱稱",
    user: { bot: false, username: "HoRo" },
    voice: { setChannel: async () => undefined }
  };
  const oldState = { guild, channelId: null, channel: null } as unknown as VoiceState;
  const newState = { guild, channelId: "trigger", channel: trigger, member } as unknown as VoiceState;
  const settings = { enabled: true, triggerChannelId: "trigger", nameTemplate: "{user} 的頻道", userLimit: 0, ownerManage: false };
  const store = {
    voiceSettings: () => settings,
    addTempVoiceChannel: () => undefined,
    removeTempVoiceChannel: () => { removes += 1; },
    tempVoiceChannel: () => undefined,
    listTempVoiceChannelIds: () => []
  };

  const first = handleVoiceStateUpdate(oldState, newState, store);
  const second = handleVoiceStateUpdate(oldState, newState, store);
  resolveCreate?.(createdChannel);
  await Promise.all([first, second]);
  assert.equal(creates, 1);
  assert.equal(createdName, "伺服器暱稱 的頻道");

  guild.channels.create = async () => createdChannel;
  const failingStore = {
    ...store,
    addTempVoiceChannel: () => { throw new Error("db failed"); }
  };
  await assert.rejects(() => handleVoiceStateUpdate(oldState, newState, failingStore), /db failed/);
  assert.equal(deletes, 1);
  assert.equal(removes, 1);
});

test("AI admission enforces message deduplication, user cooldown, and two in-flight requests", () => {
  assert.equal(claimAiRequest("admission-1", "admission-user-1", 1_000), null);
  assert.equal(claimAiRequest("admission-1", "admission-user-1", 1_001), "duplicate");
  assert.equal(claimAiRequest("admission-2", "admission-user-1", 1_002), "cooldown");
  releaseAiRequest();
  assert.equal(claimAiRequest("admission-3", "admission-user-2", 1_003), null);
  assert.equal(claimAiRequest("admission-4", "admission-user-3", 1_004), null);
  assert.equal(claimAiRequest("admission-5", "admission-user-4", 1_005), "busy");
  releaseAiRequest();
  releaseAiRequest();
});
