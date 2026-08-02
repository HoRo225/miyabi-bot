import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import {
  aiError,
  callAiProvider,
  canaryAiModel,
  fetchAiModelOptions
} from "./ai-service.js";
import { roleScopeIsValid, type Config } from "./config.js";
import {
  adminModuleFromValue,
  adminPanelMessage,
  adminPanelUpdate,
  aiModelLoadingPanelUpdate,
  aiModelSelectPanelUpdate,
  aiLimitsModal,
  aiProviderStatusPanelUpdate,
  aiSettingsModuleFromValue,
  aiSettingsPanelMessage,
  aiSettingsPanelUpdate,
  aiTestLoadingPanelUpdate,
  aiTestResultPanelUpdate,
  settingsModuleFromValue,
  settingsPanelMessage,
  settingsPanelUpdate,
  steamFreeSettingsModal,
  voiceSettingsModal
} from "./control-panels.js";
import type { PanelMessage, PanelUpdate } from "./discord-ui.js";
import { memberRoleIds } from "./discord-message-runtime.js";
import { canUseSettings } from "./permissions.js";
import {
  checkSteamFreeGames,
  sendSteamFreeTestMessage,
  type SteamFreeCheckResult
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

type ProviderModelRefreshInteraction = {
  update(options: PanelUpdate): Promise<unknown>;
  editReply(options: PanelUpdate): Promise<unknown>;
};

function isManager(interaction: Interaction, allowedUserIds: Set<string> | undefined, allowedRoleIds: Set<string> | undefined, config: Config, scope: "admin" | "aiSettings"): boolean {
  if (Boolean(allowedUserIds?.has(interaction.user.id))) return true;
  if (!roleScopeIsValid(config, scope)) return false;
  return memberRoleIds(interaction.member).some((id) => Boolean(allowedRoleIds?.has(id)));
}

function canUseSettingsInteraction(interaction: Interaction, store: Store, config: Config): boolean {
  const isAdmin = isManager(interaction, config.adminUserIds, config.adminRoleIds, config, "admin");
  if (isAdmin) return true;
  if (store.isSettingsAccessBlocked()) return false;
  return canUseSettings({
    memberRoleIds: memberRoleIds(interaction.member),
    settingsRoleIds: new Set(store.listSettingsAllowedRoles())
  });
}

function canManageAiSettings(interaction: Interaction, config: Config): boolean {
  if (config.aiSettingsUserIds.has(interaction.user.id) || config.adminUserIds.has(interaction.user.id)) return true;
  const roles = memberRoleIds(interaction.member);
  return (roleScopeIsValid(config, "aiSettings") && roles.some((id) => config.aiSettingsRoleIds.has(id))) ||
    (roleScopeIsValid(config, "admin") && roles.some((id) => config.adminRoleIds.has(id)));
}

function isThreadSelection(interaction: Interaction, channelId: string): boolean {
  const channel = interaction.guild?.channels.cache.get(channelId);
  return Boolean(channel && typeof (channel as { isThread?: () => boolean }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread());
}

async function handleChatInput(interaction: ChatInputCommandInteraction, store: Store, config: Config): Promise<void> {
  if (interaction.commandName === "settings") {
    if (!canUseSettingsInteraction(interaction, store, config)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(settingsPanelMessage(interaction, store, config));
    return;
  }

  if (interaction.commandName === "admin") {
    if (!isManager(interaction, config.adminUserIds, config.adminRoleIds, config, "admin")) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/admin"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(adminPanelMessage(interaction, store, config));
    return;
  }

  if (interaction.commandName !== "ai-settings") return;
  if (!canManageAiSettings(interaction, config)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(aiSettingsPanelMessage(interaction, store, config));
}

async function respondPanel(interaction: ModalSubmitInteraction, message: PanelMessage, update: PanelUpdate): Promise<void> {
  if (interaction.isFromMessage()) {
    await interaction.update(update);
    return;
  }
  await interaction.reply(message);
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

async function handleAiLimitsModal(interaction: ModalSubmitInteraction, store: Store, config: Config): Promise<void> {
  const actor = { id: interaction.user.id, name: interaction.user.username };
  const fields: Array<[string, string, number, number, string]> = [
    ["ai-cooldown-seconds", "ai_cooldown_seconds", 1, 60, "冷卻秒數"],
    ["ai-max-in-flight", "ai_max_in_flight", 1, 10, "同時處理數"],
    ["ai-queue-max", "ai_queue_max", 1, 10, "佇列上限"],
    ["ai-queue-timeout-seconds", "ai_queue_timeout_seconds", 30, 300, "佇列逾時秒數"]
  ];
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [fieldId, key, minimum, maximum, label] of fields) {
    const parsed = parseIntegerInput(interaction.fields.getTextInputValue(fieldId), minimum, maximum);
    if (parsed === null || parsed === undefined) {
      problems.push(label + "需為 " + minimum + "-" + maximum + " 的整數");
    } else {
      values[key] = String(parsed);
    }
  }
  const extra = interaction.fields.getTextInputValue("ai-runtime-extra").split(",").map((value) => value.trim());
  if (extra.length !== 3) {
    problems.push("上下文/附件 MB/回應字數需填 3 個逗號分隔整數");
  } else {
    const extraFields: Array<[string, number, number, string]> = [
      ["ai_recent_context_limit", 1, 50, "近期上下文則數"],
      ["attachment_max_mb", 1, 25, "附件 MB"],
      ["ai_response_max_chars", 2_000, 12_000, "回應字數"]
    ];
    for (const [index, [key, minimum, maximum, label]] of extraFields.entries()) {
      const parsed = parseIntegerInput(extra[index] ?? "", minimum, maximum);
      if (parsed === null || parsed === undefined) {
        problems.push(label + "需為 " + minimum + "-" + maximum + " 的整數");
      } else {
        values[key] = String(parsed);
      }
    }
  }
  if (problems.length) {
    await interaction.reply({ content: "AI 限制未變更： " + problems.join("；"), flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    store.setRuntimeSettings(values, actor);
  } catch {
    await interaction.reply({ content: "AI 限制未變更：驗證失敗。", flags: MessageFlags.Ephemeral });
    return;
  }
  await respondPanel(
    interaction,
    aiSettingsPanelMessage(interaction, store, config, "limits"),
    aiSettingsPanelUpdate(interaction, store, config, "limits")
  );
}

function steamCheckNotice(result: SteamFreeCheckResult): string {
  if (result.outcome === "error") return "檢查失敗 · " + (result.errorCode ?? "STEAM-CHECK-001");
  if (result.outcome === "notified") return `找到 ${result.found} 個，已通知 ${result.notified} 個`;
  if (result.outcome === "found") return `找到 ${result.found} 個，沒有新通知`;
  return "沒有新遊戲變更";
}

async function handlePanelInteraction(interaction: Interaction, store: Store, config: Config): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu()) return false;
  const customId = interaction.customId;
  if (!customId.startsWith("ai:") && !customId.startsWith("admin:") && !customId.startsWith("settings:")) return false;

  if (customId.startsWith("admin:") && !isManager(interaction, config.adminUserIds, config.adminRoleIds, config, "admin")) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/admin"), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (customId.startsWith("ai:") && !canManageAiSettings(interaction, config)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (customId.startsWith("settings:") && !canUseSettingsInteraction(interaction, store, config)) {
    await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
    return true;
  }

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
    if (customId === "settings:steam-free:options") {
      await interaction.showModal(steamFreeSettingsModal(store));
      return true;
    }
    if (customId === "settings:steam-free:check") {
      await interaction.update(settingsPanelUpdate(interaction, store, config, "steam-free"));
      let result: SteamFreeCheckResult;
      try {
        result = await checkSteamFreeGames(interaction.client, store);
      } catch (error) {
        console.error(error);
        result = { found: 0, notified: 0, outcome: "error", errorCode: "STEAM-CHECK-001" };
      }
      await interaction.editReply(settingsPanelUpdate(interaction, store, config, "steam-free", steamCheckNotice(result)));
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
      await interaction.update(aiSettingsPanelUpdate(interaction, store, config));
      return true;
    }
    if (customId === "ai:limits:edit") {
      await interaction.showModal(aiLimitsModal(store));
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
  if (interaction.isStringSelectMenu() && customId === "ai:module") {
    if (typeof (store as unknown as { setting?: unknown }).setting !== "function") {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.aiPanelSimplified, flags: MessageFlags.Ephemeral });
      return true;
    }
    const module = aiSettingsModuleFromValue(interaction.values[0] ?? "") ?? "overview";
    await interaction.update(aiSettingsPanelUpdate(interaction, store, config, module));
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
  if (interaction.isChannelSelectMenu() && customId === "ai:access:channels") {
    if (interaction.values.some((id) => isThreadSelection(interaction, id))) {
      await interaction.reply({ content: "AI 不允許使用 Thread，請選擇一般文字頻道。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const current = store.listAllowedChannels();
    const changes = selectedIdChanges(current, interaction.values);
    const nextCount = current.length - changes.remove.length + changes.add.length;
    if (nextCount > 25) {
      await interaction.reply({ content: "AI 允許頻道最多只能保留 25 個。", flags: MessageFlags.Ephemeral });
      return true;
    }
    for (const id of changes.remove) store.removeChannel(id, actor);
    for (const id of changes.add) store.addChannel(id, actor);
    await interaction.update(aiSettingsPanelUpdate(interaction, store, config, "access"));
    return true;
  }
  if (interaction.isRoleSelectMenu() && customId === "ai:access:roles") {
    const current = store.listAllowedRoles();
    const changes = selectedIdChanges(current, interaction.values);
    const nextCount = current.length - changes.remove.length + changes.add.length;
    if (nextCount > 25) {
      await interaction.reply({ content: "AI 允許身分組最多只能保留 25 個。", flags: MessageFlags.Ephemeral });
      return true;
    }
    for (const id of changes.remove) store.removeRole(id, actor);
    for (const id of changes.add) store.addRole(id, actor);
    await interaction.update(aiSettingsPanelUpdate(interaction, store, config, "access"));
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
        try {
          await canaryAiModel(config, selected);
        } catch (error) {
          const normalized = aiError(error);
          const keyState = readNineRouterKeyState(config.databasePath);
          await interaction.editReply(aiProviderStatusPanelUpdate(
            `模型 canary 失敗（${normalized.userCode}），未變更設定。`,
            keyState,
            store.setting("ai_9router_key_id") ?? ""
          ));
          return true;
        }
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
    if (!canUseSettingsInteraction(interaction, store, config)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await handleVoiceSettingsModal(interaction, store, config);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === "settings:steam-free-modal") {
    if (!canUseSettingsInteraction(interaction, store, config)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    const interval = parseIntegerInput(interaction.fields.getTextInputValue("steam-free-interval"), 15, 180);
    if (interval === null || interval === undefined) {
      await interaction.reply({
        content: "Steam 檢查間隔未變更：請填 15-180 的整數。",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    store.setSteamFreeSetting("interval_minutes", String(interval), { id: interaction.user.id, name: interaction.user.username });
    await respondPanel(
      interaction,
      settingsPanelMessage(interaction, store, config, "steam-free"),
      settingsPanelUpdate(interaction, store, config, "steam-free")
    );
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === "ai:limits-modal") {
    if (!canManageAiSettings(interaction, config)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await handleAiLimitsModal(interaction, store, config);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ai:")) {
    if (!canManageAiSettings(interaction, config)) {
      await interaction.reply({ content: DISCORD_ERROR_TEXT.permission("/ai-settings"), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: DISCORD_ERROR_TEXT.aiPanelSimplified, flags: MessageFlags.Ephemeral });
    return;
  }
}
