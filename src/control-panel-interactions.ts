import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import {
  aiError,
  callAiProvider,
  fetchAiModelOptions
} from "./ai-service.js";
import type { Config } from "./config.js";
import {
  adminModuleFromValue,
  adminPanelMessage,
  adminPanelUpdate,
  aiModelLoadingPanelUpdate,
  aiModelSelectPanelUpdate,
  aiProviderStatusPanelUpdate,
  aiSettingsPanelMessage,
  aiSettingsPanelUpdate,
  aiTestLoadingPanelUpdate,
  aiTestResultPanelUpdate,
  settingsModuleFromValue,
  settingsPanelMessage,
  settingsPanelUpdate,
  voiceSettingsModal
} from "./control-panels.js";
import type { PanelMessage, PanelUpdate } from "./discord-ui.js";
import { memberRoleIds } from "./discord-message-runtime.js";
import { canUseSettings } from "./permissions.js";
import {
  checkSteamFreeGames,
  sendSteamFreeTestMessage
} from "./steam-free-runtime.js";
import type { Store } from "./store.js";
import { DISCORD_ERROR_TEXT, safeMentions } from "./text.js";
import { normalizeVoiceNameTemplate } from "./voice.js";
import { readNineRouterKeyState } from "./nine-router-keys.js";

export function selectedIdChanges(existingIds: string[], selectedIds: string[]): { add: string[]; remove: string[] } {
  const selected = new Set(selectedIds);
  const existing = new Set(existingIds);
  return {
    add: selectedIds.filter((id) => !existing.has(id)),
    remove: existingIds.filter((id) => !selected.has(id))
  };
}

type PanelInteraction = {
  user: { id: string };
  message?: { id: string } | null;
  fetchReply(): Promise<{ id: string }>;
  deleteReply(): Promise<void>;
};
type ProviderModelRefreshInteraction = {
  update(options: PanelUpdate): Promise<unknown>;
  editReply(options: PanelUpdate): Promise<unknown>;
};

const CONTROL_PANEL_IDLE_DELETE_MS = 120_000;
const panelDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isManager(interaction: Interaction, allowedUserIds: Set<string>, allowedRoleIds: Set<string>): boolean {
  return allowedUserIds.has(interaction.user.id) || memberRoleIds(interaction.member).some((id) => allowedRoleIds.has(id));
}

function canUseSettingsInteraction(interaction: Interaction, store: Store): boolean {
  return canUseSettings({
    memberRoleIds: memberRoleIds(interaction.member),
    settingsRoleIds: new Set(store.listSettingsAllowedRoles())
  });
}

export function controlPanelTimerKey(userId: string, messageId: string): string {
  return `${userId}:${messageId}`;
}

async function resetControlPanelDeleteTimer(interaction: PanelInteraction): Promise<void> {
  let messageId = interaction.message?.id;
  if (!messageId) {
    try {
      messageId = (await interaction.fetchReply()).id;
    } catch {
      return;
    }
  }
  const key = controlPanelTimerKey(interaction.user.id, messageId);
  const oldTimer = panelDeleteTimers.get(key);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    panelDeleteTimers.delete(key);
    void interaction.deleteReply().catch(() => undefined);
  }, CONTROL_PANEL_IDLE_DELETE_MS);
  timer.unref?.();
  panelDeleteTimers.set(key, timer);
}

async function handleChatInput(interaction: ChatInputCommandInteraction, store: Store, config: Config): Promise<void> {
  if (interaction.commandName === "settings") {
    if (!canUseSettingsInteraction(interaction, store)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(settingsPanelMessage(interaction, store, config));
    await resetControlPanelDeleteTimer(interaction);
    return;
  }

  if (interaction.commandName === "admin") {
    if (!isManager(interaction, config.adminUserIds, config.adminRoleIds)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/admin"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(adminPanelMessage(interaction, store, config));
    await resetControlPanelDeleteTimer(interaction);
    return;
  }

  if (interaction.commandName !== "ai-settings") return;
  if (!isManager(interaction, config.aiSettingsUserIds, config.aiSettingsRoleIds)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(aiSettingsPanelMessage(interaction, store, config));
  await resetControlPanelDeleteTimer(interaction);
}

async function respondPanel(interaction: ModalSubmitInteraction, message: PanelMessage, update: PanelUpdate): Promise<void> {
  if (interaction.isFromMessage()) {
    await interaction.update(update);
    await resetControlPanelDeleteTimer(interaction);
    return;
  }
  await interaction.reply(message);
  await resetControlPanelDeleteTimer(interaction);
}

async function refreshProviderModelOptions(interaction: ProviderModelRefreshInteraction, store: Store, config: Config, page = 0): Promise<void> {
  const baseUrl = config.aiBaseUrl;
  const apiKey = config.aiApiKey;
  const model = store.setting("ai_model") || config.aiModel;
  const keyState = readNineRouterKeyState(config.databasePath);
  const selectedKeyId = store.setting("ai_9router_key_id") ?? "";
  if (!baseUrl || !apiKey) {
    await interaction.update(aiProviderStatusPanelUpdate("請先在 server 環境設定 Endpoint URL 與 API key。", keyState, selectedKeyId));
    return;
  }
  await interaction.update(aiModelLoadingPanelUpdate(model));
  try {
    const options = await fetchAiModelOptions(config);
    if (!options.length) {
      await interaction.editReply(aiProviderStatusPanelUpdate("/models 沒有回傳可選模型。請檢查 server 環境設定後再試。", keyState, selectedKeyId));
      return;
    }
    await interaction.editReply(aiModelSelectPanelUpdate(model, options, page, keyState, selectedKeyId));
  } catch {
    await interaction.editReply(aiProviderStatusPanelUpdate("暫時無法讀取模型清單。請檢查 server 環境設定後再試。", keyState, selectedKeyId));
  }
}


function parseBooleanInput(value: string): boolean | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on", "開啟", "是"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "關閉", "否"].includes(normalized)) return false;
  return null;
}

function parseIntegerInput(value: string, min: number, max: number): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

async function handleVoiceSettingsModal(interaction: ModalSubmitInteraction, store: Store, config: Config): Promise<void> {
  const actor = { id: interaction.user.id, name: interaction.user.username };
  const voice = store.voiceSettings();
  const nameTemplate = normalizeVoiceNameTemplate(interaction.fields.getTextInputValue("voice-name-template"));
  const userLimit = parseIntegerInput(interaction.fields.getTextInputValue("voice-user-limit"), 0, 99);
  const ownerManage = parseBooleanInput(interaction.fields.getTextInputValue("voice-owner-manage"));
  if (userLimit === null || ownerManage === null) {
    const problems: string[] = [];
    if (userLimit === null) problems.push("人數上限請填 0-99 之間的整數");
    if (ownerManage === null) problems.push("房主管理請填「開啟」或「關閉」");
    await interaction.reply({
      content: DISCORD_ERROR_TEXT.invalidVoiceSettings(problems.join("；")),
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const nextUserLimit = userLimit ?? 0;
  if (nameTemplate !== voice.nameTemplate) store.setVoiceSetting("name_template", nameTemplate, actor);
  if (nextUserLimit !== voice.userLimit) store.setVoiceSetting("user_limit", String(nextUserLimit), actor);
  if (ownerManage !== undefined && ownerManage !== voice.ownerManage) store.setVoiceSetting("owner_manage", String(ownerManage), actor);
  await respondPanel(
    interaction,
    settingsPanelMessage(interaction, store, config, "voice"),
    settingsPanelUpdate(interaction, store, config, "voice")
  );
}

async function handlePanelInteraction(interaction: Interaction, store: Store, config: Config): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu()) return false;
  const customId = interaction.customId;
  if (!customId.startsWith("ai:") && !customId.startsWith("admin:") && !customId.startsWith("settings:")) return false;

  if (customId.startsWith("admin:") && !isManager(interaction, config.adminUserIds, config.adminRoleIds)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/admin"), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (customId.startsWith("ai:") && !isManager(interaction, config.aiSettingsUserIds, config.aiSettingsRoleIds)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (customId.startsWith("settings:") && !canUseSettingsInteraction(interaction, store)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
    return true;
  }

  await resetControlPanelDeleteTimer(interaction);

  const actor = { id: interaction.user.id, name: interaction.user.username };
  if (interaction.isButton()) {

    if (customId === "settings:voice:toggle") {
      store.setVoiceSetting("enabled", String(!store.voiceSettings().enabled), actor);
      await interaction.update(settingsPanelUpdate(interaction, store, config, "voice"));
      return true;
    }
    if (customId === "settings:voice:options") {
      await interaction.showModal(voiceSettingsModal(store));
      return true;
    }
    if (customId === "settings:steam-free:toggle") {
      store.setSteamFreeSetting("enabled", String(!store.steamFreeSettings().enabled), actor);
      await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
      return true;
    }
    if (customId === "settings:steam-free:check") {
      await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
      try {
        await checkSteamFreeGames(interaction.client, store);
      } catch (error) {
        console.error(error);
      }
      await interaction.editReply(settingsPanelUpdate(interaction, store, config, "steam-free"));
      return true;
    }
    if (customId === "settings:steam-free:test") {
      await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
      try {
        await sendSteamFreeTestMessage(interaction.client, store);
      } catch (error) {
        console.error(error);
      }
      await interaction.editReply(settingsPanelUpdate(interaction, store, config, "steam-free"));
      return true;
    }
    if (customId === "admin:refresh" || customId === "admin:refresh:status") {
      await interaction.update(adminPanelUpdate(interaction, store, config, "status"));
      return true;
    }

    if (customId === "admin:settings") {
      await interaction.update(adminPanelUpdate(interaction, store, config, "settings"));
      return true;
    }
    if (customId === "admin:ai") {
      if (!isManager(interaction, config.aiSettingsUserIds, config.aiSettingsRoleIds)) {
        await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.update(aiSettingsPanelUpdate(interaction, store, config));
      return true;
    }
    if (customId === "ai:test") {
      await interaction.update(aiTestLoadingPanelUpdate(store, config));
      try {
        const result = await callAiProvider(store, config, [
          { role: "system", content: "只回覆 OK。" },
          { role: "user", content: "ping" }
        ]);
        await interaction.editReply(aiTestResultPanelUpdate([
          "AI 測試成功。",
          `模型：${result.modelAlias}`,
          `延遲：${result.latencyMs} ms`,
          `回應：${safeMentions(result.content).slice(0, 200)}`
        ].join("\n"), true));
      } catch (error) {
        const normalized = aiError(error);
        await interaction.editReply(aiTestResultPanelUpdate(
          DISCORD_ERROR_TEXT.aiUnavailable(normalized.userCode),
          false
        ));
      }
      return true;
    }
    if (customId === "ai:provider" || customId === "ai:provider-refresh") {
      await refreshProviderModelOptions(interaction, store, config);
      return true;
    }
    if (customId.startsWith("ai:model:page:")) {
      const page = Number(customId.slice("ai:model:page:".length));
      await refreshProviderModelOptions(interaction, store, config, Number.isInteger(page) ? page : 0);
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && customId === "admin:module") {
    const module = adminModuleFromValue(interaction.values[0] ?? "") ?? "status";
    await interaction.update(adminPanelUpdate(interaction, store, config, module));
    return true;
  }
  if (interaction.isStringSelectMenu() && customId === "settings:module") {
    const module = settingsModuleFromValue(interaction.values[0] ?? "") ?? "overview";
    await interaction.update(settingsPanelUpdate(interaction, store, config, module));
    return true;
  }
  if (interaction.isRoleSelectMenu() && customId === "admin:settings-role:toggle") {
    const current = store.listSettingsAllowedRoles();
    if (current.length > 25) {
      await interaction.update(adminPanelUpdate(interaction, store, config, "settings"));
      return true;
    }
    const changes = selectedIdChanges(current, interaction.values);
    const nextCount = current.length - changes.remove.length + changes.add.length;
    if (nextCount > 25) {
      await interaction.reply({
        content: "設定角色最多只能保留 25 個，請先取消部分選取。",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    for (const id of changes.remove) store.removeSettingsRole(id, actor);
    for (const id of changes.add) store.addSettingsRole(id, actor);
    await interaction.update(adminPanelUpdate(interaction, store, config, "settings"));
    return true;
  }
  if (interaction.isChannelSelectMenu() && customId === "settings:voice:trigger") {
    store.setVoiceSetting("trigger_channel_id", interaction.values[0] ?? "", actor);
    await interaction.update(settingsPanelUpdate(interaction, store, config, "voice"));
    return true;
  }
  if (interaction.isChannelSelectMenu() && customId === "settings:steam-free:channel") {
    store.setSteamFreeSetting("channel_id", interaction.values[0] ?? "", actor);
    await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
    return true;
  }
  if (interaction.isRoleSelectMenu() && customId === "settings:steam-free:roles") {
    store.setSteamFreeSetting("notify_role_ids", interaction.values.join(","), actor);
    await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
    return true;
  }
  if (interaction.isStringSelectMenu() && customId === "ai:key:select") {
    const selected = interaction.values[0]?.trim() ?? "";
    const keyState = readNineRouterKeyState(config.databasePath);
    if (!keyState.keys.some((key) => key.id === selected) || keyState.overflow) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.invalidApiKeySelection, flags: MessageFlags.Ephemeral });
      return true;
    }
    store.setRuntimeSetting("ai_9router_key_id", selected, actor);
    await interaction.update(aiSettingsPanelUpdate(interaction, store, config));
    return true;
  }
  if (interaction.isStringSelectMenu() && customId === "ai:model:select") {
    const selected = interaction.values[0]?.trim();
    const currentModel = store.setting("ai_model") || config.aiModel;
    await interaction.update(aiModelLoadingPanelUpdate(currentModel));
    try {
      const options = await fetchAiModelOptions(config);
      if (selected && selected !== currentModel && options.some((option) => option.value === selected)) {
        store.setRuntimeSetting("ai_model", selected, actor);
      }
      const keyState = readNineRouterKeyState(config.databasePath);
      await interaction.editReply(aiModelSelectPanelUpdate(
        store.setting("ai_model") || config.aiModel,
        options,
        0,
        keyState,
        store.setting("ai_9router_key_id") ?? ""
      ));
    } catch {
      const keyState = readNineRouterKeyState(config.databasePath);
      await interaction.editReply(aiProviderStatusPanelUpdate(
        "暫時無法驗證模型清單，因此未變更設定。",
        keyState,
        store.setting("ai_9router_key_id") ?? ""
      ));
    }
    return true;
  }

  if (customId.startsWith("ai:")) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.aiPanelSimplified, flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}

export async function handleInteraction(interaction: Interaction, store: Store, config: Config): Promise<void> {
  if (!interaction.guildId || !config.guildIds.includes(interaction.guildId)) return;
  if (interaction.isChatInputCommand()) {
    await handleChatInput(interaction, store, config);
    return;
  }
  if (await handlePanelInteraction(interaction, store, config)) {
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === "settings:voice-modal") {
    if (!canUseSettingsInteraction(interaction, store)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await handleVoiceSettingsModal(interaction, store, config);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ai:")) {
    if (!isManager(interaction, config.aiSettingsUserIds, config.aiSettingsRoleIds)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: DISCORD_ERROR_TEXT.aiPanelSimplified, flags: MessageFlags.Ephemeral });
    return;
  }
}