// L4-U5b: remembers the chat conversation a hosted core task was started from (`CoreTaskEntry.recordThread`). The company is the CALLER's live membership's (the deployed caller the entry mapped), never the request's word;
// before anything is written the conversation's tenant must be that company's (`ChatThreads.companyOf`), the actor must be of that same tenant, and the task must be this company's and one the caller may act on (the rule
// every task read of theirs goes through). The row is the company's own (`core/channel/threads.ts`), written once. Anything else records nothing and says `false`.
import type { ActorRef, ConversationRef, OrgId } from "@agentx/contracts";
import { recordTaskThread } from "../core/channel/threads.js";
import { taskSessionId } from "../core/sessions/create.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import type { ChatThreads } from "./chat-threads.js";
import type { DeployedCaller } from "./dev-routes.js";

export interface ChatThreadRecordDeps {
  chatThreads: Pick<ChatThreads, "companyOf">;
  runtimeFor(companyId: OrgId): Promise<{ flow: { deps: Pick<TaskFlowDeps, "store" | "access" | "companyId"> } }>;
  now: () => number;
}

export async function recordChatThread(deps: ChatThreadRecordDeps, deployed: DeployedCaller, input: { taskId: string; conversation: ConversationRef; actor: ActorRef }): Promise<boolean> {
  const { companyId } = deployed.principal;
  if (input.conversation.channel !== input.actor.channel || input.conversation.tenant !== input.actor.tenant) return false;
  if ((await deps.chatThreads.companyOf({ channel: input.conversation.channel, tenant: input.conversation.tenant })) !== companyId) return false;
  const flowDeps = (await deps.runtimeFor(companyId)).flow.deps;
  if (flowDeps.companyId !== companyId) return false;
  const task = await readTask(flowDeps, input.taskId);
  if (task === undefined || task.companyId !== companyId || !(await flowDeps.access.canAct(deployed.principal, task))) return false;
  await recordTaskThread({ store: flowDeps.store, orgId: companyId, now: deps.now }, {
    sessionId: typeof task.sessionId === "string" ? task.sessionId : taskSessionId(task.taskId), conversation: input.conversation, personId: deployed.principal.personId, actor: input.actor,
  });
  return true;
}
