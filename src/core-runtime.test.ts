import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, type VoiceState } from "discord.js";
import { Store } from "./store.js";
import { handleVoiceStateUpdate } from "./voice.js";

test("runtime settings reject provider secrets and selector writes fail at 25", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyabi-core-"));
  try {
    const store = new Store(join(dir, "bot.sqlite"));
    const actor = { id: "admin", name: "Admin" };
    store.setRuntimeSetting("ai_model", "model", actor);
    store.setRuntimeSetting("ai_9router_key_id", "f98279fb-7d96-423b-8e80-7a2e3cf7c1db", actor);
    assert.equal(store.setting("ai_9router_key_id"), "f98279fb-7d96-423b-8e80-7a2e3cf7c1db");
    assert.throws(() => store.setRuntimeSetting("ai_api_key", "secret", actor), /runtime_setting_not_allowed/);
    for (let index = 0; index < 25; index += 1) store.addRole(`role-${index}`, actor);
    assert.throws(() => store.addRole("role-25", actor), /limit_reached/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    isVoiceAccessBlocked: () => false,
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
