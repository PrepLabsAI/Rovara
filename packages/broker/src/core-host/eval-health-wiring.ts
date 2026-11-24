// L4-EVH (DEC 254zzz20 D5): the hosted wiring of the opt-in eval HEALTH RUN. One function makes the broker's runner deps for a company from what the install already has: its store, its bound adapters (the grant comes ONLY from
// the `eval-reservation` adapter bound there, so an install with none spends nothing), the live members reader, the monthly cap source, the audit sink, the code host (main's heads) and the task flow (the worker's preparation).
//   - `healthRuns` (the card's button and the route) is true only where a run can really happen: the install's model gateway is configured (a run is metered by it) AND a reservation adapter is bound AND a monthly cap source exists;
//   - the callback layer (`eval-plan` for the run's own preparation, `eval-health-result`) gets the same deps; its `mainHeads` and `launch` are never used there and answer nothing.
import { type AdapterRegistry, type AuditSink, type DocumentStore, type OrgId } from "@agentx/contracts";
import { createEvalStandInDescriptorSource } from "../core/setup-agent/eval-stand-in-descriptor.js";
import { fixtureObjectPortOf } from "../core/test-env/fixture-store-aws.js";
import type { SessionMembers } from "../core/sessions/access.js";
import { launchEvalHealthRun } from "../core/setup-agent/eval-health-launch.js";
import { startEvalHealthRun, type EvalHealthRunDeps, type EvalHealthStart } from "../core/setup-agent/eval-health-run.js";
import { boundEvalMonthlyCap, boundEvalReservation } from "../core/setup-agent/eval-reservation.js";
import { readEvalHealthRow } from "../core/setup-agent/eval-health-request.js";
import { headOf } from "../core/setup-agent/snapshot.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { codeHostForRecord } from "../plugins/routing.js";

export interface EvalHealthWiringInput {
  registry: Pick<AdapterRegistry, "names" | "get" | "require">;
  companyId: OrgId;
  now: () => number;
  members: SessionMembers;
  /** The company's task flow (to prepare the worker's workspace). Absent (the callback layer): nothing is launched. */
  flow?: TaskFlowDeps | undefined;
  /** Whether the install's model gateway is configured. */
  modelGatewayConfigured: boolean;
}

/** Whether a health run can really happen on this install for this company: the card shows its button only then. */
export function evalHealthRunsAvailable(input: Pick<EvalHealthWiringInput, "registry" | "modelGatewayConfigured">): boolean {
  try { return input.modelGatewayConfigured && boundEvalReservation(input.registry) !== undefined && boundEvalMonthlyCap(input.registry) !== undefined; } catch { return false; }
}

/** The runner deps for one company. */
export function evalHealthRunDeps(input: EvalHealthWiringInput): EvalHealthRunDeps {
  const store: DocumentStore = input.registry.require("storage");
  const audit: AuditSink = input.registry.require("audit-sink");
  const monthlyCap = boundEvalMonthlyCap(input.registry);
  const standIns = createEvalStandInDescriptorSource({ store, companyId: input.companyId, objects: fixtureObjectPortOf(input.registry.require("object-storage")) });
  return {
    standIns,
    store, companyId: input.companyId, now: input.now, members: input.members, registry: input.registry, ...(monthlyCap === undefined ? {} : { monthlyCap }),
    async mainHeads(project) {
      const flow = input.flow;
      const found = flow === undefined ? undefined : await flow.projects.latest(project);
      if (flow === undefined || found === undefined || found.archived === true) return undefined;
      const heads = await Promise.all(found.definition.repositories.map(async (repository) => ({
        repositoryId: repository.name,
        baseCommitSha: await headOf(codeHostForRecord(input.registry as never, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }), repository, { orgId: input.companyId }),
      })));
      return heads;
    },
    async launch(job) {
      const flow = input.flow;
      if (flow === undefined) return false;
      // The run is the preparation of the person who asked (their id is only the workspace's owner key).
      const row = await readEvalHealthRow({ store, companyId: input.companyId }, job.project);
      if (row === undefined || row.requestId !== job.requestId) return false;
      return await launchEvalHealthRun(flow, { ...job, owner: row.requestedBy.personId });
    },
    async audit(event) {
      await audit.record({
        eventId: `eval.health:${input.companyId}:${event.project}:${event.requestId}:${event.action}`, companyId: input.companyId, at: new Date(input.now()).toISOString(), actor: { type: "system", id: "rovara" },
        action: event.action, subject: { type: "project", id: event.project }, details: { project: event.project, requestId: event.requestId, ...(event.reason === undefined ? {} : { reason: event.reason }) },
      });
    },
  };
}

/** What the setup route calls after it recorded a person's yes: start the run if the request holds. Never throws; the person's answer does not wait on the worker. */
export async function kickEvalHealth(deps: EvalHealthRunDeps, project: string): Promise<EvalHealthStart> {
  try { return await startEvalHealthRun(deps, project); } catch { return { outcome: "nothing" }; }
}
