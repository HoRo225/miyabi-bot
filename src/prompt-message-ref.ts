import type { Message } from "discord.js";
import type { PromptMessageRef } from "./prompt-types.js";
import {
  discordAttachmentUrl,
  isLikelyImageAttachment,
  isLikelyTextAttachment
} from "./guards.js";

type AttachmentLike = {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
};

export function promptRefFromDiscordMessage(message: Message): PromptMessageRef {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.username ?? null,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((attachment) => [
      attachment.name ?? attachment.id,
      attachment.contentType ?? "unknown",
      `${attachment.size} bytes`
    ].join(" | ")),
    imageUrls: [...message.attachments.values()]
      .filter((attachment) => isLikelyImageAttachment(attachment.name, attachment.contentType))
      .map((attachment) => discordAttachmentUrl(attachment.url))
      .filter((result): result is { ok: true; url: URL } => result.ok)
      .map((result) => result.url.toString())
  };
}

/**
 * Builds an ephemeral prompt reference. Attachment extraction is deliberately
 * not persisted: AI context remains transient.
 */
export async function resolvePromptMessageRef(message: Message, attachmentMaxBytes: number): Promise<PromptMessageRef> {
  const ref = promptRefFromDiscordMessage(message);
  const attachmentExtractions: string[] = [];
  let extractionCharsRemaining = 128 * 1024;
  const textAttachments = [...message.attachments.values()]
    .filter((attachment) => attachment.size <= attachmentMaxBytes && isLikelyTextAttachment(attachment.name, attachment.contentType));
  const extractedTexts = await Promise.all(textAttachments.map((attachment) =>
    readTextAttachment(attachment, Math.min(attachmentMaxBytes, 128 * 1024), 128 * 1024)
  ));
  for (const [index, text] of extractedTexts.entries()) {
    if (extractionCharsRemaining <= 0 || !text) break;
    const attachment = textAttachments[index];
    const heading = `${attachment.name ?? attachment.id}:\n`;
    const separatorChars = attachmentExtractions.length ? 1 : 0;
    const textLimit = extractionCharsRemaining - heading.length - separatorChars;
    if (textLimit <= 0) break;
    const extraction = `${heading}${text.slice(0, textLimit)}`;
    attachmentExtractions.push(extraction);
    extractionCharsRemaining -= separatorChars + extraction.length;
  }
  const imageUrls = (await Promise.all([...message.attachments.values()]
    .filter((attachment) => isLikelyImageAttachment(attachment.name, attachment.contentType))
    .map((attachment) => readImageAttachment(attachment, attachmentMaxBytes))))
    .filter((image): image is string => Boolean(image));

  return {
    ...ref,
    imageUrls: imageUrls.length ? imageUrls : undefined,
    attachmentExtractions: attachmentExtractions.length ? attachmentExtractions : undefined
  };
}

export function attachmentLimitError(messages: Message[], maxBytes: number): string | null {
  for (const message of messages) {
    const attachments = [...message.attachments.values()];
    const unsupported = attachments.find((item) =>
      !isLikelyTextAttachment(item.name, item.contentType) &&
      !isLikelyImageAttachment(item.name, item.contentType)
    );
    const invalidAttachmentUrl = attachments.find((item) => {
      const supported = isLikelyTextAttachment(item.name, item.contentType) ||
        isLikelyImageAttachment(item.name, item.contentType);
      return supported && !discordAttachmentUrl(item.url).ok;
    });
    if (unsupported || invalidAttachmentUrl) {
      return "這類附件目前不支援，請改上傳文字、程式碼或圖片。（AI-ATTACHMENT-001）";
    }
    const textBytes = attachments
      .filter((item) => isLikelyTextAttachment(item.name, item.contentType))
      .reduce((total, item) => total + item.size, 0);
    if (textBytes > 128 * 1024) {
      return "文字或程式碼附件超過 128 KiB 分析上限，請縮小附件後重試。（AI-ATTACHMENT-002）";
    }
    const totalBytes = attachments.reduce((total, item) => total + item.size, 0);
    if (attachments.some((item) => item.size > maxBytes) || totalBytes > maxBytes) {
      return [
        "這則訊息的附件超過目前 " + Math.floor(maxBytes / 1024 / 1024) + " MB 分析上限，暫時無法處理。",
        "請縮小或拆分附件後重試。（AI-ATTACHMENT-002）"
      ].join("\n");
    }
  }
  return null;
}

async function readTextAttachment(attachment: AttachmentLike, byteLimit: number, charLimit: number, redirectCount = 0): Promise<string | null> {
  const guard = discordAttachmentUrl(attachment.url);
  if (!guard.ok) return null;
  try {
    const response = await fetch(guard.url, {
      redirect: "manual",
      headers: { "user-agent": "horo-discord-bot/0.1" },
      signal: AbortSignal.timeout(10_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= 1) return null;
      const location = response.headers.get("location");
      if (!location) return null;
      const redirected = discordAttachmentUrl(new URL(location, guard.url).toString());
      if (!redirected.ok) return null;
      return readTextAttachment({ ...attachment, url: redirected.url.toString() }, byteLimit, charLimit, redirectCount + 1);
    }
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > byteLimit) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readResponseTextWithinLimit(response, byteLimit);
    if (text == null) return null;
    return text.slice(0, charLimit);
  } catch {
    return null;
  }
}

async function readImageAttachment(attachment: AttachmentLike, byteLimit: number, redirectCount = 0): Promise<string | null> {
  const guard = discordAttachmentUrl(attachment.url);
  if (!guard.ok) return null;
  try {
    const response = await fetch(guard.url, {
      redirect: "manual",
      headers: { "user-agent": "horo-discord-bot/0.1" },
      signal: AbortSignal.timeout(10_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= 1) return null;
      const location = response.headers.get("location");
      if (!location) return null;
      const redirected = discordAttachmentUrl(new URL(location, guard.url).toString());
      if (!redirected.ok) return null;
      return readImageAttachment({ ...attachment, url: redirected.url.toString() }, byteLimit, redirectCount + 1);
    }
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > byteLimit) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readResponseBytesWithinLimit(response, byteLimit);
    if (!bytes?.length) return null;
    const contentType = imageContentType(attachment);
    return contentType ? `data:${contentType};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

function imageContentType(attachment: AttachmentLike): string | null {
  const declared = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declared?.startsWith("image/")) return declared;
  const extension = attachment.name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "webp" ? "image/webp"
    : extension === "gif" ? "image/gif"
    : null;
}

async function readResponseBytesWithinLimit(response: Response, byteLimit: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const next = Buffer.from(value);
    received += next.length;
    if (received > byteLimit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

async function readResponseTextWithinLimit(response: Response, byteLimit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const next = Buffer.from(value);
    received += next.length;
    if (received > byteLimit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}
