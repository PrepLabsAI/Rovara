// Lane L9-wire: the wiring. `createLocalApp` joins what the wave-1 lanes built, over the registry `rovara up` made (the lanes know the ports, not each other):
//
//   L3 the storage and queue the registry holds ->  L6a the task flow (start, stage machine, dispatch to the registry's worker machines)
//   L6b sessions (created in the task's own start transaction, kept current by the change feed and a sweep), the approval gate and the cost ledger
//   L8  the local review pages, over a `LocalPageData` made from the task records, and the owner's decisions through the gate
//   the callback endpoints a worker posts to, and the timers that keep the dispatch, the recovery sweep and the outbox relay going.
//
// Decision 51: nothing here names a provider; it asks the registry for `storage`, `queue`, `worker-machines`, `admission`, `audit-sink`, `approvers`, `identity` and `metering`.
// Decision 53: artifacts live in the registry's `object-storage` adapter (lane L9a); a worker's model calls go through the model proxy (lane L9a), which the task flow grants per operation.
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, providerFormat, type AdapterRegistry, type ObjectStorage, type OrgId, type Principal } from "@agentx/contracts";
import { CallbackCapabilities } from "../../callbacks.js";
import { LOCAL_MODEL_PROVIDER_ORDER, chooseLocalModel, type LocalModelChoice, type LocalModelSetting } from "../model-choice.js";
import { capabilityModelGrants, localRoute, readyProviders, registryModelProviderBook, type ModelGrantSource } from "../model-proxy/index.js";
import { createCostLedger, costUsdOf } from "../../core/cost/ledger.js";
import { createDecisionGate, type DecisionGate } from "../../core/decisions/approval-gate.js";
import { createDecisionActions } from "../../core/decisions/local-actions.js";
import { createWorkflowDocumentSubject, currentDocumentType } from "../../core/decisions/workflow-subject.js";
import type { LocalPageSessions } from "../../core/local-pages/guard.js";
import { createLocalPagesServer, type LocalPagesServer } from "../../core/local-pages/server.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { gradePlanRisk } from "../../core/decisions/plan-risk.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { WorkflowArtifactSchema } from "@agentx/contracts";
import { installBranchSyncDeciders } from "../../core/branch-sync/branch-sync.js";
import { installCiFixDecider } from "../../core/ci-fix/ci-fix.js";
import { registerMergeActionDecider } from "../../core/merge/merge-tracking.js";
import { startSessionProjector } from "../../core/sessions/projector.js";
import { sweepOpenSessions } from "../../core/sessions/sweep.js";
import type { SummaryDependencies } from "../../core/sessions/summary.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { createTaskFlowFromRegistry, TASK_FLOW_INDEXES, type TaskFlow } from "../../core/task-flow/flow.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../core/task-flow/keys.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type TaskPointerRecord } from "../../core/task-flow/records.js";
import { isTerminalStatus } from "../../core/task-flow/results.js";
import { planFeedbackKey } from "../../core/task-flow/stage-machine.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { localOwnerPrincipal } from "../../ports/policy-defaults.js";
import { modelKeyReadError, secretsPluginWords } from "../../ports/secret-stores.js";
import { RepositoryGrantService, type RepositoryCredential } from "../../repository-access.js";
import { openInSystemBrowser, type BrowserOpener } from "../open-browser.js";
import { CALLBACK_KEY_FILE_NAME, readOwnerFile, writeOwnerFile } from "../state-directory.js";
import { createCallbackHandler } from "./callbacks.js";
import { createLocalEvidence, type LocalEvidence } from "./evidence.js";
import { createLocalComments, type LocalComments } from "./comments.js";
import { createLocalMilestones, createLocalTracking, sessionTimeline, type LocalTracking } from "./tracking.js";
import { createTaskFactsSource } from "./facts.js";
import { createLocalPageData, createPageExtraActions } from "./page-data.js";
import { createOwnerRoutes } from "./routes.js";
import { createSessionRoutes } from "./session-routes.js";
import { createSessionStartExtras } from "./session-start.js";

export { TASK_FLOW_INDEXES };

/** The id the default identity adapter gives the machine's owner (`localOwnerPrincipal`). */
const LOCAL_OWNER_PERSON_ID = "local-owner";

export interface LocalAppOptions {
  /** Tells the model proxy an operation ended (it frees the operation's tokens and spend record). Set by the runtime, which makes the proxy after the servers. */
  operationEnded?: (operationId: string) => void;
  /** The model a task step calls, fixed by the caller (tests). Absent: `modelSetting`, else the first provider with a key. */
  modelChoice?: LocalModelChoice;
  /** Lane L13: the owner's `model` setting from the config; see `chooseLocalModel` for the order. */
  modelSetting?: LocalModelSetting;
  registry: AdapterRegistry;
  stateDirectory: string;
  pageSessions: LocalPageSessions;
  version: string;
  companyId?: OrgId;
  /** The `worker-machines` adapter's name when several are registered. */
  machinesName?: string;
  /** How a repository credential is made for a worker's grant (the owner's GitHub token, for now). 51 gap: GitHub-specific, from the local runtime. */
  resolveRepositoryCredential?: (credentialRef: string, repositoryUrl: string, access: "clone" | "push") => Promise<RepositoryCredential>;
  /** The address clients reach the owner's routes at (a session's `link` is its own address). Read when asked, so the server may start after the app. */
  origin?: () => string;
  /** Opens an address in the owner's browser (default: the system browser). Tests give a recorder, which then stands for the browser. */
  openBrowser?: BrowserOpener;
  /** Port of the review pages (0: a free one). */
  pagesPort?: number;
  /** The most pull request threads one comment poll reads (default 20): a test lowers it to see the rotation. */
  commentThreadsPerPoll?: number;
  /** Run the timers. Tests pass false and call `tick()`. Default true. */
  timers?: boolean;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface LocalApp {
  readonly flow: TaskFlow;
  readonly pages: LocalPagesServer;
  readonly gate: DecisionGate;
  readonly blobs: ObjectStorage;
  /** Merge tracking on this laptop: the timer's pass over the tracked pull requests (lane L12). */
  readonly tracking: LocalTracking;
  /** The evidence kept for a task's checked code (lane L12): the proof page and the pull request read it. */
  readonly evidence: LocalEvidence;
  /** Pull request comment commands on this laptop: polled, fetched by the code host and checked by the core (lane L12, decision 66). */
  readonly comments: LocalComments;
  /** What a worker's capability entitles it to in the model proxy: the models of this install and no budget held yet (see docs/local.md). */
  readonly modelGrants: ModelGrantSource;
  /** The owner's routes. `undefined` when the path is not one of them. The caller authenticated the principal. */
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  /** The worker's callbacks (`/v1/internal/...`). */
  callbacks(request: BrokerRequest): Promise<BrokerResponse>;
  /** One pass of everything the timers do: relay the outbox, dispatch, sweep the dispatch rows, refresh the sessions, and read the pull requests that are due (merge tracking). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** The key the callback capabilities are signed with: kept in the state folder, so a worker that outlives a restart of `rovara up` still reports to the new process. */
async function loadCallbackKey(stateDirectory: string): Promise<Buffer> {
  const path = join(stateDirectory, CALLBACK_KEY_FILE_NAME);
  const existing = await readOwnerFile(path, { private: true, label: "callback key" });
  if (existing !== undefined) return Buffer.from(existing.text.trim(), "base64url");
  await writeOwnerFile(path, `${randomBytes(32).toString("base64url")}\n`, { exclusive: true });
  const written = await readOwnerFile(path, { private: true, label: "callback key" });
  if (written === undefined) throw new Error("the callback key could not be saved");
  return Buffer.from(written.text.trim(), "base64url");
}

/** A purpose-bound key from the root key: HMAC-SHA256(root, purpose), 32 bytes. */
export function deriveKey(root: Buffer, purpose: string): Buffer {
  return createHmac("sha256", root).update(`rovara-local\0${purpose}`).digest();
}

export async function createLocalApp(options: LocalAppOptions): Promise<LocalApp> {
  const { registry } = options;
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const store = registry.require("storage");
  const log = options.log ?? (() => undefined);
  const owner: Principal = (await registry.require("identity").getPrincipal(companyId, LOCAL_OWNER_PERSON_ID).catch(() => undefined)) ?? localOwnerPrincipal({ companyId });
  // Lane L9a's `object-storage` point: the folder adapter if the config names one, else objects kept as documents.
  const blobs = registry.require("object-storage");

  const rootKey = await loadCallbackKey(options.stateDirectory);
  // Two kinds of token, two keys: a repository grant is not good as a callback capability, nor the other way round (the signature fails first, so a mix-up is a 403).
  const signingKey = deriveKey(rootKey, "callback-capability");
  const grants = new RepositoryGrantService(deriveKey(rootKey, "repository-grant"), options.resolveRepositoryCredential ?? (async () => { throw new Error("no GitHub access is set up: run `gh auth login` or set GH_TOKEN"); }));

  // The model a task step calls: the owner's `model` setting, else the first provider (Anthropic, OpenAI, then OpenRouter) that has a key (`chooseLocalModel`, which `rovara up --check` also asks).
  // No key: no route, and the worker has no model access.
  const keys = registry.require("model-keys");
  // The providers are the `model-provider` plug-ins (item K2); a provider that needs no key or brings its own sign-in (an AWS role) counts as ready without an entry in the key file.
  const providers = registryModelProviderBook(registry);
  const chosen = async (): Promise<LocalModelChoice | undefined> => {
    if (options.modelChoice !== undefined) return options.modelChoice;
    // Only the providers that could be chosen are asked for a credential: the setting's provider, else the default order. A provider that is installed but not chosen (Bedrock, with Anthropic chosen) is never asked.
    const candidates = options.modelSetting === undefined ? LOCAL_MODEL_PROVIDER_ORDER : [options.modelSetting.provider];
    // A `secrets` plug-in's error text is never passed on: Code's own fixed sentences are, anything else becomes a sentence naming the plug-in.
    const ready = await readyProviders(providers, keys, companyId, candidates).catch((error: unknown) => { throw modelKeyReadError(error, secretsPluginWords(registry)); });
    const picked = chooseLocalModel(ready, options.modelSetting, providers);
    return picked.ok ? { provider: picked.provider, model: picked.model, ...(picked.api === undefined ? {} : { api: picked.api }) } : undefined;
  };
  /** The route of the chosen model: the request format the owner named, else the provider's first. */
  const routeOf = (choice: LocalModelChoice) => {
    const row = providers.get(choice.provider);
    const format = row === undefined ? undefined : providerFormat(row, choice.api);
    return localRoute(choice.provider, choice.model, format?.format ?? choice.api);
  };
  const modelRoute = async () => { const choice = await chosen(); return choice === undefined ? undefined : routeOf(choice).workerRoute; };

  const clock = (): Date => options.now?.() ?? new Date();
  // Lane L12: the milestones ("fixing", "stuck", "ready") are rows and lines on the task's session, written in the transaction of the change that caused them.
  const timeline = sessionTimeline();
  const milestones = createLocalMilestones(timeline);

  const ledger = createCostLedger({ store, metering: registry.require("metering"), ...(options.now === undefined ? {} : { now: options.now }) });

  // Lane L12: the evidence of a run whose checks were recorded is kept in the object storage point (the proof page and the pull request read it).
  const evidence = createLocalEvidence({ flow: { store, companyId, log }, blobs });
  const flow = createTaskFlowFromRegistry(registry, {
    companyId,
    projects: createStoreProjectSource(store, companyId),
    repositoryGrants: grants,
    callbackSigningKey: signingKey,
    understandFirst: true,
    ...(options.machinesName === undefined ? {} : { machinesName: options.machinesName }),
    // No code host adapter registered (none is set up on a fresh laptop): a start is not refused for a host nobody knows, and publishing a pull request is simply not offered.
    checkCodeHosts: registry.names("code-host").length > 0,
    modelAccess: { route: modelRoute },
    ...(options.operationEnded === undefined ? {} : { onOperationEnded: options.operationEnded }),
    startExtras: createSessionStartExtras(companyId),
    milestones,
    keepEvidence: (input) => evidence.keepAfterChecks(input),
    // Lane L10: the approved plan is read back for the coding step and the reviewers; Rovara's own fixing reads what the task has cost (nothing priced counts as nothing spent).
    artifacts: blobs,
    taskSpendUsd: async (taskId) => costUsdOf(await ledger.taskCost(companyId, taskId)),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });

  // Lane L12: merge tracking by polling. The publish step enrols a task's tracking row; a timer reads the due rows and calls the core's pass for each (pull request status, CI fix, branch sync, ready for review).
  const tracking = createLocalTracking({ flow: flow.deps, registry, companyId, milestones, timeline, now: () => clock().getTime(), log });

  // Merge tracking's action slots (L7A-3): a failing CI, a conflict and a branch that is behind are decided by the deciders of the code, which ask for a coding run (an IMPLEMENT row) or a merge of the
  // base (a SYNC row). They are installed only here, where the dispatch runner knows both kinds (the build step), and once per process.
  installCiFixDecider(registerMergeActionDecider);
  installBranchSyncDeciders(registerMergeActionDecider);
  // The model proxy asks, per call, what this operation's capability entitles it to. The models are the install's own choice, never the worker's; no budget is held yet (the flow has no
  // run limit before a price table exists, and Code's price table is empty), and the proxy keeps no spend record without one.
  const modelGrants = capabilityModelGrants({
    capabilities: new CallbackCapabilities(signingKey),
    async describe(operation) {
      const choice = await chosen();
      if (choice === undefined) return undefined;
      const pointer = fromDocument<TaskPointerRecord>(await store.get(taskPointerKey(operation.workspaceId)));
      const task = pointer === undefined ? undefined : await readTask(flow.deps, pointer.taskId);
      return { routes: [routeOf(choice).route], ...(task === undefined ? {} : { taskId: task.taskId, projectName: task.project }) };
    },
    async holds(operation) {
      const [record, workspace] = await Promise.all([store.get(operationKey(operation.workspaceId, operation.operationId)), store.get(workspaceKey(operation.workspaceId))]);
      return record !== undefined && typeof record["status"] === "string" && !isTerminalStatus(record["status"]) && record["fence"] === operation.fence && workspace?.["activeOperationId"] === operation.operationId && workspace["fence"] === operation.fence;
    },
  });

  // Sessions: facts over the task records, the cost ledger over the metering seam.
  const summaryDeps: SummaryDependencies = {
    store,
    facts: createTaskFactsSource(flow.deps),
    cost: { async costUsd(company, taskId) { return costUsdOf(await ledger.taskCost(company, taskId)) ?? 0; } },
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  };

  // Decisions: the one gate, over the workflow document of the task. A change request starts planning again with the owner's words (L9-wire writes them where the planner's prompt reads them).
  const gate = createDecisionGate({
    store, approvers: registry.require("approvers"), audit: registry.require("audit-sink"),
    subjects: [createWorkflowDocumentSubject({
      store,
      // The tier of the plan waiting now, read from the plan itself (the files it names, the claims nothing proves): a plan nobody could grade is never graded low, but a plan that names its files
      // and its proof is not high just for being a plan.
      riskOf: async (task, workflow) => {
        const artifact = workflow.artifacts.filter((entry) => entry.type === currentDocumentType(workflow)).at(-1);
        const parsed = artifact === undefined ? undefined : WorkflowArtifactSchema.safeParse(artifact);
        const loaded = parsed?.success === true ? await loadWorkflowDocument(textReaderOf(blobs), parsed.data, {}).catch(() => undefined) : undefined;
        const estimate = (task["runEstimate"] as { highUsd?: unknown } | undefined)?.highUsd;
        return gradePlanRisk({ loaded, workflow, requestText: typeof task["requestText"] === "string" ? task["requestText"] : undefined, ...(typeof estimate === "number" ? { costHighUsd: estimate } : {}) });
      },
      onDecided: ({ taskId, before, after, attempt, at }) => {
        // The plan was approved: coding starts with no one asking, as a row like every automatic step.
        if (after.stage === "IMPLEMENT" && after.state === "READY" && before.stage !== "IMPLEMENT") return [dispatchRowItem(flow.deps, taskId, after.revision, "IMPLEMENT", at)];
        if (after.stage !== "PLAN" || after.state !== "READY" || before.stage === "PLAN") return [];
        const text = (attempt.reason ?? "").trim();
        return [
          ...(text === "" ? [] : [{ kind: "put" as const, item: { ...planFeedbackKey(taskId, after.revision), entityType: "PLAN_FEEDBACK", text, createdAt: at } }]),
          dispatchRowItem(flow.deps, taskId, after.revision, "PLAN", at),
        ];
      },
    })],
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const decisionActions = createDecisionActions({ gate, companyId });
  const comments = createLocalComments({ flow: flow.deps, registry, companyId, owner, decisions: decisionActions, now: () => clock().getTime(), ...(options.commentThreadsPerPoll === undefined ? {} : { threadsPerPoll: options.commentThreadsPerPoll }), pauseUntil: (until) => tracking.pauseUntil(until), paused: () => tracking.pausedUntil(), log });

  const pages = await createLocalPagesServer({
    data: createLocalPageData({ flow: flow.deps, blobs, owner, companyId, evidence, comments }),
    actions: { decidePlan: decisionActions.decidePlan, decideDesign: decisionActions.decideDesign, ...createPageExtraActions({ flow: flow.deps, companyId, owner, comments }) },
    sessions: options.pageSessions,
    ...(options.pagesPort === undefined ? {} : { port: options.pagesPort }),
  });

  const callbackHandler = createCallbackHandler({ flow: flow.deps, blobs, grants });
  const ownerRoutes = createOwnerRoutes({ flow, blobs, openPage: (path) => (options.openBrowser ?? openInSystemBrowser)(pages.onceLink(path, { label: "browser" })), version: options.version });
  const sessionRoutes = createSessionRoutes({ flow, blobs, companyId, origin: options.origin ?? (() => "http://127.0.0.1") });
  const routes = async (request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> => (await sessionRoutes(request, caller)) ?? ownerRoutes(request, caller);

  const projector = await startSessionProjector(summaryDeps).catch((error: unknown) => { log({ event: "local_app.projector_failed", error: error instanceof Error ? error.name : "unknown" }); return undefined; });

  const logFailure = (event: string) => (error: unknown) => log({ event, error: error instanceof Error ? error.name : "unknown" });
  const tickCore = async (): Promise<void> => {
    await flow.relayOnce().catch(logFailure("local_app.relay_failed"));
    await flow.dispatchOnce({ maxMessages: 10 }).catch(logFailure("local_app.dispatch_failed"));
    await flow.sweepOnce().catch(logFailure("local_app.sweep_failed"));
    await sweepOpenSessions(summaryDeps, { budgetMs: 5_000 }).catch(logFailure("local_app.session_sweep_failed"));
  };
  // Reading pull requests asks the code host over the network and may take seconds, so the timer runs it apart from the dispatch (a slow host never holds a step back); a test's `tick()` runs both in order.
  const tickTracking = async (): Promise<void> => {
    await tracking.sweep().catch(logFailure("local_app.tracking_failed"));
    await comments.poll().catch(logFailure("local_app.comments_failed"));
  };
  const tick = async (): Promise<void> => {
    await tickCore();
    await tickTracking();
  };
  const timers: NodeJS.Timeout[] = [];
  if (options.timers !== false) {
    const every = (ms: number, work: () => Promise<void>): void => {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        void work().finally(() => { running = false; });
      }, ms);
      timer.unref();
      timers.push(timer);
    };
    every(2_000, tickCore);
    every(5_000, tickTracking);
  }

  return {
    flow, pages, gate, blobs, tracking, evidence, comments, modelGrants,
    routes: (request, caller) => routes(request, caller),
    callbacks: callbackHandler,
    tick,
    async stop() {
      for (const timer of timers) clearInterval(timer);
      await tracking.idle();
      await projector?.stop();
      await pages.close();
    },
  };
}
