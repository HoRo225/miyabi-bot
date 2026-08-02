import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Interaction, Message } from "discord.js";
import { parseModelOptionsFromModelsResponse } from "./ai-provider.js";
import { aiError, callAiProvider, callAiProviderTurn, fetchAiModelOptions } from "./ai-service.js";
import type { Config } from "./config.js";
import { aiModelSelectPanelUpdate, aiProviderStatusPanelUpdate, aiSettingsPanelMessage } from "./control-panels.js";
import { roleSelect } from "./discord-ui.js";
import { discordAttachmentUrl } from "./guards.js";
import { attachmentLimitError, resolvePromptMessageRef } from "./prompt-message-ref.js";
import { Store } from "./store.js";

const config: Config = {
  token: "token",
  clientId: "client",
  guildIds: ["guild"],
  adminUserIds: new Set(),
  adminRoleIds: new Set(),
  aiSettingsUserIds: new Set(),
  aiSettingsRoleIds: new Set(),
  databasePath: "bot.sqlite",
  aiBaseUrl: "https://provider.example",
  aiApiKey: "env-key",
  aiModel: "env-model",
  replyMentionUser: true,
};


test("chat requests use env credentials, max_tokens, and a 1 MiB response cap", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let authorization = "";
  let requestBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const settings = new Map([
      ["ai_base_url", "https://database.example/v1"],
      ["ai_api_key", "database-key"],
      ["ai_model", "selected-model"]
    ]);
    await callAiProvider({ setting: (key) => settings.get(key) }, config, [{ role: "user", content: "ping" }]);
    assert.equal(requestedUrl, "https://provider.example/v1/chat/completions");
    assert.equal(authorization, "Bearer env-key");
    assert.equal(requestBody.model, "selected-model");
    assert.equal(requestBody.max_tokens, 2_000);
    assert.equal("temperature" in requestBody, false);
    assert.equal("top_p" in requestBody, false);
    assert.equal("top_k" in requestBody, false);
    assert.equal("presence_penalty" in requestBody, false);
    assert.equal("frequency_penalty" in requestBody, false);

    globalThis.fetch = (async () => new Response("{}", {
      headers: { "content-length": String(1024 * 1024 + 1) }
    })) as typeof fetch;
    await assert.rejects(
      () => callAiProvider({ setting: () => "selected-model" }, config, [{ role: "user", content: "ping" }]),
      (error) => aiError(error).logType === "ai_provider_body_too_large"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failures expose only fixed error categories", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("upstream-secret-body", { status: 502 })) as typeof fetch;
    await assert.rejects(
      () => callAiProvider({ setting: () => "model" }, config, [{ role: "user", content: "ping" }]),
      (error: unknown) => {
        const normalized = aiError(error);
        assert.equal(normalized.logType, "ai_provider_http_502");
        assert.doesNotMatch(normalized.message, /upstream-secret-body/);
        return true;
      }
    );

    globalThis.fetch = (async () => new Response("not-json", {
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
    await assert.rejects(
      () => callAiProvider({ setting: () => "model" }, config, [{ role: "user", content: "ping" }]),
      (error: unknown) => aiError(error).logType === "ai_provider_invalid_response"
    );

    globalThis.fetch = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    await assert.rejects(
      () => callAiProvider({ setting: () => "model" }, config, [{ role: "user", content: "ping" }]),
      (error: unknown) => aiError(error).logType === "ai_provider_request_failed"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider rejects non-empty assistant prefill before network call", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await assert.rejects(
      () => callAiProviderTurn({ setting: () => "model" }, config, [
        { role: "user", content: "question" },
        { role: "assistant", content: "prefilled answer" }
      ]),
      (error: unknown) => aiError(error).logType === "assistant_prefill_not_allowed"
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider rejects assistant prefill before trailing empty user turn", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await assert.rejects(
      () => callAiProviderTurn({ setting: () => "model" }, config, [
        { role: "user", content: "question" },
        { role: "assistant", content: "prefilled answer" },
        { role: "user", content: "   " }
      ]),
      (error: unknown) => aiError(error).logType === "assistant_prefill_not_allowed"
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool turns send fixed tool schemas and disable parallel tool calls", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "probe", arguments: "{}" } }]
          },
          finish_reason: "tool_calls"
        }]
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await callAiProviderTurn({ setting: () => "model" }, config, [{ role: "user", content: "probe" }], [{
      type: "function",
      function: {
        name: "probe",
        description: "probe",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
      }
    }]);
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.equal(requestBody.tool_choice, "auto");
    assert.equal((requestBody.tools as unknown[]).length, 1);
    assert.equal(result.toolCalls[0].function.name, "probe");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model parser keeps the complete provider catalog", () => {
  const options = parseModelOptionsFromModelsResponse({
    data: Array.from({ length: 250 }, (_, index) => ({ id: `model-${index}` }))
  });
  assert.equal(options.length, 250);
  assert.equal(options.at(-1)?.value, "model-249");
});

test("provider root endpoint uses the OpenAI v1 models path", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "model" }] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const options = await fetchAiModelOptions(config);
    assert.equal(requestedUrl, "https://provider.example/v1/models");
    assert.equal(options[0]?.value, "model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment URLs only allow HTTPS Discord CDN hosts", () => {
  assert.equal(discordAttachmentUrl("https://cdn.discordapp.com/attachments/file.txt").ok, true);
  assert.equal(discordAttachmentUrl("https://media.discordapp.net/attachments/file.txt").ok, true);
  assert.deepEqual(discordAttachmentUrl("http://cdn.discordapp.com/attachments/file.txt"), { ok: false, errorType: "unsupported_scheme" });
  assert.deepEqual(discordAttachmentUrl("https://example.com/file.txt"), { ok: false, errorType: "blocked_host" });
});

test("unsupported text attachment URL returns fixed guard error", () => {
  const message = {
    attachments: new Map([["attachment", {
      id: "attachment",
      name: "notes.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://example.com/notes.txt"
    }]])
  } as unknown as Message;
  assert.match(attachmentLimitError([message], 128 * 1024) ?? "", /AI-ATTACHMENT-001/);
});

test("ordinary message URLs are never fetched", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("unexpected");
    }) as typeof fetch;
    const message = {
      id: "message",
      channelId: "channel",
      author: { id: "user", username: "HoRo" },
      content: "請看 https://example.com/private",
      createdAt: new Date("2026-07-10T00:00:00.000Z"),
      url: "https://discord.com/channels/guild/channel/message",
      attachments: new Map()
    } as unknown as Message;
    const ref = await resolvePromptMessageRef(message, 128 * 1024);
    assert.equal(fetchCount, 0);
    assert.equal(ref.content, "請看 https://example.com/private");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text attachments allow one Discord CDN redirect and enforce 128 KiB without persistence", async () => {
  const originalFetch = globalThis.fetch;
  const attachment = {
    id: "attachment",
    name: "notes.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.discordapp.com/attachments/notes.txt"
  };
  const message = {
    id: "message",
    channelId: "channel",
    author: { id: "user", username: "HoRo" },
    content: "分析附件",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    url: "https://discord.com/channels/guild/channel/message",
    attachments: new Map([[attachment.id, attachment]])
  } as unknown as Message;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? new Response(null, { status: 302, headers: { location: "https://media.discordapp.net/attachments/notes.txt" } })
        : new Response("hello", { headers: { "content-length": "5" } });
    }) as typeof fetch;
    const ref = await resolvePromptMessageRef(message, 128 * 1024);
    assert.equal(fetchCount, 2);
    assert.deepEqual(ref.attachmentExtractions, ["notes.txt:\nhello"]);

    globalThis.fetch = (async () => new Response("too large", {
      headers: { "content-length": String(128 * 1024 + 1) }
    })) as typeof fetch;
    const oversized = await resolvePromptMessageRef(message, 128 * 1024);
    assert.equal(oversized.attachmentExtractions, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("overflow selectors are explicitly read-only", () => {
  const component = roleSelect("roles", "roles", Array.from({ length: 26 }, (_, index) => String(index)), true);
  assert.equal(component.disabled, true);
  assert.equal((component.default_values as unknown[]).length, 25);
});

test("AI settings panel only exposes 9router controls", () => {
  const store: Parameters<typeof aiSettingsPanelMessage>[1] = {
    setting: () => undefined,
    listSettingsAllowedRoles: () => [],
    voiceSettings: () => ({}) as never,
    steamFreeSettings: () => ({}) as never,
    isSettingsAccessBlocked: () => false,
    adminStats: () => ({ aiRequestLogs: 0, aiResponseMessages: 0, auditLogs: 0, allowedChannels: 0, allowedRoles: 0, settingsRoles: 0 })
  };
  const panel = JSON.stringify(aiSettingsPanelMessage({} as Interaction, store, {
    ...config,
    databasePath: join(tmpdir(), "missing-9router-panel.sqlite")
  }));
  assert.match(panel, /9router/);
  assert.match(panel, /ai:provider-refresh/);
  assert.match(panel, /ai:test/);
  assert.doesNotMatch(panel, /ai:test-agent|ai:runtime|ai:role|ai:channel|ai:memory|ai:backfill/);
});

test("AI provider panel lists existing 9router keys without exposing key values", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-key-panel-"));
  try {
    const databasePath = join(dir, "bot.sqlite");
    writeFileSync(join(dir, "9router-api-keys.json"), JSON.stringify({
      updatedAt: "2026-07-11T00:00:00Z",
      appliedId: "f98279fb-7d96-423b-8e80-7a2e3cf7c1db",
      keys: [{ id: "f98279fb-7d96-423b-8e80-7a2e3cf7c1db", name: "Existing key", createdAt: "2026-07-10T00:00:00Z", key: "secret-must-not-render" }]
    }));
    const store = new Store(databasePath);
    const panel = JSON.stringify(aiSettingsPanelMessage({} as Interaction, store, { ...config, databasePath }));
    assert.match(panel, /ai:key:select/);
    assert.match(panel, /Existing key/);
    assert.doesNotMatch(panel, /secret-must-not-render/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI provider failure panel keeps the 9router key selector", () => {
  const panel = JSON.stringify(aiProviderStatusPanelUpdate("models failed", {
    updatedAt: "2026-07-11T00:00:00Z",
    appliedId: "f98279fb-7d96-423b-8e80-7a2e3cf7c1db",
    overflow: false,
    keys: [{
      id: "f98279fb-7d96-423b-8e80-7a2e3cf7c1db",
      name: "Existing key",
      createdAt: "2026-07-10T00:00:00Z"
    }]
  }, "f98279fb-7d96-423b-8e80-7a2e3cf7c1db"));
  assert.match(panel, /ai:key:select/);
  assert.match(panel, /Existing key/);
});

test("AI model result panel omits the removed Agent tools action", () => {
  const panel = JSON.stringify(aiModelSelectPanelUpdate("model", [{ label: "model", value: "model" }]));
  assert.match(panel, /ai:test/);
  assert.doesNotMatch(panel, /ai:test-agent/);
});
