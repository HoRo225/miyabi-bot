const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function isLikelyTextAttachment(filename: string | null | undefined, contentType: string | null | undefined): boolean {
  if (contentType?.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/yaml"].includes(contentType ?? "")) return true;
  return /\.(txt|md|markdown|log|json|jsonl|csv|tsv|xml|yaml|yml|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sql|sh|ps1|ini|toml)$/i.test(filename ?? "");
}

export function isLikelyImageAttachment(filename: string | null | undefined, contentType: string | null | undefined): boolean {
  if (contentType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(filename ?? "");
}

export function discordAttachmentUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; errorType: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, errorType: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, errorType: "unsupported_scheme" };
  if (!DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, errorType: "blocked_host" };
  return { ok: true, url };
}
