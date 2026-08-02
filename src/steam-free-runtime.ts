import {
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
  steamFreeItemExpired,
  steamFreeNotificationTitle,
  steamFreePriceText,
  type SteamFreeItem
} from "./steam-free.js";
import { Store, now, type SteamFreeSeenItem } from "./store.js";
import { discordTimestampText, inlineCodeText, safeMentions } from "./text.js";

const STEAM_FREE_SEARCH_URL = "https://store.steampowered.com/search/results/?query&start=0&count=50&dynamic_data=&sort_by=_ASC&maxprice=free&category1=998&specials=1&infinite=1&cc=tw&l=tchinese";
const STEAM_FREE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const STEAM_FREE_CHANNEL_SCAN_LIMIT = 100;
const STEAM_RETRY_MAX_DELAY_MS = 30_000;

// ponytail: one bot process needs one Steam check; split per guild only if this becomes multi-tenant.
let steamFreeCheckInFlight: Promise<{ found: number; notified: number }> | null = null;

type SteamFreeRuntimeStore = Pick<Store,
  | "markSteamFreeExpired"
  | "markSteamFreeSeen"
  | "seenSteamFreeItemIds"
  | "setSteamFreeSetting"
  | "steamFreeSeenItemsToExpire"
  | "steamFreeSettings"
>;

type SendableChannel = {
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
    if (item.claimUntilAt) {
      hydrated.push(item);
      continue;
    }
    try {
      const claimUntilAt = await fetchSteamFreeAppClaimUntilAt(item.appId);
      hydrated.push(claimUntilAt ? { ...item, claimUntilAt } : item);
    } catch (error) {
      console.error(error);
      hydrated.push(item);
    }
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

export function checkSteamFreeGames(client: Client, store: SteamFreeRuntimeStore): Promise<{ found: number; notified: number }> {
  if (steamFreeCheckInFlight) return steamFreeCheckInFlight;
  const task = checkSteamFreeGamesOnce(client, store).finally(() => {
    if (steamFreeCheckInFlight === task) steamFreeCheckInFlight = null;
  });
  steamFreeCheckInFlight = task;
  return task;
}

async function checkSteamFreeGamesOnce(client: Client, store: SteamFreeRuntimeStore): Promise<{ found: number; notified: number }> {
  const settings = store.steamFreeSettings();
  if (!settings.enabled || !settings.channelId) return { found: 0, notified: 0 };
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!isSteamFreeNotificationChannel(channel)) return { found: 0, notified: 0 };

  await markExpiredSteamFreeNotifications(channel, store, settings.notifyRoleIds);
  const items = await fetchSteamFreeItems();
  const activeItems = items.filter((item) => !steamFreeItemExpired(item));
  store.setSteamFreeSetting("last_checked_at", now());
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
  return { found: items.length, notified };
}

export function startSteamFreeWorker(client: Client, store: SteamFreeRuntimeStore): void {
  const tick = async () => {
    try {
      await checkSteamFreeGames(client, store);
    } catch (error) {
      console.error(error);
    }
  };
  const timer = setInterval(() => void tick(), STEAM_FREE_CHECK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

function isSteamFreeNotificationChannel(channel: unknown): channel is SendableChannel {
  return typeof (channel as { send?: unknown } | null)?.send === "function";
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
  const settings = store.steamFreeSettings();
  if (!settings.channelId) return false;
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!isSteamFreeNotificationChannel(channel)) return false;
  await sendSteamFreeNotification(channel, steamFreeTestItem(), settings.notifyRoleIds);
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


