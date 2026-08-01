export type AiAccess =
  | { ok: true }
  | { ok: false; reason: "channel" | "role" | "disabled" };

export function canUseAi(input: {
  channelIds: string[];
  userId: string;
  memberRoleIds: string[];
  allowedChannelIds: Set<string>;
  allowedRoleIds: Set<string>;
  aiSettingsUserIds: Set<string>;
  aiSettingsRoleIds: Set<string>;
}): AiAccess {
  if (!input.channelIds.some((id) => input.allowedChannelIds.has(id))) {
    return { ok: false, reason: "channel" };
  }
  if (
    input.aiSettingsUserIds.has(input.userId) ||
    input.memberRoleIds.some((id) => input.aiSettingsRoleIds.has(id) || input.allowedRoleIds.has(id))
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "role" };
}

export function canUseSettings(input: {
  memberRoleIds: string[];
  settingsRoleIds: Set<string>;
}): boolean {
  if (input.settingsRoleIds.size === 0) return false;
  return input.memberRoleIds.some((id) => input.settingsRoleIds.has(id));
}

