import {
  parseIds,
  settingBoolean,
  type EnvLike
} from "./config.js";
import { safeMentions } from "./text.js";
import type { StatusKind } from "./discord-ui.js";

export type SteamFreeSettings = {
  enabled: boolean;
  channelId: string | null;
  lastCheckedAt: string | null;
  notifyRoleIds: string[];
};

export type SteamFreeItem = {
  appId: string;
  title: string;
  url: string;
  originalPrice: string | null;
  finalPrice: string | null;
  discountText: string | null;
  claimUntilAt: string | null;
  reviewSummary: string | null;
  reviewPercent: number | null;
  capsuleUrl: string | null;
};

export function resolveSteamFreeSettings(settings: EnvLike): SteamFreeSettings {
  return {
    enabled: settingBoolean(settings.enabled, false),
    channelId: settings.channel_id?.trim() || null,
    lastCheckedAt: settings.last_checked_at?.trim() || null,
    notifyRoleIds: [...parseIds(settings.notify_role_ids)]
  };
}

export function steamFreeStatusLabel(settings: SteamFreeSettings): StatusKind {
  if (!settings.enabled) return "off";
  return settings.channelId ? "ready" : "warn";
}

export function parseSteamFreeSearchResponse(body: unknown): SteamFreeItem[] {
  const html = (body as { results_html?: unknown } | null)?.results_html;
  if (typeof html !== "string") return [];

  const seen = new Set<string>();
  const items: SteamFreeItem[] = [];
  for (const match of html.matchAll(/<a\b[\s\S]*?<\/a>/gi)) {
    const row = match[0];
    const appId = htmlAttribute(row, "data-ds-appid");
    const href = htmlAttribute(row, "href");
    const discount = htmlAttribute(row, "data-discount");
    if (!appId || !href || discount !== "100" || seen.has(appId) || !/\/app\/\d+\//.test(href)) continue;

    const title = textFromHtml(row.match(/<span\b[^>]*class="title"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || `Steam App ${appId}`;
    const originalPrice = textFromHtml(row.match(/<div\b[^>]*class="discount_original_price"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "") || null;
    const finalPrice = textFromHtml(row.match(/<div\b[^>]*class="discount_final_price"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "") || null;
    const discountPercent = Number.parseInt(discount, 10);
    const discountText = Number.isFinite(discountPercent) ? `-${discountPercent}%` : null;
    const claimUntilAt = steamFreeClaimUntilAt(row);
    const reviewTag = row.match(/<span\b[^>]*class="search_review_summary[^"]*"[^>]*>/i)?.[0] ?? "";
    const reviewTooltip = htmlAttribute(reviewTag, "data-tooltip-html");
    const reviewSummary = textFromHtml((reviewTooltip ?? "").split(/<br\s*\/?>/i)[0] ?? "") || null;
    const reviewPercent = Number.parseInt(reviewTooltip?.match(/(\d+)%/)?.[1] ?? "", 10);
    const capsuleTag = row.match(/<img\b[^>]*>/i)?.[0] ?? "";
    items.push({
      appId,
      title,
      url: steamStoreUrl(href),
      originalPrice,
      finalPrice,
      discountText,
      claimUntilAt,
      reviewSummary,
      reviewPercent: Number.isFinite(reviewPercent) ? reviewPercent : null,
      capsuleUrl: htmlAttribute(capsuleTag, "src")
    });
    seen.add(appId);
  }
  return items;
}

function htmlAttribute(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : null;
}

function steamFreeClaimUntilAt(row: string): string | null {
  const raw = htmlAttribute(row, "data-discount-expiration")
    ?? htmlAttribute(row, "data-discount_expiration")
    ?? row.match(/discount_expiration["']?\s*[:=]\s*["']?(\d{10,13})/i)?.[1]
    ?? null;
  return steamFreeTimestampToIso(raw);
}

function steamFreeTimestampToIso(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 9_999_999_999 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseSteamFreeAppClaimUntilAt(html: string, nowDate = new Date()): string | null {
  const blocks = [...html.matchAll(/<p\b[^>]*class=["'][^"']*game_purchase_discount_quantity[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)];
  for (const block of blocks) {
    const text = textFromHtml(block[1] ?? "");
    const parsed = steamFreeClaimUntilTextToIso(text, nowDate);
    if (parsed) return parsed;
  }
  return null;
}

function steamFreeClaimUntilTextToIso(text: string, nowDate: Date): string | null {
  if (!/免費取得即可永久保留/.test(text)) return null;
  const match = text.replace(/\s+/g, " ").match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(上午|下午|凌晨|中午)?\s*(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const period = match[4] ?? "";
  let hour = Number.parseInt(match[5], 10);
  const minute = Number.parseInt(match[6] ?? "0", 10);
  if (period === "下午" && hour < 12) hour += 12;
  if ((period === "上午" || period === "凌晨") && hour === 12) hour = 0;
  if (period === "中午" && hour < 12) hour += 12;
  const explicitYear = match[1] ? Number.parseInt(match[1], 10) : null;
  const year = explicitYear ?? inferSteamFreeTaipeiYear(month, day, hour, minute, nowDate);
  return steamFreeTaipeiDateToIso(year, month, day, hour, minute);
}

function inferSteamFreeTaipeiYear(month: number, day: number, hour: number, minute: number, nowDate: Date): number {
  const year = Number.parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric" }).format(nowDate), 10);
  const parsed = Date.parse(steamFreeTaipeiDateString(year, month, day, hour, minute));
  return Number.isFinite(parsed) && parsed < nowDate.getTime() - 24 * 60 * 60 * 1000 ? year + 1 : year;
}

function steamFreeTaipeiDateToIso(year: number, month: number, day: number, hour: number, minute: number): string | null {
  const parsed = Date.parse(steamFreeTaipeiDateString(year, month, day, hour, minute));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function steamFreeTaipeiDateString(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

function textFromHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function steamStoreUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded);
    if (url.hostname === "store.steampowered.com") url.search = "";
    return url.toString();
  } catch {
    return decoded;
  }
}

export function steamFreeItemExpired(item: { claimUntilAt: string | null }, checkedAt = Date.now()): boolean {
  const timestamp = Date.parse(item.claimUntilAt ?? "");
  return Number.isFinite(timestamp) && timestamp <= checkedAt;
}

export function steamFreeNotificationTitle(item: { title: string; claimUntilAt: string | null }, checkedAt = Date.now()): string {
  const title = safeMentions(item.title);
  return steamFreeItemExpired(item, checkedAt) ? `${title} (已過期)` : title;
}

export function steamFreePriceText(item: Pick<SteamFreeItem, "originalPrice" | "finalPrice">): string {
  const finalPrice = steamFreeTrimPriceDecimals(item.finalPrice ?? "NT$ 0.00");
  return item.originalPrice
    ? `${steamFreeTrimPriceDecimals(item.originalPrice)} -> ${finalPrice}`
    : finalPrice;
}

function steamFreeTrimPriceDecimals(value: string): string {
  return value.replace(/(\d+)\.\d+\b/g, "$1");
}
