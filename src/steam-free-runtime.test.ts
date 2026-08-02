import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, type Client } from "discord.js";
import {
  checkSteamFreeGames,
  isSteamFreeNotificationChannel,
  sendSteamFreeTestMessage,
  startSteamFreeWorker,
  steamFreeRuntimeStatus,
  type SteamFreeRuntimeStore
} from "./steam-free-runtime.js";
import { parseSteamFreeSearchResponse, steamFreeIntervalMinutes } from "./steam-free.js";

function disabledStore(): SteamFreeRuntimeStore {
  return {
    isSteamAccessBlocked: () => false,
    steamFreeSettings: () => ({ enabled: false, channelId: null, lastCheckedAt: null, notifyRoleIds: [] }),
    steamFreeSetting: () => "15",
    seenSteamFreeItemIds: () => [],
    markSteamFreeSeen: () => false,
    steamFreeSeenItemsToExpire: () => [],
    markSteamFreeExpired: () => undefined,
    setSteamFreeSetting: () => undefined
  };
}

test("Steam interval is clamped to the documented range", () => {
  assert.equal(steamFreeIntervalMinutes(undefined), 30);
  assert.equal(steamFreeIntervalMinutes("1"), 15);
  assert.equal(steamFreeIntervalMinutes("180"), 180);
  assert.equal(steamFreeIntervalMinutes("999"), 180);
});

test("Steam notification channels fail closed for threads and unknown types", () => {
  const send = async () => undefined;
  assert.equal(isSteamFreeNotificationChannel({ type: ChannelType.GuildText, send }), true);
  assert.equal(isSteamFreeNotificationChannel({ type: ChannelType.GuildAnnouncement, send }), true);
  assert.equal(isSteamFreeNotificationChannel({ type: ChannelType.PublicThread, send }), false);
  assert.equal(isSteamFreeNotificationChannel({ send }), false);
});

test("Steam test message never allows role mentions", async () => {
  let payload: any;
  const channel = {
    type: ChannelType.GuildText,
    send: async (options: unknown) => {
      payload = options;
      return { id: "test-message" };
    }
  };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: ["role-id"] })
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;

  assert.equal(await sendSteamFreeTestMessage(client, store), true);
  assert.deepEqual(payload.allowedMentions, { roles: [], parse: [] });
  assert.equal(JSON.stringify(payload.components).includes("role-id"), false);
});

test("Steam test message is blocked by the access gate and resumes after clear", async () => {
  let blocked = true;
  let channelFetches = 0;
  let sends = 0;
  const channel = {
    type: ChannelType.GuildText,
    send: async () => {
      sends += 1;
      return { id: "test-message" };
    }
  };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    isSteamAccessBlocked: () => blocked,
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: [] })
  };
  const client = {
    channels: {
      fetch: async () => {
        channelFetches += 1;
        return channel;
      }
    }
  } as unknown as Client;

  assert.equal(await sendSteamFreeTestMessage(client, store), false);
  assert.equal(channelFetches, 0);
  assert.equal(sends, 0);
  assert.equal(steamFreeRuntimeStatus().errorCode, "DISCORD-ID-002");

  blocked = false;
  assert.equal(await sendSteamFreeTestMessage(client, store), true);
  assert.equal(channelFetches, 1);
  assert.equal(sends, 1);
});

test("Steam search parser rejects missing item keys and DLC rows", () => {
  const row = (itemKey: string) => '<a data-ds-appid="123" data-ds-itemkey="' + itemKey + '" data-discount="100" href="https://store.steampowered.com/app/123/"><span class="title">Game</span></a>';
  const missing = '<a data-ds-appid="123" data-discount="100" href="https://store.steampowered.com/app/123/"><span class="title">Game</span></a>';
  assert.deepEqual(parseSteamFreeSearchResponse({ results_html: missing }), []);
  assert.deepEqual(parseSteamFreeSearchResponse({ results_html: row("Sub_123") }), []);
  assert.equal(parseSteamFreeSearchResponse({ results_html: row("App_123") }).length, 1);
});

test("Steam manual check reports invalid notification channel as degraded", async () => {
  const channel = { type: ChannelType.PublicThread, send: async () => undefined };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    steamFreeSettings: () => ({ enabled: true, channelId: "thread", lastCheckedAt: null, notifyRoleIds: [] })
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;

  const result = await checkSteamFreeGames(client, store);
  assert.deepEqual(result, { found: 0, notified: 0, outcome: "error", errorCode: "STEAM-CHANNEL-001" });
  const status = steamFreeRuntimeStatus();
  assert.equal(status.module, "steam");
  assert.equal(status.state, "degraded");
  assert.equal(status.errorCode, "STEAM-CHANNEL-001");
});

test("Steam access gate blocks a valid manual check before channel or Steam fetch", async () => {
  let channelFetches = 0;
  let networkFetches = 0;
  let notifications = 0;
  const channel = {
    type: ChannelType.GuildText,
    send: async () => {
      notifications += 1;
      return { id: "message" };
    }
  };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    isSteamAccessBlocked: () => true,
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: [] })
  };
  const client = {
    channels: {
      fetch: async () => {
        channelFetches += 1;
        return channel;
      }
    }
  } as unknown as Client;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkFetches += 1;
    return new Response(JSON.stringify({ results_html: "" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await checkSteamFreeGames(client, store);
    assert.deepEqual(result, { found: 0, notified: 0, outcome: "error", errorCode: "DISCORD-ID-002" });
    assert.equal(channelFetches, 0);
    assert.equal(networkFetches, 0);
    assert.equal(notifications, 0);
    assert.equal(steamFreeRuntimeStatus().errorCode, "DISCORD-ID-002");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam manual check resumes after the access gate clears", async () => {
  let blocked = true;
  let channelFetches = 0;
  let networkFetches = 0;
  let notifications = 0;
  const channel = {
    type: ChannelType.GuildText,
    send: async () => {
      notifications += 1;
      return { id: "message" };
    }
  };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    isSteamAccessBlocked: () => blocked,
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: [] })
  };
  const client = {
    channels: {
      fetch: async () => {
        channelFetches += 1;
        return channel;
      }
    }
  } as unknown as Client;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkFetches += 1;
    return new Response(JSON.stringify({ results_html: "" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const blockedResult = await checkSteamFreeGames(client, store);
    assert.equal(blockedResult.errorCode, "DISCORD-ID-002");
    blocked = false;
    const clearResult = await checkSteamFreeGames(client, store);
    assert.deepEqual(clearResult, { found: 0, notified: 0, outcome: "no-change" });
    assert.equal(channelFetches, 1);
    assert.equal(networkFetches, 1);
    assert.equal(notifications, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blocked Steam worker tick neither fetches nor notifies", async () => {
  let channelFetches = 0;
  let networkFetches = 0;
  let notifications = 0;
  const channel = {
    type: ChannelType.GuildText,
    send: async () => {
      notifications += 1;
      return { id: "message" };
    }
  };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    isSteamAccessBlocked: () => true,
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: [] })
  };
  const client = {
    channels: {
      fetch: async () => {
        channelFetches += 1;
        return channel;
      }
    }
  } as unknown as Client;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkFetches += 1;
    return new Response(JSON.stringify({ results_html: "" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const stop = startSteamFreeWorker(client, store);
    await stop();
    assert.equal(channelFetches, 0);
    assert.equal(networkFetches, 0);
    assert.equal(notifications, 0);
    assert.equal(steamFreeRuntimeStatus().errorCode, "DISCORD-ID-002");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam check drops free-weekend rows without a permanent claim marker", async () => {
  const channel = { type: ChannelType.GuildText, send: async () => ({ id: "message" }) };
  const store: SteamFreeRuntimeStore = {
    ...disabledStore(),
    steamFreeSettings: () => ({ enabled: true, channelId: "channel", lastCheckedAt: null, notifyRoleIds: [] }),
    setSteamFreeSetting: () => undefined
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search/results")) {
      return new Response(JSON.stringify({ results_html: '<a data-ds-appid="123" data-ds-itemkey="App_123" data-discount="100" href="https://store.steampowered.com/app/123/"><span class="title">Free Weekend</span></a>' }), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response('<p class="game_purchase_discount_quantity">Weekend offer ends soon</p>', { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const result = await checkSteamFreeGames(client, store);
    assert.deepEqual(result, { found: 0, notified: 0, outcome: "no-change" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam worker returns a stop function and waits for its tick", async () => {
  const store = disabledStore();
  const client = {} as Client;
  const stop = startSteamFreeWorker(client, store);
  await stop();
  await stop();
});
