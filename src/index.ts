import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Guild
} from "discord.js";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activeAiRequestCount,
  handleAiMessage,
  stopAiRuntime
} from "./ai-message-runtime.js";
import { isValidDiscordId, loadConfig, resolveAiEnabledSetting, roleScopeValidation, type Config, type DiscordIdErrorCode, type RoleAuthorizationState } from "./config.js";
import { handleInteraction } from "./control-panel-interactions.js";
import { startSteamFreeWorker, steamFreeRuntimeStatus } from "./steam-free-runtime.js";
import { atomicWriteJson, moduleStatusRegistry } from "./module-status.js";
import { Store } from "./store.js";
import { DISCORD_ERROR_TEXT } from "./text.js";
import {
  handleVoiceStateUpdate,
  startVoiceRuntime,
  stopVoiceRuntime,
  voiceRuntimeStatus,
  type VoiceRuntimeController
} from "./voice.js";

type HealthAlert = {
  code: string;
  guildId?: string;
  detail?: string;
};

const HEALTH_FILE = "/tmp/horo-bot-health.json";
const HEALTH_WRITE_INTERVAL_MS = 30_000;
const NINE_ROUTER_PROBE_INTERVAL_MS = 60_000;
const NINE_ROUTER_PROBE_TIMEOUT_MS = 10_000;
const NINE_ROUTER_PROBE_ERROR_CODE = "9ROUTER-PROBE-001";
const DISCORD_COMMAND_ERROR_CODE = "DISCORD-COMMAND-001";
const DISCORD_CONNECTION_ERROR_CODE = "DISCORD-CONNECTION-001";
const discordAlertsByConfig = new WeakMap<Config, HealthAlert[]>();

function commands() {
  return [
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("Bot 管理入口"),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("開啟個人設定面板"),
    new SlashCommandBuilder()
      .setName("ai-settings")
      .setDescription("開啟 9router 設定面板")
  ].map((command) => command.toJSON());
}

export async function registerCommands(config: Config, restOverride?: Pick<REST, "put">): Promise<HealthAlert[]> {
  const rest = restOverride ?? new REST({ version: "10" }).setToken(config.token);
  const alerts: HealthAlert[] = [];
  for (const guildId of config.guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: commands() });
      console.log(`Registered commands for guild ${guildId}`);
    } catch {
      console.error(`Failed to register commands for guild ${guildId}`);
      alerts.push({ code: DISCORD_COMMAND_ERROR_CODE, guildId });
    }
  }
  discordAlertsByConfig.set(config, alerts);
  return alerts;
}

type DiscordValidationErrorCode = DiscordIdErrorCode;
type DiscordValidationResult = { valid: boolean; errorCode: DiscordValidationErrorCode };
type StoredDiscordValidationState = {
  ai: DiscordValidationResult;
  settings: DiscordValidationResult;
  voice: DiscordValidationResult;
  steam: DiscordValidationResult;
};

function pendingDiscordValidation(): DiscordValidationResult {
  return { valid: false, errorCode: "DISCORD-ID-001" };
}

let storedDiscordValidation: StoredDiscordValidationState = {
  ai: pendingDiscordValidation(),
  settings: pendingDiscordValidation(),
  voice: pendingDiscordValidation(),
  steam: pendingDiscordValidation()
};

type NineRouterProbeStatus = {
  state: "ready" | "disabled" | "degraded";
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  errorCode: string | null;
};

let nineRouterProbeStatus: NineRouterProbeStatus = {
  state: "degraded",
  lastSuccessAt: null,
  lastErrorAt: null,
  errorCode: NINE_ROUTER_PROBE_ERROR_CODE
};

async function validationGuilds(client: Client, config: Config): Promise<Guild[]> {
  const guilds: Guild[] = [];
  for (const guildId of config.guildIds) {
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (guild) guilds.push(guild);
  }
  return guilds;
}

async function roleExists(guilds: Guild[], id: string): Promise<boolean> {
  for (const guild of guilds) {
    if (guild.roles.cache.has(id)) return true;
    if (await guild.roles.fetch(id).then(Boolean).catch(() => false)) return true;
  }
  return false;
}

async function channelExists(guilds: Guild[], id: string, types: readonly ChannelType[]): Promise<boolean> {
  for (const guild of guilds) {
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    if (!channel || (typeof channel.isThread === "function" && channel.isThread())) continue;
    if (types.includes(channel.type)) return true;
  }
  return false;
}

function mergeDiscordErrorCode(left: DiscordValidationErrorCode, right: DiscordValidationErrorCode): DiscordValidationErrorCode {
  if (left === "DISCORD-ID-001" || right === "DISCORD-ID-001") return "DISCORD-ID-001";
  return left ?? right;
}

function combineDiscordValidation(...results: DiscordValidationResult[]): DiscordValidationResult {
  const errorCode = results.reduce<DiscordValidationErrorCode>(
    (current, result) => mergeDiscordErrorCode(current, result.errorCode),
    null
  );
  return { valid: errorCode === null, errorCode };
}

export async function validateStoredDiscordIds(client: Client, config: Config, store: Store): Promise<void> {
  const ids = store.storedDiscordIds();
  const guilds = await validationGuilds(client, config);
  const validateRoles = async (values: string[]): Promise<DiscordValidationResult> => {
    let errorCode: DiscordValidationErrorCode = null;
    for (const id of new Set(values)) {
      const validFormat = isValidDiscordId(id);
      const ok = validFormat && await roleExists(guilds, id);
      if (ok) {
        store.clearInvalidDiscordIdAudit("role", id);
        continue;
      }
      const currentErrorCode: DiscordValidationErrorCode = validFormat ? "DISCORD-ID-002" : "DISCORD-ID-001";
      store.auditInvalidDiscordId("role", id, currentErrorCode);
      errorCode = mergeDiscordErrorCode(errorCode, currentErrorCode);
    }
    return { valid: errorCode === null, errorCode };
  };
  const validateChannels = async (values: string[], types: readonly ChannelType[]): Promise<DiscordValidationResult> => {
    let errorCode: DiscordValidationErrorCode = null;
    for (const id of new Set(values)) {
      const validFormat = isValidDiscordId(id);
      const ok = validFormat && await channelExists(guilds, id, types);
      if (ok) {
        store.clearInvalidDiscordIdAudit("channel", id);
        continue;
      }
      const currentErrorCode: DiscordValidationErrorCode = validFormat ? "DISCORD-ID-002" : "DISCORD-ID-001";
      store.auditInvalidDiscordId("channel", id, currentErrorCode);
      errorCode = mergeDiscordErrorCode(errorCode, currentErrorCode);
    }
    return { valid: errorCode === null, errorCode };
  };
  const validateConfiguredRoles = async (values: Iterable<string>, malformedValues: Iterable<string>): Promise<DiscordValidationResult> => {
    let errorCode: DiscordValidationErrorCode = null;
    for (const id of new Set(malformedValues)) {
      store.auditInvalidDiscordId("role", id, "DISCORD-ID-001");
      errorCode = mergeDiscordErrorCode(errorCode, "DISCORD-ID-001");
    }
    for (const id of new Set(values)) {
      const validFormat = isValidDiscordId(id);
      const ok = validFormat && await roleExists(guilds, id);
      if (ok) {
        store.clearInvalidDiscordIdAudit("role", id);
        continue;
      }
      const currentErrorCode: DiscordValidationErrorCode = validFormat ? "DISCORD-ID-002" : "DISCORD-ID-001";
      store.auditInvalidDiscordId("role", id, currentErrorCode);
      errorCode = mergeDiscordErrorCode(errorCode, currentErrorCode);
    }
    return { valid: errorCode === null, errorCode };
  };
  const aiValidation = combineDiscordValidation(
    await validateRoles(ids.aiRoleIds),
    await validateChannels(ids.aiChannelIds, [ChannelType.GuildText, ChannelType.GuildAnnouncement])
  );
  const settingsValidation = await validateRoles(ids.settingsRoleIds);
  const voiceValidation = await validateChannels(ids.voiceChannelIds, [ChannelType.GuildVoice]);
  const steamValidation = combineDiscordValidation(
    await validateChannels(ids.steamChannelIds, [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    await validateRoles(ids.steamRoleIds)
  );
  const roleAuthorization: RoleAuthorizationState = {
    admin: await validateConfiguredRoles(config.adminRoleIds, config.invalidRoleIds?.admin ?? []),
    aiSettings: await validateConfiguredRoles(config.aiSettingsRoleIds, config.invalidRoleIds?.aiSettings ?? [])
  };
  config.roleAuthorization = roleAuthorization;
  store.setAiAccessBlocked(!aiValidation.valid);
  store.setSettingsAccessBlocked(!settingsValidation.valid);
  store.setVoiceAccessBlocked(!voiceValidation.valid);
  store.setSteamAccessBlocked(!steamValidation.valid);
  storedDiscordValidation = {
    ai: aiValidation,
    settings: settingsValidation,
    voice: voiceValidation,
    steam: steamValidation
  };
  updateModuleStatuses(config, store, process.env.STATUS_DIR?.trim() || resolve(dirname(config.databasePath), "status"));
}

function nineRouterModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`;
}

function setNineRouterModuleStatus(config: Pick<Config, "aiBaseUrl" | "aiApiKey">): void {
  if (!config.aiBaseUrl?.trim() || !config.aiApiKey?.trim()) {
    moduleStatusRegistry.set("9router", { state: "disabled", lastSuccessAt: null, lastErrorAt: null, errorCode: null });
    return;
  }
  moduleStatusRegistry.set("9router", {
    state: nineRouterProbeStatus.state,
    lastSuccessAt: nineRouterProbeStatus.lastSuccessAt,
    lastErrorAt: nineRouterProbeStatus.lastErrorAt,
    errorCode: nineRouterProbeStatus.errorCode
  });
}

export async function probeNineRouterLiveness(config: Pick<Config, "aiBaseUrl" | "aiApiKey">): Promise<void> {
  if (!config.aiBaseUrl?.trim() || !config.aiApiKey?.trim()) {
    nineRouterProbeStatus = { state: "disabled", lastSuccessAt: null, lastErrorAt: null, errorCode: null };
    setNineRouterModuleStatus(config);
    return;
  }
  try {
    const response = await fetch(nineRouterModelsUrl(config.aiBaseUrl), {
      headers: { accept: "application/json", authorization: `Bearer ${config.aiApiKey}` },
      signal: AbortSignal.timeout(NINE_ROUTER_PROBE_TIMEOUT_MS)
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("probe_failed");
    nineRouterProbeStatus = {
      ...nineRouterProbeStatus,
      state: "ready",
      lastSuccessAt: new Date().toISOString(),
      errorCode: null
    };
  } catch {
    nineRouterProbeStatus = {
      ...nineRouterProbeStatus,
      state: "degraded",
      lastErrorAt: new Date().toISOString(),
      errorCode: NINE_ROUTER_PROBE_ERROR_CODE
    };
  }
  setNineRouterModuleStatus(config);
}

const EXTERNAL_STATUS_FIELDS = ["errorCode", "lastErrorAt", "lastSuccessAt", "module", "state"] as const;
const EXTERNAL_STATUS_ERROR_CODES: Record<"backup" | "key-sync", string> = {
  backup: "BACKUP-001",
  "key-sync": "KEY-SYNC-001"
};

function assertExternalStatusPath(path: string): void {
  const absolute = resolve(path);
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  let current = absolute;
  while (true) {
    const stat = lstatSync(current);
    if (current === absolute) {
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("status_path_invalid");
      if ((stat.mode & 0o7777) !== 0o600) throw new Error("status_mode_invalid");
      if (processUid !== null && typeof stat.uid === "number" && stat.uid !== processUid) {
        throw new Error("status_owner_invalid");
      }
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("status_parent_invalid");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function externalStatusTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("status_timestamp_invalid");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("status_timestamp_invalid");
  return new Date(timestamp).toISOString();
}

export function readExternalStatus(statusDir: string, module: "backup" | "key-sync"): void {
  const path = resolve(statusDir, module + ".json");
  try {
    assertExternalStatusPath(path);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const fields = Object.keys(value).sort();
    if (fields.length !== EXTERNAL_STATUS_FIELDS.length || fields.some((field, index) => field !== EXTERNAL_STATUS_FIELDS[index])) {
      throw new Error("status_fields_invalid");
    }
    if (value.module !== module) throw new Error("status_module_mismatch");
    if (value.state !== "ready" && value.state !== "disabled" && value.state !== "degraded") {
      throw new Error("status_state_invalid");
    }
    const lastSuccessAt = externalStatusTimestamp(value.lastSuccessAt);
    const lastErrorAt = externalStatusTimestamp(value.lastErrorAt);
    const expectedErrorCode = EXTERNAL_STATUS_ERROR_CODES[module];
    if (value.state === "degraded" ? value.errorCode !== expectedErrorCode : value.errorCode !== null) {
      throw new Error("status_error_code_invalid");
    }
    moduleStatusRegistry.set(module, {
      state: value.state,
      lastSuccessAt,
      lastErrorAt,
      errorCode: value.state === "degraded" ? expectedErrorCode : null
    });
  } catch {
    const existing = moduleStatusRegistry.get(module);
    moduleStatusRegistry.set(module, {
      state: "degraded",
      lastSuccessAt: existing.lastSuccessAt,
      lastErrorAt: existing.lastErrorAt,
      errorCode: "STATUS-READ-001"
    });
  }
}

export function updateModuleStatuses(config: Config, store: Store, statusDir: string, discordReady = true, alerts?: readonly HealthAlert[]): void {
  const aiEnabled = resolveAiEnabledSetting(store.setting("ai_enabled"));
  const invalidStoredIds = store.invalidStoredDiscordIds();
  const adminRoleValidation = config.roleAuthorization?.admin ?? roleScopeValidation(config, "admin");
  const aiSettingsRoleValidation = config.roleAuthorization?.aiSettings ?? roleScopeValidation(config, "aiSettings");
  const aiManagerErrorCode = mergeDiscordErrorCode(adminRoleValidation.errorCode, aiSettingsRoleValidation.errorCode);
  const hasInvalidStoredIds = invalidStoredIds.roles.length > 0 || invalidStoredIds.channels.length > 0;
  const aiInvalid = invalidStoredIds.ai || !storedDiscordValidation.ai.valid || !adminRoleValidation.valid || !aiSettingsRoleValidation.valid;
  const settingsInvalid = invalidStoredIds.settings || !storedDiscordValidation.settings.valid;
  const voiceInvalid = invalidStoredIds.voice || !storedDiscordValidation.voice.valid;
  const steamInvalid = invalidStoredIds.steam || !storedDiscordValidation.steam.valid;
  const validationCodes = [storedDiscordValidation.ai, storedDiscordValidation.settings, storedDiscordValidation.voice, storedDiscordValidation.steam, adminRoleValidation, aiSettingsRoleValidation];
  const hasMalformedDiscordIds = Boolean(config.invalidDiscordIds?.length) || hasInvalidStoredIds || validationCodes.some((entry) => entry.errorCode === "DISCORD-ID-001");
  const hasMissingDiscordIds = validationCodes.some((entry) => entry.errorCode === "DISCORD-ID-002");
  const hasInvalidDiscordIds = hasMalformedDiscordIds || hasMissingDiscordIds || settingsInvalid || aiInvalid || voiceInvalid || steamInvalid;
  const discordErrorCode = hasMalformedDiscordIds ? "DISCORD-ID-001" : hasInvalidDiscordIds ? "DISCORD-ID-002" : null;
  const effectiveAlerts = alerts ?? discordAlertsByConfig.get(config) ?? [];
  const aiErrorCode = aiInvalid
    ? aiManagerErrorCode ?? storedDiscordValidation.ai.errorCode ?? (invalidStoredIds.ai ? "DISCORD-ID-001" : "DISCORD-ID-002")
    : !aiEnabled
      ? "AI-DISABLED-001"
      : config.aiBaseUrl && config.aiApiKey
        ? null
        : "AI-CONFIG-001";
  moduleStatusRegistry.set("ai", {
    state: aiInvalid ? "degraded" : !aiEnabled ? "disabled" : config.aiBaseUrl && config.aiApiKey ? "ready" : "degraded",
    errorCode: aiErrorCode
  });
  const voice = voiceRuntimeStatus();
  moduleStatusRegistry.set("voice", {
    state: voiceInvalid ? "degraded" : voice.state === "ready" ? "ready" : voice.state === "disabled" ? "disabled" : "degraded",
    errorCode: voiceInvalid ? storedDiscordValidation.voice.errorCode ?? (invalidStoredIds.voice ? "DISCORD-ID-001" : "DISCORD-ID-002") : voice.errorCode
  });
  const steam = steamFreeRuntimeStatus();
  moduleStatusRegistry.set("steam-free", {
    state: steamInvalid ? "degraded" : steam.state === "ready" ? "ready" : steam.state === "disabled" ? "disabled" : "degraded",
    lastSuccessAt: steam.lastSuccessAt,
    lastErrorAt: steam.lastErrorAt,
    errorCode: steamInvalid ? storedDiscordValidation.steam.errorCode ?? (invalidStoredIds.steam ? "DISCORD-ID-001" : "DISCORD-ID-002") : steam.errorCode
  });
  try {
    statSync(config.databasePath);
    moduleStatusRegistry.set("database", { state: "ready" });
  } catch {
    moduleStatusRegistry.set("database", { state: "degraded", errorCode: "DATABASE-001" });
  }
  setNineRouterModuleStatus(config);
  readExternalStatus(statusDir, "backup");
  readExternalStatus(statusDir, "key-sync");
  const commandRegistrationFailed = effectiveAlerts.some((alert) => alert.code === DISCORD_COMMAND_ERROR_CODE);
  const finalDiscordErrorCode = hasMalformedDiscordIds
    ? "DISCORD-ID-001"
    : hasInvalidDiscordIds
      ? "DISCORD-ID-002"
      : commandRegistrationFailed
        ? DISCORD_COMMAND_ERROR_CODE
        : !discordReady
          ? DISCORD_CONNECTION_ERROR_CODE
          : null;
  moduleStatusRegistry.set("discord", {
    state: finalDiscordErrorCode ? "degraded" : "ready",
    errorCode: finalDiscordErrorCode ?? discordErrorCode
  });
}

export function startHealthHeartbeat(client: Client, alerts: HealthAlert[], config: Config, store: Store): () => void {
  const statusDir = process.env.STATUS_DIR?.trim() || resolve(dirname(config.databasePath), "status");
  let stopped = false;
  let validationPromise: Promise<void> | null = null;
  let probePromise: Promise<void> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probeStopped = false;
  const writeHealth = (ready = client.isReady()) => {
    updateModuleStatuses(config, store, statusDir, ready, alerts);
    try {
      atomicWriteJson(HEALTH_FILE, {
        schemaVersion: 2,
        ready,
        timestamp: Date.now(),
        alerts,
        modules: moduleStatusRegistry.asObject()
      });
    } catch {
      console.error("Health write failed");
    }
  };
  writeHealth(false);
  const runProbe = (): Promise<void> => {
    if (probeStopped) return Promise.resolve();
    if (probePromise) return probePromise;
    probePromise = probeNineRouterLiveness(config).finally(() => {
      probePromise = null;
      if (!probeStopped) writeHealth(client.isReady());
    });
    return probePromise;
  };
  const scheduleProbe = (): void => {
    if (probeStopped) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      void runProbe().finally(scheduleProbe);
    }, NINE_ROUTER_PROBE_INTERVAL_MS);
    probeTimer.unref?.();
  };
  void runProbe().finally(scheduleProbe);
  const timer = setInterval(() => {
    if (!client.isReady()) {
      if (!stopped) writeHealth(false);
      return;
    }
    if (validationPromise) return;
    validationPromise = validateStoredDiscordIds(client, config, store)
      .catch(() => console.error("Discord validation failed"))
      .finally(() => {
        validationPromise = null;
        if (!stopped) writeHealth(client.isReady());
      });
  }, HEALTH_WRITE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    probeStopped = true;
    clearInterval(timer);
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    writeHealth(false);
  };
}

type ReadyRuntimeHooks = {
  validate(): Promise<void>;
  isStopping(): boolean;
  startSteam(): () => Promise<void>;
  startVoice(): Promise<VoiceRuntimeController>;
  setSteamStop(stop: () => Promise<void>): void;
  setVoiceController(controller: VoiceRuntimeController): void;
  setAcceptingEvents(accepting: boolean): void;
};

/** Validate resources before starting workers and close the late-start race on shutdown. */
export async function startReadyRuntimes(hooks: ReadyRuntimeHooks): Promise<void> {
  hooks.setAcceptingEvents(false);
  if (hooks.isStopping()) return;
  await hooks.validate();
  if (hooks.isStopping()) return;
  const steamStop = hooks.startSteam();
  hooks.setSteamStop(steamStop);
  if (hooks.isStopping()) {
    await steamStop();
    return;
  }
  const voiceController = await hooks.startVoice();
  if (hooks.isStopping()) {
    await voiceController.cleanup().catch((error) => console.error(error));
    return;
  }
  hooks.setVoiceController(voiceController);
  if (!hooks.isStopping()) hooks.setAcceptingEvents(true);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const healthAlerts = await registerCommands(config);
  if (config.invalidDiscordIds?.length) {
    for (const invalidId of config.invalidDiscordIds) {
      store.audit({ id: "system", name: "config" }, "config", "invalid_discord_id", "discord_id", invalidId, null, null, "degraded");
    }
    healthAlerts.push({ code: "invalid_discord_id", detail: config.invalidDiscordIds.join(",").slice(0, 500) });
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel]
  });
  let acceptingEvents = false;
  let shuttingDown = false;
  let stopHealth: () => void = () => undefined;
  let stopSteamWorker: (() => Promise<void>) | null = null;
  let voiceController: VoiceRuntimeController | null = null;
  let startupPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  stopHealth = startHealthHeartbeat(client, healthAlerts, config, store);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    startupPromise = startReadyRuntimes({
      validate: async () => {
        await validateStoredDiscordIds(readyClient, config, store);
      },
      isStopping: () => shuttingDown,
      startSteam: () => startSteamFreeWorker(readyClient, store),
      startVoice: () => startVoiceRuntime(readyClient, store),
      setSteamStop: (stop) => { stopSteamWorker = stop; },
      setVoiceController: (controller) => { voiceController = controller; },
      setAcceptingEvents: (accepting) => { acceptingEvents = accepting && !shuttingDown; }
    }).catch(console.error);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!acceptingEvents || !interaction.guildId || !config.guildIds.includes(interaction.guildId)) return;
    handleInteraction(interaction, store, config).catch((error) => {
      console.error(error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        void interaction.reply({ content: DISCORD_ERROR_TEXT.interactionFailed, flags: MessageFlags.Ephemeral });
      }
    });
  });
  client.on(Events.MessageCreate, (message) => {
    if (!acceptingEvents || !message.guildId || !config.guildIds.includes(message.guildId)) return;
    handleAiMessage(message, store, config).catch(console.error);
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!acceptingEvents || !config.guildIds.includes(newState.guild.id)) return;
    handleVoiceStateUpdate(oldState, newState, store).catch(console.error);
  });

  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      acceptingEvents = false;
      stopHealth();
      await startupPromise?.catch((error) => console.error(error));
      await stopSteamWorker?.();
      if (voiceController) {
        await voiceController.cleanup().catch((error) => console.error(error));
      }
      stopVoiceRuntime();
      await stopAiRuntime();
      const deadline = Date.now() + 35_000;
      while (activeAiRequestCount() > 0 && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      client.destroy();
      if (activeAiRequestCount() === 0) {
        store.close();
      } else {
        console.error("AI requests still active; leaving store open for graceful completion");
      }
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await client.login(config.token);
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
