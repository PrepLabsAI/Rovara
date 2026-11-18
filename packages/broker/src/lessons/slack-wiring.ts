// Lead 4 L4-SRC-SL: the three seams the Slack source needs, built the same way for a deployed install and a laptop (`core-host/lessons.ts`, `local/app/lessons.ts`):
//   reader     the task's own thread, one read through the channel adapter's `thread_messages` command (`core/channel/thread-replies.ts`);
//   optedOut   the person's own "Don't learn from my Slack messages" row, read NOW (`slack-switch.ts`); a read that fails is "opted out";
//   paused     the project's "Slack threads" row (`kind:slack_reply`) in the project's paused sources, read NOW (`sources.ts#pausedKey`); a read that fails is "paused".
import type { DocumentStore, OrgId, RegistryView } from "@agentx/contracts";
import type { ChannelCompanyOf, ChannelMemberRule } from "../core/channel/company.js";
import { createSlackThreadReader } from "../core/channel/thread-replies.js";
import { pausedKey } from "./sources.js";
import { normSource } from "./types.js";
import { readSlackOptOut } from "./slack-switch.js";
import { SLACK_PAUSE_KEY, type SlackLessonSourceOptions } from "./slack-source.js";
import type { LessonStore } from "./store.js";

export function slackThreadSource(input: {
  store: DocumentStore; companyId: OrgId; registry: Pick<RegistryView, "get">; companyOf?: ChannelCompanyOf | undefined; isMember?: ChannelMemberRule | undefined; now: () => number;
  /** The lessons' own store, asked at the moment of each read (it may be built after this call). */
  lessonStore: () => Pick<LessonStore, "flags">;
  /** The task's session id when it is not the derived one. */
  sessionOf?: ((taskId: string) => Promise<string | undefined>) | undefined;
  sendCommand?: Parameters<typeof createSlackThreadReader>[0]["sendCommand"];
}): Pick<SlackLessonSourceOptions, "reader" | "optedOut" | "paused"> {
  return {
    reader: createSlackThreadReader({ store: input.store, orgId: input.companyId, registry: input.registry, companyOf: input.companyOf, isMember: input.isMember, sessionOf: input.sessionOf, sendCommand: input.sendCommand, now: input.now }),
    optedOut: (person) => readSlackOptOut(input.store, input.companyId, person),
    // Stopped by the project's "Slack threads" row, or by a flood guard on any Slack channel of the project (a paused `slack:<channel>` stops the next read too, not only the results after it).
    paused: async (project) => {
      const flags = await input.lessonStore().flags({ workspaceId: input.companyId, project });
      return pausedKey(flags, SLACK_PAUSE_KEY) !== undefined || Object.keys(flags.pausedSources ?? {}).some((name) => normSource(name).startsWith("slack:"));
    },
  };
}
