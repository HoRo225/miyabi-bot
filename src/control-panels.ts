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
import {
  actionRow,
  button,
  componentContainer,
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
  type RowComponent
} from "./discord-ui.js";
import { steamFreeStatusLabel, type SteamFreeSettings } from "./steam-free.js";
import { discordTimestampText } from "./text.js";
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

export const ADMIN_NAV_MODULES: Array<{ label: string; value: AdminModule }> = [
  { label: "總覽", value: "status" },
  { label: "設定權限", value: "settings" }
];

export const SETTINGS_NAV_MODULES: Array<{ label: string; value: SettingsModule }> = [
  { label: "總覽", value: "overview" },
  { label: "動態語音", value: "voice" },
  { label: "Steam 免費遊戲", value: "steam-free" }
];

function settingsModuleLabel(module: SettingsModule): string {
  return SETTINGS_MODULE_LABELS[module] ?? module;
}

function settingsModuleSelect(module: SettingsModule): RowComponent {
  return stringSelect("settings:module", settingsModuleLabel(module), SETTINGS_NAV_MODULES) ?? actionRow([]);
}

export function settingsModuleFromValue(value: string): SettingsModule | null {
  return SETTINGS_NAV_MODULES.some((item) => item.value === value) ? value as SettingsModule : null;
}

function settingsPanelComponents(store: ControlPanelStore, _config: Config, module: SettingsModule = "overview"): APIMessageTopLevelComponent[] {
  const settingsRoles = store.listSettingsAllowedRoles();
  const voice = store.voiceSettings();
  const voiceReady = voice.enabled && voice.triggerChannelId;
  const steamFree = store.steamFreeSettings();
  const steamFreeReady = steamFree.enabled && steamFree.channelId;
  const children: ComponentJson[] = [
    textDisplay("## 設定"),
    settingsModuleSelect(module),
    separator()
  ];

  if (module === "overview") {
    children.push(
      textDisplay([
        "> 狀態",
        `- /settings 權限：${settingsRoles.length ? mentionList(settingsRoles, (id) => `<@&${id}>`) : "未設定"}`,
        "",
        "> 啟用模組",
        `- 動態語音：${voiceReady ? "啟用" : "未啟用"}`,
        `- Steam 免費遊戲：${steamFreeReady ? "啟用" : "未啟用"}`
      ].join("\n")),
      actionRow([button("settings:refresh:overview", "重新整理")])
    );
  }

  if (module === "voice") {
    children.push(
      textDisplay([
        "> 動態語音",
        `- 狀態：${voiceStatusLabel(voice)}`,
        `- 入口頻道：${voice.triggerChannelId ? `<#${voice.triggerChannelId}>` : "未設定"}`,
        `- 命名：${voice.nameTemplate}`,
        `- 人數上限：${voice.userLimit || "無"}`,
        `- 房主管理：${voice.ownerManage ? "開啟" : "關閉"}`
      ].join("\n")),
      actionRow([
        button("settings:voice:toggle", voice.enabled ? "停用" : "啟用", voice.enabled ? ButtonStyle.Danger : ButtonStyle.Primary),
        button("settings:voice:options", "編輯選項", ButtonStyle.Primary)
      ]),
      actionRow([voiceChannelSelect("settings:voice:trigger", "\u200b", voice.triggerChannelId)]),
      actionRow([button("settings:refresh:voice", "重新整理")])
    );
  }

  if (module === "steam-free") {
    children.push(
      textDisplay([
        "> Steam 免費遊戲",
        `- 狀態：${steamFreeStatusLabel(steamFree)}`,
        `- 通知頻道：${steamFree.channelId ? `<#${steamFree.channelId}>` : "未設定"}`,
        `- 最近檢查：${discordTimestampText(steamFree.lastCheckedAt)}`,
        `- 通知身分組：${steamFree.notifyRoleIds.length ? mentionList(steamFree.notifyRoleIds, (id) => `<@&${id}>`) : "未設定"}`
      ].join("\n")),
      actionRow([
        button("settings:steam-free:toggle", steamFree.enabled ? "停用" : "啟用", steamFree.enabled ? ButtonStyle.Danger : ButtonStyle.Primary),
        button("settings:steam-free:check", "立即檢查", ButtonStyle.Primary, !steamFreeReady),
        button("settings:steam-free:test", "測試訊息", ButtonStyle.Secondary, !steamFree.channelId)
      ]),
      actionRow([notificationChannelSelect("settings:steam-free:channel", "\u200b", steamFree.channelId)]),
      actionRow([roleSelect("settings:steam-free:roles", "\u200b", steamFree.notifyRoleIds)]),
      actionRow([button("settings:refresh:steam-free", "重新整理")])
    );
  }

  return [componentContainer(children, 0x5865f2)];
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
  return stringSelect("admin:module", adminModuleLabel(module), ADMIN_NAV_MODULES) ?? actionRow([]);
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
    `- /settings：${settingsRoles.length ? mentionList(settingsRoles, (id) => `<@&${id}>`) : "未設定"}`
  ];
}

function adminPanelComponents(interaction: Interaction, store: ControlPanelStore, _config: Config, module: AdminModule = "status"): APIMessageTopLevelComponent[] {
  const children: ComponentJson[] = [
    textDisplay("## 系統管理"),
    adminModuleSelect(module),
    separator()
  ];

  if (module === "status") {
    const stats = store.adminStats();
    children.push(
      textDisplay([
        "> 服務",
        `- 版本：0.1.0`,
        `- Uptime：${formatUptime(process.uptime())}`,
        `- WebSocket：${Math.round(interaction.client.ws.ping)} ms`,
        `- 伺服器：${interaction.guildId ?? "未知"}`,
        `- 資料庫：啟用`,
        "",
        "> 資料量",
        `- 訊息：${stats.messages}`,
        `- 附件：${stats.attachments}`,
        `- AI 請求：${stats.aiRequestLogs}`,
        `- Audit：${stats.auditLogs}`,
        "",
        "> 功能",
        ...enabledModuleLines(store)
      ].join("\n")),
      actionRow([button("admin:refresh:status", "重新整理")])
    );
  }

  if (module === "settings") {
    const roleIds = store.listSettingsAllowedRoles();
    const overflow = roleIds.length > 25;
    children.push(
      textDisplay([
        "> /settings 權限",
        `目前：${roleIds.length ? mentionList(roleIds, (id) => `<@&${id}>`) : "未設定"}`,
        ...(overflow ? ["", "⚠️ 已超過 25 筆上限；為避免遺失資料，此頁目前唯讀。"] : [])
      ].join("\n")),
      actionRow([roleSelect("admin:settings-role:toggle", "\u200b", roleIds, overflow)]),
      actionRow([button("admin:refresh:settings", "重新整理")])
    );
  }

  return [componentContainer(children, 0x5865f2)];
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
  const children: ComponentJson[] = [textDisplay([
    "> 9router API key",
    `目前套用：${applied ? `${applied.name} · ${applied.id.slice(0, 8)}` : "尚未同步"}`,
    `面板選擇：${selected ? `${selected.name} · ${selected.id.slice(0, 8)}` : applied ? "沿用目前 key" : "未選擇"}`,
    "同步：最長 1 分鐘；只有 key 改變才重啟 bot"
  ].join("\n"))];
  if (state.overflow) {
    children.push(textDisplay("active keys 超過 25 筆；請先在 9router Dashboard 停用不使用的 key。"));
    return children;
  }
  const select = stringSelect("ai:key:select", "選擇 9router API key", nineRouterKeyOptions(state, selectedId));
  if (select) children.push(select);
  return children;
}

function aiSettingsPanelComponents(store: ControlPanelStore, config: Config): APIMessageTopLevelComponent[] {
  const baseUrl = config.aiBaseUrl;
  const model = store.setting("ai_model") ?? config.aiModel;
  const hasKey = Boolean(config.aiApiKey);
  const keyState = readNineRouterKeyState(config.databasePath);
  const selectedKeyId = store.setting("ai_9router_key_id") ?? "";

  const children: ComponentJson[] = [
    textDisplay("## 9router 設定"),
    separator(),
  ];

  children.push(
    textDisplay([
      "> 連線",
      `狀態：${baseUrl && hasKey ? "正常" : "斷線"}`,
      `Endpoint／API key：${hasKey ? "由 server 環境設定" : "server 尚未設定"}`,
      "",
      "> 模型",
      `目前：${model}`
    ].join("\n")),
    ...aiKeySelectionComponents(keyState, selectedKeyId),
    actionRow([
      button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
      button("ai:test", "測試連線", ButtonStyle.Secondary, !baseUrl || !hasKey)
    ])
  );

  return [componentContainer(children, 0x5865f2)];
}

export function aiSettingsPanelMessage(_interaction: Interaction, store: ControlPanelStore, config: Config): PanelMessage {
  return panelMessage(aiSettingsPanelComponents(store, config));
}

export function aiSettingsPanelUpdate(_interaction: Interaction, store: ControlPanelStore, config: Config): PanelUpdate {
  return panelUpdate(aiSettingsPanelComponents(store, config));
}

function aiModelLoadingPanelComponents(currentModel: string): APIMessageTopLevelComponent[] {
  return [componentContainer([
    textDisplay("## 9router 設定"),
    separator(),
    textDisplay([
      "> 連線",
      "狀態：檢查中",
      "",
      "> 模型",
      `目前：${currentModel || "未設定"}`
    ].join("\n"))
  ], 0x5865f2)];
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
  const children: ComponentJson[] = [
    textDisplay("## 9router 設定"),
    separator(),
    textDisplay([
      "> 連線",
      "狀態：正常",
      "",
      "> 模型",
      `目前：${currentModel || "未設定"}`,
      `可選：${displayOptions.length}`
    ].join("\n"))
  ];
  children.push(...aiKeySelectionComponents(keyState, selectedKeyId));
  if (select) children.push(select);
  children.push(actionRow([
    button(`ai:model:page:${safePage - 1}`, "上一頁", ButtonStyle.Secondary, safePage === 0),
    button(`ai:model:page:${safePage + 1}`, "下一頁", ButtonStyle.Secondary, safePage >= totalPages - 1)
  ]));
  children.push(actionRow([
    button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
    button("ai:test", "測試連線"),
  ]));
  return panelUpdate([componentContainer(children, 0x5865f2)]);
}

export function aiProviderStatusPanelUpdate(
  message: string,
  keyState: NineRouterKeyState = { keys: [], appliedId: "", updatedAt: "", overflow: false },
  selectedKeyId = ""
): PanelUpdate {
  const children: ComponentJson[] = [
    textDisplay("## 9router 設定"),
    separator(),
    textDisplay([
      "> 連線",
      "狀態：斷線",
      `說明：${message}`
    ].join("\n"))
  ];
  children.push(...aiKeySelectionComponents(keyState, selectedKeyId));
  children.push(
    actionRow([
      button("ai:provider-refresh", "重新讀取模型", ButtonStyle.Primary),
      button("ai:test", "測試連線")
    ])
  );
  return panelUpdate([componentContainer(children, 0xd29922)]);
}

export function aiTestLoadingPanelUpdate(store: ControlPanelStore, config: Config): PanelUpdate {
  const model = store.setting("ai_model") ?? config.aiModel;
  return panelUpdate([componentContainer([
    textDisplay("## 9router 設定"),
    separator(),
    textDisplay(`**測試連線**\n正在測試目前模型：${model}`)
  ], 0x5865f2)]);
}

export function aiTestResultPanelUpdate(message: string, ok: boolean): PanelUpdate {
  return panelUpdate([componentContainer([
    textDisplay("## 9router 設定"),
    separator(),
    textDisplay(`**測試連線**\n${message}`),
    actionRow([button("ai:test", "重新測試", ButtonStyle.Primary)])
  ], ok ? 0x3fb950 : 0xf85149)]);
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
