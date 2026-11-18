// L4-U5 test support: one task with a chat thread, the real thread-notices handler over the memory store, and a chat adapter that counts EVERY delivery attempt (the real fake adapter drops a repeated event id, which would hide a
// missing once-only claim).
import { IMPLICIT_COMPANY_ID, type ChannelEvent, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../../packages/broker/src/ports/fake-channel-adapter.js";
import { channelThreadHandler } from "../../../packages/broker/src/core/channel/thread-notices.js";
import { recordTaskThread } from "../../../packages/broker/src/core/channel/threads.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { taskSessionId } from "../../../packages/broker/src/core/sessions/create.js";
import type { CodeMilestoneHandler } from "../../../packages/broker/src/core/milestones/milestones.js";

const COMPANY = IMPLICIT_COMPANY_ID as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const clock = { ms: Date.parse("2026-11-17T10:00:00.000Z") };

export interface ThreadWorldOptions { milestones?: boolean; setupUrl?: (project: string) => string | undefined; companyOf?: () => Promise<OrgId | undefined>; closed?: boolean }

export class ThreadWorld {
  static readonly TASK = TASK;
  constructor(readonly store: MemoryDocumentStore, readonly handler: CodeMilestoneHandler, readonly attempts: ChannelEvent[]) {}

  static async make(options: ThreadWorldOptions = {}): Promise<ThreadWorld> {
    const store = new MemoryDocumentStore();
    const adapter = new FakeChannelAdapter();
    const attempts: ChannelEvent[] = [];
    const realDeliver = adapter.deliver.bind(adapter);
    adapter.deliver = async (event) => { attempts.push(event); await realDeliver(event); };
    const sessionId = taskSessionId(TASK);
    await store.put({ item: { ...taskKey(TASK), orgId: COMPANY, project: "payments", title: "Add a retry", sessionId, ...(options.closed === true ? { closedAt: "2026-11-17T09:00:00.000Z" } : {}) } });
    await recordTaskThread({ store, orgId: COMPANY, now: () => clock.ms }, { sessionId, conversation: CONVERSATION, personId: "d".repeat(64) });
    const registry = { get: (point: string, name: string) => (point === "channel" && name === "examplechat" ? adapter : undefined) } as never;
    const handler = channelThreadHandler({
      store, registry, now: () => clock.ms, footer: "Open it with `rovara open`.",
      ...(options.milestones === undefined ? {} : { milestones: options.milestones }), ...(options.setupUrl === undefined ? {} : { setupUrl: options.setupUrl }),
      ...(options.companyOf === undefined ? {} : { companyOf: async () => await options.companyOf!() }),
    });
    return new ThreadWorld(store, handler, attempts);
  }
}
