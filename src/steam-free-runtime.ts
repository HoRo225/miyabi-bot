import {
  ChannelType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Client
} from "discord.js";
import {
  actionRow,
  componentContainer,
  linkButton,
  mediaGallery,
  separator,
  textDisplay,
  type ComponentJson
} from "./discord-ui.js";
import {
  parseSteamFreeAppClaimUntilAt,
  parseSteamFreeSearchResponse,
  steamFreeIntervalMinutes,
  steamFreeItemExpired,
  steamFreeNotificationTitle,
  steamFreePriceText,
  type SteamFreeItem
} from "./steam-free.js";
import { Store, now, type SteamFreeSeenItem } from "./store.js";
import { discordTimestampText, inlineCodeText, safeMentions } from "./text.js";

const STEAM_FREE_SEARCH_URL = "https://store.steampowered.com/search/results/?query&start=0&count=50&dynamic_data=&sort_by=_ASC&maxprice=free&category1=998&specials=1&infinite=1&cc=tw&l=tchinese";
const STEAM_FREE_CHANNEL_SCAN_LIMIT = 100;
const STEAM_RETRY_MAX_DELAY_MS = 30_000;
const STEAM_FREE_CHANNEL_ERROR_CODE = "STEAM-CHANNEL-001";
const STEAM_FREE_CHECK_ERROR_CODE = "STEAM-CHECK-001";
const STEAM_ACCESS_BLOCKED_ERROR_CODE = "DISCORD-ID-002";

export type SteamFreeCheckOutcome = "found" | "notified" | "no-change" | "error";

export type SteamFreeCheckResult = {
  found: number;
  notified: number;
  outcome: SteamFreeCheckOutcome;
  errorCode?: string;

};
// ponytail: one bot process needs one Steam check; split per guild only if this becomes multi-tenant.
export type SteamFreeRuntimeStatus = {
  module: "steam";
  state: "ready" | "disabled" | "degraded";
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  errorCode: string | null;
};

let steamFreeStatusState: SteamFreeRuntimeStatus = {
  module: "steam",
  state: "disabled",
  lastSuccessAt: null,
  lastErrorAt: null,
  errorCode: null
};

export function steamFreeRuntimeStatus(): SteamFreeRuntimeStatus {
  return { ...steamFreeStatusState };
}

function setSteamFreeStatus(state: SteamFreeRuntimeStatus["state"], errorCode: string | null = null): void {
  const timestamp = now();
  steamFreeStatusState = {
    ...steamFreeStatusState,
    state,
    ...(state === "ready" ? { lastSuccessAt: timestamp } : {}),
    ...(state === "degraded" ? { lastErrorAt: timestamp } : {}),
    errorCode
  };
}
let steamFreeCheckInFlight: Promise<SteamFreeCheckResult> | null = null;

export type SteamFreeRuntimeStore = Pick<Store,
  | "markSteamFreeExpired"
  | "markSteamFreeSeen"
  | "seenSteamFreeItemIds"
  | "setSteamFreeSetting"
  | "steamFreeSeenItemsToExpire"
  | "steamFreeSettings"
  | "isSteamAccessBlocked"
> & {
  steamFreeSetting?: (key: string) => string | undefined;
};

type SendableChannel = {
  type?: ChannelType;
  isThread?: () => boolean;
  send(options: unknown): Promise<unknown>;
};
type SteamFreeChannelMessage = {
  id: string | null;
  text: string;
};

type MessageHistoryChannel = SendableChannel & {
  messages: { fetch(options: { limit: number }): Promise<{ values(): Iterable<unknown> }> };
};

type MessageLookupChannel = SendableChannel & {
  messages: { fetch(messageId: string): Promise<unknown> };
};

async function fetchSteamFreeItems(): Promise<SteamFreeItem[]> {
  const response = await fetchSteam(STEAM_FREE_SEARCH_URL, {
    headers: { accept: "application/json", "user-agent": "horo-discord-bot/0.1" }
  });
  if (!response.ok) throw new Error(`Steam Store HTTP ${response.status}`);
  return hydrateSteamFreeClaimUntilDates(
    parseSteamFreeSearchResponse(await response.json())
      .map(normalizeSteamFreeItem)
      .filter((item): item is SteamFreeItem => item !== null)
  );
}

async function hydrateSteamFreeClaimUntilDates(items: SteamFreeItem[]): Promise<SteamFreeItem[]> {
  const hydrated: SteamFreeItem[] = [];
  for (const item of items) {
    const claimUntilAt = await fetchSteamFreeAppClaimUntilAt(item.appId);
    if (claimUntilAt) hydrated.push({ ...item, claimUntilAt });
  }
  return hydrated;
}

async function fetchSteamFreeAppClaimUntilAt(appId: string): Promise<string | null> {
  const response = await fetchSteam(`https://store.steampowered.com/app/${encodeURIComponent(appId)}/?cc=tw&l=tchinese`, {
    headers: { accept: "text/html", "user-agent": "horo-discord-bot/0.1" }
  });
  if (!response.ok) throw new Error(`Steam app ${appId} HTTP ${response.status}`);
  return parseSteamFreeAppClaimUntilAt(await response.text());
}

export function checkSteamFreeGames(client: Client, store: SteamFreeRuntimeStore): Promise<SteamFreeCheckResult> {
  if (store.isSteamAccessBlocked()) return Promise.resolve(steamAccessBlockedResult());
  if (steamFreeCheckInFlight) return steamFreeCheckInFlight;
  const task = (async (): Promise<SteamFreeCheckResult> => {
    try {
      if (store.isSteamAccessBlocked()) return steamAccessBlockedResult();
      const settings = store.steamFreeSettings();
      if (!settings.enabled) {
        setSteamFreeStatus("disabled");
        return { found: 0, notified: 0, outcome: "no-change" };
      }
      const result = await checkSteamFreeGamesOnce(client, store);
      if (result.outcome === "error") setSteamFreeStatus("degraded", result.errorCode ?? STEAM_FREE_CHECK_ERROR_CODE);
      else setSteamFreeStatus("ready");
      return result;
    } catch (error) {
      console.error(error);
      setSteamFreeStatus("degraded", STEAM_FREE_CHECK_ERROR_CODE);
      return { found: 0, notified: 0, outcome: "error", errorCode: STEAM_FREE_CHECK_ERROR_CODE };
    }
  })().finally(() => {
    if (steamFreeCheckInFlight === task) steamFreeCheckInFlight = null;
  });
  steamFreeCheckInFlight = task;
  return task;
}

async function checkSteamFreeGamesOnce(client: Client, store: SteamFreeRuntimeStore): Promise<SteamFreeCheckResult> {
  if (store.isSteamAccessBlocked()) return steamAccessBlockedResult();
  const settings = store.steamFreeSettings();
  if (!settings.enabled) return { found: 0, notified: 0, outcome: "no-change" };
  if (!settings.channelId) return { found: 0, notified: 0, outcome: "error", errorCode: STEAM_FREE_CHANNEL_ERROR_CODE };
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!isSteamFreeNotificationChannel(channel)) return { found: 0, notified: 0, outcome: "error", errorCode: STEAM_FREE_CHANNEL_ERROR_CODE };

  await markExpiredSteamFreeNotifications(channel, store, settings.notifyRoleIds);
  const items = await fetchSteamFreeItems();
  const activeItems = items.filter((item) => !steamFreeItemExpired(item));
  const seen = new Set(store.seenSteamFreeItemIds());
  const channelSnapshot = await fetchSteamFreeChannelMessages(channel, client.user?.id ?? null);
  const activeSnapshot = channelSnapshot?.filter((message) => !message.text.includes("(已過期)")) ?? null;
  const channelText = activeSnapshot?.map((message) => message.text).join("\n") ?? null;
  const missingIds = channelSnapshot == null
    ? null
    : new Set(steamFreeItemsMissingFromChannel(activeItems, channelText ?? "").map((item) => item.appId));
  let notified = 0;
  for (const item of activeItems) {
    if (missingIds) {
      if (!missingIds.has(item.appId)) {
        store.markSteamFreeSeen(item, steamFreeItemMessageIdInSnapshot(item, activeSnapshot ?? []));
        seen.add(item.appId);
        continue;
      }
    } else if (seen.has(item.appId)) {
      continue;
    }

    const message = await sendSteamFreeNotification(channel, item, settings.notifyRoleIds);
    store.markSteamFreeSeen(item, steamFreeMessageId(message));
    seen.add(item.appId);
    notified += 1;
  }
  store.setSteamFreeSetting("last_checked_at", now());
  const outcome: SteamFreeCheckOutcome = notified > 0 ? "notified" : activeItems.length > 0 ? "found" : "no-change";
  return { found: items.length, notified, outcome };
}

type SteamFreeWorker = {
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  stop: () => Promise<void>;
};

let steamFreeWorker: SteamFreeWorker | null = null;

export function startSteamFreeWorker(client: Client, store: SteamFreeRuntimeStore): () => Promise<void> {
  if (steamFreeWorker) return steamFreeWorker.stop;
  const worker: SteamFreeWorker = { stopped: false, timer: null, running: null, stop: async () => undefined };
  const schedule = () => {
    if (worker.stopped) return;
    const minutes = steamFreeIntervalMinutes(store.steamFreeSetting?.("interval_minutes"));
    worker.timer = setTimeout(() => {
      worker.timer = null;
      worker.running = tick();
      void worker.running;
    }, minutes * 60 * 1000);
    worker.timer.unref?.();
  };
  const tick = async () => {
    try {
      if (store.isSteamAccessBlocked()) {
        setSteamFreeStatus("degraded", STEAM_ACCESS_BLOCKED_ERROR_CODE);
        return;
      }
      await checkSteamFreeGames(client, store);
    } catch (error) {
      console.error(error);
    } finally {
      if (!worker.stopped) schedule();
    }
  };
  worker.stop = async () => {
    worker.stopped = true;
    if (worker.timer) clearTimeout(worker.timer);
    await worker.running?.catch(() => undefined);
    await steamFreeCheckInFlight?.catch(() => undefined);
    if (steamFreeWorker === worker) steamFreeWorker = null;
  };
  steamFreeWorker = worker;
  worker.running = tick();
  void worker.running;
  return worker.stop;
}

function steamAccessBlockedResult(): SteamFreeCheckResult {
  setSteamFreeStatus("degraded", STEAM_ACCESS_BLOCKED_ERROR_CODE);
  return { found: 0, notified: 0, outcome: "error", errorCode: STEAM_ACCESS_BLOCKED_ERROR_CODE };
}

export async function stopSteamFreeWorker(): Promise<void> {
  const worker = steamFreeWorker;
  if (worker) await worker.stop();
}

export function isSteamFreeNotificationChannel(channel: unknown): channel is SendableChannel {
  const value = channel as { type?: unknown; isThread?: () => boolean; send?: unknown } | null;
  if (typeof value?.send !== "function") return false;
  if (typeof value.isThread === "function" && value.isThread()) return false;
  return value.type === ChannelType.GuildText || value.type === ChannelType.GuildAnnouncement;
}

function isMessageHistoryChannel(channel: SendableChannel): channel is MessageHistoryChannel {
  return typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch === "function";
}

function isMessageLookupChannel(channel: SendableChannel): channel is MessageLookupChannel {
  return typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch === "function";
}

async function fetchSteamFreeChannelMessages(channel: SendableChannel, botUserId: string | null): Promise<SteamFreeChannelMessage[] | null> {
  if (!botUserId || !isMessageHistoryChannel(channel)) return null;
  try {
    const messages = await channel.messages.fetch({ limit: STEAM_FREE_CHANNEL_SCAN_LIMIT });
    return [...messages.values()]
      .filter((message) => botUserId && (message as { author?: { id?: unknown } } | null)?.author?.id === botUserId)
      .filter(isSteamComponentsMessage)
      .map(steamFreeMessageSnapshot);
  } catch {
    return null;
  }
}

function steamFreeMessageSnapshot(message: unknown): SteamFreeChannelMessage {
  const id = typeof (message as { id?: unknown } | null)?.id === "string"
    ? (message as { id: string }).id
    : null;
  const content = typeof (message as { content?: unknown } | null)?.content === "string"
    ? (message as { content: string }).content
    : "";
  const components = (message as { components?: unknown } | null)?.components;
  return { id, text: [content, jsonText(components)].filter(Boolean).join("\n") };
}

function isSteamComponentsMessage(message: unknown): boolean {
  const components = (message as { components?: unknown } | null)?.components;
  return Array.isArray(components) && components.length > 0;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function steamFreeItemsMissingFromChannel(items: SteamFreeItem[], channelText: string): SteamFreeItem[] {
  return items.filter((item) => !steamFreeItemMentionedInText(item, channelText));
}

function steamFreeItemMentionedInText(item: SteamFreeItem, channelText: string): boolean {
  const text = channelText.toLowerCase();
  return text.includes(item.url.toLowerCase()) || text.includes(`/app/${item.appId}`);
}

function steamFreeItemMessageIdInSnapshot(item: SteamFreeItem, messages: SteamFreeChannelMessage[]): string | null {
  return messages.find((message) => message.id && steamFreeItemMentionedInText(item, message.text))?.id ?? null;
}

function steamFreeMessageId(message: unknown): string | null {
  return typeof (message as { id?: unknown } | null)?.id === "string" ? (message as { id: string }).id : null;
}

async function fetchSteam(url: string, init: RequestInit): Promise<Response> {
  const request = () => fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  let response = await request();
  const retryable = response.status === 429 || response.status >= 500;
  if (!retryable) return response;
  const delayMs = response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : 2_000;
  await response.body?.cancel().catch(() => undefined);
  await sleep(Math.min(STEAM_RETRY_MAX_DELAY_MS, delayMs));
  response = await request();
  return response;
}

function retryAfterMs(value: string | null): number {
  if (!value) return 2_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 2_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSteamFreeItem(item: SteamFreeItem): SteamFreeItem | null {
  if (!/^\d+$/.test(item.appId)) return null;
  const appId = item.appId;
  const capsuleUrl = safeSteamImageUrl(item.capsuleUrl);
  return {
    ...item,
    url: `https://store.steampowered.com/app/${appId}/`,
    capsuleUrl
  };
}

function safeSteamImageUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host.endsWith(".steamstatic.com") || host === "steamcdn-a.akamaihd.net")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function markExpiredSteamFreeNotifications(channel: SendableChannel, store: SteamFreeRuntimeStore, notifyRoleIds: string[]): Promise<void> {
  for (const item of store.steamFreeSeenItemsToExpire()) {
    try {
      if (await editSteamFreeNotification(channel, item, notifyRoleIds)) store.markSteamFreeExpired(item.appId);
    } catch (error) {
      console.error(error);
    }
  }
}

async function editSteamFreeNotification(channel: SendableChannel, item: SteamFreeSeenItem, notifyRoleIds: string[]): Promise<boolean> {
  if (!isMessageLookupChannel(channel)) return false;
  const message = await channel.messages.fetch(item.messageId).catch(() => null);
  const edit = (message as { edit?: unknown } | null)?.edit;
  if (typeof edit !== "function") return false;
  await edit.call(message, {
    components: steamFreeNotificationComponents(item, notifyRoleIds),
    allowedMentions: { parse: [] }
  });
  return true;
}

async function sendSteamFreeNotification(channel: SendableChannel, item: SteamFreeItem, notifyRoleIds: string[]): Promise<unknown> {
  return channel.send({
    components: steamFreeNotificationComponents(item, notifyRoleIds),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: notifyRoleIds, parse: [] }
  });
}

export async function sendSteamFreeTestMessage(client: Client, store: SteamFreeRuntimeStore): Promise<boolean> {
  if (store.isSteamAccessBlocked()) {
    setSteamFreeStatus("degraded", STEAM_ACCESS_BLOCKED_ERROR_CODE);
    return false;
  }
  const settings = store.steamFreeSettings();
  if (!settings.channelId) return false;
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!isSteamFreeNotificationChannel(channel)) return false;
  await sendSteamFreeNotification(channel, steamFreeTestItem(), []);
  return true;
}

function steamFreeTestItem(): SteamFreeItem {
  return {
    appId: "steam-free-test",
    title: "Steam 免費遊戲測試訊息",
    url: "https://store.steampowered.com/search/?maxprice=free&specials=1",
    originalPrice: "NT$ 100.00",
    finalPrice: "NT$ 0.00",
    discountText: "-100%",
    claimUntilAt: null,
    reviewSummary: "測試評價",
    reviewPercent: 100,
    capsuleUrl: null
  };
}

function steamFreeNotificationComponents(item: SteamFreeItem, notifyRoleIds: string[]): APIMessageTopLevelComponent[] {
  const notifyMentions = notifyRoleIds.map((id) => `<@&${id}>`).join(" ");
  const infoLines = [
    "### 領取資訊",
    steamFreeClaimUntilLine(item),
    steamFreePriceLine(item),
    steamFreeReviewLine(item)
  ].filter((line): line is string => Boolean(line));
  const children: ComponentJson[] = [
    textDisplay([
      "# Steam 免費遊戲領取",
      notifyMentions,
      `## ${steamFreeNotificationTitle(item)}`
    ].filter(Boolean).join("\n")),
    separator(),
    textDisplay(infoLines.join("\n"))
  ];
  if (item.capsuleUrl) children.push(mediaGallery(item.capsuleUrl, item.title));
  children.push(
    separator(),
    actionRow([linkButton(item.url, "前往領取")]),
    textDisplay("-# 資料來源：Steam Store")
  );
  return [componentContainer(children, steamFreeItemExpired(item) ? "off" : "ready")];
}


function steamFreePriceLine(item: SteamFreeItem): string {
  return "💰 " + inlineCodeText(steamFreePriceText(item)) + "（" + (item.discountText ?? "-100%") + "）";
}
function steamFreeClaimUntilLine(item: SteamFreeItem): string {
  return "⏰ 截止 · " + discordTimestampText(item.claimUntilAt, inlineCodeText("Steam 未提供"));
}
function steamFreeReviewLine(item: SteamFreeItem): string | null {
  if (!item.reviewSummary) return null;
  const percent = item.reviewPercent == null ? "" : "（" + item.reviewPercent + "%）";
  return "👍 " + inlineCodeText(safeMentions(item.reviewSummary) + percent);
}


