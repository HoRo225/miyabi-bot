import {
  GuildMember,
  type Interaction,
  type Message
} from "discord.js";
import { resolveAiEnabledSetting, roleScopeIsValid, type Config } from "./config.js";
import { canUseAi, type AiAccess } from "./permissions.js";
import type { Store } from "./store.js";

export function aiEnabled(store: Store): boolean {
  return resolveAiEnabledSetting(store.setting("ai_enabled"));
}

export function memberRoleIds(member: Interaction["member"] | Message["member"]): string[] {
  if (!member) return [];
  if (member instanceof GuildMember) return member.roles.cache.map((role) => role.id);
  const roles = member.roles;
  return Array.isArray(roles) ? roles : [];
}

export function channelScopeIds(channelId: string, parentId?: string | null): string[] {
  return parentId ? [channelId, parentId] : [channelId];
}

export function parentChannelId(channel: Interaction["channel"] | Message["channel"]): string | null {
  return channel && "parentId" in channel ? channel.parentId : null;
}

export function isMessageThread(message: Message): boolean {
  const channel = message.channel as { isThread?: () => boolean; type?: number } | null;
  if (!channel) return false;
  if (typeof channel.isThread === "function") return channel.isThread();
  return typeof channel.type === "number" && [10, 11, 12].includes(channel.type);
}

export function aiAccessForMessage(message: Message, store: Store, config: Config): AiAccess {
  if (store.isAiAccessBlocked()) return { ok: false, reason: "channel" };
  if (isMessageThread(message)) return { ok: false, reason: "channel" };
  if (!aiEnabled(store)) return { ok: false, reason: "disabled" };
  const channelIds = channelScopeIds(message.channelId, parentChannelId(message.channel));
  const channelAllowed = channelIds.some((id) => store.listAllowedChannels().includes(id));
  if (!channelAllowed) return { ok: false, reason: "channel" };
  const roles = memberRoleIds(message.member);
  if (config.adminUserIds.has(message.author.id) || config.aiSettingsUserIds.has(message.author.id)) {
    return { ok: true };
  }
  const adminRoleAllowed = roleScopeIsValid(config, "admin") && roles.some((roleId) => config.adminRoleIds.has(roleId));
  const aiSettingsRoleAllowed = roleScopeIsValid(config, "aiSettings") && roles.some((roleId) => config.aiSettingsRoleIds.has(roleId));
  if (adminRoleAllowed || aiSettingsRoleAllowed) return { ok: true };
  return canUseAi({
    channelIds,
    userId: message.author.id,
    memberRoleIds: roles,
    allowedChannelIds: new Set(store.listAllowedChannels()),
    allowedRoleIds: new Set(store.listAllowedRoles()),
    aiSettingsUserIds: config.aiSettingsUserIds,
    aiSettingsRoleIds: aiSettingsRoleAllowed ? config.aiSettingsRoleIds : new Set()
  });
}
