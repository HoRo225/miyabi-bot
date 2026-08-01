import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, type Client, type Message } from "discord.js";
import { parseOpenAiChatResponseText } from "./ai-provider.js";
import { resolveAiAgentEnabledSetting, type Config } from "./config.js";
import {
  DISCORD_AGENT_TOOLS,
  agentTool,
  destructiveConfirmationToken,
  executeDiscordAgentTool,
  parseAgentToolArguments,
  providerAgentTools
} from "./discord-agent-tools.js";
import { Store } from "./store.js";
import { boundedToolContent, runDiscordAgent } from "./discord-agent-runtime.js";

test("provider parser reassembles streamed tool calls by index", () => {
  const parsed = parseOpenAiChatResponseText([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"discord_","arguments":"{\\"limit\\":"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"list_bans","arguments":"5}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
    "data: [DONE]"
  ].join("\n"), "text/event-stream");

  assert.deepEqual(parsed.choices?.[0]?.message?.tool_calls, [{
    id: "call_1",
    type: "function",
    function: { name: "discord_list_bans", arguments: '{"limit":5}' }
  }]);
  assert.equal(parsed.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(parsed.usage?.prompt_tokens, 10);
});

test("agent tool result is capped at 32 KiB after UTF-8 JSON encoding", () => {
  const content = boundedToolContent({ text: '中\\"'.repeat(20_000) });
  assert.ok(Buffer.byteLength(content, "utf8") <= 32 * 1024);
  assert.equal(JSON.parse(content).truncated, true);
});

test("agent tool surface is fixed, strict, and read-only for ordinary users", () => {
  assert.ok(DISCORD_AGENT_TOOLS.length >= 50);
  assert.ok(providerAgentTools(false).every((item) => agentTool(item.function.name)?.risk === "read"));
  assert.ok(providerAgentTools(true).some((item) => agentTool(item.function.name)?.risk === "destructive"));

  const send = agentTool("discord_send_message");
  assert.ok(send);
  assert.deepEqual(parseAgentToolArguments(send, '{"content":"hello"}'), { content: "hello" });
  assert.throws(() => parseAgentToolArguments(send, '{"content":"hello","url":"https://example.com"}'), /agent_tool_unknown/);
  assert.throws(() => parseAgentToolArguments(send, '{"content":""}'), /agent_tool_short/);

  const role = agentTool("discord_create_role");
  assert.ok(role);
  assert.throws(() => parseAgentToolArguments(role, '{"name":"admin","permissions":["Administrator"]}'), /agent_tool_enum/);
  assert.equal(destructiveConfirmationToken({ channel_id: "12345678901234567", name: "new" }), "12345678901234567");
  assert.equal(destructiveConfirmationToken({ name: "new-channel" }), "new-channel");
});

test("agent pending actions are single-use, expiring, and scrub arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-agent-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    const action = store.createAgentPendingAction({
      actionId: "action-1",
      guildId: "guild",
      channelId: "channel",
      sourceMessageId: "message",
      requester: { id: "admin", name: "Admin" },
      toolName: "discord_send_message",
      arguments: { content: "secret pending text" },
      risk: "write",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    assert.equal(action.arguments.content, "secret pending text");
    assert.equal(store.claimAgentPendingAction("action-1", "other", "other"), false);
    assert.equal(store.claimAgentPendingAction("action-1", "admin", "admin"), true);
    assert.equal(store.claimAgentPendingAction("action-1", "admin", "admin"), false);
    assert.equal(store.finishAgentPendingAction("action-1", "rejected", "late_reject"), false);
    assert.equal(store.finishAgentPendingAction("action-1", "completed", "ok"), true);
    assert.deepEqual(store.agentPendingAction("action-1")?.arguments, {});

    store.createAgentPendingAction({
      actionId: "action-expired",
      guildId: "guild",
      channelId: "channel",
      sourceMessageId: "message",
      requester: { id: "admin", name: "Admin" },
      toolName: "discord_delete_channel",
      arguments: { channel_id: "12345678901234567" },
      risk: "destructive",
      expiresAt: "2020-01-01T00:00:00.000Z"
    });
    store.pruneAgentPendingActions(new Date("2026-07-10T00:00:00.000Z"));
    assert.equal(store.agentPendingAction("action-expired")?.status, "expired");
    assert.deepEqual(store.agentPendingAction("action-expired")?.arguments, {});
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent tools are fail-closed by default", () => {
  assert.equal(resolveAiAgentEnabledSetting(undefined), false);
  assert.equal(resolveAiAgentEnabledSetting("true"), true);
  assert.equal(resolveAiAgentEnabledSetting("off"), false);
});

test("write executor rechecks admin, actor permission, bot permission, and guild", async () => {
  const send = agentTool("discord_send_message");
  assert.ok(send);
  const sent: string[] = [];
  let actorAllowed = true;
  let botAllowed = true;
  const actor = { id: "admin", roles: { cache: { some: () => false } } };
  const bot = { id: "bot", roles: { cache: { some: () => false } } };
  const channel = {
    id: "12345678901234567",
    guildId: "98765432109876543",
    name: "general",
    type: ChannelType.GuildText,
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    messages: {},
    permissionsFor(member: unknown) {
      return { has: () => member === actor ? actorAllowed : botAllowed };
    },
    async send(options: { content: string }) {
      sent.push(options.content);
      return { id: "11111111111111111" };
    }
  };
  const guild = {
    id: "98765432109876543",
    members: {
      fetch: async () => actor,
      fetchMe: async () => bot
    },
    channels: { fetch: async () => channel }
  };
  const client = { guilds: { fetch: async () => guild }, user: { id: "bot" } } as unknown as Client<true>;
  const config = testConfig(new Set(["admin"]));
  const context = {
    client,
    config,
    guildId: "98765432109876543",
    currentChannelId: "12345678901234567",
    actorId: "admin",
    requestText: "請在 general 傳送 hello"
  };

  const success = await executeDiscordAgentTool(context, send, { content: "hello" });
  assert.equal(success.message, "已傳送訊息 11111111111111111。");
  assert.deepEqual(sent, ["hello"]);

  botAllowed = false;
  await assert.rejects(() => executeDiscordAgentTool(context, send, { content: "blocked" }), /agent_tool_missing_channel_permission/);
  botAllowed = true;
  actorAllowed = false;
  await assert.rejects(() => executeDiscordAgentTool(context, send, { content: "blocked" }), /agent_tool_missing_channel_permission/);
  actorAllowed = true;
  await assert.rejects(() => executeDiscordAgentTool({ ...context, config: testConfig(new Set()) }, send, { content: "blocked" }), /agent_tool_admin_required/);
  await assert.rejects(() => executeDiscordAgentTool({ ...context, config: { ...config, guildIds: ["other"] } }, send, { content: "blocked" }), /agent_tool_cross_guild/);
  assert.deepEqual(sent, ["hello"]);
});

test("agent loop exposes tools by role and never executes a proposed write before approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-agent-loop-"));
  const originalFetch = globalThis.fetch;
  const requestTools: string[][] = [];
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    let calls = [{
      id: "call-1",
      type: "function",
      function: { name: "discord_send_message", arguments: '{"content":"hello"}' }
    }];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
      requestTools.push((body.tools ?? []).map((item) => item.function?.name ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const adminConfig = testConfig(new Set(["admin"]));
    const adminMessage = fakeAgentMessage("admin");
    const approved = await runDiscordAgent(adminMessage, store, adminConfig, "請傳送 hello", [{ role: "user", content: "請傳送 hello" }]);
    assert.equal(approved.kind, "approval");
    assert.ok(requestTools[0].includes("discord_send_message"));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM agent_pending_actions WHERE status = 'pending'").get() as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT new_value FROM audit_logs WHERE entrypoint = 'ai-agent' AND action = 'discord_send_message' ORDER BY id DESC LIMIT 1").get() as { new_value: string }).new_value, "write");

    const ordinary = await runDiscordAgent(fakeAgentMessage("user"), store, testConfig(new Set()), "請傳送 hello", [{ role: "user", content: "請傳送 hello" }]);
    assert.equal(ordinary.kind, "message");
    assert.match(ordinary.kind === "message" ? ordinary.content : "", /只開放給管理者/);
    assert.ok(requestTools[1].every((name) => agentTool(name)?.risk === "read"));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM agent_pending_actions WHERE status = 'pending'").get() as { count: number }).count, 1);

    calls = [
      { id: "call-2", type: "function", function: { name: "discord_send_message", arguments: '{"content":"one"}' } },
      { id: "call-3", type: "function", function: { name: "discord_add_reaction", arguments: '{"message_id":"12345678901234567","emoji":"✅"}' } }
    ];
    const multiple = await runDiscordAgent(adminMessage, store, adminConfig, "做兩件事", [{ role: "user", content: "做兩件事" }]);
    assert.equal(multiple.kind, "message");
    assert.match(multiple.kind === "message" ? multiple.content : "", /一次只能提出一項/);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM agent_pending_actions WHERE status = 'pending'").get() as { count: number }).count, 1);
    store.close();
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAgentMessage(userId: string): Message {
  return {
    guildId: "98765432109876543",
    channelId: "12345678901234567",
    id: `message-${userId}`,
    author: { id: userId, username: userId },
    member: { id: userId, roles: { cache: { some: () => false } } },
    client: { isReady: () => true }
  } as unknown as Message;
}

function testConfig(adminUserIds: Set<string>): Config {
  return {
    token: "test",
    clientId: "client",
    guildIds: ["98765432109876543"],
    adminUserIds,
    adminRoleIds: new Set(),
    aiSettingsUserIds: new Set(),
    aiSettingsRoleIds: new Set(),
    databasePath: "test.sqlite",
    aiBaseUrl: "https://provider.example/v1",
    aiApiKey: "test",
    aiModel: "model",
    aiEmbeddingModel: "embedding",
    searxngBaseUrl: "https://search.example",
    summaryMessageLimit: 50,
    replyMentionUser: false,
    attachmentMaxBytes: 1024
  };
}
