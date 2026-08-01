import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type VoiceState
} from "discord.js";
import {
  clampInteger,
  settingBoolean,
  settingNumber,
  type EnvLike
} from "./config.js";

const DEFAULT_VOICE_NAME_TEMPLATE = "{user} 的頻道";
// ponytail: the bot is single-process, so an in-memory lock is the complete coordination boundary.
const voiceChannelCreates = new Set<string>();

export type VoiceSettings = {
  enabled: boolean;
  triggerChannelId: string | null;
  nameTemplate: string;
  userLimit: number;
  ownerManage: boolean;
};

export function resolveVoiceSettings(settings: EnvLike): VoiceSettings {
  return {
    enabled: settingBoolean(settings.enabled, false),
    triggerChannelId: settings.trigger_channel_id?.trim() || null,
    nameTemplate: normalizeVoiceNameTemplate(settings.name_template),
    userLimit: clampInteger(settingNumber(settings.user_limit, 0), 0, 99),
    ownerManage: settingBoolean(settings.owner_manage, true)
  };
}

export function normalizeVoiceNameTemplate(value: string | undefined): string {
  return (value?.replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim() || DEFAULT_VOICE_NAME_TEMPLATE).slice(0, 100);
}

export function voiceStatusLabel(settings: VoiceSettings): string {
  if (!settings.enabled) return "關閉";
  return settings.triggerChannelId ? "可用" : "未完成設定";
}

export function renderVoiceChannelName(template: string, displayName: string): string {
  const safeUser = displayName.replace(/[\r\n]/g, " ").trim() || "User";
  const rendered = template.replaceAll("{user}", safeUser).replace(/\s+/g, " ").trim();
  return (rendered || DEFAULT_VOICE_NAME_TEMPLATE.replaceAll("{user}", safeUser)).slice(0, 100);
}

type VoiceRuntimeStore = {
  voiceSettings(): VoiceSettings;
  addTempVoiceChannel(channelId: string, guildId: string, ownerId: string, triggerChannelId: string): void;
  removeTempVoiceChannel(channelId: string): void;
  tempVoiceChannel(channelId: string): unknown;
  listTempVoiceChannelIds(): string[];
};

function uniqueVoiceChannelName(guild: VoiceState["guild"], baseName: string): string {
  const names = new Set([...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildVoice)
    .map((channel) => channel.name));
  if (!names.has(baseName)) return baseName;
  for (let index = 2; index < 100; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${baseName.slice(0, 100 - suffix.length)}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${baseName.slice(0, 93)} ${Date.now() % 100_000}`;
}

function tempVoicePermissionOverwrites(trigger: NonNullable<VoiceState["channel"]>, ownerId: string, ownerManage: boolean) {
  const overwrites = trigger.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield
  }));
  if (!ownerManage) return overwrites;

  const ownerPermissions = PermissionFlagsBits.ManageChannels | PermissionFlagsBits.MoveMembers;
  const ownerOverwrite = overwrites.find((overwrite) => overwrite.id === ownerId);
  if (ownerOverwrite) {
    ownerOverwrite.allow |= ownerPermissions;
    ownerOverwrite.deny &= ~ownerPermissions;
  } else {
    overwrites.push({
      id: ownerId,
      type: OverwriteType.Member,
      allow: ownerPermissions,
      deny: 0n
    });
  }
  return overwrites;
}

async function createTempVoiceChannel(state: VoiceState, store: VoiceRuntimeStore, settings: VoiceSettings): Promise<void> {
  if (!settings.enabled || !settings.triggerChannelId || state.channelId !== settings.triggerChannelId) return;
  const member = state.member;
  const trigger = state.channel;
  if (!member || member.user.bot || !trigger || trigger.type !== ChannelType.GuildVoice) return;

  const lockKey = `${state.guild.id}:${member.id}`;
  if (voiceChannelCreates.has(lockKey)) return;
  voiceChannelCreates.add(lockKey);

  try {
    const baseName = renderVoiceChannelName(settings.nameTemplate, member.displayName);
    const channel = await state.guild.channels.create({
      name: uniqueVoiceChannelName(state.guild, baseName),
      type: ChannelType.GuildVoice,
      parent: trigger.parentId ?? undefined,
      userLimit: settings.userLimit,
      permissionOverwrites: tempVoicePermissionOverwrites(trigger, member.id, settings.ownerManage),
      reason: "Horo dynamic voice"
    });

    try {
      store.addTempVoiceChannel(channel.id, state.guild.id, member.id, settings.triggerChannelId);
      await member.voice.setChannel(channel, "Horo dynamic voice");
    } catch (error) {
      await deleteTrackedTempVoiceChannel(store, channel, "Horo dynamic voice setup failed");
      throw error;
    }
  } finally {
    voiceChannelCreates.delete(lockKey);
  }
}

async function deleteTrackedTempVoiceChannel(store: VoiceRuntimeStore, channel: { id: string; delete(reason?: string): Promise<unknown> }, reason: string): Promise<void> {
  try {
    await channel.delete(reason);
    store.removeTempVoiceChannel(channel.id);
  } catch {
    // Keep the DB row so the next cleanup pass can retry.
  }
}

async function cleanupTempVoiceChannel(state: VoiceState, store: VoiceRuntimeStore): Promise<void> {
  const channelId = state.channelId;
  if (!channelId || !store.tempVoiceChannel(channelId)) return;
  const channel = state.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    store.removeTempVoiceChannel(channelId);
    return;
  }
  if (channel.members.size > 0) return;
  await deleteTrackedTempVoiceChannel(store, channel, "Horo dynamic voice empty");
}

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState, store: VoiceRuntimeStore): Promise<void> {
  if (oldState.channelId === newState.channelId) return;
  await cleanupTempVoiceChannel(oldState, store);
  await createTempVoiceChannel(newState, store, store.voiceSettings());
}

export async function cleanupKnownTempVoiceChannels(client: Client, store: VoiceRuntimeStore): Promise<void> {
  for (const channelId of store.listTempVoiceChannelIds()) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      store.removeTempVoiceChannel(channelId);
      continue;
    }
    if (channel.members.size === 0) {
      await deleteTrackedTempVoiceChannel(store, channel, "Horo dynamic voice startup cleanup");
    }
  }
}
