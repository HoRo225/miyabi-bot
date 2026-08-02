function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeMentions(text: string): string {
  return text.replace(/@(everyone|here|[!&]?\d{17,20})/g, "@\u200b$1");
}
export const DISCORD_ERROR_TEXT = {
  permission: (command: string) => "⚠️ 權限不足\n-# " + command + " 需要管理員授權的身分組，請洽伺服器管理員。",
  cooldown: "⏳ 請稍候\n-# 距離上次提問未滿 10 秒。",
  busy: "⏳ 忙線中\n-# 目前有 2 個請求處理中，稍後再試。",
  aiUnavailable: (code: string) => "🔴 AI 服務暫時不可用\n-# 錯誤代碼 " + code + "，請稍後再試。",
  channelDisabled: "⚫ 此頻道未啟用 AI\n-# 請管理員在 /settings 開啟。",
  aiDisabled: "⚫ AI 功能目前停用\n-# 請管理員在 /settings 確認設定。",
  invalidVoiceSettings: (detail: string) => "⚠️ 輸入無效\n-# " + detail + "。",
  invalidApiKeySelection: "⚠️ 選擇無效\n-# 這個 9router key 已不存在、停用，或超過安全選單上限。",
  aiPanelSimplified: "⚫ 此按鈕已停用\n-# 請重新執行 /ai-settings 開啟最新面板。",
  interactionFailed: "🔴 操作失敗\n-# 請重新執行指令。"
} as const;

export function stripBotMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), "").trim();
}

export function splitDiscordText(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const chunkLimit = Math.max(1, limit - Math.min(80, Math.floor(limit / 2)));
  for (let index = 0; index < text.length; index += chunkLimit) {
    chunks.push(text.slice(index, index + chunkLimit));
  }
  return chunks.map((chunk, index) => `${chunk}\n\n-# 第 ${index + 1} / ${chunks.length} 段`);
}

type DiscordTimestampStyle = "d" | "t" | "R";

export function discordTimestamp(value: string | null | undefined, style: DiscordTimestampStyle): string | null {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:${style}>` : null;
}

export function discordTimestampText(value: string | null | undefined, fallback = "尚未檢查"): string {
  const date = discordTimestamp(value, "d");
  const time = discordTimestamp(value, "t");
  const relative = discordTimestamp(value, "R");
  return date && time && relative ? `${date} ${time} (${relative})` : fallback;
}

export function inlineCodeText(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}
