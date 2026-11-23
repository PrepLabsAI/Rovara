// Hosted composition of the existing application-round ports. Required rounds always use these seams.
import { Ec2RuntimeBindingSchema, WEB_API_RUNTIME_PROFILE_ID, projectRevisionKey, type E2ESourceSnapshot, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { createApplicationPlanningContext, type ApplicationPlanningProject } from "../core/e2e/application-planning.js";
import { createApplicationApproval } from "../core/e2e/application-approval.js";
import { createApplicationSelectionReader } from "../core/e2e/application-readiness.js";
import { createApplicationRounds } from "../core/e2e/application-rounds.js";
import { createHostedE2EAuthority } from "../core/e2e/hosted-authority.js";
import { createApplicationResults } from "../core/e2e/application-results.js";
import { createApplicationPublicationFence } from "../core/e2e/publication-fence.js";
import { readProjectReadyE2ERuntimes, runtimeRowReader } from "../core/e2e/runtime-readiness.js";
import { readAccountRegistryEntries } from "../core/e2e/account-registry.js";
import { acceptStep } from "../core/task-flow/stage-machine.js";
import { dispatchRowItem } from "../core/task-flow/dispatch-rows.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import { hostedCreatorAuthority } from "./core-e2e-authority-store.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { ApplicationE2ESeams } from "../core/e2e/application-seams.js";
import type { E2EVerificationDeps } from "../core/e2e/authority.js";

export function wireHostedApplicationE2E(input: { flow: TaskFlowDeps; objects: ObjectStorage; runtimeCatalogId: string;
  documentClient: { send(command: unknown): Promise<unknown> }; stateTableName: string; signInTableName: string | undefined; companyId: OrgId;
  capture?: ((repositoryUrl: string, commit: string) => Promise<E2ESourceSnapshot>) | undefined }) {
  const { flow, objects, runtimeCatalogId } = input;
  const state = { store: flow.store, ...(flow.now === undefined ? {} : { now: flow.now }) };
  const creator = (task: Parameters<typeof hostedCreatorAuthority>[1]) => hostedCreatorAuthority(input, task);
  const reader = createApplicationSelectionReader({ companyId: flow.companyId, state, objects, runtimeCatalogId });
  const verification: E2EVerificationDeps = { state, objects, readTask: (id) => readTask(flow, id),
    authority: createHostedE2EAuthority({ companyId: flow.companyId, state, objects, projects: flow.projects, access: flow.access, creator,
      operationsOf: (task) => workspaceOperations(flow, task.workspaceId),
      currentSelection: async ({ task, intent, artifact }) => {
        if (task.workflow === undefined) return { ok: false, kind: "unevaluable", reason: "the workflow is unavailable" };
        const current = await reader.current({ ...task, workflow: task.workflow }, intent, artifact);
        return { ok: true, selection: current.selection, rows: current.inputs.registeredRuntimes, accountEntries: current.inputs.accountEntries };
      } }), ...(flow.log === undefined ? {} : { log: flow.log }) };
  const rounds = createApplicationRounds({ flow, objects, selection: reader, creator, verification,
    checksRow: (taskId, revision, at) => dispatchRowItem(flow, taskId, revision, "CHECKS", at),
    accept: (step) => acceptStep(flow, step),
    cancelBaseline: async (task, operationId) => { await cancelTask(flow, task.taskId, operationId); },
  });
  const selection: ApplicationE2ESeams["rounds"]["selection"] = async (...args) => {
    const authority = await creator(args[0]);
    if (authority === undefined) throw new Error("the original creator has no current company and project authority");
    const selected = await reader.selection(...args);
    return { ...selected, items: [...selected.items, ...authority.items] };
  };
  const planning = { context: createApplicationPlanningContext({
    project: async (task) => await flow.store.get(projectRevisionKey(flow.companyId, task.project, task.startingRevision)) as unknown as ApplicationPlanningProject | undefined,
    readText: async (key, max) => { const bytes = await objects.get(key, max); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); },
    ...(input.capture === undefined ? {} : { capture: (_task, repositoryUrl, commit) => input.capture!(repositoryUrl, commit) }),
    readyRuntimes: async (task) => {
      const row = await flow.store.get(projectRevisionKey(flow.companyId, task.project, task.startingRevision));
      const binding = Ec2RuntimeBindingSchema.safeParse(row?.["runtimeBinding"]);
      return !binding.success ? [] : readProjectReadyE2ERuntimes({ runtimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, binding: binding.data, now: (flow.now?.() ?? new Date()).getTime(), read: runtimeRowReader(flow.store) });
    },
    accounts: async (task, _snapshot, policy) => (await readAccountRegistryEntries(state, flow.companyId, task.project,
      policy.targets.map((target) => ({ applicationId: target.applicationId, profileId: target.accountProfileId })))).entries,
    now: () => (flow.now?.() ?? new Date()).getTime(),
  }), approve: createApplicationApproval({ ...flow, selection }) };
  flow.e2e = verification;
  const application: ApplicationE2ESeams = { planning, rounds: { ...rounds, selection }, results: createApplicationResults({ ...verification, operations: (task) => workspaceOperations(flow, task.workspaceId) }),
    publication: createApplicationPublicationFence(flow) };
  flow.applicationE2E = application;
  return application;
}
