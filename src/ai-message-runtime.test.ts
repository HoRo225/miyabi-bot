import assert from "node:assert/strict";
import type { Message } from "discord.js";
import test from "node:test";
import { activeAiRequestCount, handleAiMessage, stopAiRuntime } from "./ai-message-runtime.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

type PendingFetch = {
  body: Record<string, unknown>;
  resolve: (response: Response) => void;
};

function responseOk(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "OK" } }]
  }), { headers: { "content-type": "application/json" } });
}

function messageReplies(message: Message): unknown[] {
  return (message as Message & { replies: unknown[] }).replies;
}

function makeMessage(id: string, userId: string, question = `question-${id}`): Message {
  let replyIndex = 0;
  const replies: unknown[] = [];
  const channel = {
    parentId: null,
    sendTyping: async () => undefined,
    send: async () => ({ id: `${id}-follow-up-${++replyIndex}` })
  };
  const message = {
    id,
    guildId: "guild",
    channelId: "channel",
    content: `<@bot> ${question}`,
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
      replies.push(payload);
      return { id: `${id}-reply-${++replyIndex}` };
    },
    fetchReference: async () => null
  } as unknown as Message & { replies: unknown[] };
  message.replies = replies;
  return message;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("integration test timeout");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("AI runtime enforces FIFO admission and stop race safety", async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingFetch[] = [];
  const requests: Record<string, unknown>[] = [];
  const settingValues: Record<string, string> = {
    ai_enabled: "true",
    ai_model: "test-model",
    ai_cooldown_seconds: "10",
    ai_max_in_flight: "2",
    ai_queue_max: "5",
    ai_queue_timeout_seconds: "30",
    ai_recent_context_limit: "5",
    attachment_max_mb: "10",
    ai_response_max_chars: "12000"
  };
  let requestLogId = 0;
  let aiResponseChainCalls = 0;
  const store = {
    setting: (key: string) => settingValues[key],
    listAllowedChannels: () => ["channel"],
    listAllowedRoles: () => [],
    isAiAccessBlocked: () => false,
    logAiRequest: () => ++requestLogId,
    recordAiResponseMessages: () => undefined,
    aiResponseChain: () => { aiResponseChainCalls += 1; return undefined; }
  } as unknown as Store;
  const config = {
    guildIds: ["guild"],
    adminUserIds: new Set(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10", "u11"]),
    adminRoleIds: new Set<string>(),
    aiSettingsUserIds: new Set<string>(),
    aiSettingsRoleIds: new Set<string>(),
    databasePath: "integration.sqlite",
    aiBaseUrl: "https://provider.example",
    aiApiKey: "test-key",
    aiModel: "test-model",
    replyMentionUser: false
  } as unknown as Config;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return new Promise<Response>((resolve) => {
      pending.push({ body, resolve });
    });
  }) as typeof fetch;

  try {
    const initial = Array.from({ length: 7 }, (_, index) =>
      makeMessage(`m${index + 1}`, `u${index + 1}`)
    );
    await Promise.all(initial.map((message) => handleAiMessage(message, store, config)));
    await waitFor(() => activeAiRequestCount() === 2 && pending.length === 2);

    const sameUser = makeMessage("same-user", "u1");
    await handleAiMessage(sameUser, store, config);
    assert.equal(messageReplies(sameUser).length, 1);
    assert.match(String((messageReplies(sameUser)[0] as { content?: unknown }).content), /AI-RATE-001/);

    const queueFull = makeMessage("m8", "u8");
    await handleAiMessage(queueFull, store, config);
    assert.equal(messageReplies(queueFull).length, 1);
    assert.match(String((messageReplies(queueFull)[0] as { content?: unknown }).content), /AI-RATE-001/);
    assert.equal(requests.length, 2);

    const first = pending.shift();
    assert.ok(first);
    first.resolve(responseOk());
    await waitFor(() => messageReplies(initial[0]).length === 1 && requests.length >= 3);

    const queueFullReplies = messageReplies(queueFull).length;
    await handleAiMessage(queueFull, store, config);
    assert.equal(messageReplies(queueFull).length, queueFullReplies);

    const cooldown = makeMessage("cooldown", "u1");
    await handleAiMessage(cooldown, store, config);
    assert.equal(messageReplies(cooldown).length, 1);
    assert.match(String((messageReplies(cooldown)[0] as { content?: unknown }).content), /AI-RATE-001/);

    const duplicateReplies = messageReplies(initial[0]).length;
    await handleAiMessage(initial[0], store, config);
    assert.equal(messageReplies(initial[0]).length, duplicateReplies);

    while (pending.length) {
      const next = pending.shift();
      assert.ok(next);
      next.resolve(responseOk());
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => activeAiRequestCount() === 0);

    assert.equal(requests.length, 8);
    const requestText = requests.map((request) => JSON.stringify(request.messages));
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
      assert.ok(requestText[Number(id.slice(1)) - 1]?.includes(`question-${id}`));
    }

    settingValues.ai_max_in_flight = "1";
    const held = makeMessage("shutdown-held", "u9");
    await handleAiMessage(held, store, config);
    await waitFor(() => activeAiRequestCount() === 1 && pending.length === 1);

    const shutdownQueued = makeMessage("shutdown-queued", "u10");
    await handleAiMessage(shutdownQueued, store, config);
    assert.equal(messageReplies(shutdownQueued).length, 0);
    assert.equal(requests.length, 9);

    const beforeChainCalls = aiResponseChainCalls;
    let referenceStarted = false;
    let resolveReference!: (message: Message | null) => void;
    const referencePromise = new Promise<Message | null>((resolve) => {
      resolveReference = resolve;
    });
    const raceMessage = makeMessage("stop-race", "u11");
    (raceMessage as unknown as {
      reference: unknown;
      fetchReference: () => Promise<Message | null>;
    }).reference = { channelId: "channel", guildId: "guild", messageId: "referenced", type: 0 };
    (raceMessage as unknown as {
      fetchReference: () => Promise<Message | null>;
    }).fetchReference = async () => {
      referenceStarted = true;
      return referencePromise;
    };
    const race = handleAiMessage(raceMessage, store, config);
    await waitFor(() => referenceStarted);

    await stopAiRuntime();
    assert.equal(messageReplies(shutdownQueued).length, 1);
    assert.match(String((messageReplies(shutdownQueued)[0] as { content?: unknown }).content), /AI-QUEUE-002/);
    assert.equal(requests.length, 9);

    resolveReference(null);
    await race;
    assert.equal(requests.length, 9);
    assert.equal(messageReplies(raceMessage).length, 0);
    assert.equal(aiResponseChainCalls, beforeChainCalls);

    const heldFetch = pending.shift();
    assert.ok(heldFetch);
    heldFetch.resolve(responseOk());
    await waitFor(() => activeAiRequestCount() === 0);
  } finally {
    for (let index = 0; index < 20 && activeAiRequestCount() > 0; index += 1) {
      while (pending.length) pending.shift()?.resolve(responseOk());
      await new Promise((resolve) => setImmediate(resolve));
    }
    await stopAiRuntime();
    globalThis.fetch = originalFetch;
  }
});
