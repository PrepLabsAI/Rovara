// Fix with agent on a laptop: the install's answers to the core's seams (`core/diagnosis/service.ts`) from what `rovara up` has: the task flow's records, the session's timeline, the project definitions and the owner's model
// (called THROUGH the local model proxy, `diagnosis-model.ts`). The core knows no provider; this is the one place that joins it to the install. It also draws the task page's part and answers the page's one form.
import { createHmac, randomUUID } from "node:crypto";
import { diagnosisProposalLine, errorRefKey, type AdapterRegistry, type OrgId, type Principal } from "@agentx/contracts";
import type { DiagnosisWords } from "../../core/diagnosis/words.js";
import { createDiagnosis, type Diagnosis, type DiagnosisAnswerer, type DiagnosisCaller } from "../../core/diagnosis/service.js";
import { taskViewErrorRef } from "../../core/diagnosis/error-ref.js";
import type { DiagnosisContextPorts, DiagnosisTaskView } from "../../core/diagnosis/context.js";
import { CODE_LOCAL_SETTINGS } from "../../core/merge/defaults.js";
import type { LocalActionResult, PlanDiagnosisView } from "../../core/local-pages/views.js";
import { readSessionEvents } from "../../core/sessions/read.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { loadOwnedTask, taskViewOf } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

/** The status words of a session's timeline that a diagnosis reads as the step's status lines. The people's own comments and messages are left out (they are not Rovara's words). */
const STATUS_EVENT_TYPES = new Set(["started", "status", "step", "stopped", "retried", "ended"]);
const EVENTS_MAX = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface LocalDiagnosisOptions {
  flow: TaskFlowDeps;
  registry: Pick<AdapterRegistry, "require">;
  companyId: OrgId;
  owner: Principal;
  /** The root key of the install, for the tags a diagnosis's data is framed with. */
  tagKey: Buffer;
  answerer: DiagnosisAnswerer;
  enabled: boolean;
  /** Other words than a laptop's (see `DiagnosisWords`). Absent: the laptop's. */
  words?: DiagnosisWords | undefined;
  now?: (() => Date) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LocalDiagnosis {
  readonly core: Diagnosis;
  /** The task page's part: the button, the words, or the diagnosis. Undefined when the task shows no error or the feature is off. */
  pageView(taskId: string): Promise<PlanDiagnosisView | undefined>;
  /** The page's one form: the owner presses "Fix with agent". */
  diagnose(input: { taskId: string; requestId: string; errorKey: string }): Promise<LocalActionResult>;
}

export function createLocalDiagnosis(options: LocalDiagnosisOptions): LocalDiagnosis {
  const { flow, owner, companyId } = options;
  const log = options.log ?? (() => undefined);
  const caller: DiagnosisCaller = { principal: owner };

  /** The task the owner may drive (the flow's own check); a task of someone else, or one that is not there, is not the owner's to diagnose. */
  const taskOf = async (principal: Principal, taskId: string): Promise<TaskRecord | undefined> => loadOwnedTask(flow, { principal }, taskId).catch(() => undefined);

  const context: DiagnosisContextPorts = {
    tagKey: createHmac("sha256", options.tagKey).update("rovara-local\0diagnosis-tag").digest("hex"),
    async taskView(task): Promise<DiagnosisTaskView> {
      const view = await taskViewOf(flow, task);
      const workflow = view.workflow;
      const failedOperation = [...view.operations].reverse().find((operation) => (operation.status === "FAILED" || operation.status === "INTERRUPTED") && UUID.test(operation.id));
      const errorRef = taskViewErrorRef({
        taskId: task.taskId, status: view.status, workflow, failure: view.failure, operationId: failedOperation?.id, creatorRemoved: false, at: task.updatedAt,
      });
      const events = task.sessionId === undefined ? [] : (await readSessionEvents(flow.store, companyId, task.sessionId).catch(() => ({ events: [] }))).events
        .filter((event) => STATUS_EVENT_TYPES.has(event.type)).slice(-EVENTS_MAX).map((event) => ({ at: event.at, kind: "status", text: event.text }));
      return {
        title: view.title, status: view.status, ...(errorRef === undefined ? {} : { errorRef }),
        workflow: { stage: workflow?.stage, state: workflow?.state, blockReason: workflow?.blockReason, verification: task.workflow?.verification },
        ...(view.failure === undefined ? {} : { failure: { category: view.failure.category, ...(view.failure.stage === undefined ? {} : { stage: view.failure.stage }), message: view.failure.message } }),
        events,
      };
    },
    async projectFacts(_orgId, project) {
      // A laptop's code settings are fixed (`CODE_LOCAL_SETTINGS`): no merge method, review count or approval rule is a setting the owner changes through Rovara, and no dev container runs locally.
      const revision = await flow.projects.latest(project);
      if (revision === undefined) return undefined;
      return {
        name: project, mergeMethod: CODE_LOCAL_SETTINGS.mergeMethod, allowSelfApproval: CODE_LOCAL_SETTINGS.allowSelfApproval, reviewers: CODE_LOCAL_SETTINGS.codeReviewers.length,
        repositories: revision.definition.repositories.map((repository) => repository.name), allowedWebsites: revision.definition.network?.allowedDomains.length ?? 0,
      };
    },
  };

  const core = createDiagnosis({
    store: flow.store, audit: options.registry.require("audit-sink"), companyId, enabled: options.enabled, admission: options.registry.require("admission"),
    answerer: options.answerer, context, taskOf, ...(options.words === undefined ? {} : { words: options.words }), ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }), log,
  });

  return {
    core,
    async pageView(taskId) {
      const read = await core.forTask(owner, taskId).catch(() => undefined);
      if (read === undefined || read.errorRef === undefined) return undefined;
      const diagnosis = read.diagnosis;
      const view: PlanDiagnosisView = {};
      if (diagnosis?.state === "queued") view.state = "waiting";
      else if (diagnosis?.state === "failed") { view.state = "failed"; if (diagnosis.failure !== undefined) view.failure = diagnosis.failure; }
      else if (diagnosis?.state === "ready") {
        view.state = "ready";
        view.lines = (diagnosis.proposals ?? []).map((proposal) => diagnosisProposalLine(proposal));
        if (diagnosis.needsCode === true) view.needsCode = true;
      }
      if (read.offered) view.offer = { requestId: randomUUID(), errorKey: errorRefKey(read.errorRef) };
      else if (read.why !== undefined) view.why = read.why;
      return view;
    },
    async diagnose(input): Promise<LocalActionResult> {
      try {
        await core.startForTask(caller.principal, input.taskId, { requestId: input.requestId, errorKey: input.errorKey });
        return { ok: true, message: "Fix with agent is looking into this error." };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
        const message = error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : core.words.refusals.couldNot;
        return { ok: false, reason: code === "CONFIG_INVALID" ? "stale" : code === "NOT_FOUND" ? "not_found" : "refused", message };
      }
    },
  };
}
