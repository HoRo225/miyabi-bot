import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activeAiRequestCount,
  handleAiMessage,
  stopAiRuntime
} from "./ai-message-runtime.js";
import { loadConfig, type Config } from "./config.js";
import { handleInteraction } from "./control-panel-interactions.js";
import { startSteamFreeWorker } from "./steam-free-runtime.js";
import { Store } from "./store.js";
import { DISCORD_ERROR_TEXT } from "./text.js";
import {
  cleanupKnownTempVoiceChannels,
  handleVoiceStateUpdate
} from "./voice.js";

type HealthAlert = {
  code: "slash_command_registration_failed";
  guildId: string;
};

const HEALTH_FILE = "/tmp/horo-bot-health.json";
const HEALTH_WRITE_INTERVAL_MS = 30_000;

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

async function registerCommands(config: Config): Promise<HealthAlert[]> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const alerts: HealthAlert[] = [];
  for (const guildId of config.guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: commands() });
      console.log(`Registered commands for guild ${guildId}`);
    } catch (error) {
      console.error(`Failed to register commands for guild ${guildId}`, error);
      alerts.push({ code: "slash_command_registration_failed", guildId });
    }
  }
  return alerts;
}

function startHealthHeartbeat(client: Client, alerts: HealthAlert[]): () => void {
  const writeHealth = (ready = client.isReady()) => {
    try {
      writeFileSync(HEALTH_FILE, JSON.stringify({ ready, timestamp: Date.now(), alerts }));
    } catch (error) {
      console.error(error);
    }
  };
  writeHealth();
  const timer = setInterval(writeHealth, HEALTH_WRITE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    writeHealth(false);
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const healthAlerts = await registerCommands(config);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel]
  });
  let acceptingEvents = true;
  let stopHealth: () => void = () => undefined;

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    stopHealth = startHealthHeartbeat(readyClient, healthAlerts);
    startSteamFreeWorker(readyClient, store);
    cleanupKnownTempVoiceChannels(readyClient, store).catch(console.error);
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

  const shutdown = async () => {
    if (!acceptingEvents) return;
    acceptingEvents = false;
    stopHealth();
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
