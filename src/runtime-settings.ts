import {
  resolveRuntimeSettings,
  type Config,
  type RuntimeSettings
} from "./config.js";

type RuntimeSettingsStore = {
  setting(key: string): string | undefined;
};

export function runtimeSettingsFromStore(store: RuntimeSettingsStore, config: Config): RuntimeSettings {
  return resolveRuntimeSettings({
    summary_message_limit: store.setting("summary_message_limit"),
    reply_mention_user: store.setting("reply_mention_user"),
    attachment_max_mb: store.setting("attachment_max_mb")
  }, {
    summaryMessageLimit: config.summaryMessageLimit,
    replyMentionUser: config.replyMentionUser,
    attachmentMaxBytes: config.attachmentMaxBytes
  });
}
