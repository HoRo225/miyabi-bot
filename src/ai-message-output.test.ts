import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "discord.js";
import { handleAiMessage, stopAiRuntime } from "./ai-message-runtime.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

test("AI output chunks are bounded, mention-safe, URL-free, and fully indexed", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<{ content?: string; allowedMentions?: { parse?: string[]; repliedUser?: boolean } }> = [];
  let requestLog: Record<string, unknown> | undefined;
  let recorded: { requestLogId: number; messageIds: string[] } | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const providerText = Array.from({ length: 180 }, (_, index) =>
    `part-${index.toString().padStart(3, "0")} @everyone @here <@12345678901234567> <@&123456789012345678> https://discord.com/channels/guild/channel/${index}`
  ).join(" ");
  const channel = {
    id: "channel",
    parentId: null,
    type: 0,
    sendTyping: async () => undefined,
    send: async (options: unknown) => {
      sent.push(options as { content?: string; allowedMentions?: { parse?: string[]; repliedUser?: boolean } });
      return { id: `segment-${sent.length}` };
    },
    messages: { fetch: async () => [] }
  };
  const message = {
    id: "question-current",
    guildId: "guild",
    channelId: "channel",
    channel,
    content: "<@bot> answer this",
    author: { id: "asker", username: "asker", bot: false },
    member: { roles: [] },
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    attachments: new Map(),
    components: [],
    embeds: [],
    client: { user: { id: "bot" } },
    mentions: { users: { has: (id: string) => id === "bot" } },
    reply: async (options: unknown) => {
      sent.push(options as { content?: string; allowedMentions?: { parse?: string[]; repliedUser?: boolean } });
      return { id: `segment-${sent.length}` };
    }
  } as unknown as Message;
  const settings = new Map([["ai_enabled", "true"], ["ai_model", "test-model"]]);
  const store = {
    setting: (key: string) => settings.get(key),
    listAllowedChannels: () => ["channel"],
    listAllowedRoles: () => [],
    aiResponseChain: () => undefined,
    logAiRequest: (input: Record<string, unknown>) => {
      requestLog = input;
      return 7;
    },
    recordAiResponseMessages: (requestLogId: number, messageIds: string[]) => {
      recorded = { requestLogId, messageIds };
    }
  } as unknown as Store;
  const config = {
    token: "token",
    clientId: "client",
    guildIds: ["guild"],
    adminUserIds: new Set<string>(),
    adminRoleIds: new Set<string>(),
    aiSettingsUserIds: new Set(["asker"]),
    aiSettingsRoleIds: new Set<string>(),
    databasePath: "bot.sqlite",
    aiBaseUrl: "https://provider.example",
    aiApiKey: "key",
    aiModel: "test-model",
    replyMentionUser: false
  } as Config;
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: providerText } }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await handleAiMessage(message, store, config);
    for (let index = 0; index < 100 && !recorded; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(requestBody);
    assert.equal(sent.length, Math.ceil(12_000 / 2_000));
    assert.ok(sent.every((payload) => (payload.content?.length ?? 0) <= 2_000));
    assert.ok(sent.reduce((total, payload) => total + (payload.content?.length ?? 0), 0) <= 12_000);
    assert.ok(sent.every((payload) => payload.allowedMentions?.parse?.length === 0));
    assert.ok(sent.every((payload) => !payload.content?.includes("@everyone") && !payload.content?.includes("@here")));
    assert.ok(sent.every((payload) => !/@(?:[!&]?\d{17,20})/.test(payload.content ?? "")));
    assert.ok(sent.every((payload) => !/https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\//i.test(payload.content ?? "")));
    assert.deepEqual(recorded, {
      requestLogId: 7,
      messageIds: sent.map((_payload, index) => `segment-${index + 1}`)
    });
    assert.equal(requestLog?.sourceMessageId, "question-current");
    assert.equal(requestLog?.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
    await stopAiRuntime();
  }
});
