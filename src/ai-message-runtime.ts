import { type Client, type Message } from "discord.js";
import { buildMentionMessages } from "./ai-prompts.js";
import {
  aiError,
  callAiProvider,
  callEmbeddingProvider,
  embeddingDocumentText,
  embeddingProviderConfig,
  embeddingQueryText
} from "./ai-service.js";
import {
  regexIntentRoute,
  shouldSearchMemory,
  shouldUseRecentContext,
  type IntentRoute
} from "./ai-routing.js";
import type { Config } from "./config.js";
import { aiAccessForMessage } from "./discord-message-runtime.js";
import {
  boundedContextMessages,
  promptSource,
  uniquePromptRefs,
  type MemorySearchResult,
  type PromptMessageRef
} from "./memory.js";
import { attachmentLimitError, resolvePromptMessageRef } from "./prompt-message-ref.js";
import { runtimeSettingsFromStore } from "./runtime-settings.js";
import { Store } from "./store.js";
import { safeMentions, splitDiscordText, stripBotMention } from "./text.js";

type SendableChannel = {
  send(options: unknown): Promise<unknown>;
};

type TypingChannel = {
  sendTyping(): Promise<unknown>;
};

const AI_USER_COOLDOWN_MS = 10_000;
const AI_MESSAGE_DEDUP_MS = 10 * 60_000;
const AI_MAX_IN_FLIGHT = 2;
const DISCORD_RESPONSE_CHAR_LIMIT = 12_000;
const DISCORD_RESPONSE_CHUNK_LIMIT = 6;

const aiUserCooldowns = new Map<string, number>();
const recentAiMessageIds = new Map<string, number>();
let activeAiRequests = 0;

async function memoryForQuestion(store: Store, config: Config, question: string, currentChannelId: string, summaryMessageLimit: number, excludeMessageIds: string[] = [], route?: IntentRoute): Promise<MemorySearchResult | undefined> {
  const useMemory = route ? route.useMemory || route.useRecentContext : shouldSearchMemory(question);
  const useRecent = route ? route.useRecentContext : shouldUseRecentContext(question);
  if (!useMemory && !useRecent) return undefined;
  if (!store.listMemoryChannels().includes(currentChannelId)) {
    return { query: "", hits: [], contextMessages: [], sources: [] };
  }

  if (useRecent) {
    const recent = store.recentMessages(currentChannelId, summaryMessageLimit, excludeMessageIds);
    return {
      query: "(近期對話)",
      hits: [],
      contextMessages: recent,
      sources: recent.slice(-3).map(promptSource)
    };
  }

  const memory = store.searchMemory({
    query: question,
    currentChannelId,
    excludeMessageIds,
    limit: summaryMessageLimit
  });
  if (route ? route.useMemory : shouldSearchMemory(question)) {
    const semantic = await semanticMemoryForQuestion(store, config, question, currentChannelId, summaryMessageLimit, excludeMessageIds);
    if (semantic) {
      memory.hits = uniquePromptRefs([...memory.hits, ...semantic.hits]).slice(0, summaryMessageLimit);
      memory.contextMessages = boundedContextMessages(
        uniquePromptRefs([...memory.contextMessages, ...semantic.contextMessages]),
        memory.hits,
        summaryMessageLimit
      );
      memory.sources = [...new Set([...memory.sources, ...semantic.sources])].slice(0, 3);
      memory.query = memory.query || semantic.query;
    }
  }
  return useMemory ? memory : undefined;
}

async function semanticMemoryForQuestion(store: Store, config: Config, question: string, currentChannelId: string, limit: number, excludeMessageIds: string[]): Promise<MemorySearchResult | undefined> {
  try {
    const { model } = embeddingProviderConfig(config);
    const [embedding] = await callEmbeddingProvider(config, [embeddingQueryText(question)]);
    if (!embedding?.length) return undefined;
    const result = store.searchSemanticMemory({
      embedding,
      model,
      currentChannelId,
      excludeMessageIds,
      limit
    });
    return result.hits.length ? result : undefined;
  } catch {
    return undefined;
  }
}

async function fetchReferencedMessage(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) return null;
  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

function isSendableChannel(channel: Message["channel"]): channel is Message["channel"] & SendableChannel {
  return "send" in channel && typeof channel.send === "function";
}

function startTyping(message: Message): () => void {
  const channel = message.channel as Message["channel"] & Partial<TypingChannel>;
  if (typeof channel.sendTyping !== "function") return () => undefined;
  const sendTyping = () => {
    const promise = channel.sendTyping?.();
    void promise?.catch(() => undefined);
  };
  sendTyping();
  const timer = setInterval(sendTyping, 8_000);
  return () => clearInterval(timer);
}

async function replyDiscordChunks(message: Message, content: string, repliedUser: boolean): Promise<void> {
  const suffix = "\n\n（回覆過長，已截斷）";
  const safe = safeMentions(content);
  const bounded = safe.length > DISCORD_RESPONSE_CHAR_LIMIT
    ? `${safe.slice(0, DISCORD_RESPONSE_CHAR_LIMIT - suffix.length)}${suffix}`
    : safe;
  const allChunks = splitDiscordText(bounded);
  const chunks = allChunks.slice(0, DISCORD_RESPONSE_CHUNK_LIMIT);
  if (allChunks.length > DISCORD_RESPONSE_CHUNK_LIMIT) {
    const last = chunks.length - 1;
    chunks[last] = `${chunks[last].slice(0, 2_000 - suffix.length)}${suffix}`;
  }
  await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser } });
  if (!isSendableChannel(message.channel)) return;
  for (const chunk of chunks.slice(1)) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

export function startEmbeddingWorker(store: Store, config: Config): () => Promise<void> {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processPendingEmbeddings(store, config);
    } catch (error) {
      console.error(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref?.();
  void tick();
  return async () => {
    clearInterval(timer);
    while (running) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  };
}

async function processPendingEmbeddings(store: Store, config: Config): Promise<void> {
  let model: string;
  try {
    model = embeddingProviderConfig(config).model;
  } catch {
    return;
  }
  const pending = store.pendingMessageEmbeddings(model, 8);
  if (!pending.length) return;
  try {
    const embeddings = await callEmbeddingProvider(config, pending.map((item) => embeddingDocumentText(item.text)));
    if (embeddings.length !== pending.length) throw new Error(`embedding_count_mismatch:${embeddings.length}/${pending.length}`);
    for (let index = 0; index < pending.length; index += 1) {
      store.saveMessageEmbedding(pending[index].messageId, model, embeddings[index]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of pending) {
      store.markMessageEmbeddingFailed(item.messageId, model, message);
    }
  }
}

export function claimAiRequest(messageId: string, userId: string, at = Date.now()): "duplicate" | "cooldown" | "busy" | null {
  for (const [id, expiresAt] of recentAiMessageIds) if (expiresAt <= at) recentAiMessageIds.delete(id);
  for (const [id, expiresAt] of aiUserCooldowns) if (expiresAt <= at) aiUserCooldowns.delete(id);
  if ((recentAiMessageIds.get(messageId) ?? 0) > at) return "duplicate";
  recentAiMessageIds.set(messageId, at + AI_MESSAGE_DEDUP_MS);
  if ((aiUserCooldowns.get(userId) ?? 0) > at) return "cooldown";
  if (activeAiRequests >= AI_MAX_IN_FLIGHT) return "busy";
  aiUserCooldowns.set(userId, at + AI_USER_COOLDOWN_MS);
  activeAiRequests += 1;
  return null;
}

export function releaseAiRequest(): void {
  activeAiRequests = Math.max(0, activeAiRequests - 1);
}

export function activeAiRequestCount(): number {
  return activeAiRequests;
}

export async function handleAiMention(message: Message, client: Client, store: Store, config: Config): Promise<void> {
  if (!message.guildId || !config.guildIds.includes(message.guildId) || message.author.bot || !client.user) return;
  if (!message.mentions.users.has(client.user.id)) return;
  const triggerType = "mention";
  const referencedMessage = await fetchReferencedMessage(message);
  const runtime = runtimeSettingsFromStore(store, config);
  const access = aiAccessForMessage(message, store, config);
  if (!access.ok) {
    if (access.reason === "channel") {
      await message.reply({ content: "此頻道尚未啟用 AI 功能", allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser } });
    }
    if (access.reason === "disabled") {
      await message.reply({ content: "AI 功能目前已停用", allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser } });
    }
    return;
  }

  const attachmentError = attachmentLimitError([message, ...(referencedMessage ? [referencedMessage] : [])], runtime.attachmentMaxBytes);
  if (attachmentError) {
    await message.reply({ content: attachmentError, allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser } });
    return;
  }

  const admission = claimAiRequest(message.id, message.author.id);
  if (admission === "duplicate") return;
  if (admission === "cooldown") {
    await message.reply({ content: "請稍候 10 秒再詢問。", allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser } });
    return;
  }
  if (admission === "busy") {
    await message.reply({ content: "目前已有兩個 AI 請求處理中，請稍後再試。", allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser } });
    return;
  }

  const question = stripBotMention(message.content, client.user.id) || "請分析這則訊息。";
  const stopTyping = startTyping(message);
  let targetMessage: PromptMessageRef | undefined;
  let providerResult: {
    modelAlias: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
  } | undefined;
  let successfulStatus = "ok";
  try {
    const askingMessage = await resolvePromptMessageRef(message, store, runtime.attachmentMaxBytes);
    targetMessage = referencedMessage ? await resolvePromptMessageRef(referencedMessage, store, runtime.attachmentMaxBytes) : undefined;
    const route = regexIntentRoute(question, askingMessage, targetMessage);
    const memory = await memoryForQuestion(store, config, question, message.channelId, runtime.summaryMessageLimit, [message.id], route);
    const promptMessages = buildMentionMessages({
      question,
      askingMessage,
      targetMessage,
      memory,
      useSpoilerWarning: route.useSpoiler
    });
    const chatResult = await callAiProvider(store, config, promptMessages);
    providerResult = chatResult;
    await replyDiscordChunks(message, chatResult.content, runtime.replyMentionUser);
    store.logAiRequest({
      actorId: message.author.id,
      channelId: message.channelId,
      sourceMessageId: targetMessage?.id ?? message.id,
      triggerType,
      taskType: targetMessage ? "analyze_reply" : "answer",
      modelAlias: providerResult.modelAlias,
      status: successfulStatus,
      latencyMs: providerResult.latencyMs,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens
    });
  } catch (error) {
    if (providerResult) {
      store.logAiRequest({
        actorId: message.author.id,
        channelId: message.channelId,
        sourceMessageId: targetMessage?.id ?? message.id,
        triggerType,
        taskType: targetMessage ? "analyze_reply" : "answer",
        modelAlias: providerResult.modelAlias,
        status: "delivery_error",
        errorType: "discord_delivery_failed",
        latencyMs: providerResult.latencyMs,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens
      });
      console.error(error);
      return;
    }
    const normalized = aiError(error);
    store.logAiRequest({
      actorId: message.author.id,
      channelId: message.channelId,
      sourceMessageId: targetMessage?.id ?? message.id,
      triggerType,
      taskType: targetMessage ? "analyze_reply" : "answer",
      modelAlias: store.setting("ai_model") ?? config.aiModel,
      status: "error",
      errorType: normalized.logType
    });
    await message.reply({
      content: `目前 AI 服務暫時不可用，請稍後再試。\n錯誤代碼：${normalized.userCode}`,
      allowedMentions: { parse: [], repliedUser: runtime.replyMentionUser }
    });
  } finally {
    releaseAiRequest();
    stopTyping();
  }
}
