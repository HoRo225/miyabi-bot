import type { Message } from "discord.js";
import type { PromptMessageRef } from "./memory.js";
import {
  discordAttachmentUrl,
  isLikelyImageAttachment,
  isLikelyTextAttachment
} from "./guards.js";
import type { Store } from "./store.js";

type PromptMessageStore = Pick<Store, "listMemoryChannels" | "saveAttachmentExtraction">;

type AttachmentLike = {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
};

function messageToPromptRef(message: Message): PromptMessageRef {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.username ?? null,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    url: message.url,
    attachments: [...message.attachments.values()].map((attachment) => [
      attachment.name ?? attachment.id,
      attachment.contentType ?? "unknown",
      `${attachment.size} bytes`,
      attachment.url
    ].join(" | ")),
    imageUrls: [...message.attachments.values()]
      .filter((attachment) => isLikelyImageAttachment(attachment.name, attachment.contentType))
      .map((attachment) => discordAttachmentUrl(attachment.url))
      .filter((result): result is { ok: true; url: URL } => result.ok)
      .map((result) => result.url.toString())
  };
}

export async function resolvePromptMessageRef(message: Message, store: PromptMessageStore, attachmentMaxBytes: number): Promise<PromptMessageRef> {
  const ref = messageToPromptRef(message);
  const attachmentExtractions: string[] = [];
  let extractionCharsRemaining = 12_000;
  const persistExtractions = store.listMemoryChannels().includes(message.channelId);
  for (const attachment of message.attachments.values()) {
    if (extractionCharsRemaining <= 0) break;
    if (attachment.size > attachmentMaxBytes || !isLikelyTextAttachment(attachment.name, attachment.contentType)) continue;
    const heading = `${attachment.name ?? attachment.id}:\n`;
    const separatorChars = attachmentExtractions.length ? 1 : 0;
    const textLimit = extractionCharsRemaining - heading.length - separatorChars;
    if (textLimit <= 0) break;
    const text = await readTextAttachment(attachment, Math.min(attachmentMaxBytes, 128 * 1024), textLimit);
    if (!text) continue;
    if (persistExtractions) {
      store.saveAttachmentExtraction({
        attachmentId: attachment.id,
        messageId: message.id,
        filename: attachment.name ?? null,
        contentType: attachment.contentType ?? null,
        sizeBytes: attachment.size,
        extractedText: text,
        extractionMethod: "text_attachment"
      });
    }
    const extraction = `${heading}${text}`;
    attachmentExtractions.push(extraction);
    extractionCharsRemaining -= separatorChars + extraction.length;
  }

  return {
    ...ref,
    attachmentExtractions: attachmentExtractions.length ? attachmentExtractions : undefined
  };
}

export function attachmentLimitError(messages: Message[], maxBytes: number): string | null {
  const attachment = messages.flatMap((message) => [...message.attachments.values()]).find((item) => item.size > maxBytes);
  if (!attachment) return null;
  return [
    `這個附件超過目前 ${Math.floor(maxBytes / 1024 / 1024)} MB 的分析上限，暫時無法處理。`,
    "請重新上傳較小的檔案，或改成文字、PDF 摘要、圖片截圖。"
  ].join("\n");
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
