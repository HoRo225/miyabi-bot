import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type InteractionReplyOptions,
  type InteractionUpdateOptions
} from "discord.js";
import { safeMentions } from "./text.js";

export type PanelMessage = Pick<InteractionReplyOptions, "allowedMentions" | "components" | "flags">;
export type PanelUpdate = Pick<InteractionUpdateOptions, "allowedMentions" | "components">;
export type ComponentJson = Record<string, unknown>;
export type RowComponent = ComponentJson;

const MEDIA_GALLERY_COMPONENT_TYPE = 12;

export function panelMessage(components: APIMessageTopLevelComponent[]): PanelMessage {
  return {
    components,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

export function panelUpdate(components: APIMessageTopLevelComponent[]): PanelUpdate {
  return {
    components,
    allowedMentions: { parse: [] }
  };
}

export function componentContainer(children: ComponentJson[], accentColor: number): APIMessageTopLevelComponent {
  return {
    type: ComponentType.Container,
    accent_color: accentColor,
    components: children
  } as unknown as APIMessageTopLevelComponent;
}

export function textDisplay(content: string): ComponentJson {
  return { type: ComponentType.TextDisplay, content };
}

export function separator(): ComponentJson {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

export function mediaGallery(url: string, description: string): ComponentJson {
  return { type: MEDIA_GALLERY_COMPONENT_TYPE, items: [{ media: { url }, description: safeMentions(description).slice(0, 1024) }] };
}

export function actionRow(components: ComponentJson[]): RowComponent {
  return { type: ComponentType.ActionRow, components };
}

export function button(customId: string, label: string, style = ButtonStyle.Secondary, disabled = false): ComponentJson {
  return { type: ComponentType.Button, custom_id: customId, label, style, disabled };
}

export function linkButton(url: string, label: string): ComponentJson {
  return { type: ComponentType.Button, style: ButtonStyle.Link, label, url };
}

export function roleSelect(customId: string, placeholder: string, defaultIds: string[] = [], disabled = false): ComponentJson {
  const defaults = defaultIds.slice(0, 25).map((id) => ({ id, type: "role" }));
  return {
    type: ComponentType.RoleSelect,
    custom_id: customId,
    ...(placeholder ? { placeholder } : {}),
    min_values: 0,
    max_values: 25,
    disabled,
    ...(defaults.length ? { default_values: defaults } : {})
  };
}

export function channelSelect(customId: string, placeholder: string, defaultIds: string[] = [], disabled = false): ComponentJson {
  const defaults = defaultIds.slice(0, 25).map((id) => ({ id, type: "channel" }));
  return {
    type: ComponentType.ChannelSelect,
    custom_id: customId,
    ...(placeholder ? { placeholder } : {}),
    min_values: 0,
    max_values: 25,
    disabled,
    channel_types: [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.PublicThread,
      ChannelType.PrivateThread
    ],
    ...(defaults.length ? { default_values: defaults } : {})
  };
}

export function notificationChannelSelect(customId: string, placeholder: string, defaultId: string | null = null): ComponentJson {
  return {
    type: ComponentType.ChannelSelect,
    custom_id: customId,
    ...(placeholder ? { placeholder } : {}),
    min_values: 0,
    max_values: 1,
    channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread],
    ...(defaultId ? { default_values: [{ id: defaultId, type: "channel" }] } : {})
  };
}

export function voiceChannelSelect(customId: string, placeholder: string, defaultId: string | null = null): ComponentJson {
  return {
    type: ComponentType.ChannelSelect,
    custom_id: customId,
    ...(placeholder ? { placeholder } : {}),
    min_values: 0,
    max_values: 1,
    channel_types: [ChannelType.GuildVoice],
    ...(defaultId ? { default_values: [{ id: defaultId, type: "channel" }] } : {})
  };
}

export function stringSelect(customId: string, placeholder: string, options: Array<{ label: string; value: string; description?: string }>): RowComponent | null {
  if (!options.length) return null;
  return actionRow([{
    type: ComponentType.StringSelect,
    custom_id: customId,
    placeholder,
    min_values: 1,
    max_values: 1,
    options: options.slice(0, 25).map((option) => ({
      label: option.label.slice(0, 100),
      value: option.value.slice(0, 100),
      ...(option.description ? { description: option.description.slice(0, 100) } : {})
    }))
  }]);
}
