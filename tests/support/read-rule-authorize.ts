// The core host's `authorize` for a test that drives the aws task rule routes alone (no core flow): the ONE read rule over a minimal flow whose own rule admits nobody, with the host's two seams bound as
// the dev routes bind them (the stored share, and the live standing: the task's own person by the hotfix's own-task test, everyone else by the grant).
import type { OrgId, Principal } from "@agentx/contracts";
import { liveGrantSeamOf } from "../../packages/broker/src/core-host/dev-routes.js";
import { decideTaskRead, type TaskRead, type TaskReadSeams } from "../../packages/broker/src/core/task-flow/read-rule.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { CoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";

export function authorizeFor(routes: CoreTaskRuleRoutes, input: { companyId: OrgId; principal: Principal; task: Record<string, unknown>; grant?: (personId: string, project: string, companyId?: string) => Promise<boolean> }) {
  const flow = { companyId: input.companyId, access: { canAct: async () => false, canRead: async () => false } } as unknown as TaskFlowDeps;
  const person = { developerId: input.principal.personId, name: input.principal.displayName };
  const liveGrant = liveGrantSeamOf({ companyId: input.companyId, holdsOwnTask: (given) => routes.holdsOwnTask(given), grant: input.grant });
  return (read: TaskRead, seams?: TaskReadSeams) => decideTaskRead(flow, {
    caller: { principal: input.principal }, task: input.task as never, read,
    seams: { sharedReader: (_who, task) => routes.sharedReader({ person, companyId: input.companyId, task }), ...(liveGrant === undefined ? {} : { liveGrant }), ...seams },
  });
}
