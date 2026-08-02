import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits, type VoiceState } from "discord.js";
import {
  handleVoiceStateUpdate,
  startVoiceRuntime,
  stopVoiceRuntime,
  voiceRuntimeStatus
} from "./voice.js";

type Settings = {
  enabled: boolean;
  triggerChannelId: string | null;
  nameTemplate: string;
  userLimit: number;
  ownerManage: boolean;
};

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    enabled: true,
    triggerChannelId: "trigger",
    nameTemplate: "{user} 的頻道",
    userLimit: 0,
    ownerManage: false,
    ...overrides
  };
}

function makeStore(value: Settings, tracked: string[] = [], present = new Set<string>(), blocked = false) {
  const removed: string[] = [];
  const added: string[] = [];
  return {
    removed,
    added,
    isVoiceAccessBlocked: () => blocked,
    setVoiceAccessBlocked: (value: boolean) => { blocked = value; },
    voiceSettings: () => value,
    addTempVoiceChannel: (channelId: string) => { added.push(channelId); },
    removeTempVoiceChannel: (channelId: string) => {
      removed.push(channelId);
      const index = tracked.indexOf(channelId);
      if (index >= 0) tracked.splice(index, 1);
    },
    tempVoiceChannel: (channelId: string) => present.has(channelId) ? { channelId } : undefined,
    listTempVoiceChannelIds: () => [...tracked]
  };
}

function makeGuild(trigger: unknown, create: (options: Record<string, unknown>) => Promise<unknown>) {
  return {
    id: "guild",
    channels: {
      cache: new Map(trigger ? [["trigger", trigger]] : []),
      fetch: async () => trigger,
      create
    }
  };
}

function makeClient(guild: ReturnType<typeof makeGuild>) {
  const client = {
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: { fetch: async () => null }
  };
  (guild as unknown as { client: typeof client }).client = client;
  return client;
}

function voiceState(guild: ReturnType<typeof makeGuild>, channelId: string | null, channel: unknown, member: unknown): VoiceState {
  return { guild, channelId, channel, member } as unknown as VoiceState;
}

function triggerChannel(members = new Set<string>()) {
  return {
    type: ChannelType.GuildVoice,
    parentId: null,
    members,
    permissionOverwrites: { cache: { map: () => [] } }
  };
}

function member(canConnect = true) {
  return {
    id: "owner",
    displayName: "Owner",
    user: { bot: false },
    permissions: { has: () => canConnect },
    voice: { setChannel: async () => undefined }
  };
}

async function begin(store: ReturnType<typeof makeStore>, guild: ReturnType<typeof makeGuild>) {
  await startVoiceRuntime(makeClient(guild) as never, store);
}

test("voice requires native Connect and always grants owner management permissions", async () => {
  let creates = 0;
  let options: Record<string, unknown> | undefined;
  const created = { id: "temporary", delete: async () => undefined };
  const trigger = triggerChannel();
  const guild = makeGuild(trigger, async (value) => {
    creates += 1;
    options = value;
    return created;
  });
  const store = makeStore(settings());
  await begin(store, guild);
  store.removed.length = 0;

  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member(false)),
    store
  );
  assert.equal(creates, 0);

  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member(true)),
    store
  );
  assert.equal(creates, 1);
  const overwrites = options?.permissionOverwrites as Array<{ id: string; allow: bigint }>;
  const owner = overwrites.find((overwrite) => overwrite.id === "owner");
  assert.ok(owner);
  assert.equal(
    owner.allow & (PermissionFlagsBits.ManageChannels | PermissionFlagsBits.MoveMembers),
    PermissionFlagsBits.ManageChannels | PermissionFlagsBits.MoveMembers
  );
});

test("owner leaving a populated temporary channel does not transfer or delete it", async () => {
  let deletes = 0;
  const channel = triggerChannel(new Set(["other"]));
  const temporary = { ...channel, id: "temporary", delete: async () => { deletes += 1; } };
  const guild = makeGuild(triggerChannel(), async () => ({ id: "unused", delete: async () => undefined }));
  const store = makeStore(settings(), ["temporary"], new Set(["temporary"]));
  await begin(store, guild);
  store.removed.length = 0;

  await handleVoiceStateUpdate(
    voiceState(guild, "temporary", temporary, member()),
    voiceState(guild, null, null, null),
    store
  );
  assert.equal(deletes, 0);
  assert.deepEqual(store.removed, []);
});

test("empty temporary channels are deleted immediately", async () => {
  let deletes = 0;
  const channel = { ...triggerChannel(new Set()), id: "temporary", delete: async () => { deletes += 1; } };
  const guild = makeGuild(triggerChannel(), async () => ({ id: "unused", delete: async () => undefined }));
  const store = makeStore(settings(), ["temporary"], new Set(["temporary"]));
  await begin(store, guild);
  store.removed.length = 0;

  await handleVoiceStateUpdate(
    voiceState(guild, "temporary", channel, member()),
    voiceState(guild, null, null, null),
    store
  );
  assert.equal(deletes, 1);
  assert.deepEqual(store.removed, ["temporary"]);
});

test("startup cleanup removes tracked empty or missing channels and keeps populated ones", async () => {
  let emptyDeletes = 0;
  const empty = { type: ChannelType.GuildVoice, members: new Set<string>(), id: "empty", delete: async () => { emptyDeletes += 1; } };
  const busy = { type: ChannelType.GuildVoice, members: new Set(["other"]), id: "busy", delete: async () => undefined };
  const guild = makeGuild(triggerChannel(), async () => ({ id: "unused", delete: async () => undefined }));
  const store = makeStore(settings(), ["empty", "busy", "gone"], new Set());
  const client = {
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: {
      fetch: async (id: string) => id === "empty" ? empty : id === "busy" ? busy : { code: 10003 }
    }
  };
  await startVoiceRuntime(client as never, store);
  assert.equal(emptyDeletes, 1);
  assert.deepEqual(store.removed, ["empty", "gone"]);
  assert.deepEqual(store.listTempVoiceChannelIds(), ["busy"]);
});

test("invalid trigger marks degraded and blocks creation", async () => {
  let creates = 0;
  const guild = makeGuild(null, async () => {
    creates += 1;
    return { id: "temporary", delete: async () => undefined };
  });
  const store = makeStore(settings());
  const client = makeClient(guild);
  await startVoiceRuntime(client as never, store);
  assert.deepEqual(voiceRuntimeStatus(), { state: "degraded", errorCode: "VOICE-TRIGGER-001" });

  const trigger = triggerChannel();
  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member()),
    store
  );
  assert.equal(creates, 0);
});

test("voice access gate failure remains fail-closed with the trigger fallback code", async () => {
  let creates = 0;
  const trigger = triggerChannel();
  const guild = makeGuild(trigger, async () => {
    creates += 1;
    return { id: "temporary", delete: async () => undefined };
  });
  const store = makeStore(settings());
  store.isVoiceAccessBlocked = () => { throw new Error("store unavailable"); };
  await startVoiceRuntime(makeClient(guild) as never, store);
  assert.deepEqual(voiceRuntimeStatus(), { state: "degraded", errorCode: "VOICE-TRIGGER-001" });
  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member()),
    store
  );
  assert.equal(creates, 0);
});

test("blocked valid trigger is fail-closed, cleans empty tracked channels, and reopens after validation clears", async () => {
  let creates = 0;
  let deletes = 0;
  const trigger = triggerChannel();
  const empty = { type: ChannelType.GuildVoice, members: new Set<string>(), id: "empty", delete: async () => { deletes += 1; } };
  const busy = { type: ChannelType.GuildVoice, members: new Set(["other"]), id: "busy", delete: async () => undefined };
  const guild = makeGuild(trigger, async () => {
    creates += 1;
    return { id: "temporary", delete: async () => undefined };
  });
  const store = makeStore(settings(), ["empty", "busy"], new Set(), true);
  const client = {
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: {
      fetch: async (id: string) => id === "empty" ? empty : id === "busy" ? busy : null
    }
  };
  (guild as unknown as { client: typeof client }).client = client;

  await startVoiceRuntime(client as never, store);
  assert.deepEqual(voiceRuntimeStatus(), { state: "degraded", errorCode: "DISCORD-ID-002" });
  assert.equal(creates, 0);
  assert.equal(deletes, 1);
  assert.deepEqual(store.listTempVoiceChannelIds(), ["busy"]);

  store.setVoiceAccessBlocked(false);
  await startVoiceRuntime(client as never, store);
  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member()),
    store
  );
  assert.equal(creates, 1);
});

test("runtime transition to blocked stops new creation and only removes tracked empty channels", async () => {
  let creates = 0;
  let deletes = 0;
  const trigger = triggerChannel();
  const empty = { type: ChannelType.GuildVoice, members: new Set<string>(), id: "empty", delete: async () => { deletes += 1; } };
  const busy = { type: ChannelType.GuildVoice, members: new Set(["other"]), id: "busy", delete: async () => undefined };
  const guild = makeGuild(trigger, async () => {
    creates += 1;
    return { id: "temporary", delete: async () => undefined };
  });
  const store = makeStore(settings(), ["empty", "busy"], new Set(), false);
  const client = {
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: {
      fetch: async (id: string) => id === "empty" ? empty : id === "busy" ? busy : null
    }
  };
  (guild as unknown as { client: typeof client }).client = client;
  await startVoiceRuntime(client as never, store);
  store.setVoiceAccessBlocked(true);

  await handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member()),
    store
  );
  assert.deepEqual(voiceRuntimeStatus(), { state: "degraded", errorCode: "DISCORD-ID-002" });
  assert.equal(creates, 0);
  assert.equal(deletes, 1);
  assert.deepEqual(store.listTempVoiceChannelIds(), ["busy"]);
});

test("stop prevents a late channel create from being persisted", async () => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  let deletes = 0;
  const trigger = triggerChannel();
  const guild = makeGuild(trigger, () => new Promise((resolve) => { resolveCreate = resolve; }));
  const store = makeStore(settings());
  await begin(store, guild);
  store.removed.length = 0;

  const pending = handleVoiceStateUpdate(
    voiceState(guild, null, null, null),
    voiceState(guild, "trigger", trigger, member()),
    store
  );
  await Promise.resolve();
  stopVoiceRuntime();
  resolveCreate?.({ id: "late", delete: async () => { deletes += 1; } });
  await pending;
  assert.equal(deletes, 1);
  assert.deepEqual(store.added, []);

  await begin(store, guild);
  store.removed.length = 0;
});
