import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "discord.js";
import type { Config } from "./config.js";
import { aiAccessForMessage } from "./discord-message-runtime.js";
import type { Store } from "./store.js";

const channelId = "123456789012345678";
const roleId = "223456789012345678";

function config(overrides: Partial<Config> = {}): Config {
  return {
    token: "token",
    clientId: "client",
    guildIds: ["guild"],
    adminUserIds: new Set(),
    adminRoleIds: new Set(),
    aiSettingsUserIds: new Set(),
    aiSettingsRoleIds: new Set(),
    databasePath: ":memory:",
    aiBaseUrl: "https://provider.example",
    aiApiKey: "key",
    aiModel: "model",
    replyMentionUser: true,
    ...overrides
  };
}

function store(blocked: boolean, enabled = true): Store {
  return {
    setting: (key: string) => key === "ai_enabled" ? String(enabled) : undefined,
    listAllowedChannels: () => [channelId],
    listAllowedRoles: () => [roleId],
    isAiAccessBlocked: () => blocked
  } as unknown as Store;
}

function message(authorId: string, roles: string[] = [], thread = false): Message {
  return {
    channelId,
    channel: { parentId: null, isThread: () => thread },
    member: roles.length ? { roles } : null,
    author: { id: authorId, bot: false },
    webhookId: null,
    system: false
  } as unknown as Message;
}

test("invalid configured AI state blocks an admin on an otherwise valid channel", () => {
  const result = aiAccessForMessage(
    message("admin-user"),
    store(true),
    config({ adminUserIds: new Set(["admin-user"]) })
  );
  assert.deepEqual(result, { ok: false, reason: "channel" });
});

test("invalid configured AI state blocks a role-authorized user on every valid channel", () => {
  const result = aiAccessForMessage(
    message("ordinary-user", [roleId]),
    store(true),
    config()
  );
  assert.deepEqual(result, { ok: false, reason: "channel" });
});

test("fail-closed gate runs before disabled and thread-specific access decisions", () => {
  assert.deepEqual(
    aiAccessForMessage(message("ordinary-user", [roleId], true), store(true, false), config()),
    { ok: false, reason: "channel" }
  );
});

test("valid access remains unchanged when the fail-closed gate is clear", () => {
  assert.deepEqual(
    aiAccessForMessage(message("ordinary-user", [roleId]), store(false), config()),
    { ok: true }
  );
});

test("invalid AI manager role scope fails closed while direct user repair stays channel-scoped", () => {
  const invalidScope = {
    admin: { valid: false, errorCode: "DISCORD-ID-002" },
    aiSettings: { valid: false, errorCode: "DISCORD-ID-002" }
  } as const;
  const managerConfig = config({
    adminRoleIds: new Set(["admin-role"]),
    aiSettingsRoleIds: new Set(["ai-manager-role"]),
    aiSettingsUserIds: new Set(["ai-user"]),
    roleAuthorization: invalidScope
  });
  assert.deepEqual(aiAccessForMessage(message("role-admin", ["admin-role"]), store(false), managerConfig), { ok: false, reason: "role" });
  assert.deepEqual(aiAccessForMessage(message("role-manager", ["ai-manager-role"]), store(false), managerConfig), { ok: false, reason: "role" });
  assert.deepEqual(aiAccessForMessage(message("ai-user"), store(false), managerConfig), { ok: true });
  const channelBlockedStore = {
    setting: (key: string) => key === "ai_enabled" ? "true" : undefined,
    listAllowedChannels: () => [],
    listAllowedRoles: () => [],
    isAiAccessBlocked: () => false
  } as unknown as Store;
  assert.deepEqual(aiAccessForMessage(message("ai-user"), channelBlockedStore, managerConfig), { ok: false, reason: "channel" });
});
