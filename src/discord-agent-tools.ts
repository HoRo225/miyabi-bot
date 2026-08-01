import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type HexColorString,
  type PermissionOverwriteOptions,
  type Role
} from "discord.js";
import type { AiProviderTool, JsonSchema } from "./ai-provider.js";
import type { Config } from "./config.js";
import { discordAttachmentUrl, isLikelyImageAttachment } from "./guards.js";

export type AgentToolRisk = "read" | "write" | "destructive";

export type DiscordAgentTool = {
  name: string;
  description: string;
  risk: AgentToolRisk;
  parameters: JsonSchema;
};

export type DiscordAgentContext = {
  client: Client<true>;
  config: Config;
  guildId: string;
  currentChannelId: string;
  actorId: string;
  requestText: string;
};

export type AgentToolExecutionResult = {
  output: unknown;
  message: string;
  targetType: string;
  targetId: string | null;
};

const ID = schemaString("Discord snowflake ID", 17, 20, "^[0-9]{17,20}$");
const SHORT_TEXT = schemaString("文字", 1, 100);
const REASON = schemaString("Discord audit log reason", 0, 512);
const CONTENT = schemaString("訊息內容，不可包含 mass mention", 1, 2_000);
const PERMISSION_NAMES = [
  "CreateInstantInvite", "KickMembers", "BanMembers", "ManageChannels", "ManageGuild", "AddReactions",
  "ViewAuditLog", "ViewChannel", "SendMessages", "ManageMessages", "EmbedLinks", "AttachFiles",
  "ReadMessageHistory", "Connect", "MuteMembers", "DeafenMembers", "MoveMembers", "ChangeNickname",
  "ManageNicknames", "ManageRoles", "ManageWebhooks", "ManageGuildExpressions", "ManageEvents", "ManageThreads",
  "CreatePublicThreads", "CreatePrivateThreads", "SendMessagesInThreads", "ModerateMembers",
  "CreateGuildExpressions", "CreateEvents", "SendPolls", "PinMessages"
] as const;
const PERMISSION = schemaString("Discord permission name", 1, 64, undefined, [...PERMISSION_NAMES]);

function schemaString(description: string, minLength = 0, maxLength = 2_000, pattern?: string, values?: string[]): JsonSchema {
  return { type: "string", description, minLength, maxLength, ...(pattern ? { pattern } : {}), ...(values ? { enum: values } : {}) };
}

function schemaInteger(description: string, minimum: number, maximum: number): JsonSchema {
  return { type: "integer", description, minimum, maximum };
}

function schemaBoolean(description: string): JsonSchema {
  return { type: "boolean", description };
}

function schemaArray(items: JsonSchema, minItems = 0, maxItems = 25): JsonSchema {
  return { type: "array", items, minItems, maxItems };
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function tool(name: string, description: string, risk: AgentToolRisk, properties: Record<string, JsonSchema> = {}, required: string[] = []): DiscordAgentTool {
  return { name, description, risk, parameters: objectSchema(properties, required) };
}

const channelId = { channel_id: ID };
const messageTarget = { channel_id: ID, message_id: ID };
const nameReason = { name: SHORT_TEXT, reason: REASON };

export const DISCORD_AGENT_TOOLS: readonly DiscordAgentTool[] = [
  tool("discord_get_server_info", "取得目前 Discord server 的安全基本資訊。", "read"),
  tool("discord_list_channels", "列出呼叫者與 bot 都可見的 channels/categories。", "read"),
  tool("discord_get_channel_info", "取得指定 channel 的資訊。", "read", channelId, ["channel_id"]),
  tool("discord_read_messages", "讀取目前或明確指定 channel 的近期訊息。", "read", {
    channel_id: ID, limit: schemaInteger("1 到 50 則", 1, 50), before_message_id: ID
  }),
  tool("discord_list_threads", "列出目前 server 可見的 active threads。", "read"),
  tool("discord_list_forum_posts", "列出指定 forum/media channel 的 active 與 archived posts。", "read", channelId, ["channel_id"]),
  tool("discord_list_roles", "列出 server roles，不包含敏感 token。", "read"),
  tool("discord_get_member", "取得指定成員資料與 roles。", "read", { member_id: ID }, ["member_id"]),
  tool("discord_search_members", "依 username/nickname 前綴搜尋成員。", "read", {
    query: schemaString("username 或 nickname 前綴", 1, 100), limit: schemaInteger("1 到 25 筆", 1, 25)
  }, ["query"]),
  tool("discord_list_bans", "列出 bans；需要 BanMembers。", "read", { limit: schemaInteger("1 到 100 筆", 1, 100) }),
  tool("discord_list_scheduled_events", "列出 scheduled events。", "read"),
  tool("discord_list_invites", "列出 invite metadata；不回傳完整 code/URL。", "read"),
  tool("discord_list_webhooks", "列出 webhook metadata；永不回傳 token。", "read"),
  tool("discord_list_expressions", "列出 emoji 與 sticker metadata。", "read"),
  tool("discord_list_channel_permission_overwrites", "列出指定 channel 的 permission overwrites。", "read", channelId, ["channel_id"]),
  tool("discord_get_voice_state", "取得指定成員目前 voice state。", "read", { member_id: ID }, ["member_id"]),

  tool("discord_send_message", "在目前或指定 channel 傳送安全文字訊息。", "write", { channel_id: ID, content: CONTENT }, ["content"]),
  tool("discord_edit_bot_message", "編輯 bot 自己發出的訊息。", "write", { ...messageTarget, content: CONTENT }, ["message_id", "content"]),
  tool("discord_delete_message", "刪除指定訊息。", "destructive", messageTarget, ["message_id"]),
  tool("discord_add_reaction", "替指定訊息加入 reaction。", "write", { ...messageTarget, emoji: schemaString("Unicode emoji 或 custom emoji identifier", 1, 100) }, ["message_id", "emoji"]),
  tool("discord_remove_bot_reaction", "移除 bot 自己在指定訊息上的 reaction。", "write", { ...messageTarget, emoji: schemaString("Unicode emoji 或 custom emoji identifier", 1, 100) }, ["message_id", "emoji"]),
  tool("discord_pin_message", "釘選指定訊息。", "write", messageTarget, ["message_id"]),
  tool("discord_unpin_message", "取消釘選指定訊息。", "write", messageTarget, ["message_id"]),
  tool("discord_create_poll", "在目前或指定 channel 建立 poll。", "write", {
    channel_id: ID,
    question: schemaString("投票問題", 1, 300),
    answers: schemaArray(schemaString("選項文字", 1, 55), 2, 10),
    duration_hours: schemaInteger("投票時數", 1, 768),
    allow_multiselect: schemaBoolean("是否允許多選")
  }, ["question", "answers", "duration_hours"]),

  tool("discord_create_thread", "從文字 channel 或指定 message 建立 thread。", "write", {
    channel_id: ID, message_id: ID, name: SHORT_TEXT, auto_archive_minutes: schemaInteger("60, 1440, 4320 或 10080", 60, 10080), reason: REASON
  }, ["channel_id", "name"]),
  tool("discord_edit_thread", "修改 thread 名稱、封存或鎖定狀態。", "write", {
    channel_id: ID, name: SHORT_TEXT, archived: schemaBoolean("是否封存"), locked: schemaBoolean("是否鎖定"), reason: REASON
  }, ["channel_id"]),
  tool("discord_create_forum_post", "在 forum/media channel 建立 post。", "write", {
    channel_id: ID, name: SHORT_TEXT, content: CONTENT, applied_tag_ids: schemaArray(ID, 0, 5), reason: REASON
  }, ["channel_id", "name", "content"]),
  tool("discord_edit_forum_post", "修改 forum post/thread。", "write", {
    channel_id: ID, name: SHORT_TEXT, archived: schemaBoolean("是否封存"), locked: schemaBoolean("是否鎖定"), applied_tag_ids: schemaArray(ID, 0, 5), reason: REASON
  }, ["channel_id"]),

  tool("discord_create_channel", "建立 text/voice/category/forum/stage channel。", "destructive", {
    ...nameReason,
    channel_type: schemaString("channel 類型", 1, 20, undefined, ["text", "voice", "category", "forum", "stage"]),
    parent_id: ID, topic: schemaString("topic", 0, 1_024), nsfw: schemaBoolean("NSFW"), slowmode_seconds: schemaInteger("0 到 21600", 0, 21_600), user_limit: schemaInteger("0 到 99", 0, 99)
  }, ["name", "channel_type"]),
  tool("discord_edit_channel", "修改 channel/category/forum/stage 基本設定。", "destructive", {
    channel_id: ID, name: SHORT_TEXT, parent_id: ID, topic: schemaString("topic", 0, 1_024), nsfw: schemaBoolean("NSFW"), slowmode_seconds: schemaInteger("0 到 21600", 0, 21_600), user_limit: schemaInteger("0 到 99", 0, 99), reason: REASON
  }, ["channel_id"]),
  tool("discord_move_channel", "調整 channel 位置。", "destructive", { channel_id: ID, position: schemaInteger("零起算位置", 0, 500), reason: REASON }, ["channel_id", "position"]),
  tool("discord_delete_channel", "永久刪除 channel/category/thread。", "destructive", { channel_id: ID, reason: REASON }, ["channel_id"]),

  tool("discord_create_role", "建立 role；禁止 Administrator 與 MentionEveryone。", "destructive", {
    ...nameReason, color: schemaString("#RRGGBB", 7, 7, "^#[0-9A-Fa-f]{6}$"), hoist: schemaBoolean("分開顯示"), mentionable: schemaBoolean("可被 mention"), permissions: schemaArray(PERMISSION, 0, 32)
  }, ["name"]),
  tool("discord_edit_role", "修改可管理的 role；禁止 Administrator 與 MentionEveryone。", "destructive", {
    role_id: ID, name: SHORT_TEXT, color: schemaString("#RRGGBB", 7, 7, "^#[0-9A-Fa-f]{6}$"), hoist: schemaBoolean("分開顯示"), mentionable: schemaBoolean("可被 mention"), permissions: schemaArray(PERMISSION, 0, 32), reason: REASON
  }, ["role_id"]),
  tool("discord_delete_role", "永久刪除可管理的 role。", "destructive", { role_id: ID, reason: REASON }, ["role_id"]),
  tool("discord_assign_role", "將可管理的 role 指派給成員。", "destructive", { member_id: ID, role_id: ID, reason: REASON }, ["member_id", "role_id"]),
  tool("discord_remove_role", "移除成員的可管理 role。", "destructive", { member_id: ID, role_id: ID, reason: REASON }, ["member_id", "role_id"]),
  tool("discord_set_channel_permission_overwrite", "建立或更新 role/member channel permission overwrite。", "destructive", {
    channel_id: ID, target_id: ID, target_type: schemaString("target 類型", 1, 10, undefined, ["role", "member"]), allow: schemaArray(PERMISSION, 0, 32), deny: schemaArray(PERMISSION, 0, 32), reason: REASON
  }, ["channel_id", "target_id", "target_type"]),
  tool("discord_delete_channel_permission_overwrite", "刪除 channel permission overwrite。", "destructive", { channel_id: ID, target_id: ID, target_type: schemaString("target 類型", 1, 10, undefined, ["role", "member"]), reason: REASON }, ["channel_id", "target_id", "target_type"]),

  tool("discord_set_nickname", "修改可管理成員的 nickname。", "destructive", { member_id: ID, nickname: schemaString("nickname，空字串代表清除", 0, 32), reason: REASON }, ["member_id", "nickname"]),
  tool("discord_timeout_member", "timeout 可管理成員。", "destructive", { member_id: ID, duration_minutes: schemaInteger("1 到 40320 分鐘", 1, 40_320), reason: REASON }, ["member_id", "duration_minutes"]),
  tool("discord_remove_timeout", "移除成員 timeout。", "destructive", { member_id: ID, reason: REASON }, ["member_id"]),
  tool("discord_kick_member", "將可管理成員踢出 server。", "destructive", { member_id: ID, reason: REASON }, ["member_id"]),
  tool("discord_ban_member", "ban 指定成員；不支援批次。", "destructive", { member_id: ID, delete_message_seconds: schemaInteger("刪除歷史秒數，0 到 604800", 0, 604_800), reason: REASON }, ["member_id"]),
  tool("discord_unban_member", "解除指定 user ID 的 ban。", "destructive", { member_id: ID, reason: REASON }, ["member_id"]),

  tool("discord_move_member", "移動 voice 成員。", "destructive", { member_id: ID, channel_id: ID, reason: REASON }, ["member_id", "channel_id"]),
  tool("discord_disconnect_member", "將成員移出 voice。", "destructive", { member_id: ID, reason: REASON }, ["member_id"]),
  tool("discord_set_server_mute", "設定成員 server mute。", "destructive", { member_id: ID, muted: schemaBoolean("是否 mute"), reason: REASON }, ["member_id", "muted"]),
  tool("discord_set_server_deaf", "設定成員 server deafen。", "destructive", { member_id: ID, deafened: schemaBoolean("是否 deafen"), reason: REASON }, ["member_id", "deafened"]),

  tool("discord_create_scheduled_event", "建立 voice/stage/external scheduled event。", "write", {
    name: SHORT_TEXT, entity_type: schemaString("event 類型", 1, 10, undefined, ["voice", "stage", "external"]), channel_id: ID, location: schemaString("external event location", 1, 100), description: schemaString("event description", 0, 1_000), start_time: schemaString("ISO 8601 開始時間", 10, 40), end_time: schemaString("ISO 8601 結束時間", 10, 40), reason: REASON
  }, ["name", "entity_type", "start_time"]),
  tool("discord_edit_scheduled_event", "修改 scheduled event。", "write", {
    event_id: ID, name: SHORT_TEXT, description: schemaString("event description", 0, 1_000), start_time: schemaString("ISO 8601 開始時間", 10, 40), end_time: schemaString("ISO 8601 結束時間", 10, 40), reason: REASON
  }, ["event_id"]),
  tool("discord_delete_scheduled_event", "永久刪除 scheduled event。", "destructive", { event_id: ID }, ["event_id"]),

  tool("discord_create_invite", "建立有期限/次數上限的 invite。", "destructive", { channel_id: ID, max_age_seconds: schemaInteger("60 到 604800", 60, 604_800), max_uses: schemaInteger("1 到 100", 1, 100), temporary: schemaBoolean("temporary membership"), reason: REASON }, ["channel_id", "max_age_seconds", "max_uses"]),
  tool("discord_delete_invite", "撤銷 invite code。", "destructive", { invite_code: schemaString("invite code", 2, 100, "^[A-Za-z0-9_-]+$"), reason: REASON }, ["invite_code"]),

  tool("discord_create_webhook", "建立 incoming webhook；token 不會輸出或保存。", "destructive", { channel_id: ID, name: SHORT_TEXT, reason: REASON }, ["channel_id", "name"]),
  tool("discord_edit_webhook", "修改 webhook 名稱或 channel。", "destructive", { webhook_id: ID, name: SHORT_TEXT, channel_id: ID, reason: REASON }, ["webhook_id"]),
  tool("discord_delete_webhook", "永久刪除 webhook。", "destructive", { webhook_id: ID, reason: REASON }, ["webhook_id"]),
  tool("discord_send_webhook_message", "透過可管理 webhook 傳送安全文字，不自訂冒名 username/avatar。", "destructive", { webhook_id: ID, content: CONTENT }, ["webhook_id", "content"]),

  tool("discord_create_emoji", "使用 Discord CDN message attachment 建立 emoji。", "destructive", { channel_id: ID, message_id: ID, attachment_id: ID, name: schemaString("emoji name", 2, 32, "^[A-Za-z0-9_]+$"), reason: REASON }, ["channel_id", "message_id", "attachment_id", "name"]),
  tool("discord_edit_emoji", "修改 emoji 名稱。", "destructive", { emoji_id: ID, name: schemaString("emoji name", 2, 32, "^[A-Za-z0-9_]+$"), reason: REASON }, ["emoji_id", "name"]),
  tool("discord_delete_emoji", "永久刪除 emoji。", "destructive", { emoji_id: ID, reason: REASON }, ["emoji_id"]),
  tool("discord_create_sticker", "使用 Discord CDN message attachment 建立 sticker。", "destructive", { channel_id: ID, message_id: ID, attachment_id: ID, name: SHORT_TEXT, tags: schemaString("Unicode emoji tag", 1, 200), description: schemaString("sticker description", 0, 100), reason: REASON }, ["channel_id", "message_id", "attachment_id", "name", "tags"]),
  tool("discord_edit_sticker", "修改 sticker metadata。", "destructive", { sticker_id: ID, name: SHORT_TEXT, tags: schemaString("Unicode emoji tag", 1, 200), description: schemaString("sticker description", 0, 100), reason: REASON }, ["sticker_id"]),
  tool("discord_delete_sticker", "永久刪除 sticker。", "destructive", { sticker_id: ID, reason: REASON }, ["sticker_id"])
];

const TOOL_MAP = new Map(DISCORD_AGENT_TOOLS.map((definition) => [definition.name, definition]));

export function providerAgentTools(isAdmin: boolean): AiProviderTool[] {
  return DISCORD_AGENT_TOOLS
    .filter((definition) => definition.risk === "read" || isAdmin)
    .map((definition) => ({
      type: "function",
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters
      }
    }));
}

export function agentTool(name: string): DiscordAgentTool | undefined {
  return TOOL_MAP.get(name);
}

export function parseAgentToolArguments(definition: DiscordAgentTool, raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new Error("agent_tool_invalid_json");
  }
  validateSchema(value, definition.parameters, "arguments");
  return value as Record<string, unknown>;
}

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`agent_tool_invalid_${path}`);
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of Object.keys(record)) if (!(key in properties)) throw new Error(`agent_tool_unknown_${path}_${key}`);
    for (const key of schema.required ?? []) if (!(key in record)) throw new Error(`agent_tool_missing_${path}_${key}`);
    for (const [key, child] of Object.entries(properties)) if (key in record) validateSchema(record[key], child, `${path}_${key}`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`agent_tool_invalid_${path}`);
    if (schema.minItems != null && value.length < schema.minItems) throw new Error(`agent_tool_too_few_${path}`);
    if (schema.maxItems != null && value.length > schema.maxItems) throw new Error(`agent_tool_too_many_${path}`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items as JsonSchema, `${path}_${index}`));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`agent_tool_invalid_${path}`);
    if (schema.minLength != null && value.length < schema.minLength) throw new Error(`agent_tool_short_${path}`);
    if (schema.maxLength != null && value.length > schema.maxLength) throw new Error(`agent_tool_long_${path}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`agent_tool_pattern_${path}`);
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`agent_tool_invalid_${path}`);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`agent_tool_invalid_${path}`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`agent_tool_invalid_${path}`);
  }
  if (schema.enum && !schema.enum.includes(value as never)) throw new Error(`agent_tool_enum_${path}`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) throw new Error(`agent_tool_min_${path}`);
    if (schema.maximum != null && value > schema.maximum) throw new Error(`agent_tool_max_${path}`);
  }
}

export function isAgentAdmin(member: GuildMember, config: Config): boolean {
  return config.adminUserIds.has(member.id) || member.roles.cache.some((role) => config.adminRoleIds.has(role.id));
}

export function agentActionSummary(definition: DiscordAgentTool, args: Record<string, unknown>): string {
  const target = agentActionTargetId(args);
  const name = textArg(args, "name") ?? textArg(args, "nickname");
  const content = textArg(args, "content");
  return [definition.name, target ? `target=${target}` : null, name ? `name=${name}` : null, content ? `content=${content.slice(0, 120)}` : null]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
}

export function agentActionTargetId(args: Record<string, unknown>): string | null {
  for (const key of ["target_id", "event_id", "webhook_id", "emoji_id", "sticker_id", "message_id", "role_id", "member_id", "channel_id"]) {
    const value = textArg(args, key);
    if (value) return value;
  }
  return null;
}

export function destructiveConfirmationToken(args: Record<string, unknown>): string {
  return agentActionTargetId(args) ?? textArg(args, "invite_code") ?? textArg(args, "name") ?? "確認";
}

export async function executeDiscordAgentTool(
  context: DiscordAgentContext,
  definition: DiscordAgentTool,
  args: Record<string, unknown>
): Promise<AgentToolExecutionResult> {
  const guild = await context.client.guilds.fetch(context.guildId);
  if (!context.config.guildIds.includes(guild.id)) throw new Error("agent_tool_cross_guild");
  const actor = await guild.members.fetch(context.actorId);
  const bot = await guild.members.fetchMe();
  if (definition.risk !== "read" && !isAgentAdmin(actor, context.config)) throw new Error("agent_tool_admin_required");
  await preflight(definition.name, args, context, guild, actor, bot);
  return execute(definition.name, args, context, guild, actor, bot);
}

async function preflight(
  name: string,
  args: Record<string, unknown>,
  context: DiscordAgentContext,
  guild: Guild,
  actor: GuildMember,
  bot: GuildMember
): Promise<void> {
  const specifiedChannelId = textArg(args, "channel_id");
  if (specifiedChannelId && specifiedChannelId !== context.currentChannelId) {
    const specifiedChannel = await fetchGuildChannel(guild, specifiedChannelId);
    if (!explicitChannelTarget(context.requestText, specifiedChannel)) throw new Error("agent_tool_cross_channel_not_explicit");
  }
  const parentId = textArg(args, "parent_id");
  if (parentId) {
    const parent = await fetchGuildChannel(guild, parentId);
    if (parent.type !== ChannelType.GuildCategory) throw new Error("agent_tool_parent_not_category");
    if (!explicitChannelTarget(context.requestText, parent)) throw new Error("agent_tool_cross_channel_not_explicit");
  }
  const channelPermissions = channelPermissionRequirements(name);
  if (channelPermissions.length) {
    const channel = await fetchGuildChannel(guild, textArg(args, "channel_id") ?? context.currentChannelId);
    if (channel.id !== context.currentChannelId && !explicitChannelTarget(context.requestText, channel)) {
      throw new Error("agent_tool_cross_channel_not_explicit");
    }
    requireChannelPermissions(channel, actor, channelPermissions);
    requireChannelPermissions(channel, bot, channelPermissions);
  }
  const guildPermissions = guildPermissionRequirements(name);
  requireGuildPermissions(actor, guildPermissions);
  requireGuildPermissions(bot, guildPermissions);

  if (/(_member|_role$|_role_|timeout|kick|ban_member|server_mute|server_deaf)/.test(name)) {
    const memberId = textArg(args, "member_id");
    if (memberId && name !== "discord_unban_member") {
      const member = await guild.members.fetch(memberId);
      ensureManageableMember(guild, actor, bot, member);
    }
    const roleId = textArg(args, "role_id");
    if (roleId) ensureManageableRole(guild, actor, bot, await guild.roles.fetch(roleId));
  }
  if (["discord_set_channel_permission_overwrite", "discord_delete_channel_permission_overwrite"].includes(name) && textArg(args, "target_type") === "role") {
    const role = await guild.roles.fetch(requiredText(args, "target_id"));
    if (!role) throw new Error("agent_tool_permission_target_not_found");
    if (role.id !== guild.id) ensureManageableRole(guild, actor, bot, role);
  }
  if (["discord_set_channel_permission_overwrite", "discord_delete_channel_permission_overwrite"].includes(name) && textArg(args, "target_type") === "member") {
    ensureManageableMember(guild, actor, bot, await guild.members.fetch(requiredText(args, "target_id")));
  }
  if (name === "discord_edit_role" || name === "discord_create_role") permissionBits(stringArrayArg(args, "permissions"));
}

function explicitChannelTarget(requestText: string, channel: GuildBasedChannel): boolean {
  if (requestText.includes(channel.id) || requestText.includes(`<#${channel.id}>`)) return true;
  const name = "name" in channel ? channel.name.trim().toLowerCase() : "";
  return Boolean(name && requestText.toLowerCase().includes(name));
}

function channelPermissionRequirements(name: string): bigint[] {
  if (["discord_get_channel_info", "discord_list_forum_posts", "discord_list_channel_permission_overwrites"].includes(name)) return [PermissionFlagsBits.ViewChannel];
  if (name === "discord_read_messages") return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  if (name === "discord_send_message") return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (name === "discord_create_poll") return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendPolls];
  if (["discord_edit_bot_message", "discord_delete_message", "discord_pin_message", "discord_unpin_message"].includes(name)) return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages];
  if (["discord_add_reaction", "discord_remove_bot_reaction"].includes(name)) return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions];
  if (name === "discord_create_thread") return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads];
  if (name === "discord_create_forum_post") return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (["discord_edit_thread", "discord_edit_forum_post"].includes(name)) return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads];
  if (["discord_edit_channel", "discord_move_channel", "discord_delete_channel"].includes(name)) return [PermissionFlagsBits.ManageChannels];
  if (["discord_set_channel_permission_overwrite", "discord_delete_channel_permission_overwrite"].includes(name)) return [PermissionFlagsBits.ManageRoles];
  if (["discord_create_invite"].includes(name)) return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreateInstantInvite];
  if (["discord_create_webhook"].includes(name)) return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks];
  return [];
}

function guildPermissionRequirements(name: string): bigint[] {
  if (["discord_create_channel", "discord_edit_channel", "discord_move_channel", "discord_delete_channel"].includes(name)) return [PermissionFlagsBits.ManageChannels];
  if (name.includes("role") || name.includes("permission_overwrite")) return [PermissionFlagsBits.ManageRoles];
  if (["discord_set_nickname"].includes(name)) return [PermissionFlagsBits.ManageNicknames];
  if (["discord_timeout_member", "discord_remove_timeout"].includes(name)) return [PermissionFlagsBits.ModerateMembers];
  if (name === "discord_kick_member") return [PermissionFlagsBits.KickMembers];
  if (["discord_ban_member", "discord_unban_member", "discord_list_bans"].includes(name)) return [PermissionFlagsBits.BanMembers];
  if (["discord_move_member", "discord_disconnect_member"].includes(name)) return [PermissionFlagsBits.MoveMembers];
  if (name === "discord_set_server_mute") return [PermissionFlagsBits.MuteMembers];
  if (name === "discord_set_server_deaf") return [PermissionFlagsBits.DeafenMembers];
  if (name.includes("scheduled_event")) return [PermissionFlagsBits.ManageEvents];
  if (["discord_list_invites"].includes(name)) return [PermissionFlagsBits.ManageGuild];
  if (name.includes("webhook")) return [PermissionFlagsBits.ManageWebhooks];
  if (name.includes("emoji") || name.includes("sticker")) return [PermissionFlagsBits.ManageGuildExpressions];
  return [];
}

function requireGuildPermissions(member: GuildMember, permissions: bigint[]): void {
  for (const permission of permissions) if (!member.permissions.has(permission)) throw new Error("agent_tool_missing_guild_permission");
}

function requireChannelPermissions(channel: GuildBasedChannel, member: GuildMember, permissions: bigint[]): void {
  const effective = channel.permissionsFor(member);
  for (const permission of permissions) if (!effective?.has(permission)) throw new Error("agent_tool_missing_channel_permission");
}

function ensureManageableMember(guild: Guild, actor: GuildMember, bot: GuildMember, target: GuildMember): void {
  if (target.id === guild.ownerId || target.id === bot.id || target.id === actor.id) throw new Error("agent_tool_forbidden_member");
  if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("agent_tool_bot_hierarchy");
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("agent_tool_actor_hierarchy");
}

function ensureManageableRole(guild: Guild, actor: GuildMember, bot: GuildMember, role: Role | null): void {
  if (!role || role.id === guild.id || role.managed) throw new Error("agent_tool_forbidden_role");
  if (bot.roles.highest.comparePositionTo(role) <= 0) throw new Error("agent_tool_bot_role_hierarchy");
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) throw new Error("agent_tool_actor_role_hierarchy");
}

async function execute(
  name: string,
  args: Record<string, unknown>,
  context: DiscordAgentContext,
  guild: Guild,
  actor: GuildMember,
  bot: GuildMember
): Promise<AgentToolExecutionResult> {
  const targetId = agentActionTargetId(args);
  const result = (output: unknown, message: string, targetType = "guild", resolvedTargetId: string | null = targetId): AgentToolExecutionResult => ({ output, message, targetType, targetId: resolvedTargetId });

  if (name === "discord_get_server_info") {
    return result({ id: guild.id, name: guild.name, description: guild.description, member_count: guild.memberCount, owner_id: guild.ownerId, features: guild.features, created_timestamp: Math.floor(guild.createdTimestamp / 1000) }, "已取得 server 資訊。");
  }
  if (name === "discord_list_channels") {
    const channels = await guild.channels.fetch();
    const visible = [...channels.values()]
      .filter((channel) => channel !== null)
      .filter((channel) => channel.permissionsFor(actor)?.has(PermissionFlagsBits.ViewChannel) && channel.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel));
    return result(visible.slice(0, 200).map(channelSummary), `已取得 ${visible.length} 個可見 channels。`, "channel", null);
  }
  if (name === "discord_get_channel_info") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    return result(channelSummary(channel), `已取得 channel ${channel.id}。`, "channel", channel.id);
  }
  if (name === "discord_read_messages") {
    const channel = await fetchTextChannel(guild, textArg(args, "channel_id") ?? context.currentChannelId);
    const messages = await channel.messages.fetch({ limit: numberArg(args, "limit") ?? 25, ...(textArg(args, "before_message_id") ? { before: textArg(args, "before_message_id") as string } : {}) });
    const output = [...messages.values()].reverse().map((message) => ({
      id: message.id,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content.slice(0, 2_000),
      created_timestamp: Math.floor(message.createdTimestamp / 1_000),
      attachments: [...message.attachments.values()].map((attachment) => ({ id: attachment.id, name: attachment.name, content_type: attachment.contentType, size: attachment.size }))
    }));
    return result(output, `已讀取 ${output.length} 則訊息。`, "channel", channel.id);
  }
  if (name === "discord_list_threads") {
    const threads = await guild.channels.fetchActiveThreads();
    const visible = [...threads.threads.values()].filter((thread) => thread.permissionsFor(actor)?.has(PermissionFlagsBits.ViewChannel) && thread.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel));
    return result(visible.map(channelSummary), `已取得 ${visible.length} 個 active threads。`, "thread", null);
  }
  if (name === "discord_list_forum_posts") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia) throw new Error("agent_tool_not_forum");
    const [active, archived] = await Promise.all([channel.threads.fetchActive(), channel.threads.fetchArchived({ type: "public", fetchAll: true })]);
    const threads = [...active.threads.values(), ...archived.threads.values()].slice(0, 200);
    return result(threads.map(channelSummary), `已取得 ${threads.length} 個 forum posts。`, "channel", channel.id);
  }
  if (name === "discord_list_roles") {
    const roles = await guild.roles.fetch();
    return result([...roles.values()].sort((a, b) => b.position - a.position).map((role) => ({ id: role.id, name: role.name, position: role.position, managed: role.managed, permissions: role.permissions.toArray() })), `已取得 ${roles.size} 個 roles。`, "role", null);
  }
  if (name === "discord_get_member") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    return result(memberSummary(member), `已取得成員 ${member.id}。`, "member", member.id);
  }
  if (name === "discord_search_members") {
    const members = await guild.members.search({ query: requiredText(args, "query"), limit: numberArg(args, "limit") ?? 10 });
    return result([...members.values()].map(memberSummary), `找到 ${members.size} 位成員。`, "member", null);
  }
  if (name === "discord_list_bans") {
    const bans = await guild.bans.fetch({ limit: numberArg(args, "limit") ?? 25 });
    return result([...bans.values()].map((ban) => ({ user_id: ban.user.id, username: ban.user.username, reason: ban.reason })), `已取得 ${bans.size} 筆 bans。`, "member", null);
  }
  if (name === "discord_list_scheduled_events") {
    const events = await guild.scheduledEvents.fetch();
    return result([...events.values()].map((event) => ({ id: event.id, name: event.name, status: event.status, channel_id: event.channelId, entity_type: event.entityType, scheduled_start_timestamp: event.scheduledStartTimestamp ? Math.floor(event.scheduledStartTimestamp / 1_000) : null, scheduled_end_timestamp: event.scheduledEndTimestamp ? Math.floor(event.scheduledEndTimestamp / 1_000) : null })), `已取得 ${events.size} 個 events。`, "event", null);
  }
  if (name === "discord_list_invites") {
    const invites = await guild.invites.fetch();
    return result([...invites.values()].map((invite) => ({ channel_id: invite.channelId, inviter_id: invite.inviterId, uses: invite.uses, max_uses: invite.maxUses, max_age: invite.maxAge, expires_timestamp: invite.expiresTimestamp ? Math.floor(invite.expiresTimestamp / 1_000) : null })), `已取得 ${invites.size} 個 invite metadata。`, "invite", null);
  }
  if (name === "discord_list_webhooks") {
    const webhooks = await guild.fetchWebhooks();
    return result([...webhooks.values()].map((webhook) => ({ id: webhook.id, name: webhook.name, channel_id: webhook.channelId, owner_id: webhook.owner?.id ?? null, type: webhook.type })), `已取得 ${webhooks.size} 個 webhooks。`, "webhook", null);
  }
  if (name === "discord_list_expressions") {
    const [emojis, stickers] = await Promise.all([guild.emojis.fetch(), guild.stickers.fetch()]);
    return result({ emojis: [...emojis.values()].map((emoji) => ({ id: emoji.id, name: emoji.name, animated: emoji.animated, managed: emoji.managed })), stickers: [...stickers.values()].map((sticker) => ({ id: sticker.id, name: sticker.name, description: sticker.description, tags: sticker.tags })) }, `已取得 ${emojis.size} 個 emojis 與 ${stickers.size} 個 stickers。`, "expression", null);
  }
  if (name === "discord_list_channel_permission_overwrites") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.isThread()) throw new Error("agent_tool_thread_overwrite_inherited");
    return result([...channel.permissionOverwrites.cache.values()].map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow.toArray(), deny: overwrite.deny.toArray() })), `已取得 channel ${channel.id} 的 permission overwrites。`, "channel", channel.id);
  }
  if (name === "discord_get_voice_state") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    if (member.voice.channel) {
      requireChannelPermissions(member.voice.channel, actor, [PermissionFlagsBits.ViewChannel]);
      requireChannelPermissions(member.voice.channel, bot, [PermissionFlagsBits.ViewChannel]);
    }
    return result({ member_id: member.id, channel_id: member.voice.channelId, server_mute: member.voice.serverMute, server_deaf: member.voice.serverDeaf, self_mute: member.voice.selfMute, self_deaf: member.voice.selfDeaf }, `已取得成員 ${member.id} 的 voice state。`, "member", member.id);
  }

  if (name === "discord_send_message") {
    const channel = await fetchTextChannel(guild, textArg(args, "channel_id") ?? context.currentChannelId);
    const message = await channel.send({ content: sanitizeOutbound(requiredText(args, "content")), allowedMentions: { parse: [] } });
    return result({ message_id: message.id, channel_id: channel.id }, `已傳送訊息 ${message.id}。`, "message", message.id);
  }
  if (name === "discord_edit_bot_message") {
    const message = await fetchMessage(guild, textArg(args, "channel_id") ?? context.currentChannelId, requiredText(args, "message_id"));
    if (message.author.id !== context.client.user.id) throw new Error("agent_tool_not_bot_message");
    await message.edit({ content: sanitizeOutbound(requiredText(args, "content")), allowedMentions: { parse: [] } });
    return result({ message_id: message.id }, `已編輯 bot 訊息 ${message.id}。`, "message", message.id);
  }
  if (name === "discord_delete_message") {
    const message = await fetchMessage(guild, textArg(args, "channel_id") ?? context.currentChannelId, requiredText(args, "message_id"));
    await message.delete();
    return result({ message_id: message.id }, `已刪除訊息 ${message.id}。`, "message", message.id);
  }
  if (name === "discord_add_reaction" || name === "discord_remove_bot_reaction") {
    const message = await fetchMessage(guild, textArg(args, "channel_id") ?? context.currentChannelId, requiredText(args, "message_id"));
    const emoji = requiredText(args, "emoji");
    if (name === "discord_add_reaction") await message.react(emoji);
    else await message.reactions.resolve(emoji)?.users.remove(context.client.user.id);
    return result({ message_id: message.id, emoji }, `${name === "discord_add_reaction" ? "已加入" : "已移除 bot"} reaction。`, "message", message.id);
  }
  if (name === "discord_pin_message" || name === "discord_unpin_message") {
    const message = await fetchMessage(guild, textArg(args, "channel_id") ?? context.currentChannelId, requiredText(args, "message_id"));
    if (name === "discord_pin_message") await message.pin(); else await message.unpin();
    return result({ message_id: message.id }, `${name === "discord_pin_message" ? "已釘選" : "已取消釘選"}訊息 ${message.id}。`, "message", message.id);
  }
  if (name === "discord_create_poll") {
    const channel = await fetchTextChannel(guild, textArg(args, "channel_id") ?? context.currentChannelId);
    const message = await channel.send({
      poll: {
        question: { text: sanitizeOutbound(requiredText(args, "question")) },
        answers: stringArrayArg(args, "answers").map((text) => ({ text: sanitizeOutbound(text) })),
        duration: requiredNumber(args, "duration_hours"),
        allowMultiselect: booleanArg(args, "allow_multiselect") ?? false
      },
      allowedMentions: { parse: [] }
    });
    return result({ message_id: message.id }, `已建立 poll ${message.id}。`, "message", message.id);
  }

  if (name === "discord_create_thread") {
    const channel = await fetchTextChannel(guild, requiredText(args, "channel_id"));
    const options = { name: requiredText(args, "name"), autoArchiveDuration: archiveDuration(numberArg(args, "auto_archive_minutes")), reason: textArg(args, "reason") };
    const sourceMessageId = textArg(args, "message_id");
    const thread = sourceMessageId ? await channel.messages.fetch(sourceMessageId).then((message) => message.startThread(options)) : "threads" in channel ? await channel.threads.create(options) : null;
    if (!thread) throw new Error("agent_tool_thread_unsupported");
    return result({ channel_id: thread.id }, `已建立 thread ${thread.id}。`, "thread", thread.id);
  }
  if (name === "discord_edit_thread" || name === "discord_edit_forum_post") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (!channel.isThread()) throw new Error("agent_tool_not_thread");
    await channel.edit({ name: textArg(args, "name"), archived: booleanArg(args, "archived"), locked: booleanArg(args, "locked"), ...(name === "discord_edit_forum_post" && Array.isArray(args.applied_tag_ids) ? { appliedTags: stringArrayArg(args, "applied_tag_ids") } : {}), reason: textArg(args, "reason") });
    return result({ channel_id: channel.id }, `已修改 thread ${channel.id}。`, "thread", channel.id);
  }
  if (name === "discord_create_forum_post") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia) throw new Error("agent_tool_not_forum");
    const thread = await channel.threads.create({ name: requiredText(args, "name"), message: { content: sanitizeOutbound(requiredText(args, "content")), allowedMentions: { parse: [] } }, appliedTags: stringArrayArg(args, "applied_tag_ids"), reason: textArg(args, "reason") });
    return result({ channel_id: thread.id }, `已建立 forum post ${thread.id}。`, "thread", thread.id);
  }

  if (name === "discord_create_channel") {
    const type = channelType(requiredText(args, "channel_type"));
    const channel = await guild.channels.create({ name: requiredText(args, "name"), type, parent: textArg(args, "parent_id"), topic: textArg(args, "topic"), nsfw: booleanArg(args, "nsfw"), rateLimitPerUser: numberArg(args, "slowmode_seconds"), userLimit: numberArg(args, "user_limit"), reason: textArg(args, "reason") });
    return result({ channel_id: channel.id }, `已建立 channel ${channel.id}。`, "channel", channel.id);
  }
  if (name === "discord_edit_channel") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    await guild.channels.edit(channel, { name: textArg(args, "name"), parent: textArg(args, "parent_id"), topic: textArg(args, "topic"), nsfw: booleanArg(args, "nsfw"), rateLimitPerUser: numberArg(args, "slowmode_seconds"), userLimit: numberArg(args, "user_limit"), reason: textArg(args, "reason") });
    return result({ channel_id: channel.id }, `已修改 channel ${channel.id}。`, "channel", channel.id);
  }
  if (name === "discord_move_channel") {
    const channel = await guild.channels.setPosition(requiredText(args, "channel_id"), requiredNumber(args, "position"), { reason: textArg(args, "reason") });
    return result({ channel_id: channel.id, position: channel.position }, `已移動 channel ${channel.id}。`, "channel", channel.id);
  }
  if (name === "discord_delete_channel") {
    const id = requiredText(args, "channel_id");
    await guild.channels.delete(id, textArg(args, "reason"));
    return result({ channel_id: id }, `已刪除 channel ${id}。`, "channel", id);
  }

  if (name === "discord_create_role") {
    const role = await guild.roles.create({ name: requiredText(args, "name"), color: textArg(args, "color") as HexColorString | undefined, hoist: booleanArg(args, "hoist"), mentionable: booleanArg(args, "mentionable"), permissions: permissionBits(stringArrayArg(args, "permissions")), reason: textArg(args, "reason") });
    return result({ role_id: role.id }, `已建立 role ${role.id}。`, "role", role.id);
  }
  if (name === "discord_edit_role") {
    const role = await guild.roles.edit(requiredText(args, "role_id"), { name: textArg(args, "name"), color: textArg(args, "color") as HexColorString | undefined, hoist: booleanArg(args, "hoist"), mentionable: booleanArg(args, "mentionable"), ...(Array.isArray(args.permissions) ? { permissions: permissionBits(stringArrayArg(args, "permissions")) } : {}), reason: textArg(args, "reason") });
    return result({ role_id: role.id }, `已修改 role ${role.id}。`, "role", role.id);
  }
  if (name === "discord_delete_role") {
    const id = requiredText(args, "role_id");
    await guild.roles.delete(id, textArg(args, "reason"));
    return result({ role_id: id }, `已刪除 role ${id}。`, "role", id);
  }
  if (name === "discord_assign_role" || name === "discord_remove_role") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    const roleId = requiredText(args, "role_id");
    if (name === "discord_assign_role") await member.roles.add(roleId, textArg(args, "reason")); else await member.roles.remove(roleId, textArg(args, "reason"));
    return result({ member_id: member.id, role_id: roleId }, `${name === "discord_assign_role" ? "已指派" : "已移除"} role。`, "member", member.id);
  }
  if (name === "discord_set_channel_permission_overwrite") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.isThread()) throw new Error("agent_tool_thread_overwrite_inherited");
    const overwrite: Record<string, boolean> = {};
    for (const permission of stringArrayArg(args, "allow")) overwrite[permission] = true;
    for (const permission of stringArrayArg(args, "deny")) overwrite[permission] = false;
    const target = textArg(args, "target_type") === "member"
      ? await guild.members.fetch(requiredText(args, "target_id"))
      : await guild.roles.fetch(requiredText(args, "target_id"));
    if (!target) throw new Error("agent_tool_permission_target_not_found");
    await channel.permissionOverwrites.edit(target, overwrite as PermissionOverwriteOptions, { reason: textArg(args, "reason") });
    return result({ channel_id: channel.id, target_id: requiredText(args, "target_id") }, `已更新 channel ${channel.id} 的 permission overwrite。`, "channel", channel.id);
  }
  if (name === "discord_delete_channel_permission_overwrite") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.isThread()) throw new Error("agent_tool_thread_overwrite_inherited");
    await channel.permissionOverwrites.delete(requiredText(args, "target_id"), textArg(args, "reason"));
    return result({ channel_id: channel.id, target_id: requiredText(args, "target_id") }, `已刪除 channel ${channel.id} 的 permission overwrite。`, "channel", channel.id);
  }

  if (name === "discord_set_nickname") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    await member.setNickname(requiredText(args, "nickname") || null, textArg(args, "reason"));
    return result({ member_id: member.id }, `已更新成員 ${member.id} 的 nickname。`, "member", member.id);
  }
  if (name === "discord_timeout_member" || name === "discord_remove_timeout") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    await member.timeout(name === "discord_timeout_member" ? requiredNumber(args, "duration_minutes") * 60_000 : null, textArg(args, "reason"));
    return result({ member_id: member.id }, `${name === "discord_timeout_member" ? "已 timeout" : "已移除 timeout"} 成員 ${member.id}。`, "member", member.id);
  }
  if (name === "discord_kick_member") {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    await member.kick(textArg(args, "reason"));
    return result({ member_id: member.id }, `已踢出成員 ${member.id}。`, "member", member.id);
  }
  if (name === "discord_ban_member") {
    const id = requiredText(args, "member_id");
    await guild.members.ban(id, { deleteMessageSeconds: numberArg(args, "delete_message_seconds") ?? 0, reason: textArg(args, "reason") });
    return result({ member_id: id }, `已 ban 成員 ${id}。`, "member", id);
  }
  if (name === "discord_unban_member") {
    const id = requiredText(args, "member_id");
    await guild.members.unban(id, textArg(args, "reason"));
    return result({ member_id: id }, `已解除 ${id} 的 ban。`, "member", id);
  }

  if (["discord_move_member", "discord_disconnect_member", "discord_set_server_mute", "discord_set_server_deaf"].includes(name)) {
    const member = await guild.members.fetch(requiredText(args, "member_id"));
    if (name === "discord_move_member") await member.voice.setChannel(requiredText(args, "channel_id"), textArg(args, "reason"));
    if (name === "discord_disconnect_member") await member.voice.disconnect(textArg(args, "reason"));
    if (name === "discord_set_server_mute") await member.voice.setMute(requiredBoolean(args, "muted"), textArg(args, "reason"));
    if (name === "discord_set_server_deaf") await member.voice.setDeaf(requiredBoolean(args, "deafened"), textArg(args, "reason"));
    return result({ member_id: member.id, channel_id: member.voice.channelId }, `已更新成員 ${member.id} 的 voice state。`, "member", member.id);
  }

  if (name === "discord_create_scheduled_event") {
    const entityType = eventEntityType(requiredText(args, "entity_type"));
    const event = await guild.scheduledEvents.create({
      name: requiredText(args, "name"),
      description: textArg(args, "description"),
      scheduledStartTime: validDate(requiredText(args, "start_time")),
      scheduledEndTime: textArg(args, "end_time") ? validDate(textArg(args, "end_time") as string) : undefined,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType,
      channel: entityType === GuildScheduledEventEntityType.External ? undefined : requiredText(args, "channel_id"),
      entityMetadata: entityType === GuildScheduledEventEntityType.External ? { location: requiredText(args, "location") } : undefined,
      reason: textArg(args, "reason")
    });
    return result({ event_id: event.id }, `已建立 scheduled event ${event.id}。`, "event", event.id);
  }
  if (name === "discord_edit_scheduled_event") {
    const id = requiredText(args, "event_id");
    const event = await guild.scheduledEvents.edit(id, { name: textArg(args, "name"), description: textArg(args, "description"), scheduledStartTime: textArg(args, "start_time") ? validDate(textArg(args, "start_time") as string) : undefined, scheduledEndTime: textArg(args, "end_time") ? validDate(textArg(args, "end_time") as string) : undefined, reason: textArg(args, "reason") });
    return result({ event_id: event.id }, `已修改 scheduled event ${event.id}。`, "event", event.id);
  }
  if (name === "discord_delete_scheduled_event") {
    const id = requiredText(args, "event_id");
    await guild.scheduledEvents.delete(id);
    return result({ event_id: id }, `已刪除 scheduled event ${id}。`, "event", id);
  }

  if (name === "discord_create_invite") {
    const channel = await fetchGuildChannel(guild, requiredText(args, "channel_id"));
    if (channel.isThread() || channel.type === ChannelType.GuildCategory) throw new Error("agent_tool_channel_not_invitable");
    const invite = await guild.invites.create(channel, { maxAge: requiredNumber(args, "max_age_seconds"), maxUses: requiredNumber(args, "max_uses"), temporary: booleanArg(args, "temporary") ?? false, unique: true, reason: textArg(args, "reason") });
    return result({ channel_id: channel.id }, `已建立 invite：||${invite.url}||`, "invite", null);
  }
  if (name === "discord_delete_invite") {
    const code = requiredText(args, "invite_code");
    const invite = await guild.invites.fetch(code);
    if (invite.channelId) {
      const channel = await fetchGuildChannel(guild, invite.channelId);
      requireChannelPermissions(channel, actor, [PermissionFlagsBits.ManageChannels]);
      requireChannelPermissions(channel, bot, [PermissionFlagsBits.ManageChannels]);
    }
    await guild.invites.delete(code, textArg(args, "reason"));
    return result({ deleted: true }, "已撤銷指定 invite。", "invite", null);
  }

  if (name === "discord_create_webhook") {
    const channel = await fetchTextChannel(guild, requiredText(args, "channel_id"));
    if (!("createWebhook" in channel)) throw new Error("agent_tool_webhook_unsupported");
    const webhook = await channel.createWebhook({ name: requiredText(args, "name"), reason: textArg(args, "reason") });
    return result({ webhook_id: webhook.id, channel_id: channel.id }, `已建立 webhook ${webhook.id}；token 未顯示或保存。`, "webhook", webhook.id);
  }
  if (["discord_edit_webhook", "discord_delete_webhook", "discord_send_webhook_message"].includes(name)) {
    const webhookId = requiredText(args, "webhook_id");
    const webhooks = await guild.fetchWebhooks();
    const webhook = webhooks.get(webhookId);
    if (!webhook) throw new Error("agent_tool_webhook_not_found");
    if (!webhook.channelId) throw new Error("agent_tool_webhook_channel_missing");
    const webhookChannel = await fetchGuildChannel(guild, webhook.channelId);
    requireChannelPermissions(webhookChannel, actor, [PermissionFlagsBits.ManageWebhooks]);
    requireChannelPermissions(webhookChannel, bot, [PermissionFlagsBits.ManageWebhooks]);
    if (name === "discord_edit_webhook") await webhook.edit({ name: textArg(args, "name"), channel: textArg(args, "channel_id"), reason: textArg(args, "reason") });
    if (name === "discord_delete_webhook") await webhook.delete(textArg(args, "reason"));
    if (name === "discord_send_webhook_message") await webhook.send({ content: sanitizeOutbound(requiredText(args, "content")), allowedMentions: { parse: [] } });
    return result({ webhook_id: webhook.id }, `已完成 webhook ${webhook.id} 操作。`, "webhook", webhook.id);
  }

  if (name === "discord_create_emoji" || name === "discord_create_sticker") {
    const attachment = await sourceImageAttachment(guild, args, name === "discord_create_emoji" ? 256 * 1024 : 512 * 1024);
    if (name === "discord_create_emoji") {
      const emoji = await guild.emojis.create({ attachment: attachment.url, name: requiredText(args, "name"), reason: textArg(args, "reason") });
      return result({ emoji_id: emoji.id }, `已建立 emoji ${emoji.id}。`, "emoji", emoji.id);
    }
    const sticker = await guild.stickers.create({ file: attachment.url, name: requiredText(args, "name"), tags: requiredText(args, "tags"), description: textArg(args, "description"), reason: textArg(args, "reason") });
    return result({ sticker_id: sticker.id }, `已建立 sticker ${sticker.id}。`, "sticker", sticker.id);
  }
  if (name === "discord_edit_emoji") {
    const emoji = await guild.emojis.edit(requiredText(args, "emoji_id"), { name: requiredText(args, "name"), reason: textArg(args, "reason") });
    return result({ emoji_id: emoji.id }, `已修改 emoji ${emoji.id}。`, "emoji", emoji.id);
  }
  if (name === "discord_delete_emoji") {
    const id = requiredText(args, "emoji_id");
    await guild.emojis.delete(id, textArg(args, "reason"));
    return result({ emoji_id: id }, `已刪除 emoji ${id}。`, "emoji", id);
  }
  if (name === "discord_edit_sticker") {
    const sticker = await guild.stickers.edit(requiredText(args, "sticker_id"), { name: textArg(args, "name"), tags: textArg(args, "tags"), description: textArg(args, "description"), reason: textArg(args, "reason") });
    return result({ sticker_id: sticker.id }, `已修改 sticker ${sticker.id}。`, "sticker", sticker.id);
  }
  if (name === "discord_delete_sticker") {
    const id = requiredText(args, "sticker_id");
    await guild.stickers.delete(id, textArg(args, "reason"));
    return result({ sticker_id: id }, `已刪除 sticker ${id}。`, "sticker", id);
  }

  throw new Error("agent_tool_not_implemented");
}

async function fetchGuildChannel(guild: Guild, id: string): Promise<GuildBasedChannel> {
  const channel = await guild.channels.fetch(id);
  if (!channel || channel.guildId !== guild.id) throw new Error("agent_tool_channel_not_found");
  return channel;
}

async function fetchTextChannel(guild: Guild, id: string) {
  const channel = await fetchGuildChannel(guild, id);
  if (!channel.isTextBased() || channel.isDMBased() || !("messages" in channel) || !("send" in channel)) throw new Error("agent_tool_not_text_channel");
  return channel;
}

async function fetchMessage(guild: Guild, channelIdValue: string, messageId: string) {
  const channel = await fetchTextChannel(guild, channelIdValue);
  return channel.messages.fetch(messageId);
}

async function sourceImageAttachment(guild: Guild, args: Record<string, unknown>, maxBytes: number) {
  const message = await fetchMessage(guild, requiredText(args, "channel_id"), requiredText(args, "message_id"));
  const attachment = message.attachments.get(requiredText(args, "attachment_id"));
  if (!attachment || !isLikelyImageAttachment(attachment.name, attachment.contentType)) throw new Error("agent_tool_image_attachment_required");
  if (attachment.size > maxBytes) throw new Error("agent_tool_image_attachment_too_large");
  if (!discordAttachmentUrl(attachment.url).ok) throw new Error("agent_tool_attachment_url_blocked");
  return attachment;
}

function channelSummary(channel: GuildBasedChannel) {
  return { id: channel.id, name: "name" in channel ? channel.name : null, type: channel.type, parent_id: "parentId" in channel ? channel.parentId : null, position: "position" in channel ? channel.position : null };
}

function memberSummary(member: GuildMember) {
  return { id: member.id, username: member.user.username, display_name: member.displayName, roles: member.roles.cache.filter((role) => role.id !== member.guild.id).map((role) => ({ id: role.id, name: role.name })), joined_timestamp: member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1_000) : null, timed_out_until_timestamp: member.communicationDisabledUntilTimestamp ? Math.floor(member.communicationDisabledUntilTimestamp / 1_000) : null };
}

function permissionBits(names: string[]): PermissionsBitField {
  const bits = names.map((name) => {
    if (name === "Administrator" || name === "MentionEveryone") throw new Error("agent_tool_forbidden_permission");
    const bit = (PermissionFlagsBits as unknown as Record<string, bigint>)[name];
    if (typeof bit !== "bigint") throw new Error("agent_tool_unknown_permission");
    return bit;
  });
  return new PermissionsBitField(bits);
}

function channelType(value: string): ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildCategory | ChannelType.GuildForum | ChannelType.GuildStageVoice {
  if (value === "text") return ChannelType.GuildText;
  if (value === "voice") return ChannelType.GuildVoice;
  if (value === "category") return ChannelType.GuildCategory;
  if (value === "forum") return ChannelType.GuildForum;
  if (value === "stage") return ChannelType.GuildStageVoice;
  throw new Error("agent_tool_invalid_channel_type");
}

function eventEntityType(value: string): GuildScheduledEventEntityType {
  if (value === "voice") return GuildScheduledEventEntityType.Voice;
  if (value === "stage") return GuildScheduledEventEntityType.StageInstance;
  if (value === "external") return GuildScheduledEventEntityType.External;
  throw new Error("agent_tool_invalid_event_type");
}

function archiveDuration(value: number | undefined): 60 | 1440 | 4320 | 10080 | undefined {
  if (value == null) return undefined;
  if (value === 60 || value === 1440 || value === 4320 || value === 10080) return value;
  throw new Error("agent_tool_invalid_archive_duration");
}

function validDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("agent_tool_invalid_date");
  return date;
}

function sanitizeOutbound(value: string): string {
  return value.replace(/@(everyone|here)/gi, "＠$1").replace(/<@&\d+>/g, "[role]").replace(/<@!?\d+>/g, "[user]");
}

function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = textArg(args, key);
  if (value == null) throw new Error(`agent_tool_missing_${key}`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = numberArg(args, key);
  if (value == null) throw new Error(`agent_tool_missing_${key}`);
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? args[key] : undefined;
}

function requiredBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = booleanArg(args, key);
  if (value == null) throw new Error(`agent_tool_missing_${key}`);
  return value;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
