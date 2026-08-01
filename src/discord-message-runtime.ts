import {
  GuildMember,
  type Interaction,
  type Message,
  type PartialMessage
} from "discord.js";
import { resolveAiEnabledSetting, type Config } from "./config.js";
import { canRememberInChannel } from "./memory.js";
import { canUseAi, type AiAccess } from "./permissions.js";
import type { Store, StoredMessage } from "./store.js";

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

export function aiAccessForMessage(message: Message, store: Store, config: Config): AiAccess {
  if (!aiEnabled(store)) return { ok: false, reason: "disabled" };
  return canUseAi({
    channelIds: channelScopeIds(message.channelId, parentChannelId(message.channel)),
    userId: message.author.id,
    memberRoleIds: memberRoleIds(message.member),
    allowedChannelIds: new Set(store.listAllowedChannels()),
    allowedRoleIds: new Set(store.listAllowedRoles()),
    aiSettingsUserIds: config.aiSettingsUserIds,
    aiSettingsRoleIds: config.aiSettingsRoleIds
  });
}

export function shouldRememberMessage(message: Message, store: Pick<Store, "listMemoryChannels">): boolean {
  return Boolean(
    message.guild &&
    !message.author.bot &&
    !message.webhookId &&
    canRememberInChannel(message.channelId, new Set(store.listMemoryChannels()))
  );
}

export function storedMessageFromDiscord(message: Message): StoredMessage {
  return {
    messageId: message.id,
    guildId: message.guildId ?? message.guild?.id ?? "",
    channelId: message.channelId,
    parentChannelId: parentChannelId(message.channel),
    authorId: message.author.id,
    authorName: message.author.username ?? null,
    content: message.content || null,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    editedFlag: Boolean(message.editedAt),
    referencedMessageId: message.reference?.messageId ?? null,
    messageUrl: message.url,
    attachments: [...message.attachments.values()].map((attachment) => ({
      attachmentId: attachment.id,
      messageId: message.id,
      filename: attachment.name ?? null,
      contentType: attachment.contentType ?? null,
      sizeBytes: attachment.size,
      lastSeenUrl: attachment.url,
      proxyUrl: attachment.proxyURL ?? null
    }))
  };
}

export function rememberDiscordMessage(message: Message, store: Store): void {
  if (!shouldRememberMessage(message, store)) return;
  store.rememberMessage(storedMessageFromDiscord(message));
}

export async function rememberUpdatedDiscordMessage(message: Message | PartialMessage, store: Store): Promise<void> {
  const fullMessage = await resolveFullMessage(message);
  if (fullMessage) rememberDiscordMessage(fullMessage, store);
}

export function forgetDiscordMessage(message: Message | PartialMessage, store: Store): void {
  store.deleteRememberedMessage(message.id);
}

async function resolveFullMessage(message: Message | PartialMessage): Promise<Message | null> {
  if (!message.partial) return message as Message;
  try {
    return await message.fetch();
  } catch {
    return null;
  }
}
