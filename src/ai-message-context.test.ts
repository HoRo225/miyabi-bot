import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "discord.js";
import { buildMentionMessages } from "./ai-prompts.js";
import { activeAiRequestCount, handleAiMessage, stopAiRuntime } from "./ai-message-runtime.js";
import { shouldUseRecentContext } from "./ai-routing.js";
import { attachmentLimitError, resolvePromptMessageRef } from "./prompt-message-ref.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

function fakeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    id: "message",
    channelId: "channel",
    author: { id: "user", username: "user", bot: false },
    content: "hello",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    attachments: new Map(),
    components: [],
    embeds: [],
    ...overrides
  } as unknown as Message;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

test("recent context includes only ordinary human text and successful bot text", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { messages?: unknown[] } | undefined;
  let replyPayload: unknown;
  let degradedReply: unknown;
  let threadReply: unknown;
  let providerCalls = 0;
  const requestLogs: Array<Record<string, unknown>> = [];
  const human = (id: string, content: string, overrides: Record<string, unknown> = {}) => fakeMessage({
    id,
    content,
    ...overrides
  });
  const validBot = fakeMessage({
    id: "bot-valid",
    author: { id: "bot", username: "bot", bot: true },
    content: "keep-bot"
  });
  const invalidBot = fakeMessage({
    id: "bot-invalid",
    author: { id: "bot", username: "bot", bot: true },
    content: "drop-bot"
  });
  const otherBot = fakeMessage({
    id: "bot-other",
    author: { id: "other-bot", username: "other-bot", bot: true },
    content: "drop-other-bot"
  });

  const recentMessages = [
    human("human-valid", "keep-human"),
    human("system", "drop-system", { system: true }),
    human("components", "drop-components", { components: [{}] }),
    human("embeds", "drop-embeds", { embeds: [{}] }),
    human("attachments", "drop-attachments", { attachments: new Map([["a", { size: 1 }]]) }),
    human("webhook", "drop-webhook", { webhookId: "hook" }),
    validBot,
    invalidBot,
    otherBot,
  ];
  const channel = {
    id: "channel",
    parentId: null,
    type: 0,
    sendTyping: async () => undefined,
    send: async () => ({ id: "segment-2" }),
    messages: { fetch: async () => recentMessages }
  };
  const message = fakeMessage({
    id: "asking",
    guildId: "guild",
    content: "<@bot> 最近在討論什麼？",
    author: { id: "asker", username: "asker", bot: false },
    member: { roles: [] },
    client: { user: { id: "bot" } },
    mentions: { users: { has: (id: string) => id === "bot" } },
    channel,
    reply: async (options: unknown) => {
      replyPayload = options;
      return { id: "segment-1" };
    }
  });
  const settings = new Map([
    ["ai_enabled", "true"],
    ["ai_model", "test-model"],
    ["ai_recent_context_limit", "50"]
  ]);
  const store = {
    setting: (key: string) => settings.get(key),
    listAllowedChannels: () => ["channel"],
    listAllowedRoles: () => [],
    isAiAccessBlocked: () => false,
    aiResponseChain: (id: string) => id === "bot-valid"
      ? { requestLogId: 1, sourceMessageId: "human-valid", channelId: "channel", responseMessageIds: ["bot-valid"] }
      : id === "reply-bot"
        ? { requestLogId: 2, sourceMessageId: "reply-source", channelId: "channel", responseMessageIds: ["reply-bot"] }
        : id === "bot-other"
          ? { requestLogId: 3, sourceMessageId: "human-valid", channelId: "channel", responseMessageIds: ["bot-other"] }
          : undefined,
    logAiRequest: (input: Record<string, unknown>) => {
      requestLogs.push(input);
      return requestLogs.length;
    },
    recordAiResponseMessages: () => undefined
  } as unknown as Store;
  const config = {
    token: "token",
    clientId: "client",
    guildIds: ["guild"],
    adminUserIds: new Set<string>(),
    adminRoleIds: new Set<string>(),
    aiSettingsUserIds: new Set(["asker", "asker-2", "asker-3", "asker-4", "asker-5", "asker-6", "asker-7"]),
    aiSettingsRoleIds: new Set<string>(),
    databasePath: "bot.sqlite",
    aiBaseUrl: "https://provider.example",
    aiApiKey: "key",
    aiModel: "test-model",
    replyMentionUser: false
  } as Config;
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      providerCalls += 1;
      requestBody = JSON.parse(String(init?.body)) as { messages?: unknown[] };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await handleAiMessage(message, store, config);
    for (let index = 0; index < 100 && (!requestBody || !replyPayload); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(requestBody);
    const rendered = JSON.stringify(requestBody.messages);
    assert.match(rendered, /keep-human/);
    assert.match(rendered, /keep-bot/);
    for (const value of ["drop-system", "drop-components", "drop-embeds", "drop-attachments", "drop-webhook", "drop-bot", "drop-other-bot"]) {
      assert.doesNotMatch(rendered, new RegExp(value));
    }
    assert.equal((replyPayload as { content?: string } | undefined)?.content, "ok");

    for (let index = 0; index < 100 && activeAiRequestCount() > 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    channel.messages.fetch = async () => { throw new Error("history unavailable"); };
    const degradedMessage = {
      ...message,
      id: "asking-degraded",
      author: { id: "asker-2", username: "asker-2", bot: false },
      reply: async (options: unknown) => {
        degradedReply = options;
        return { id: "degraded-segment" };
      }
    } as unknown as Message;
    await handleAiMessage(degradedMessage, store, config);
    for (let index = 0; index < 100 && !degradedReply; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(providerCalls, 2);
    assert.match((degradedReply as { content?: string } | undefined)?.content ?? "", /AI-CONTEXT-001/);

    const threadChannel = { ...channel, isThread: () => true };
    const threadMessage = {
      ...message,
      id: "asking-thread",
      author: { id: "asker-3", username: "asker-3", bot: false },
      channel: threadChannel,
      reply: async (options: unknown) => {
        threadReply = options;
        return { id: "thread-segment" };
      }
    } as unknown as Message;
    await handleAiMessage(threadMessage, store, config);
    assert.equal(providerCalls, 2);
    assert.match((threadReply as { content?: string } | undefined)?.content ?? "", /此頻道未啟用 AI/);
    for (let index = 0; index < 100 && activeAiRequestCount() > 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const replySource = fakeMessage({ id: "reply-source", content: "source question" });
    const replyBot = fakeMessage({
      id: "reply-bot",
      author: { id: "bot", username: "bot", bot: true },
      content: "previous answer"
    });
    (channel.messages as { fetch: (value?: unknown) => Promise<unknown> }).fetch = async (value?: unknown) =>
      value === "reply-source" ? replySource : [];
    let replyReply: unknown;
    const replyMessage = {
      ...message,
      id: "question-reply",
      author: { id: "asker-4", username: "asker-4", bot: false },
      content: "follow up",
      reference: { messageId: "reply-bot" },
      fetchReference: async () => replyBot,
      reply: async (options: unknown) => {
        replyReply = options;
        return { id: "reply-segment" };
      }
    } as unknown as Message;
    await handleAiMessage(replyMessage, store, config);
    for (let index = 0; index < 100 && !replyReply; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(providerCalls, 3);
    assert.equal(requestLogs.at(-1)?.sourceMessageId, "question-reply");
    for (let index = 0; index < 100 && activeAiRequestCount() > 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const invalidTarget = fakeMessage({
      id: "invalid-target",
      author: { id: "other-bot", username: "other-bot", bot: true },
      content: "do-not-include"
    });
    let invalidTargetReply: unknown;
    const mentionWithInvalidTarget = {
      ...message,
      id: "question-invalid-target",
      author: { id: "asker-5", username: "asker-5", bot: false },
      content: "<@bot> current question",
      reference: { messageId: "invalid-target" },
      fetchReference: async () => invalidTarget,
      reply: async (options: unknown) => {
        invalidTargetReply = options;
        return { id: "invalid-target-segment" };
      }
    } as unknown as Message;
    await handleAiMessage(mentionWithInvalidTarget, store, config);
    for (let index = 0; index < 100 && !invalidTargetReply; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(providerCalls, 4);
    assert.doesNotMatch(JSON.stringify(requestBody?.messages), /do-not-include/);
    let filteredReplyCalls = 0;
    const webhookMessage = {
      ...message,
      id: "asking-webhook",
      webhookId: "hook",
      author: { id: "asker-6", username: "asker-6", bot: false },
      reply: async () => {
        filteredReplyCalls += 1;
        return { id: "webhook-segment" };
      }
    } as unknown as Message;
    const systemMessage = {
      ...message,
      id: "asking-system",
      system: true,
      author: { id: "asker-7", username: "asker-7", bot: false },
      reply: async () => {
        filteredReplyCalls += 1;
        return { id: "system-segment" };
      }
    } as unknown as Message;
    await handleAiMessage(webhookMessage, store, config);
    await handleAiMessage(systemMessage, store, config);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(providerCalls, 4);
    assert.equal(filteredReplyCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await stopAiRuntime();
  }
});

test("recent routing recognizes temporal speaker questions without broad matching", () => {
  assert.equal(shouldUseRecentContext("上次誰提過 API key？"), true);
  assert.equal(shouldUseRecentContext("剛剛誰說 X？"), true);
  assert.equal(shouldUseRecentContext("最近模型有哪些？"), false);
});

test("text attachment admission enforces a 128 KiB aggregate boundary", () => {
  const limit = 128 * 1024;
  const makeAttachment = (id: string, size: number) => ({
    id,
    name: `${id}.txt`,
    contentType: "text/plain",
    size,
    url: "https://cdn.discordapp.com/attachments/file.txt"
  });
  assert.equal(attachmentLimitError([fakeMessage({
    attachments: new Map([["a", makeAttachment("a", limit)]])
  })], 10 * 1024 * 1024), null);
  assert.match(attachmentLimitError([fakeMessage({
    attachments: new Map([["a", makeAttachment("a", limit + 1)]])
  })], 10 * 1024 * 1024) ?? "", /AI-ATTACHMENT-002/);
  assert.equal(attachmentLimitError([fakeMessage({
    attachments: new Map([
      ["a", makeAttachment("a", limit / 2)],
      ["b", makeAttachment("b", limit / 2)]
    ])
  })], 10 * 1024 * 1024), null);
  assert.match(attachmentLimitError([fakeMessage({
    attachments: new Map([
      ["a", makeAttachment("a", limit / 2)],
      ["b", makeAttachment("b", limit / 2 + 1)]
    ])
  })], 10 * 1024 * 1024) ?? "", /AI-ATTACHMENT-002/);
});

test("image attachments follow one Discord CDN redirect into an ephemeral data URL", async () => {
  const originalFetch = globalThis.fetch;
  const attachment = {
    id: "image",
    name: "image.png",
    contentType: "image/png",
    size: 3,
    url: "https://cdn.discordapp.com/attachments/image.png"
  };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://media.discordapp.net/attachments/image.png" }
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    }) as typeof fetch;
    const ref = await resolvePromptMessageRef(fakeMessage({
      attachments: new Map([[attachment.id, attachment]])
    }), 10 * 1024 * 1024);
    assert.deepEqual(ref.imageUrls, ["data:image/png;base64,AQID"]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image attachments reject a second redirect without exposing the source URL", async () => {
  const originalFetch = globalThis.fetch;
  const attachment = {
    id: "image",
    name: "image.png",
    contentType: "image/png",
    size: 3,
    url: "https://cdn.discordapp.com/attachments/image.png"
  };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://media.discordapp.net/attachments/image.png" }
      });
    }) as typeof fetch;
    const ref = await resolvePromptMessageRef(fakeMessage({
      attachments: new Map([[attachment.id, attachment]])
    }), 10 * 1024 * 1024);
    assert.equal(ref.imageUrls, undefined);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text extraction and prompt rendering no longer use a 12 KiB cap", async () => {
  const originalFetch = globalThis.fetch;
  const text = "x".repeat(20_000);
  const attachment = {
    id: "notes",
    name: "notes.txt",
    contentType: "text/plain",
    size: text.length,
    url: "https://cdn.discordapp.com/attachments/notes.txt"
  };
  try {
    globalThis.fetch = (async () => new Response(text, {
      headers: { "content-length": String(text.length) }
    })) as typeof fetch;
    const ref = await resolvePromptMessageRef(fakeMessage({
      attachments: new Map([[attachment.id, attachment]])
    }), 10 * 1024 * 1024);
    const prompt = buildMentionMessages({ question: "q", askingMessage: ref });
    const rendered = contentText(prompt[1]?.content);
    assert.match(rendered, new RegExp(text));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text attachment downloads concurrently but preserve Discord order", async () => {
  const originalFetch = globalThis.fetch;
  const attachments = new Map([
    ["first", {
      id: "first",
      name: "first.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://cdn.discordapp.com/attachments/first.txt"
    }],
    ["second", {
      id: "second",
      name: "second.txt",
      contentType: "text/plain",
      size: 6,
      url: "https://cdn.discordapp.com/attachments/second.txt"
    }]
  ]);
  let active = 0;
  let maxActive = 0;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const url = String(input);
      await new Promise((resolve) => setTimeout(resolve, url.includes("first") ? 5 : 0));
      active -= 1;
      const content = url.includes("first") ? "FIRST" : "SECOND";
      return new Response(content, {
        headers: { "content-length": String(content.length) }
      });
    }) as typeof fetch;
    const ref = await resolvePromptMessageRef(fakeMessage({ attachments }), 10 * 1024 * 1024);
    assert.equal(maxActive, 2);
    assert.deepEqual(ref.attachmentExtractions, [
      "first.txt:\nFIRST",
      "second.txt:\nSECOND"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
