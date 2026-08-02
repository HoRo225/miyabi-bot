import assert from "node:assert/strict";
import type { Message } from "discord.js";
import test from "node:test";
import { activeAiRequestCount, handleAiMessage, stopAiRuntime } from "./ai-message-runtime.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

type MessageState = {
  replies: unknown[];
  typing: number;
};

function responseOk(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "OK" } }]
  }), { headers: { "content-type": "application/json" } });
}

function stateOf(message: Message): MessageState {
  return (message as Message & { state: MessageState }).state;
}

function makeMessage(id: string, userId: string): Message {
  const state: MessageState = { replies: [], typing: 0 };
  let replyIndex = 0;
  const channel = {
    parentId: null,
    sendTyping: async () => {
      state.typing += 1;
    },
    send: async () => ({ id: `${id}-follow-up-${++replyIndex}` })
  };
  const message = {
    id,
    guildId: "guild",
    channelId: "channel",
    content: `<@bot> timeout-${id}`,
    author: { id: userId, bot: false, username: userId },
    member: null,
    channel,
    mentions: { users: { has: (value: string) => value === "bot" } },
    attachments: new Map(),
    embeds: [],
    components: [],
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    url: `https://discord.com/channels/guild/channel/${id}`,
    client: { user: { id: "bot" } },
    reference: null,
    reply: async (payload: unknown) => {
      state.replies.push(payload);
      return { id: `${id}-reply-${++replyIndex}` };
    },
    fetchReference: async () => null,
    state
  } as unknown as Message & { state: MessageState };
  return message;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function waitImmediateFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("integration test immediate timeout");
}

test("AI queue timeout expires cleanly and typing stops", async (t) => {
  const originalFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  let providerCalls = 0;
  const settingValues: Record<string, string> = {
    ai_enabled: "true",
    ai_model: "test-model",
    ai_cooldown_seconds: "10",
    ai_max_in_flight: "1",
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
    logAiRequest: () => 1,
    recordAiResponseMessages: () => undefined,
    aiResponseChain: () => undefined
  } as unknown as Store;
  const config = {
    guildIds: ["guild"],
    adminUserIds: new Set(["u1", "u2", "u3"]),
    adminRoleIds: new Set<string>(),
    aiSettingsUserIds: new Set<string>(),
    aiSettingsRoleIds: new Set<string>(),
    databasePath: "timeout.sqlite",
    aiBaseUrl: "https://provider.example",
    aiApiKey: "test-key",
    aiModel: "test-model",
    replyMentionUser: false
  } as unknown as Config;

  globalThis.fetch = (async () => {
    providerCalls += 1;
    return new Promise<Response>((resolve) => {
      pending.push(resolve);
    });
  }) as typeof fetch;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

  try {
    const held = makeMessage("held", "u1");
    await handleAiMessage(held, store, config);
    await flushMicrotasks();
    assert.equal(activeAiRequestCount(), 1);
    assert.equal(providerCalls, 1);
    assert.equal(pending.length, 1);
    assert.equal(stateOf(held).typing, 1);

    const queued = makeMessage("queued", "u2");
    await handleAiMessage(queued, store, config);
    await flushMicrotasks();
    assert.equal(activeAiRequestCount(), 1);
    assert.equal(providerCalls, 1);
    assert.equal(stateOf(queued).replies.length, 0);
    assert.equal(stateOf(queued).typing, 1);

    t.mock.timers.tick(8_000); await flushMicrotasks();
    assert.equal(stateOf(held).typing, 2);
    assert.equal(stateOf(queued).typing, 2);
    t.mock.timers.tick(8_000); await flushMicrotasks();
    assert.equal(stateOf(held).typing, 3);
    assert.equal(stateOf(queued).typing, 3);
    t.mock.timers.tick(8_000); await flushMicrotasks();
    assert.equal(stateOf(held).typing, 4);
    assert.equal(stateOf(queued).typing, 4);

    t.mock.timers.tick(6_000);
    await flushMicrotasks();
    assert.equal(activeAiRequestCount(), 1);
    assert.equal(providerCalls, 1);
    assert.equal(stateOf(queued).replies.length, 1);
    assert.match(String((stateOf(queued).replies[0] as { content?: unknown }).content), /AI-QUEUE-001/);
    assert.equal(stateOf(held).typing, 4);
    assert.equal(stateOf(queued).typing, 4);

    const newcomer = makeMessage("newcomer", "u3");
    await handleAiMessage(newcomer, store, config);
    await flushMicrotasks();
    assert.equal(stateOf(newcomer).replies.length, 0);
    assert.equal(providerCalls, 1);
    assert.equal(stateOf(newcomer).typing, 1);

    const releaseHeld = pending.shift();
    assert.ok(releaseHeld);
    releaseHeld(responseOk());
    await waitImmediateFor(() => activeAiRequestCount() === 1 && providerCalls === 2 && pending.length === 1);
    await flushMicrotasks();
    assert.equal(activeAiRequestCount(), 1);
    assert.equal(providerCalls, 2);
    assert.equal(pending.length, 1);
    assert.equal(stateOf(newcomer).typing, 1);

    t.mock.timers.tick(8_000); await flushMicrotasks();
    assert.equal(stateOf(held).typing, 4);
    assert.equal(stateOf(newcomer).typing, 2);

    const releaseNewcomer = pending.shift();
    assert.ok(releaseNewcomer);
    releaseNewcomer(responseOk());
    await waitImmediateFor(() => activeAiRequestCount() === 0);
    await flushMicrotasks();
    assert.equal(activeAiRequestCount(), 0);
    assert.equal(stateOf(newcomer).typing, 2);

    t.mock.timers.tick(8_000); await flushMicrotasks();
    assert.equal(stateOf(held).typing, 4);
    assert.equal(stateOf(queued).typing, 4);
    assert.equal(stateOf(newcomer).typing, 2);
  } finally {
    for (const resolve of pending.splice(0)) resolve(responseOk());
    await flushMicrotasks();
    await stopAiRuntime();
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});
