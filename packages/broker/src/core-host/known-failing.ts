import { wholeTaskSpendUsd, type ObjectStorage } from "@agentx/contracts";
import { createKnownFailing, verificationResultsEnabled } from "../core/test-env/known-failing.js";
import { loadEvidencePack } from "../core/proof/evidence-keep.js";
import { alreadyFailingForResults } from "../core/proof/verification-result.js";
import { testingViewOf } from "../core/proof/testing-section.js";
import { readTask } from "../core/task-flow/reads.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { DeployedPeople } from "./deployed-decisions.js";
import { liveGrant, liveMemberRole } from "./deployed-decisions.js";

/** One company's live role rule and evidence reader, reused by cards and the project read/Undo route. */
export function hostedKnownFailing(input: { flow: TaskFlowDeps; blobs: ObjectStorage; people: DeployedPeople; env?: NodeJS.ProcessEnv }) {
  const { flow, blobs, people } = input;
  return createKnownFailing({ store: flow.store, audit: flow.audit, now: () => (flow.now?.() ?? new Date()).getTime(), env: input.env ?? process.env,
    mayMaintain: async (principal, project) => {
      const role = await liveMemberRole(people, flow.companyId, principal.personId);
      return role === "owner" || role === "admin" || (role === "member" && await liveGrant(people, principal.personId, project) === "administrator");
    },
    workflowOf: async (company, project, taskId) => {
      const task = await readTask(flow, taskId);
      return task?.companyId === company && task.project === project ? task.workflow : undefined;
    },
    evidenceOf: async (company, project, taskId, digest) => {
      const task = await readTask(flow, taskId);
      if (task === undefined || task.companyId !== company || task.project !== project || task.workflow?.candidate?.digest !== digest || task.workflow.state !== "BLOCKED" || task.workflow.verification?.candidateDigest !== digest || !task.workflow.verification.results.some((result) => result.status === "FAILED")) return undefined;
      return loadEvidencePack(blobs, task, digest);
    },
  });
}

/** The task GET's production caller of the storage-backed already-failing reader and classifier. */
export async function hostedTestingView(flow: TaskFlowDeps, blobs: ObjectStorage, task: TaskRecord, env: NodeJS.ProcessEnv = process.env) {
  if (!verificationResultsEnabled(env) || task.companyId !== flow.companyId || task.workflow === undefined) return undefined;
  const workflow = task.workflow;
  const evidence = await loadEvidencePack(blobs, task, workflow.candidate?.digest);
  const alreadyFailing = await alreadyFailingForResults({ store: flow.store, now: () => (flow.now?.() ?? new Date()).getTime(), env }, { companyId: flow.companyId, project: task.project, taskId: task.taskId });
  const facts = { checkOriginal: Object.fromEntries((evidence?.checks ?? []).filter((check) => check.class === "already_failing").map((check) => [check.checkId, "failed" as const])) };
  const result = testingViewOf({ workflow, evidence, alreadyFailing, facts, budget: { enabled: false, dayBudgetHasRoom: true, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: 0 } } });
  return result.view;
}


/** A task read also observes broker-classified environment blocks that produced no usable report. */
export async function observeHostedBlockedTask(flow: TaskFlowDeps, task: TaskRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!verificationResultsEnabled(env) || task.companyId !== flow.companyId || task.workflow === undefined) return;
  await createKnownFailing({ store: flow.store, now: () => (flow.now?.() ?? new Date()).getTime(), env, audit: flow.audit, mayMaintain: async () => false, evidenceOf: async () => undefined }).observeBlocked({ companyId: flow.companyId, project: task.project, taskId: task.taskId, workflow: task.workflow });
}
