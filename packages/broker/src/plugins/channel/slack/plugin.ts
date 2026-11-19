// The chat tool's channel adapter as a plug-in module (owner decision 58). The config entry names it, and its settings point at the tokens, which are read through the `secrets` point (never held in the config):
//
//   { "point": "channel", "name": "slack", "module": "@agentx/broker/plugins/channel-slack",
//     "settings": { "botToken": { "env": "SLACK_BOT_TOKEN" }, "appToken": { "env": "SLACK_APP_TOKEN" }, "projects": ["web"] } }
//
// `botToken` lets it post; `appToken` (the app-level token of a socket-mode app) lets it hear a mention and a button press on a laptop with no public address. Without `appToken` it only posts notices.
import { z } from "zod";
import { AgentXNameSchema, type PluginContext, type PluginModule } from "@agentx/contracts";
import { contextSecretReader, readPluginSettings, SecretSourceSchema } from "../../module-support.js";
import { SlackChannel } from "./adapter.js";
import type { SocketFactory } from "./socket.js";

export const SLACK_CHANNEL_NAME = "slack";

const SettingsSchema = z.object({
  botToken: SecretSourceSchema,
  appToken: SecretSourceSchema.optional(),
  projects: z.array(AgentXNameSchema).min(1).max(64).refine((names) => new Set(names).size === names.length, "each project once"),
}).strict();

export interface SlackChannelPluginOptions {
  fetch?: typeof fetch;
  socket?: SocketFactory;
  sleep?: (ms: number) => Promise<void>;
}

export function slackChannelPlugin(options: SlackChannelPluginOptions = {}): PluginModule<"channel"> {
  return {
    point: "channel",
    name: SLACK_CHANNEL_NAME,
    create(context: PluginContext) {
      const settings = readPluginSettings(SettingsSchema, context.settings, `channel/${SLACK_CHANNEL_NAME}`);
      return new SlackChannel({
        projects: settings.projects,
        botToken: contextSecretReader(context, settings.botToken),
        appToken: settings.appToken === undefined ? undefined : contextSecretReader(context, settings.appToken),
        now: context.now,
        // Fixed words only: the adapter's own log lines carry codes and counts, never a token or what was said.
        log: (entry) => console.error(JSON.stringify({ component: "channel", channel: SLACK_CHANNEL_NAME, ...entry })),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.socket === undefined ? {} : { socket: options.socket }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
    },
  };
}
