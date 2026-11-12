// Spec 062 Phase 7c: the notifier's Slack posts through the built-in Slack adapter. The notifier keeps its own logic and
// its Slack-shaped inputs (a channel or person ID, a thread timestamp, Block Kit); here each becomes a signed command
// with a neutral message, and the adapter's answer comes back in the shape Slack's own answer had. A refusal carries
// Slack's error code, so the notifier reads it as it always has; no answer reads as a post that may have landed.
import {
  SLACK_CHANNEL,
  channelMessageOfSlackBlocks,
  slackBlocksOf,
  type ChannelAdapterRecord,
  type ChannelCommandKind,
  type ChannelCommandResult,
  type RichMessage,
} from "@agentx/contracts";
import { isDeepStrictEqual } from "node:util";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { checkEndpointAddresses } from "@agentx/gateway";
import { builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { ChannelCommandFailed, sendChannelCommand, type ChannelCommandDependencies, type ChannelCommandInput } from "./channel-commands.js";
import { slackAdapterSecretReader } from "./slack-adapter.js";
import { SlackPostError, taskPlanCanvasTitle } from "./slack-web.js";

export interface SlackNoticeChannelDependencies extends ChannelCommandDependencies {
  /** The built-in Slack adapter, with its commands URL. */
  adapter: ChannelAdapterRecord;
  /** The Slack workspace (team) this deployment serves: a person is named within it. */
  teamId: string;
  log?: (entry: Record<string, unknown>) => void;
}

/** The notifier's Slack client, through the adapter. */
export interface SlackNoticeChannel {
  post: (input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }) => Promise<{ ts: string; channel?: string }>;
  update: (input: { channel: string; ts: string; text: string; blocks?: unknown[] }) => Promise<void>;
  postEphemeral: (input: { channel: string; threadTs: string; user: string; text: string; blocks?: unknown[] }) => Promise<void>;
  createPlanCanvas: (input: { channel: string; taskId: string; title: string; version: number; markdown: string }, onCreated?: (canvasId: string) => Promise<void>) => Promise<{ canvasId: string; permalink: string }>;
  deleteCanvas: (canvasId: string) => Promise<"deleted" | "unknown">;
}

const SLACK_METHOD: Partial<Record<ChannelCommandKind, string>> = {
  post_message: "chat.postMessage", direct_message: "chat.postMessage", update_message: "chat.update", create_document: "canvases.create", delete_document: "canvases.delete",
};

/** Blocks as the adapter renders them: without block IDs, which no handler reads. */
function withoutBlockIds(blocks: readonly unknown[]): unknown[] {
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const rest: Record<string, unknown> = { ...(block as Record<string, unknown>) };
    delete rest.block_id;
    return rest;
  });
}

export function createSlackNoticeChannel(deps: SlackNoticeChannelDependencies): SlackNoticeChannel {
  const log = deps.log ?? (() => undefined);

  /** One command, its failures read as Slack's: a refusal by its code, no answer as a post that may have landed. */
  async function command<K extends ChannelCommandKind>(kind: K, input: ChannelCommandInput<K>): Promise<ChannelCommandResult<K>> {
    try {
      return await sendChannelCommand(deps, deps.adapter, kind, input);
    } catch (error) {
      const method = SLACK_METHOD[kind] ?? kind;
      if (error instanceof ChannelCommandFailed) {
        throw error.outcome === "refused" ? new SlackPostError(error.adapterCode ?? "refused", method) : new SlackPostError("http_503", method);
      }
      throw error;
    }
  }

  /** Block Kit as a neutral message; a block it cannot read sends the text alone, and is logged. */
  function messageOf(text: string, blocks: unknown[] | undefined): RichMessage {
    if (blocks === undefined) return { text };
    const message = channelMessageOfSlackBlocks(text, blocks);
    if (message !== undefined) {
      // The adapter renders it back; a card that would not look the same is said, so the drift is seen and fixed.
      if (!isDeepStrictEqual(slackBlocksOf(message), withoutBlockIds(blocks))) log({ event: "slack_notice.blocks_changed" });
      return message;
    }
    log({ event: "slack_notice.blocks_unreadable" });
    return { text };
  }

  const person = (userId: string) => ({ channel: SLACK_CHANNEL, tenant: deps.teamId, userId });
  /** A person's ID: the post goes to their direct message with the bot. */
  const isPerson = (channel: string) => /^[UW][A-Z0-9]{2,}$/.test(channel);

  return {
    async post(input) {
      const message = messageOf(input.text, input.blocks);
      if (isPerson(input.channel) && input.threadTs === undefined) {
        const sent = await command("direct_message", { to: person(input.channel), message });
        return { ts: sent.messageId, channel: sent.space };
      }
      const sent = await command("post_message", { tenant: deps.teamId, space: input.channel, ...(input.threadTs === undefined ? {} : { thread: input.threadTs }), message });
      if (sent.messageId === undefined) throw new SlackPostError("no_message_id", "chat.postMessage");
      return { ts: sent.messageId, channel: sent.space };
    },
    async update(input) {
      await command("update_message", { tenant: deps.teamId, space: input.channel, messageId: input.ts, message: messageOf(input.text, input.blocks) });
    },
    async postEphemeral(input) {
      await command("post_message", { tenant: deps.teamId, space: input.channel, thread: input.threadTs, message: messageOf(input.text, input.blocks), audience: { kind: "ephemeral", actor: person(input.user) } });
    },
    async createPlanCanvas(input, onCreated) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.taskId) || input.title.trim() === "" || !Number.isSafeInteger(input.version) || input.version < 1 || input.markdown.trim() === "") {
        throw new Error("task plan Canvas input is invalid");
      }
      const created = await command("create_document", { tenant: deps.teamId, space: input.channel, title: taskPlanCanvasTitle(input.title, input.version), markdown: input.markdown });
      // The adapter made, shared and read the Canvas in one command; its ID is recorded as soon as it is known.
      await onCreated?.(created.documentId);
      return { canvasId: created.documentId, permalink: created.url };
    },
    async deleteCanvas(canvasId) {
      if (!/^F[A-Z0-9]{8,}$/.test(canvasId)) throw new Error("task Canvas ID is invalid");
      return (await command("delete_document", { documentId: canvasId })).deleted ? "deleted" : "unknown";
    },
  };
}

/**
 * The notifier's and reconciler's Slack client through the adapter, when Slack goes through the channel API
 * (`SlackViaChannel`) and the adapter's commands URL and the Slack team are set; otherwise undefined, and they post to
 * Slack themselves as before.
 */
export function slackNoticeChannelFromEnvironment(secretsManager: Pick<SecretsManagerClient, "send">, team?: string): SlackNoticeChannel | undefined {
  if (process.env.SLACK_VIA_CHANNEL !== "enabled") return undefined;
  const adapter = builtInAdapterFromEnvironment(process.env);
  // Phase 7d: the legacy deployment names no team; the channel API passes the message's own.
  const teamId = team ?? process.env.SLACK_ADAPTER_TEAM_ID;
  if (adapter?.commandsUrl === undefined || !teamId || !/^[TE][A-Z0-9]{2,31}$/.test(teamId)) {
    console.log(JSON.stringify({ component: "slack-notice-channel", event: "not_configured" }));
    return undefined;
  }
  const secret = slackAdapterSecretReader(secretsManager, adapter.secretName);
  return createSlackNoticeChannel({
    adapter, teamId, getSecret: () => secret(), fetch, checkAddresses: (url) => checkEndpointAddresses(url), now: Date.now,
    log: (entry) => console.log(JSON.stringify({ component: "slack-notice-channel", ...entry })),
  });
}

/**
 * Phase 7d: a Slack client for whichever team is answering now, so a deployment that names no team (the legacy one)
 * posts as the message it answers belongs to. `teamOf` reads the current team; each team's client is made once.
 */
export function slackNoticeChannelForCurrentTeam(secretsManager: Pick<SecretsManagerClient, "send">, teamOf: () => string | undefined): SlackNoticeChannel {
  const clients = new Map<string, SlackNoticeChannel>();
  const current = (): SlackNoticeChannel => {
    const team = teamOf() ?? process.env.SLACK_ADAPTER_TEAM_ID;
    if (team === undefined) throw new Error("no Slack team is known for this post");
    let client = clients.get(team);
    if (client === undefined) {
      client = slackNoticeChannelFromEnvironment(secretsManager, team);
      if (client === undefined) throw new Error("the Slack adapter is not configured");
      clients.set(team, client);
    }
    return client;
  };
  return {
    post: (input) => current().post(input),
    update: (input) => current().update(input),
    postEphemeral: (input) => current().postEphemeral(input),
    createPlanCanvas: (input, onCreated) => current().createPlanCanvas(input, onCreated),
    deleteCanvas: (canvasId) => current().deleteCanvas(canvasId),
  };
}
