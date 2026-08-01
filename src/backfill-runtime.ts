import type { Client, Message } from "discord.js";
import { shouldRememberMessage, storedMessageFromDiscord } from "./discord-message-runtime.js";
import type { BackfillTarget, Store } from "./store.js";
// ponytail: a fixed safety ceiling is enough for this single-guild bot.
const BACKFILL_MESSAGE_LIMIT = 10_000;

type BackfillStore = Pick<Store,
  | "addBackfillTarget"
  | "backfillFetchedCount"
  | "finishBackfillJob"
  | "listMemoryChannels"
  | "markBackfillJobRunning"
  | "markBackfillTargetCompleted"
  | "markBackfillTargetFailed"
  | "markBackfillTargetProgress"
  | "markBackfillTargetRunning"
  | "nextBackfillTarget"
  | "rememberMessage"
  | "resetRunningBackfillTargets"
>;

export async function runBackfillJob(client: Client, store: BackfillStore, jobId: number): Promise<void> {
  store.resetRunningBackfillTargets(jobId);
  store.markBackfillJobRunning(jobId);

  let target: BackfillTarget | undefined;
  while ((target = store.nextBackfillTarget(jobId))) {
    const remaining = BACKFILL_MESSAGE_LIMIT - store.backfillFetchedCount(jobId);
    if (remaining <= 0) {
      store.finishBackfillJob(jobId, "partial_limit");
      return;
    }
    store.markBackfillTargetRunning(target.id);
    try {
      const limitReached = await backfillTarget(client, store, target, remaining);
      store.markBackfillTargetCompleted(target.id);
      if (limitReached) {
        store.finishBackfillJob(jobId, "partial_limit");
        return;
      }
    } catch (error) {
      store.markBackfillTargetFailed(target.id, error instanceof Error ? error.message : String(error));
      await sleep(1_000);
    }
  }

  store.finishBackfillJob(jobId);
}

async function backfillTarget(client: Client, store: BackfillStore, target: BackfillTarget, remaining: number): Promise<boolean> {
  // Memory scope is exact: a parent channel being enabled never opts its threads in.
  if (!store.listMemoryChannels().includes(target.channelId)) return false;
  const channel = await client.channels.fetch(target.channelId);
  if (!channel) throw new Error(`channel ${target.channelId} not found`);

  let threadDiscoveryError: unknown;
  if (target.type === "channel") {
    try {
      await addThreadTargetsFromChannel(channel, store, target.jobId);
    } catch (error) {
      threadDiscoveryError = error;
    }
  }
  if (!hasMessageFetch(channel)) {
    throw new Error(`channel ${target.channelId} does not support message history`);
  }

  let before = target.oldestFetchedMessageId ?? undefined;
  while (true) {
    const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
    const messages = [...batch.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);
    if (!messages.length) break;

    let remembered = 0;
    const selected = messages.slice(Math.max(0, messages.length - remaining));
    for (const message of selected) {
      if (!shouldRememberMessage(message, store)) continue;
      store.rememberMessage(storedMessageFromDiscord(message));
      remembered += 1;
      remaining -= 1;
      if (remaining <= 0) break;
    }

    before = messages[0].id;
    store.markBackfillTargetProgress(target.id, before, remembered);
    if (remaining <= 0) return true;
    if (batch.size < 100) break;
    await sleep(500);
  }
  if (threadDiscoveryError) throw threadDiscoveryError;
  return false;
}

async function addThreadTargetsFromChannel(channel: unknown, store: BackfillStore, jobId: number): Promise<void> {
  const manager = (channel as { threads?: {
    fetchActive?: () => Promise<unknown>;
    fetchArchived?: (options: { type: "public" | "private"; fetchAll: true }) => Promise<unknown>;
  } }).threads;
  if (!manager) return;

  const parentId = (channel as { id?: string }).id ?? null;
  const errors: string[] = [];
  for (const [kind, fetchThreads] of [
    ["active", () => manager.fetchActive?.()],
    ["public archived", () => manager.fetchArchived?.({ type: "public", fetchAll: true })],
    ["private archived", () => manager.fetchArchived?.({ type: "private", fetchAll: true })]
  ] as const) {
    try {
      const result = await fetchThreads();
      for (const thread of threadValues(result)) {
        store.addBackfillTarget(jobId, thread.id, parentId, "thread");
      }
    } catch (error) {
      errors.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new Error(`thread discovery partial: ${errors.join("; ").slice(0, 400)}`);
}

function threadValues(result: unknown): Array<{ id: string }> {
  const threads = (result as { threads?: { values?: () => IterableIterator<{ id: string }> } } | undefined)?.threads;
  return threads?.values ? [...threads.values()] : [];
}

function hasMessageFetch(channel: unknown): channel is { messages: { fetch(options: { limit: number; before?: string }): Promise<{ values(): IterableIterator<Message>; size: number }> } } {
  return typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch === "function";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


