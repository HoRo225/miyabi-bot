import assert from "node:assert/strict";
import type { Message } from "discord.js";
import test from "node:test";
import { activeAiRequestCount, handleAiMessage, stopAiRuntime } from "./ai-message-runtime.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

type Chain = {
  requestLogId: number;
  sourceMessageId: string | null;
  channelId: string;
  responseMessageIds: string[];
};

type LogEntry = {
  id: number;
  sourceMessageId: string | null;
  triggerType: string;
  taskType: string;
};

type ResponseRecord = {
  requestLogId: number;
  channelId: string;
  messageIds: string[];
};

type ProviderBody = {
  messages?: Array<{ role?: string; content?: unknown }>;
};

type MessageOptions = {
  reference?: Message | null;
  mention?: boolean;
  authorId?: string;
  bot?: boolean;
  components?: unknown[];
  embeds?: unknown[];
  system?: boolean;
};

type Harness = {
  makeHuman(id: string, userId: string, content: string, options?: MessageOptions): Message;
  makeBot(id: string, content: string, options?: MessageOptions): Message;
  message(id: string): Message | undefined;
  replies(id: string): unknown[];
  chains: Map<string, Chain>;
  logs: LogEntry[];
  recordings: ResponseRecord[];
  chainLookups: string[];
  config: Config;
  store: Store;
};

function payloadContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as { content?: unknown }).content;
  return typeof value === "string" ? value : "";
}

function promptText(body: ProviderBody): string {
  const user = body.messages?.find((message) => message.role === "user");
  if (typeof user?.content === "string") return user.content;
  return JSON.stringify(user?.content ?? "");
}

function makeHarness(): Harness {
  const messages = new Map<string, Message>();
  const replyMap = new Map<string, unknown[]>();
  const chains = new Map<string, Chain>();
  const logs: LogEntry[] = [];
  const recordings: ResponseRecord[] = [];
  const chainLookups: string[] = [];
  let responseIndex = 0;
  let requestLogId = 0;

  const channel = {
    id: "channel",
    parentId: null,
    isThread: () => false,
    sendTyping: async () => undefined,
    send: async (payload: unknown) => {
      const id = "response-" + (++responseIndex);
      makeBot(id, payloadContent(payload));
      return { id };
    },
    messages: {
      fetch: async (id: string) => messages.get(id) ?? null
    }
  };

  function buildMessage(
    id: string,
    content: string,
    options: MessageOptions = {}
  ): Message {
    const bot = options.bot ?? false;
    const authorId = options.authorId ?? (bot ? "bot" : "user");
    const message = {
      id,
      guildId: "guild",
      channelId: "channel",
      content,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      author: { id: authorId, username: authorId, bot },
      member: null,
      channel,
      client: { user: { id: "bot" } },
      mentions: {
        users: {
          has: (value: string) => Boolean(options.mention && value === "bot")
        }
      },
      attachments: new Map(),
      embeds: options.embeds ?? [],
      system: Boolean(options.system),
      components: options.components ?? [],
      webhookId: null,
      reference: options.reference
        ? { channelId: "channel", guildId: "guild", messageId: options.reference.id, type: 0 }
        : null,
      fetchReference: async () => options.reference ?? null,
      reply: async (payload: unknown) => {
        const responseId = "response-" + (++responseIndex);
        replyMap.set(id, [...(replyMap.get(id) ?? []), payload]);
        makeBot(responseId, payloadContent(payload));
        return { id: responseId };
      }
    } as unknown as Message;
    messages.set(id, message);
    replyMap.set(id, replyMap.get(id) ?? []);
    return message;
  }

  function makeHuman(
    id: string,
    userId: string,
    content: string,
    options: MessageOptions = {}
  ): Message {
    return buildMessage(id, (options.mention ? "<@bot> " : "") + content, {
      ...options,
      authorId: userId,
      bot: false
    });
  }

  function makeBot(id: string, content: string, options: MessageOptions = {}): Message {
    return buildMessage(id, content, {
      ...options,
      authorId: options.authorId ?? "bot",
      bot: true
    });
  }

  const adminUserIds = new Set([
    "q1-user",
    "invalid-no-metadata-user",
    "invalid-other-bot-user",
    "invalid-component-user",
    "invalid-system-user",
    "q2-user",
    "q3-user",
    "mention-user"
  ]);
  const settingValues: Record<string, string> = {
    ai_enabled: "true",
    ai_model: "test-model",
    ai_cooldown_seconds: "1",
    ai_max_in_flight: "2",
    ai_queue_max: "5",
    ai_queue_timeout_seconds: "30",
    ai_recent_context_limit: "5",
    attachment_max_mb: "10",
    ai_response_max_chars: "12000"
  };
  const store = {
    setting: (key: string) => settingValues[key],
    listAllowedChannels: () => ["channel"],
    listAllowedRoles: () => [],
    isAiAccessBlocked: () => false,
    logAiRequest: (input: unknown) => {
      const entry = input as Omit<LogEntry, "id">;
      const id = ++requestLogId;
      logs.push({ ...entry, id });
      return id;
    },
    recordAiResponseMessages: (
      id: number,
      messageIds: string[]
    ) => {
      const channelId = "channel";
      const log = logs.find((entry) => entry.id === id);
      if (!log) throw new Error("missing request log");
      recordings.push({ requestLogId: id, channelId, messageIds: [...messageIds] });
      const chain: Chain = {
        requestLogId: id,
        sourceMessageId: log.sourceMessageId,
        channelId,
        responseMessageIds: [...messageIds]
      };
      for (const messageId of messageIds) chains.set(messageId, chain);
    },
    aiResponseChain: (id: string) => {
      chainLookups.push(id);
      return chains.get(id);
    }
  } as unknown as Store;

  return {
    makeHuman,
    makeBot,
    message: (id) => messages.get(id),
    replies: (id) => replyMap.get(id) ?? [],
    chains,
    logs,
    recordings,
    chainLookups,
    config: {
      token: "token",
      clientId: "client",
      guildIds: ["guild"],
      adminUserIds,
      adminRoleIds: new Set(),
      aiSettingsUserIds: new Set(),
      aiSettingsRoleIds: new Set(),
      databasePath: "integration.sqlite",
      aiBaseUrl: "https://provider.example",
      aiApiKey: "provider-key",
      aiModel: "test-model",
      replyMentionUser: false
    },
    store
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for " + label);
}

test("public reply runtime validates chains, records segments, and prioritizes mentions", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: ProviderBody[] = [];
  let providerCall = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ProviderBody;
    requestBodies.push(body);
    const answer = providerCall === 0
      ? "A2-ANSWER-" + "x".repeat(2_500)
      : providerCall === 1
        ? "A3-ANSWER"
        : "MENTION-ANSWER";
    providerCall += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: answer } }] }),
      { headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const harness = makeHarness();
  try {
    const q1 = harness.makeHuman("q1", "q1-user", "Q1-HUMAN");
    const a1First = harness.makeBot("a1-first", "A1-SEGMENT-1");
    const a1Last = harness.makeBot("a1-last", "A1-SEGMENT-2");
    const q1Chain: Chain = {
      requestLogId: 10,
      sourceMessageId: q1.id,
      channelId: "channel",
      responseMessageIds: [a1First.id, a1Last.id]
    };
    harness.chains.set(a1First.id, q1Chain);
    harness.chains.set(a1Last.id, q1Chain);

    const noMetadata = harness.makeBot("invalid-no-metadata", "INVALID-NO-METADATA");
    const otherBot = harness.makeBot("invalid-other-bot", "INVALID-OTHER-BOT", { authorId: "other-bot" });
    const componentBot = harness.makeBot("invalid-component", "INVALID-COMPONENT", { components: [{}] });
    const systemBot = harness.makeBot("invalid-system", "INVALID-SYSTEM", { system: true });
    const invalidChain: Chain = {
      requestLogId: 11,
      sourceMessageId: q1.id,
      channelId: "channel",
      responseMessageIds: [otherBot.id, componentBot.id, systemBot.id]
    };
    harness.chains.set(otherBot.id, invalidChain);
    harness.chains.set(componentBot.id, invalidChain);
    harness.chains.set(systemBot.id, invalidChain);

    const invalidReplies = [
      harness.makeHuman("invalid-no-metadata-message", "invalid-no-metadata-user", "INVALID-1", { reference: noMetadata }),
      harness.makeHuman("invalid-other-bot-message", "invalid-other-bot-user", "INVALID-2", { reference: otherBot }),
      harness.makeHuman("invalid-component-message", "invalid-component-user", "INVALID-3", { reference: componentBot }),
      harness.makeHuman("invalid-system-message", "invalid-system-user", "INVALID-4", { reference: systemBot })
    ];
    for (const invalid of invalidReplies) {
      await handleAiMessage(invalid, harness.store, harness.config);
      assert.equal(harness.replies(invalid.id).length, 0);
    }
    assert.equal(requestBodies.length, 0);

    const q2 = harness.makeHuman("q2", "q2-user", "Q2-NEW", { reference: a1Last });
    await handleAiMessage(q2, harness.store, harness.config);
    await waitFor(
      () => requestBodies.length === 1 && harness.recordings.length === 1 && activeAiRequestCount() === 0,
      "valid Q2 reply"
    );
    const q2Prompt = promptText(requestBodies[0]);
    assert.match(q2Prompt, /Q1-HUMAN/);
    assert.match(q2Prompt, /A1-SEGMENT-1/);
    assert.match(q2Prompt, /A1-SEGMENT-2/);
    assert.match(q2Prompt, /Q2-NEW/);
    assert.equal(harness.logs[0]?.sourceMessageId, q2.id);
    assert.equal(harness.logs[0]?.triggerType, "reply_to_bot");
    assert.equal(harness.recordings[0]?.requestLogId, harness.logs[0]?.id);
    assert.equal(harness.recordings[0]?.messageIds.length, 2);
    for (const responseId of harness.recordings[0]?.messageIds ?? []) {
      assert.ok(harness.message(responseId));
      assert.ok(harness.chains.has(responseId));
    }

    const a2ReferenceId = harness.recordings[0]?.messageIds[1];
    assert.ok(a2ReferenceId);
    const a2Reference = harness.message(a2ReferenceId);
    assert.ok(a2Reference);
    const q3 = harness.makeHuman("q3", "q3-user", "Q3-NEW", { reference: a2Reference });
    await handleAiMessage(q3, harness.store, harness.config);
    await waitFor(
      () => requestBodies.length === 2 && harness.recordings.length === 2 && activeAiRequestCount() === 0,
      "new Q3 reply"
    );
    const q3Prompt = promptText(requestBodies[1]);
    assert.match(q3Prompt, /Q2-NEW/);
    assert.match(q3Prompt, /A2-ANSWER/);
    assert.match(q3Prompt, /Q3-NEW/);
    assert.doesNotMatch(q3Prompt, /Q1-HUMAN|A1-SEGMENT-1|A1-SEGMENT-2/);

    const mention = harness.makeHuman(
      "mention",
      "mention-user",
      "MENTION-QUESTION",
      { reference: a2Reference, mention: true }
    );
    await handleAiMessage(mention, harness.store, harness.config);
    await waitFor(
      () => requestBodies.length === 3 && harness.recordings.length === 3 && activeAiRequestCount() === 0,
      "mention priority"
    );
    const mentionPrompt = promptText(requestBodies[2]);
    assert.match(mentionPrompt, /MENTION-QUESTION/);
    assert.doesNotMatch(mentionPrompt, /Q1-HUMAN|Q2-NEW|A1-SEGMENT-1|A1-SEGMENT-2/);
    assert.doesNotMatch(mentionPrompt, /回覆鏈原始使用者問題|上一輪 AI 回覆/);
    assert.equal(harness.logs[2]?.sourceMessageId, mention.id);
    assert.equal(harness.logs[2]?.triggerType, "mention");
  } finally {
    await waitFor(() => activeAiRequestCount() === 0, "runtime cleanup");
    await stopAiRuntime();
    globalThis.fetch = originalFetch;
  }
});
