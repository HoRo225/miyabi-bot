import { statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ActionRowBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIMessageTopLevelComponent,
  type Interaction
} from "discord.js";
import type { AiModelOption } from "./ai-provider.js";
import {
  clampInteger,
  type Config
} from "./config.js";
import { memberRoleIds } from "./discord-message-runtime.js";
import {
  actionRow,
  button,
  componentContainer,
  statusBadge,
  worstStatus,
  notificationChannelSelect,
  panelMessage,
  panelUpdate,
  roleSelect,
  separator,
  stringSelect,
  textDisplay,
  voiceChannelSelect,
  type ComponentJson,
  type PanelMessage,
  type PanelUpdate,
  type RowComponent,
  type StatusKind
} from "./discord-ui.js";
import { steamFreeStatusLabel, type SteamFreeSettings } from "./steam-free.js";
import { discordTimestampText, inlineCodeText } from "./text.js";
import { nineRouterKeyOptions, readNineRouterKeyState, type NineRouterKeyState } from "./nine-router-keys.js";
import { voiceStatusLabel, type VoiceSettings } from "./voice.js";

type AdminStats = {
  messages: number;
  attachments: number;
  aiRequestLogs: number;
  auditLogs: number;
};

type ControlPanelStore = {
  setting(key: string): string | undefined;
  listSettingsAllowedRoles(): string[];
  voiceSettings(): VoiceSettings;
  steamFreeSettings(): SteamFreeSettings;
  adminStats(): AdminStats;
};
const packageJson = createRequire(import.meta.url)("../package.json") as { version?: string };
export type AdminModule = "status" | "settings";
export type SettingsModule = "overview" | "voice" | "steam-free";

const ADMIN_MODULE_LABELS: Record<AdminModule, string> = {
  status: "總覽",
  settings: "設定權限"
};

const SETTINGS_MODULE_LABELS: Record<SettingsModule, string> = {
  overview: "總覽",
  voice: "動態語音",
  "steam-free": "Steam 免費遊戲"
};

export const ADMIN_NAV_MODULES: Array<{ label: string; value: AdminModule; description: string }> = [
  { label: "總覽", value: "status", description: "服務狀態與資料量" },
  { label: "設定權限", value: "settings", description: "/settings 可用身分組" }
];
export const SETTINGS_NAV_MODULES: Array<{ label: string; value: SettingsModule; description: string }> = [
  { label: "總覽", value: "overview", description: "權限與模組狀態" },
  { label: "動態語音", value: "voice", description: "入口頻道與命名" },
  { label: "Steam 免費遊戲", value: "steam-free", description: "通知頻道與身分組" }
];

function settingsModuleLabel(module: SettingsModule): string {
  return SETTINGS_MODULE_LABELS[module] ?? module;
}

function settingsModuleSelect(module: SettingsModule): RowComponent {
  const options = SETTINGS_NAV_MODULES.map((item) => ({
    label: item.value === module ? "✓ " + item.label : item.label,
    value: item.value,
    description: item.description
  }));
  return stringSelect("settings:module", "目前：" + settingsModuleLabel(module), options) ?? actionRow([]);
}

export function settingsModuleFromValue(value: string): SettingsModule | null {
  return SETTINGS_NAV_MODULES.some((item) => item.value === value) ? value as SettingsModule : null;
}

function settingsPanelComponents(store: ControlPanelStore, _config: Config, module: SettingsModule = "overview"): APIMessageTopLevelComponent[] {
  const settingsRoles = store.listSettingsAllowedRoles();
  const voice = store.voiceSettings();
  const voiceStatus: StatusKind = voiceStatusLabel(voice);
  const steamFree = store.steamFreeSettings();
  const steamStatus: StatusKind = steamFreeStatusLabel(steamFree);
  const steamFreeReady = steamStatus === "ready";
  const children: ComponentJson[] = [
    textDisplay("## ⚙️ 設定"),
    settingsModuleSelect(module),
    separator()
  ];

  if (module === "overview") {
    children.push(
      textDisplay([
        "### 權限",
        "/settings · " + (settingsRoles.length ? mentionList(settingsRoles, (id) => "<@&" + id + ">") : "未設定"),
        "",
        "### 模組",
        statusBadge(voiceStatus) + " · 動態語音",
        statusBadge(steamStatus) + " · Steam 免費遊戲"
      ].join("\n"))
    );
  }

  if (module === "voice") {
    children.push(
      textDisplay([
        "### 動態語音",
        "狀態 · " + statusBadge(voiceStatus),
        "入口頻道 · " + (voice.triggerChannelId ? "<#" + voice.triggerChannelId + ">" : "未設定"),
        "命名 · " + voice.nameTemplate,
        "人數上限 · " + (voice.userLimit || "無"),
        "房主管理 · " + (voice.ownerManage ? "開啟" : "關閉")
      ].join("\n")),
      actionRow([
        button("settings:voice:toggle", voice.enabled ? "停用" : "啟用", voice.enabled ? ButtonStyle.Danger : ButtonStyle.Primary),
        button("settings:voice:options", "編輯選項", ButtonStyle.Primary)
      ]),
      actionRow([voiceChannelSelect("settings:voice:trigger", "選擇入口語音頻道", voice.triggerChannelId)])
    );
  }

  if (module === "steam-free") {
    children.push(
      textDisplay([
        "### Steam 免費遊戲",
        "狀態 · " + statusBadge(steamStatus),
        "通知頻道 · " + (steamFree.channelId ? "<#" + steamFree.channelId + ">" : "未設定"),
        "最近檢查 · " + discordTimestampText(steamFree.lastCheckedAt),
        "通知身分組 · " + (steamFree.notifyRoleIds.length ? mentionList(steamFree.notifyRoleIds, (id) => "<@&" + id + ">") : "未設定")
      ].join("\n")),
      actionRow([
        button("settings:steam-free:toggle", steamFree.enabled ? "停用" : "啟用", steamFree.enabled ? ButtonStyle.Danger : ButtonStyle.Primary),
        button("settings:steam-free:check", "立即檢查", ButtonStyle.Primary, !steamFreeReady),
        button("settings:steam-free:test", "測試訊息", ButtonStyle.Secondary, !steamFree.channelId)
      ]),
      actionRow([notificationChannelSelect("settings:steam-free:channel", "選擇通知頻道", steamFree.channelId)]),
      actionRow([roleSelect("settings:steam-free:roles", "選擇通知身分組", steamFree.notifyRoleIds)])
    );
  }

  return [componentContainer(children, worstStatus([voiceStatus, steamStatus]))];
}

export function settingsPanelMessage(_interaction: Interaction, store: ControlPanelStore, config: Config, module: SettingsModule = "overview"): PanelMessage {
  return panelMessage(settingsPanelComponents(store, config, module));
}

export function settingsPanelUpdate(_interaction: Interaction, store: ControlPanelStore, config: Config, module: SettingsModule = "overview"): PanelUpdate {
  return panelUpdate(settingsPanelComponents(store, config, module));
}

function adminModuleLabel(module: AdminModule): string {
  return ADMIN_MODULE_LABELS[module] ?? module;
}

function adminModuleSelect(module: AdminModule): RowComponent {
  const options = ADMIN_NAV_MODULES.map((item) => ({
    label: item.value === module ? "✓ " + item.label : item.label,
    value: item.value,
    description: item.description
  }));
  return stringSelect("admin:module", "目前：" + adminModuleLabel(module), options) ?? actionRow([]);
}

export function adminModuleFromValue(value: string): AdminModule | null {
  return ADMIN_NAV_MODULES.some((item) => item.value === value) ? value as AdminModule : null;
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return [
    days ? `${days} 天` : "",
    hours ? `${hours} 小時` : "",
    `${minutes} 分鐘`
  ].filter(Boolean).join(" ");
}

function enabledModuleLines(store: ControlPanelStore): string[] {
  const settingsRoles = store.listSettingsAllowedRoles();
  return [
    "/settings · " + (settingsRoles.length ? mentionList(settingsRoles, (id) => "<@&" + id + ">") : "未設定")
  ];
}
function canOpenAiSettings(interaction: Interaction, config: Config): boolean {
  return config.aiSettingsUserIds.has(interaction.user.id) || memberRoleIds(interaction.member).some((id) => config.aiSettingsRoleIds.has(id));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function databaseStatus(path: string): { kind: StatusKind; text: string } {
  try {
    return { kind: "ready", text: formatBytes(statSync(path).size) };
  } catch {
    return { kind: "error", text: "無法讀取檔案" };
  }
}
function adminPanelComponents(interaction: Interaction, store: ControlPanelStore, config: Config, module: AdminModule = "status"): APIMessageTopLevelComponent[] {
  let panelStatus: StatusKind = "ready";
  const children: ComponentJson[] = [
    textDisplay("## 🛠️ 系統管理"),
    adminModuleSelect(module),
    separator()
  ];

  if (module === "status") {
    let stats: AdminStats = { messages: 0, attachments: 0, aiRequestLogs: 0, auditLogs: 0 };
    let statsStatus: StatusKind = "ready";
    try {
      stats = store.adminStats();
    } catch {
      statsStatus = "error";
    }
    const database = databaseStatus(config.databasePath);
    const databaseKind: StatusKind = statsStatus === "error" ? "error" : database.kind;
    panelStatus = databaseKind;
    const version = typeof packageJson.version === "string" ? packageJson.version : "未知";
    const guildName = interaction.guild?.name ?? interaction.guildId ?? "未知";
    children.push(
      textDisplay([
        "### 服務",
        "版本 · " + version,
        "啟動時間 · " + formatUptime(process.uptime()),
        "延遲 · " + Math.round(interaction.client.ws.ping) + " ms",
        "伺服器 · " + guildName,
        "資料庫 · " + statusBadge(databaseKind) + " · " + database.text,
        "",
        "### 資料量",
        "訊息 " + stats.messages + " · 附件 " + stats.attachments,
        "AI 請求 " + stats.aiRequestLogs + " · Audit " + stats.auditLogs,
        "",
        "### 功能",
        ...enabledModuleLines(store)
      ].join("\n")),
      actionRow([
        button("admin:refresh:status", "重新整理"),
        button("admin:ai", "9router 設定", ButtonStyle.Secondary, !canOpenAiSettings(interaction, config))
      ]),
      textDisplay("-# 資料截至 " + discordTimestampText(new Date().toISOString(), "剛剛"))
    );
  }

  if (module === "settings") {
    const roleIds = store.listSettingsAllowedRoles();
    const overflow = roleIds.length > 25;
    children.push(
      textDisplay([
        "### /settings 權限",
        "目前 · " + (roleIds.length ? mentionList(roleIds, (id) => "<@&" + id + ">") : "未設定"),
        ...(overflow ? ["", "-# ⚠️ 已超過 25 筆上限，此頁暫時唯讀以避免資料遺失。"] : [])
      ].join("\n")),
      actionRow([roleSelect("admin:settings-role:toggle", "選擇可用 /settings 的身分組", roleIds, overflow)])
    );
  }

  return [componentContainer(children, panelStatus)];
}

export function adminPanelMessage(interaction: Interaction, store: ControlPanelStore, config: Config, module: AdminModule = "status"): PanelMessage {
  return panelMessage(adminPanelComponents(interaction, store, config, module));
}

export function adminPanelUpdate(interaction: Interaction, store: ControlPanelStore, config: Config, module: AdminModule = "status"): PanelUpdate {
  return panelUpdate(adminPanelComponents(interaction, store, config, module));
}

function mentionList(ids: string[], formatter: (id: string) => string): string {
  return ids.length ? ids.map(formatter).join(" ") : "無";
}

function aiKeySelectionComponents(state: NineRouterKeyState, selectedId: string): ComponentJson[] {
  const applied = state.keys.find((key) => key.id === state.appliedId);
  const selected = state.keys.find((key) => key.id === selectedId);
  const appliedText = applied ? applied.name + " · " + applied.id.slice(0, 8) : "尚未同步";
  const selectedText = selected ? selected.name + " · " + selected.id.slice(0, 8) : applied ? "沿用目前 key" : "未選擇";
  const children: ComponentJson[] = [textDisplay([
    "### API key",
    "套用中 · " + appliedText,
    "面板選擇 · " + selectedText,
    "-# 同步最長 1 分鐘；只有 key 改變才重啟 bot"
  ].join("\n"))];
  if (state.overflow) {
    children.push(textDisplay("-# ⚠️ active keys 超過 25 筆；請先在 9router Dashboard 停用不使用的 key。"));
    return children;
  }
  const select = stringSelect("ai:key:select", "選擇 9router API key", nineRouterKeyOptions(state, selectedId));
  if (select) children.push(select);
  return children;
}

function aiSettingsPanelComponents(store: ControlPanelStore, config: Config): APIMessageTopLevelComponent[] {
  const baseUrl = config.aiBaseUrl;
  const model = (store.setting("ai_model") || config.aiModel).trim();
  const hasKey = Boolean(config.aiApiKey);
  const connectionStatus: StatusKind = baseUrl && hasKey ? "ready" : "error";
  const modelStatus: StatusKind = model ? "ready" : "warn";
  const panelStatus = worstStatus([connectionStatus, modelStatus]);
  const keyState = readNineRouterKeyState(config.databasePath);
  const selectedKeyId = store.setting("ai_9router_key_id") || "";
  const modelLines = [
    "### 模型",
    "目前 · " + (model ? inlineCodeText(model) : statusBadge("warn")),
    ...(!model ? ["-# 按「重新讀取模型」後從清單選一個。"] : [])
  ];
  const children: ComponentJson[] = [
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 連線",
      "狀態 · " + statusBadge(connectionStatus),
      connectionStatus === "ready" ? "-# Endpoint 與 API key 由 server 環境設定" : "-# server 尚未設定 Endpoint 與 API key"
    ].join("\n")),
    textDisplay(modelLines.join("\n")),
    ...aiKeySelectionComponents(keyState, selectedKeyId),
    actionRow([
      button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
      button("ai:test", "測試連線", ButtonStyle.Secondary, !baseUrl || !hasKey)
    ])
  ];
  return [componentContainer(children, panelStatus)];
}

export function aiSettingsPanelMessage(_interaction: Interaction, store: ControlPanelStore, config: Config): PanelMessage {
  return panelMessage(aiSettingsPanelComponents(store, config));
}

export function aiSettingsPanelUpdate(_interaction: Interaction, store: ControlPanelStore, config: Config): PanelUpdate {
  return panelUpdate(aiSettingsPanelComponents(store, config));
}

function aiModelLoadingPanelComponents(currentModel: string): APIMessageTopLevelComponent[] {
  return [componentContainer([
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 連線",
      "狀態 · 🔄 處理中",
      "",
      "### 模型",
      "目前 · " + (currentModel ? inlineCodeText(currentModel) : statusBadge("warn"))
    ].join("\n"))
  ], "warn")];
}

export function aiModelLoadingPanelUpdate(currentModel: string): PanelUpdate {
  return panelUpdate(aiModelLoadingPanelComponents(currentModel));
}

function displayModelOptions(options: AiModelOption[], currentModel: string): AiModelOption[] {
  const currentIndex = options.findIndex((option) => option.value === currentModel);
  if (currentIndex <= 0) return options;
  return [options[currentIndex], ...options.slice(0, currentIndex), ...options.slice(currentIndex + 1)];
}

export function aiModelSelectPanelUpdate(
  currentModel: string,
  options: AiModelOption[],
  page = 0,
  keyState: NineRouterKeyState = { keys: [], appliedId: "", updatedAt: "", overflow: false },
  selectedKeyId = ""
): PanelUpdate {
  const displayOptions = displayModelOptions(options.slice(0, 200), currentModel);
  const totalPages = Math.max(1, Math.ceil(displayOptions.length / 25));
  const safePage = clampInteger(page, 0, totalPages - 1);
  const start = safePage * 25;
  const pageOptions = displayOptions.slice(start, start + 25);
  const select = stringSelect("ai:model:select", "選擇可用模型", pageOptions);
  const modelStatus: StatusKind = currentModel ? "ready" : "warn";
  const children: ComponentJson[] = [
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 連線",
      "狀態 · " + statusBadge("ready"),
      "",
      "### 模型",
      "目前 · " + (currentModel ? inlineCodeText(currentModel) : statusBadge("warn")),
      "可選 · " + displayOptions.length
    ].join("\n"))
  ];
  children.push(...aiKeySelectionComponents(keyState, selectedKeyId));
  if (select) children.push(select);
  children.push(actionRow([
    button("ai:model:page:" + (safePage - 1), "上一頁", ButtonStyle.Secondary, safePage === 0),
    button("ai:model:page:" + (safePage + 1), "下一頁", ButtonStyle.Secondary, safePage >= totalPages - 1)
  ]));
  children.push(actionRow([
    button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
    button("ai:test", "測試連線")
  ]));
  return panelUpdate([componentContainer(children, modelStatus)]);
}

export function aiProviderStatusPanelUpdate(
  message: string,
  keyState: NineRouterKeyState = { keys: [], appliedId: "", updatedAt: "", overflow: false },
  selectedKeyId = ""
): PanelUpdate {
  const children: ComponentJson[] = [
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 連線",
      "狀態 · " + statusBadge("error"),
      "說明 · " + message,
      "-# 請檢查 server 環境設定後再試。"
    ].join("\n"))
  ];
  children.push(...aiKeySelectionComponents(keyState, selectedKeyId));
  children.push(actionRow([
    button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
    button("ai:test", "測試連線")
  ]));
  return panelUpdate([componentContainer(children, "error")]);
}

export function aiTestLoadingPanelUpdate(store: ControlPanelStore, config: Config): PanelUpdate {
  const model = (store.setting("ai_model") || config.aiModel).trim();
  return panelUpdate([componentContainer([
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 測試連線",
      "狀態 · 🔄 處理中",
      "目前模型 · " + (model ? inlineCodeText(model) : statusBadge("warn"))
    ].join("\n"))
  ], "warn")]);
}

export function aiTestResultPanelUpdate(message: string, ok: boolean): PanelUpdate {
  const status: StatusKind = ok ? "ready" : "error";
  return panelUpdate([componentContainer([
    textDisplay("## 🤖 9router 設定"),
    separator(),
    textDisplay([
      "### 測試連線",
      "狀態 · " + statusBadge(status),
      message
    ].join("\n")),
    actionRow([button("ai:test", "重新測試", ButtonStyle.Primary)])
  ], status)]);
}

export function voiceSettingsModal(store: ControlPanelStore): ModalBuilder {
  const voice = store.voiceSettings();
  return new ModalBuilder()
    .setCustomId("settings:voice-modal")
    .setTitle("動態語音")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("voice-name-template")
        .setLabel("頻道命名")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(voice.nameTemplate)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("voice-user-limit")
        .setLabel("人數上限")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(String(voice.userLimit))),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("voice-owner-manage")
        .setLabel("房主管理")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(voice.ownerManage ? "開啟" : "關閉"))
    );
}
