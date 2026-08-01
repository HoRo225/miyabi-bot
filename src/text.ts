function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeMentions(text: string): string {
  return text.replace(/@(everyone|here|[!&]?\d{17,20})/g, "@\u200b$1");
}

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
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
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
