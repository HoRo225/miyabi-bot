import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "discord.js";
import { checkSteamFreeGames } from "./steam-free-runtime.js";
import { Store } from "./store.js";
import type { SteamFreeItem } from "./steam-free.js";

test("expired Steam app can notify again in a later free campaign", () => {
  const directory = mkdtempSync(join(tmpdir(), "horo-steam-repeat-"));
  const store = new Store(join(directory, "bot.sqlite"));
  const item: SteamFreeItem = {
    appId: "123",
    title: "Repeat Game",
    url: "https://store.steampowered.com/app/123/",
    originalPrice: "NT$ 100",
    finalPrice: "NT$ 0",
    discountText: "-100%",
    claimUntilAt: "2026-01-01T00:00:00.000Z",
    reviewSummary: null,
    reviewPercent: null,
    capsuleUrl: null
  };

  try {
    assert.equal(store.markSteamFreeSeen(item, "old-message"), true);
    store.markSteamFreeExpired(item.appId);
    assert.deepEqual(store.seenSteamFreeItemIds(), []);

    store.markSteamFreeSeen({ ...item, claimUntilAt: "2027-01-01T00:00:00.000Z" }, "new-message");
    assert.deepEqual(store.seenSteamFreeItemIds(), ["123"]);
    const row = store.db.prepare("SELECT message_id, expired_at FROM steam_free_seen_items WHERE app_id = ?").get("123") as {
      message_id: string;
      expired_at: string | null;
    };
    assert.deepEqual({ ...row }, { message_id: "new-message", expired_at: null });
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduled and manual Steam checks share one in-flight promise", async () => {
  const store: Parameters<typeof checkSteamFreeGames>[1] = {
    isSteamAccessBlocked: () => false,
    steamFreeSettings: () => ({ enabled: false, channelId: null, lastCheckedAt: null, notifyRoleIds: [] }),
    seenSteamFreeItemIds: () => [],
    markSteamFreeSeen: () => false,
    steamFreeSeenItemsToExpire: () => [],
    markSteamFreeExpired: () => undefined,
    setSteamFreeSetting: () => undefined
  };
  const client = {} as Client;
  const first = checkSteamFreeGames(client, store);
  const second = checkSteamFreeGames(client, store);
  assert.equal(first, second);
  assert.deepEqual(await first, { found: 0, notified: 0, outcome: "no-change" });
});
