// The one read of a task's own chat thread for the lessons' Slack source (Lead 4 L4-SRC-SL; the rules are in `lessons/slack-source.ts`). Built on what the core already holds:
//   - the thread is the one the task's work STARTED in (`readTaskThread`, written when a person started the work there); nothing else is ever asked for, and a task started elsewhere has no thread;
//   - the thread's space must be bound to the task's own project (`readChannelBinding`) and its tenant must be the asking company's (`tenantIsCompanys`): another company's or another project's space is nobody's here;
//   - the adapter is asked once, with the `thread_messages` command (`core/channel/commands.ts`: the command only reaches an adapter that declares `history`, and only inside the company);
//   - each reply's writer is mapped to a person only through a chat link the person made themselves (`linkedPerson`) and a host's member rule (`personIsServed`); an account nobody linked has no person.
// Nothing here stores a word of any message. A refusal, an adapter that cannot answer, a thread of another kind of channel: no thread (the task's reflection goes on without it).
import { ChannelCommandResultSchemas, SLACK_CHANNEL, type ChannelCommandResult, type DocumentStore, type OrgId, type RegistryView } from "@agentx/contracts";
import type { SlackThreadFacts, SlackThreadReader } from "../../lessons/slack-source.js";
import { readChannelBinding } from "./bindings.js";
import { personIsServed, tenantIsCompanys, type ChannelCompanyOf, type ChannelMemberRule } from "./company.js";
import { sendChannelCommand } from "./commands.js";
import { linkedPerson } from "./links.js";
import { readTaskThread } from "./threads.js";
import { taskSessionId } from "../sessions/create.js";

export interface SlackThreadReaderDeps {
  store: DocumentStore;
  orgId: OrgId;
  /** Where the channel adapters are (`registry.get("channel", id)`). */
  registry: Pick<RegistryView, "get">;
  companyOf?: ChannelCompanyOf | undefined;
  isMember?: ChannelMemberRule | undefined;
  /** The task's session id when it is not the one derived from the task id (a task record names its own). */
  sessionOf?: ((taskId: string) => Promise<string | undefined>) | undefined;
  now: () => number;
  /**
   * Sends the `thread_messages` command some other way than an in-process adapter (a deployment whose Slack adapter is a signed webhook one: `aws/channel-commands.ts`). It is asked only after the thread, the binding and the tenant
   * checks below, and its answer is checked here by the caller's own schema. Absent: the registry's in-process adapter is used (and none means no thread).
   */
  sendCommand?: ((input: { tenant: string; space: string; thread: string }) => Promise<ChannelCommandResult<"thread_messages">>) | undefined;
}

export function createSlackThreadReader(deps: SlackThreadReaderDeps): SlackThreadReader {
  return {
    async read(input) {
      // The reader answers for the one company it was built for.
      if (input.companyId !== deps.orgId) return undefined;
      const sessionId = (await deps.sessionOf?.(input.taskId)) ?? taskSessionId(input.taskId);
      const thread = await readTaskThread(deps.store, deps.orgId, sessionId);
      if (thread === undefined) return undefined;
      const { conversation } = thread;
      if (conversation.channel !== SLACK_CHANNEL) return undefined;
      if (!(await tenantIsCompanys(deps.companyOf, deps.orgId, conversation.channel, conversation.tenant))) return undefined;
      // Only a space bound to THIS task's project is asked about at all (a space bound to another project, or to none, is not read).
      const binding = await readChannelBinding({ store: deps.store, orgId: deps.orgId }, { channel: conversation.channel, tenant: conversation.tenant, space: conversation.space });
      if (binding === undefined || binding.projectName !== input.project) return undefined;
      const place = `${SLACK_CHANNEL}:${conversation.tenant}/${conversation.space}`;
      const asking = { tenant: conversation.tenant, space: conversation.space, thread: conversation.thread };
      let answer: ChannelCommandResult<"thread_messages">;
      if (deps.sendCommand !== undefined) {
        const checked = ChannelCommandResultSchemas.thread_messages.safeParse(await deps.sendCommand(asking));
        if (!checked.success) return undefined;
        answer = checked.data;
      } else {
        const adapter = deps.registry.get("channel", conversation.channel);
        if (adapter === undefined) return undefined;
        answer = await sendChannelCommand({ channel: conversation.channel, adapter, orgId: deps.orgId, companyOf: deps.companyOf, now: deps.now }, "thread_messages", asking);
      }
      const personOf = new Map<string, string | undefined>();
      const person = async (userId: string): Promise<string | undefined> => {
        if (!personOf.has(userId)) {
          const actor = { channel: conversation.channel, tenant: conversation.tenant, userId };
          // An account id that is not a chat account of this channel (or a link that cannot be read) has no person here.
          let linked: string | undefined;
          try { linked = await linkedPerson({ store: deps.store, orgId: deps.orgId, now: deps.now }, actor); } catch { linked = undefined; }
          personOf.set(userId, linked !== undefined && (await personIsServed(deps.isMember, deps.orgId, linked, actor)) ? linked : undefined);
        }
        return personOf.get(userId);
      };
      const messages: SlackThreadFacts["messages"][number][] = [];
      for (const message of answer.messages) {
        // Only a person's own plain reply is mapped; for anything else the person is never looked up.
        const mappable = !message.bot && !message.external && message.plain && message.userId !== undefined;
        const who = mappable ? await person(message.userId!) : undefined;
        messages.push({ id: message.id, text: message.text, bot: message.bot, external: message.external, plain: message.plain, ...(who === undefined ? {} : { person: who }) });
      }
      return { place, boundToProject: true, private: answer.space.private, shared: answer.space.shared, direct: answer.space.direct, messages, ...(answer.truncated ? { truncated: true as const } : {}) };
    },
  };
}
