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
import type { StatusKind } from "./discord-ui.js";

const DEFAULT_VOICE_NAME_TEMPLATE = "{user} 的頻道";
const VOICE_TRIGGER_INVALID = "VOICE-TRIGGER-001";
const VOICE_CLEANUP_DEGRADED = "VOICE-CLEANUP-001";
const DISCORD_ID_INVALID = "DISCORD-ID-002";
// ponytail: the bot is single-process, so an in-memory lock is the complete coordination boundary.
const voiceChannelCreates = new Set<string>();
let acceptingVoiceEvents = true;
let runtimeValidated = false;
let runtimeGeneration = 0;
let moduleStatus: VoiceStatus = { state: "disabled", errorCode: null };

export type VoiceSettings = {
  enabled: boolean;
  triggerChannelId: string | null;
  nameTemplate: string;
  userLimit: number;
  ownerManage: boolean;
};

export type VoiceStatus = {
  state: "ready" | "disabled" | "degraded";
  errorCode: string | null;
};

export type VoiceRuntimeController = {
  cleanup(): Promise<void>;
  stop(): void;
  status(): VoiceStatus;
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

export function voiceStatusLabel(settings: VoiceSettings): StatusKind {
  if (!settings.enabled) return "off";
  return settings.triggerChannelId ? "ready" : "warn";
}

export function voiceRuntimeStatus(): VoiceStatus {
  return { ...moduleStatus };
}

export function renderVoiceChannelName(template: string, displayName: string): string {
  const safeUser = displayName.replace(/[\r\n]/g, " ").trim() || "User";
  const rendered = template.replaceAll("{user}", safeUser).replace(/\s+/g, " ").trim();
  return (rendered || DEFAULT_VOICE_NAME_TEMPLATE.replaceAll("{user}", safeUser)).slice(0, 100);
}

type VoiceRuntimeStore = {
  voiceSettings(): VoiceSettings;
  isVoiceAccessBlocked(): boolean;
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

function tempVoicePermissionOverwrites(trigger: NonNullable<VoiceState["channel"]>, ownerId: string) {
  const overwrites = trigger.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield
  }));
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

function canConnect(member: NonNullable<VoiceState["member"]>, channel: NonNullable<VoiceState["channel"]>): boolean {
  const channelPermissions = (channel as { permissionsFor?: (target: unknown) => { has?: (permission: bigint) => boolean } }).permissionsFor?.(member);
  if (channelPermissions?.has) return channelPermissions.has(PermissionFlagsBits.Connect);
  const permissions = member.permissions as { has?: (permission: bigint) => boolean } | undefined;
  return !permissions?.has || permissions.has(PermissionFlagsBits.Connect);
}

function voiceAccessGate(store: VoiceRuntimeStore): { blocked: boolean; errorCode: string } {
  try {
    const blocked = store.isVoiceAccessBlocked();
    if (typeof blocked !== "boolean") return { blocked: true, errorCode: VOICE_TRIGGER_INVALID };
    return { blocked, errorCode: DISCORD_ID_INVALID };
  } catch {
    return { blocked: true, errorCode: VOICE_TRIGGER_INVALID };
  }
}

function blockVoiceRuntime(errorCode: string): void {
  acceptingVoiceEvents = false;
  runtimeValidated = false;
  runtimeGeneration += 1;
  voiceChannelCreates.clear();
  markVoiceDegraded(errorCode);
}

async function createTempVoiceChannel(state: VoiceState, store: VoiceRuntimeStore, settings: VoiceSettings): Promise<void> {
  const access = voiceAccessGate(store);
  if (access.blocked) {
    blockVoiceRuntime(access.errorCode);
    return;
  }
  if (!acceptingVoiceEvents || !settings.enabled || !settings.triggerChannelId || state.channelId !== settings.triggerChannelId) return;
  if (runtimeValidated && moduleStatus.state === "degraded" && moduleStatus.errorCode === VOICE_TRIGGER_INVALID) return;
  const member = state.member;
  const trigger = state.channel;
  if (!member || member.user.bot || !trigger || trigger.type !== ChannelType.GuildVoice || !canConnect(member, trigger)) return;

  const lockKey = `${state.guild.id}:${member.id}`;
  if (voiceChannelCreates.has(lockKey)) return;
  voiceChannelCreates.add(lockKey);
  const generation = runtimeGeneration;

  try {
    const baseName = renderVoiceChannelName(settings.nameTemplate, member.displayName);
    const channel = await state.guild.channels.create({
      name: uniqueVoiceChannelName(state.guild, baseName),
      type: ChannelType.GuildVoice,
      parent: trigger.parentId ?? undefined,
      userLimit: settings.userLimit,
      permissionOverwrites: tempVoicePermissionOverwrites(trigger, member.id),
      reason: "Horo dynamic voice"
    });

    if (!acceptingVoiceEvents || generation !== runtimeGeneration) {
      await deleteTrackedTempVoiceChannel(store, channel, "Horo dynamic voice shutdown");
      return;
    }

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

async function cleanupBlockedVoiceChannels(state: VoiceState, store: VoiceRuntimeStore): Promise<void> {
  const client = (state.guild as VoiceState["guild"] & { client?: Client }).client;
  if (client) {
    await cleanupKnownTempVoiceChannels(client, store, true);
    return;
  }
  await cleanupTempVoiceChannel(state, store);
}

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState, store: VoiceRuntimeStore): Promise<void> {
  const access = voiceAccessGate(store);
  if (access.blocked) {
    blockVoiceRuntime(access.errorCode);
    await cleanupBlockedVoiceChannels(oldState, store);
    markVoiceDegraded(access.errorCode);
    return;
  }
  if (oldState.channelId === newState.channelId) return;
  if (!acceptingVoiceEvents) return;
  await cleanupTempVoiceChannel(oldState, store);
  await createTempVoiceChannel(newState, store, store.voiceSettings());
}

function setVoiceStatus(next: VoiceStatus): void {
  moduleStatus = { ...next };
}

function markVoiceDegraded(errorCode: string): void {
  setVoiceStatus({ state: "degraded", errorCode });
}

async function validateVoiceTrigger(client: Client, settings: VoiceSettings): Promise<void> {
  if (!settings.enabled) {
    setVoiceStatus({ state: "disabled", errorCode: null });
    return;
  }
  if (!settings.triggerChannelId) {
    markVoiceDegraded(VOICE_TRIGGER_INVALID);
    return;
  }

  const guilds = client.guilds?.cache?.values() ?? [];
  let found = false;
  for (const guild of guilds) {
    const cached = guild.channels.cache.get(settings.triggerChannelId);
    const channel = cached ?? await guild.channels.fetch(settings.triggerChannelId).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
      found = true;
      break;
    }
  }
  if (found) setVoiceStatus({ state: "ready", errorCode: null });
  else markVoiceDegraded(VOICE_TRIGGER_INVALID);
}

export async function startVoiceRuntime(client: Client, store: VoiceRuntimeStore): Promise<VoiceRuntimeController> {
  acceptingVoiceEvents = false;
  runtimeValidated = false;
  runtimeGeneration += 1;
  const access = voiceAccessGate(store);
  if (access.blocked) {
    blockVoiceRuntime(access.errorCode);
    await cleanupKnownTempVoiceChannels(client, store, true);
    markVoiceDegraded(access.errorCode);
    return {
      cleanup: () => cleanupKnownTempVoiceChannels(client, store),
      stop: stopVoiceRuntime,
      status: voiceRuntimeStatus
    };
  }
  acceptingVoiceEvents = true;
  await validateVoiceTrigger(client, store.voiceSettings());
  runtimeValidated = true;
  await cleanupKnownTempVoiceChannels(client, store);
  return {
    cleanup: () => cleanupKnownTempVoiceChannels(client, store),
    stop: stopVoiceRuntime,
    status: voiceRuntimeStatus
  };
}

export function stopVoiceRuntime(): void {
  acceptingVoiceEvents = false;
  runtimeValidated = false;
  runtimeGeneration += 1;
  voiceChannelCreates.clear();
}

function isUnknownChannelError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 10003;
}

export async function cleanupKnownTempVoiceChannels(client: Client, store: VoiceRuntimeStore, force = false): Promise<void> {
  for (const channelId of store.listTempVoiceChannelIds()) {
    if (!acceptingVoiceEvents && !force) return;
    const fetched = await client.channels.fetch(channelId).catch((error: unknown) => {
      if (isUnknownChannelError(error)) store.removeTempVoiceChannel(channelId);
      else markVoiceDegraded(VOICE_CLEANUP_DEGRADED);
      return undefined;
    });
    if (fetched === undefined) continue;
    if (!fetched || fetched.type !== ChannelType.GuildVoice) {
      store.removeTempVoiceChannel(channelId);
      continue;
    }
    if (fetched.members.size === 0) {
      await deleteTrackedTempVoiceChannel(store, fetched, "Horo dynamic voice startup cleanup");
    }
  }
}
