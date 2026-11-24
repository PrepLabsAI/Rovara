import type { DeveloperTaskView, E2EApplicationPlanIntent, E2EApplicationSelectionRecord, E2EScenarioResults, E2EWorkflowDisplayRef, TransactItem, WorkflowArtifact, WorkflowSnapshot } from "@agentx/contracts";
import type { FeatureE2EPlanningContextResult } from "../../e2e/feature-plan-planning-context.js";
import type { ApplicationAccountsInput } from "../../e2e/application-plan-approval.js";
import type { TaskRecord, OperationRecord } from "../task-flow/records.js";
import type { StepStart } from "../task-flow/stage-machine.js";
import type { E2EVerificationDeps } from "./authority.js";
import type { RoundRecordReaders } from "./callbacks.js";
export type ApplicationTask = TaskRecord & { workflow: WorkflowSnapshot };
export interface ApplicationE2ESeams {
  planning: {
    context(task: ApplicationTask): Promise<FeatureE2EPlanningContextResult | undefined>;
    approve(input: { task: ApplicationTask; before: WorkflowSnapshot; after: WorkflowSnapshot; artifact: WorkflowArtifact; at: string }): Promise<{ workflow: WorkflowSnapshot; items: readonly TransactItem[] }>;
  };
  rounds: {
    selection(task: ApplicationTask, intent: E2EApplicationPlanIntent, artifact: { id: string; sha256: string }, accounts: Pick<ApplicationAccountsInput, "mode" | "pinned">): Promise<{ selection: E2EApplicationSelectionRecord; items: readonly TransactItem[]; baselineWanted: boolean }>;
    runRow(row: { taskId: string; workflowRevision: number }): Promise<StepStart>;
    retry(task: ApplicationTask, input: { requestId: string; actorId: string }): Promise<StepStart>;
    records: RoundRecordReaders;
    verification: E2EVerificationDeps;
  };
  results: {
    read(task: ApplicationTask, actor: "owner" | "viewer"): Promise<{ presentation: NonNullable<DeveloperTaskView["e2ePresentation"]>; scenarioResults?: E2EScenarioResults } | undefined>;
    project(task: ApplicationTask, operation: OperationRecord, status: "SUCCEEDED" | "FAILED"): Promise<E2EWorkflowDisplayRef | undefined>;
    artifact(task: ApplicationTask, sha256: string): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined>;
    notice(task: ApplicationTask, taskPageUrl?: string): Promise<unknown[] | undefined>;
  };
  publication(task: ApplicationTask): Promise<{ mode: "CHECKED_TREE" | "COMMITTED_HEAD"; items: readonly TransactItem[] } | undefined>;
  /**
   * Browser testing: after a task's browser check PASSED and its verdict was recorded, the project's test accounts that are near their 90-day expiry are renewed (the same definition, under the approval in
   * force). Best effort and after the verdict is committed (the verdict's own fence reads the account rows): it never changes a verdict, and a failure is a served fault, not a thrown error.
   */
  accountRenewal?: { afterPassedRound(task: ApplicationTask): Promise<void> };
}
