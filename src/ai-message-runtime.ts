import type { Message } from "discord.js";
import { buildMentionMessages } from "./ai-prompts.js";
import { aiError, callAiProvider } from "./ai-service.js";
import { regexIntentRoute, type IntentRoute } from "./ai-routing.js";
import type { Config } from "./config.js";
import { aiAccessForMessage } from "./discord-message-runtime.js";
import type { PromptMessageRef } from "./prompt-types.js";
import {
  attachmentLimitError,
  promptRefFromDiscordMessage,
  resolvePromptMessageRef
} from "./prompt-message-ref.js";
import { runtimeSettingsFromStore, type ResolvedRuntimeSettings } from "./runtime-settings.js";
import type { Store } from "./store.js";
import { DISCORD_ERROR_TEXT, safeMentions, stripBotMention } from "./text.js";

type SendableChannel = {
  send(options: unknown): Promise<unknown>;
};

type TypingChannel = {
  sendTyping(): Promise<unknown>;
};

type AiResponseChain = {
  requestLogId: number;
  sourceMessageId: string | null;
  channelId: string;
  responseMessageIds: string[];
};

type AiRequestLogInput = {
  actorId: string;
  channelId: string;
  sourceMessageId: string | null;
  triggerType: string;
  taskType: string;
  modelAlias?: string;
  status: string;
  errorType?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

type AiRuntimeStore = {
  setting(key: string): string | undefined;
  logAiRequest(input: AiRequestLogInput): number;
  recordAiResponseMessages(requestLogId: number, messageIds: string[]): void;
  aiResponseChain(messageId: string): AiResponseChain | undefined;
};

type TriggerContext = {
  triggerType: "mention" | "reply_to_bot";
  referencedMessage: Message | null;
  chain?: AiResponseChain;
};

type AiJob = {
  message: Message;
  store: Store;
  runtimeStore: AiRuntimeStore;
  config: Config;
  runtime: ResolvedRuntimeSettings;
  trigger: TriggerContext;
  userId: string;
  stopTyping: () => void;
  queuedTimer?: ReturnType<typeof setTimeout>;
};
const AI_MESSAGE_DEDUP_MS = 10 * 60_000;

const queuedJobs: AiJob[] = [];
const activeJobs = new Set<AiJob>();
const admittedByUser = new Map<string, AiJob>();
const aiUserCooldowns = new Map<string, number>();
const recentAiMessageIds = new Map<string, number>();
let aiRuntimeStopped = false;

function runtimeStore(store: Store): AiRuntimeStore {
  return store as unknown as AiRuntimeStore;
}

function modelAlias(store: Store, config: Config): string {
  return store.setting("ai_model")?.trim() || config.aiModel.trim() || "gemini/gemini-3.6-flash";
}

function cleanupAdmissionMaps(now = Date.now()): void {
  for (const [id, expiresAt] of recentAiMessageIds) {
    if (expiresAt <= now) recentAiMessageIds.delete(id);
  }
  for (const [id, expiresAt] of aiUserCooldowns) {
    if (expiresAt <= now) aiUserCooldowns.delete(id);
  }
}

function replyMentions(runtime: ResolvedRuntimeSettings): { parse: []; repliedUser: boolean } {
  return { parse: [], repliedUser: runtime.replyMentionUser };
}

async function safeReply(message: Message, content: string, runtime: ResolvedRuntimeSettings): Promise<void> {
  try {
    await message.reply({ content, allowedMentions: replyMentions(runtime) });
  } catch (error) {
    console.error(error);
  }
}

function cooldownText(): string {
  return "AI 使用量已達上限，請稍後再試。（AI-RATE-001）";
}

function sameUserText(): string {
  return "AI 使用量已達上限，請稍後再試。（AI-RATE-001）";
}

function queueFullText(): string {
  return "AI 使用量已達上限，請稍後再試。（AI-RATE-001）";
}

function queueTimeoutText(): string {
  return "AI 請求等候逾時，請稍後重試。（AI-QUEUE-001）";
}

function queueShutdownText(): string {
  return "正常重啟已取消佇列中的 AI 請求，請稍後重試。（AI-QUEUE-002）";
}

async function fetchReferencedMessage(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) return null;
  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}
function currentClientUserId(message: Message): string | null {
  const candidate = (message as Message & { client?: { user?: { id: string } | null } }).client;
  return candidate?.user?.id ?? null;
}

function hasBotMention(message: Message, clientUserId: string | null): boolean {
  if (!clientUserId) return false;
  const mentions = (message as Message & { mentions?: { users?: { has(id: string): boolean } } }).mentions;
  return Boolean(mentions?.users?.has(clientUserId));
}

async function detectTrigger(message: Message, runtimeStoreValue: AiRuntimeStore): Promise<TriggerContext | null> {
  const clientUserId = currentClientUserId(message);
  const referencedMessage = await fetchReferencedMessage(message);
  if (aiRuntimeStopped) return null;
  if (hasBotMention(message, clientUserId)) {
    const target = mentionTargetMessage(referencedMessage, message, clientUserId, runtimeStoreValue);
    return { triggerType: "mention", referencedMessage: target };
  }
  if (!referencedMessage) return null;
  const chain = runtimeStoreValue.aiResponseChain(referencedMessage.id);
  const referencedAttachments = (referencedMessage as Message & { attachments?: { size?: number } }).attachments;
  const referencedEmbeds = (referencedMessage as Message & { embeds?: unknown[] }).embeds;
  const referencedComponents = (referencedMessage as Message & { components?: unknown[] }).components;
  const attachmentCount = referencedAttachments?.size ?? 0;
  if (!chain || chain.channelId !== message.channelId || !chain.responseMessageIds.includes(referencedMessage.id) ||
      referencedMessage.author.id !== clientUserId || !pureTextMessage(referencedMessage) || attachmentCount > 0 ||
      Boolean(referencedEmbeds?.length) || Boolean(referencedComponents?.length)) return null;
  return { triggerType: "reply_to_bot", referencedMessage, chain };
}

function mentionTargetMessage(
  referenced: Message | null,
  message: Message,
  clientUserId: string | null,
  runtimeStoreValue: AiRuntimeStore
): Message | null {
  if (!referenced || referenced.channelId !== message.channelId) return null;
  const components = (referenced as Message & { components?: unknown[] }).components;
  const embeds = (referenced as Message & { embeds?: unknown[] }).embeds;
  if (components?.length || embeds?.length || referenced.system) return null;
  if (!referenced.author.bot) return referenced.webhookId || !humanTextMessage(referenced) ? null : referenced;
  if (referenced.author.id !== clientUserId || !pureTextMessage(referenced)) return null;
  const chain = runtimeStoreValue.aiResponseChain(referenced.id);
  return chain && chain.channelId === message.channelId && chain.responseMessageIds.includes(referenced.id)
    ? referenced
    : null;
}

function isSendableChannel(channel: Message["channel"]): channel is Message["channel"] & SendableChannel {
  return "send" in channel && typeof channel.send === "function";
}

function startTyping(message: Message): () => void {
  const channel = message.channel as Message["channel"] & Partial<TypingChannel>;
  if (typeof channel.sendTyping !== "function") return () => undefined;
  const sendTyping = () => {
    try {
      const promise = channel.sendTyping?.();
      void Promise.resolve(promise).catch(() => undefined);
    } catch {
      // Typing failures must not block admitted requests.
    }
  };
  sendTyping();
  const timer = setInterval(sendTyping, 8_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function stripDiscordHistoryUrls(content: string): string {
  return content.replace(/https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/[^\s>]+/gi, "[Discord 連結已移除]");
}

function messageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

async function replyDiscordChunks(message: Message, content: string, repliedUser: boolean, responseMaxChars: number): Promise<string[]> {
  const bounded = stripDiscordHistoryUrls(safeMentions(content)).slice(0, responseMaxChars);
  const chunks: string[] = [];
  for (let offset = 0; offset < bounded.length; offset += 2_000) {
    chunks.push(bounded.slice(offset, offset + 2_000));
  }
  if (!chunks.length) chunks.push("");
  const sentMessageIds: string[] = [];
  const first = await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser } });
  const firstId = messageId(first);
  if (!firstId) throw new Error("discord_delivery_missing_message_id");
  sentMessageIds.push(firstId);
  if (!isSendableChannel(message.channel)) {
    if (chunks.length > 1) throw new Error("discord_delivery_channel_not_sendable");
    return sentMessageIds;
  }
  for (const chunk of chunks.slice(1)) {
    const sent = await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    const sentId = messageId(sent);
    if (!sentId) throw new Error("discord_delivery_missing_message_id");
    sentMessageIds.push(sentId);
  }
  return sentMessageIds;
}

async function fetchChannelMessage(message: Message, id: string): Promise<Message | null> {
  const channel = message.channel as Message["channel"] & {
    messages?: { fetch(id: string): Promise<unknown> };
  };
  if (!channel.messages || typeof channel.messages.fetch !== "function") return null;
  try {
    const fetched = await channel.messages.fetch(id);
    return fetched && typeof fetched === "object" ? fetched as Message : null;
  } catch {
    return null;
  }
}

function pureTextMessage(message: Message): boolean {
  const components = (message as Message & { components?: unknown[] }).components;
  const embeds = (message as Message & { embeds?: unknown[] }).embeds;
  const attachments = (message as Message & { attachments?: { size?: number } }).attachments;
  const attachmentCount = attachments?.size ?? 0;
  const system = (message as Message & { system?: boolean }).system;
  return !system && !message.webhookId && !components?.length && !embeds?.length && attachmentCount === 0 && Boolean(message.content?.trim());
}

function textOnlyPromptRef(message: Message): PromptMessageRef {
  const ref = promptRefFromDiscordMessage(message);
  return { ...ref, attachments: undefined, imageUrls: undefined, attachmentExtractions: undefined };
}

function humanTextMessage(message: Message): boolean {
  return Boolean(message.content?.trim());
}

function validHumanTextMessage(message: Message): boolean {
  return !message.author.bot && !message.webhookId && !message.system &&
    humanTextMessage(message);
}

function recentHumanTextMessage(message: Message): boolean {
  const components = (message as Message & { components?: unknown[] }).components;
  const embeds = (message as Message & { embeds?: unknown[] }).embeds;
  const attachments = (message as Message & { attachments?: { size?: number } }).attachments;
  const system = (message as Message & { system?: boolean }).system;
  return !message.author.bot && !system && !components?.length && !embeds?.length &&
    (attachments?.size ?? 0) === 0 && humanTextMessage(message);
}

async function replyChainPrompt(
  job: AiJob
): Promise<{ source?: PromptMessageRef; responses: PromptMessageRef[]; unavailable: boolean }> {
  const chain = job.trigger.chain;
  if (!chain) return { responses: [], unavailable: false };
  const clientUserId = currentClientUserId(job.message);
  let unavailable = false;
  const sourceMessage = chain.sourceMessageId
    ? await fetchChannelMessage(job.message, chain.sourceMessageId)
    : null;
  if (!sourceMessage || !validHumanTextMessage(sourceMessage)) unavailable = true;
  const responseRefs: PromptMessageRef[] = [];
  for (const id of chain.responseMessageIds) {
    const response = id === job.trigger.referencedMessage?.id
      ? job.trigger.referencedMessage
      : await fetchChannelMessage(job.message, id);
    if (!response || !response.author.bot || response.author.id !== clientUserId || !pureTextMessage(response)) {
      unavailable = true;
      continue;
    }
    responseRefs.push(textOnlyPromptRef(response));
  }
  return {
    source: sourceMessage && validHumanTextMessage(sourceMessage)
      ? textOnlyPromptRef(sourceMessage)
      : undefined,
    responses: responseRefs,
    unavailable
  };
}

async function recentContext(
  job: AiJob,
  route: IntentRoute
): Promise<{ messages: PromptMessageRef[]; unavailable: boolean }> {
  if (!route.useRecentContext) return { messages: [], unavailable: false };
  const channel = job.message.channel as Message["channel"] & {
    messages?: { fetch(options: { limit: number }): Promise<unknown> };
  };
  if (!channel.messages || typeof channel.messages.fetch !== "function") {
    return { messages: [], unavailable: true };
  }
  try {
    const fetched = await channel.messages.fetch({ limit: job.runtime.recentContextMessages });
    const values = fetched && typeof fetched === "object" && "values" in fetched
      ? [...(fetched as { values(): Iterable<Message> }).values()]
      : Array.isArray(fetched) ? fetched : [];
    const selected: PromptMessageRef[] = [];
    const clientUserId = currentClientUserId(job.message);
    for (const candidate of values) {
      if (!candidate || candidate.id === job.message.id) continue;
      if (candidate.author.bot) {
        if (candidate.author.id !== clientUserId || !pureTextMessage(candidate)) continue;
        const chain = job.runtimeStore.aiResponseChain(candidate.id);
        if (!chain || chain.channelId !== job.message.channelId || !chain.responseMessageIds.includes(candidate.id)) continue;
      } else if (!recentHumanTextMessage(candidate) || candidate.webhookId) {
        continue;
      }
      selected.push(textOnlyPromptRef(candidate));
    }
    selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { messages: selected.slice(-job.runtime.recentContextMessages), unavailable: false };
  } catch {
    return { messages: [], unavailable: true };
  }
}
function logRequest(store: AiRuntimeStore, input: AiRequestLogInput): number | undefined {
  try {
    const id = store.logAiRequest(input);
    return typeof id === "number" ? id : undefined;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

function finishJob(job: AiJob): void {
  activeJobs.delete(job);
  if (admittedByUser.get(job.userId) === job) admittedByUser.delete(job.userId);
  aiUserCooldowns.set(job.userId, Date.now() + job.runtime.cooldownSeconds * 1_000);
  job.stopTyping();
  pumpQueue();
}

async function executeJob(job: AiJob): Promise<void> {
  const message = job.message;
  const runtimeStoreValue = job.runtimeStore;
  const clientUserId = currentClientUserId(message);
  const question = (clientUserId ? stripBotMention(message.content, clientUserId) : message.content).trim() || "請分析這則訊息。";
  const sourceMessageId: string | null = message.id;
  let providerResult: { content: string; modelAlias: string; latencyMs: number; inputTokens?: number; outputTokens?: number } | undefined;
  let deliveryCompleted = false;
  const taskType = job.trigger.triggerType === "reply_to_bot" ? "analyze_reply" : "answer";
  let contextUnavailable = false;
  try {
    const askingMessage = await resolvePromptMessageRef(message, job.runtime.attachmentMaxBytes);
    const referenced = job.trigger.referencedMessage;
    const targetMessage = referenced && job.trigger.triggerType === "mention"
      ? textOnlyPromptRef(referenced)
      : undefined;
    const route = regexIntentRoute(question, askingMessage, targetMessage);
    const chainPrompt = await replyChainPrompt(job);
    contextUnavailable = chainPrompt.unavailable;
    const recent = await recentContext(job, route);
    contextUnavailable ||= recent.unavailable;
    const promptMessages = buildMentionMessages({
      question,
      askingMessage,
      targetMessage,
      replyContext: job.trigger.triggerType === "reply_to_bot" ? chainPrompt : undefined,
      recentContext: recent.messages,
      useSpoilerWarning: route.useSpoiler
    });
    providerResult = await callAiProvider(job.store, job.config, promptMessages);
    let content = providerResult.content;
    if (contextUnavailable) {
      content = "部分近期對話無法取得（AI-CONTEXT-001），以下根據目前可取得上下文回答。\n\n" + content;
    }
    const responseMessageIds = await replyDiscordChunks(message, content, job.runtime.replyMentionUser, job.runtime.responseMaxChars);
    deliveryCompleted = true;
    const requestLogId = logRequest(runtimeStoreValue, {
      actorId: message.author.id,
      channelId: message.channelId,
      sourceMessageId,
      triggerType: job.trigger.triggerType,
      taskType,
      modelAlias: providerResult.modelAlias,
      status: "ok",
      errorType: contextUnavailable ? "ai_context_unavailable" : undefined,
      latencyMs: providerResult.latencyMs,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens
    });
    if (requestLogId === undefined) {
      console.error("ai_response_metadata_failed");
      return;
    }
    if (responseMessageIds.length) {
      runtimeStoreValue.recordAiResponseMessages(requestLogId, responseMessageIds);
    }
  } catch (error) {
    if (providerResult) {
      if (!deliveryCompleted) logRequest(runtimeStoreValue, {
        actorId: message.author.id,
        channelId: message.channelId,
        sourceMessageId,
        triggerType: job.trigger.triggerType,
        taskType,
        modelAlias: providerResult.modelAlias,
        status: "delivery_error",
        errorType: "discord_delivery_failed",
        latencyMs: providerResult.latencyMs,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens
      });
      else console.error("ai_response_metadata_failed");
      console.error(error);
      return;
    }
    const normalized = aiError(error);
    logRequest(runtimeStoreValue, {
      actorId: message.author.id,
      channelId: message.channelId,
      sourceMessageId,
      triggerType: job.trigger.triggerType,
      taskType,
      modelAlias: modelAlias(job.store, job.config),
      status: "error",
      errorType: normalized.logType
    });
    await safeReply(message, DISCORD_ERROR_TEXT.aiUnavailable(normalized.userCode), job.runtime);
  }
}
async function runJob(job: AiJob): Promise<void> {
  activeJobs.add(job);
  try {
    await executeJob(job);
  } finally {
    finishJob(job);
  }
}

function pumpQueue(): void {
  if (aiRuntimeStopped) return;
  while (queuedJobs.length) {
    const next = queuedJobs[0];
    if (activeJobs.size >= next.runtime.maxInFlight) break;
    queuedJobs.shift();
    if (next.queuedTimer) clearTimeout(next.queuedTimer);
    void runJob(next);
  }
}

function expireQueuedJob(job: AiJob): void {
  const index = queuedJobs.indexOf(job);
  if (index < 0) return;
  queuedJobs.splice(index, 1);
  if (admittedByUser.get(job.userId) === job) admittedByUser.delete(job.userId);
  aiUserCooldowns.set(job.userId, Date.now() + job.runtime.cooldownSeconds * 1_000);
  job.stopTyping();
  void safeReply(job.message, queueTimeoutText(), job.runtime);
  pumpQueue();
}

function admitJob(job: AiJob): "duplicate" | "cooldown" | "same_user" | "queue_full" | "running" | "queued" | "stopped" {
  const now = Date.now();
  if (aiRuntimeStopped) return "stopped";
  cleanupAdmissionMaps(now);
  if ((recentAiMessageIds.get(job.message.id) ?? 0) > now) return "duplicate";
  if ((aiUserCooldowns.get(job.userId) ?? 0) > now) return "cooldown";
  if (admittedByUser.has(job.userId)) return "same_user";
  if (activeJobs.size < job.runtime.maxInFlight) {
    recentAiMessageIds.set(job.message.id, now + AI_MESSAGE_DEDUP_MS);
    admittedByUser.set(job.userId, job);
    return "running";
  }
  if (queuedJobs.length >= job.runtime.queueMax) return "queue_full";
  recentAiMessageIds.set(job.message.id, now + AI_MESSAGE_DEDUP_MS);
  admittedByUser.set(job.userId, job);
  queuedJobs.push(job);
  job.queuedTimer = setTimeout(() => expireQueuedJob(job), job.runtime.queueTimeoutSeconds * 1_000);
  return "queued";
}

export async function handleAiMessage(message: Message, store: Store, config: Config): Promise<void> {
  if (aiRuntimeStopped || !message.guildId || !config.guildIds.includes(message.guildId) ||
      message.author.bot || message.webhookId || message.system) return;
  const runtimeStoreValue = runtimeStore(store);
  const trigger = await detectTrigger(message, runtimeStoreValue);
  if (!trigger) return;
  if (aiRuntimeStopped) return;
  const runtime = runtimeSettingsFromStore(store, config);
  const access = aiAccessForMessage(message, store, config);
  if (!access.ok) {
    if (access.reason === "channel") await safeReply(message, DISCORD_ERROR_TEXT.channelDisabled, runtime);
    if (access.reason === "disabled") await safeReply(message, DISCORD_ERROR_TEXT.aiDisabled, runtime);
    return;
  }
  const attachmentError = attachmentLimitError(
    [message],
    runtime.attachmentMaxBytes
  );
  if (attachmentError) {
    await safeReply(message, attachmentError, runtime);
    return;
  }
  const job: AiJob = {
    message,
    store,
    runtimeStore: runtimeStoreValue,
    config,
    runtime,
    trigger,
    userId: message.author.id,
    stopTyping: () => undefined
  };
  const admission = admitJob(job);
  if (admission === "duplicate") {
    job.stopTyping();
    return;
  }
  if (admission === "cooldown") {
    job.stopTyping();
    await safeReply(message, cooldownText(), runtime);
    return;
  }
  if (admission === "same_user") {
    job.stopTyping();
    await safeReply(message, sameUserText(), runtime);
    return;
  }
  if (admission === "queue_full") {
    job.stopTyping();
    await safeReply(message, queueFullText(), runtime);
    return;
  }
  if (admission === "stopped") {
    job.stopTyping();
    return;
  }
  job.stopTyping = startTyping(message);
  if (admission === "running") {
    void runJob(job);
  } else {
    pumpQueue();
  }
}

export async function stopAiRuntime(): Promise<void> {
  if (aiRuntimeStopped) return;
  aiRuntimeStopped = true;
  const pending = queuedJobs.splice(0);
  await Promise.all(pending.map(async (job) => {
    if (job.queuedTimer) clearTimeout(job.queuedTimer);
    if (admittedByUser.get(job.userId) === job) admittedByUser.delete(job.userId);
    aiUserCooldowns.set(job.userId, Date.now() + job.runtime.cooldownSeconds * 1_000);
    job.stopTyping();
    await safeReply(job.message, queueShutdownText(), job.runtime);
  }));
}

export function activeAiRequestCount(): number {
  return activeJobs.size;
}
