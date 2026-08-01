import type { DatabaseSync } from "node:sqlite";
import {
  resolveSteamFreeSettings,
  steamFreeItemExpired,
  type SteamFreeItem,
  type SteamFreeSettings
} from "./steam-free.js";

export type SteamFreeSeenItem = SteamFreeItem & {
  messageId: string;
  expiredAt: string | null;
};

export function ensureSteamFreeSeenItemColumns(db: DatabaseSync): void {
  for (const [column, definition] of [
    ["final_price", "TEXT"],
    ["review_summary", "TEXT"],
    ["review_percent", "INTEGER"],
    ["claim_until_at", "TEXT"],
    ["message_id", "TEXT"],
    ["expired_at", "TEXT"]
  ] as const) {
    ensureColumn(db, "steam_free_seen_items", column, definition);
  }
}

export function steamFreeSetting(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM steam_free_runtime_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function steamFreeSettings(db: DatabaseSync): SteamFreeSettings {
  return resolveSteamFreeSettings({
    enabled: steamFreeSetting(db, "enabled"),
    channel_id: steamFreeSetting(db, "channel_id"),
    last_checked_at: steamFreeSetting(db, "last_checked_at"),
    notify_role_ids: steamFreeSetting(db, "notify_role_ids")
  });
}

export function seenSteamFreeItemIds(db: DatabaseSync): string[] {
  return db.prepare("SELECT app_id FROM steam_free_seen_items WHERE expired_at IS NULL ORDER BY app_id").all().map((row) => String((row as { app_id: unknown }).app_id));
}

export function markSteamFreeSeen(db: DatabaseSync, item: SteamFreeItem, messageId: string | null = null): boolean {
  const timestamp = now();
  const existing = db.prepare("SELECT 1 FROM steam_free_seen_items WHERE app_id = ?").get(item.appId);
  if (existing) {
    db.prepare(`
      UPDATE steam_free_seen_items
      SET name = ?,
          url = ?,
          original_price = ?,
          final_price = ?,
          review_summary = ?,
          review_percent = ?,
          capsule_url = ?,
          claim_until_at = ?,
          message_id = COALESCE(?, message_id),
          notified_at = CASE WHEN expired_at IS NOT NULL AND ? IS NOT NULL THEN ? ELSE notified_at END,
          expired_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE expired_at END
      WHERE app_id = ?
    `).run(
      item.title,
      item.url,
      item.originalPrice,
      item.finalPrice,
      item.reviewSummary,
      item.reviewPercent,
      item.capsuleUrl,
      item.claimUntilAt,
      messageId,
      messageId,
      timestamp,
      messageId,
      item.appId
    );
    return false;
  }
  return db.prepare(`
    INSERT INTO steam_free_seen_items
      (app_id, name, url, original_price, final_price, review_summary, review_percent, capsule_url, claim_until_at, message_id, first_seen_at, notified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.appId,
    item.title,
    item.url,
    item.originalPrice,
    item.finalPrice,
    item.reviewSummary,
    item.reviewPercent,
    item.capsuleUrl,
    item.claimUntilAt,
    messageId,
    timestamp,
    timestamp
  ).changes > 0;
}

export function steamFreeSeenItemsToExpire(db: DatabaseSync, checkedAt = Date.now()): SteamFreeSeenItem[] {
  return db.prepare(`
    SELECT app_id, name, url, original_price, final_price, review_summary, review_percent, capsule_url, claim_until_at, message_id, expired_at
    FROM steam_free_seen_items
    WHERE claim_until_at IS NOT NULL
      AND message_id IS NOT NULL
      AND expired_at IS NULL
  `).all()
    .map(steamFreeSeenItemFromRow)
    .filter((item) => steamFreeItemExpired(item, checkedAt));
}

export function markSteamFreeExpired(db: DatabaseSync, appId: string): void {
  db.prepare("UPDATE steam_free_seen_items SET expired_at = ? WHERE app_id = ?").run(now(), appId);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String((row as { name: unknown }).name)));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function steamFreeSeenItemFromRow(row: unknown): SteamFreeSeenItem {
  const value = row as Record<string, unknown>;
  const reviewPercent = value.review_percent == null ? null : Number(value.review_percent);
  return {
    appId: String(value.app_id),
    title: String(value.name),
    url: String(value.url),
    originalPrice: dbString(value.original_price),
    finalPrice: dbString(value.final_price),
    discountText: null,
    claimUntilAt: dbString(value.claim_until_at),
    reviewSummary: dbString(value.review_summary),
    reviewPercent: Number.isFinite(reviewPercent) ? reviewPercent : null,
    capsuleUrl: dbString(value.capsule_url),
    messageId: String(value.message_id),
    expiredAt: dbString(value.expired_at)
  };
}

function dbString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function now(): string {
  return new Date().toISOString();
}
