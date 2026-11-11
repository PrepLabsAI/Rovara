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
import { AgentXError as ScriptTokenAgentXError, IMPLICIT_COMPANY_ID, providerFormat, type AdapterRegistry, type Metering, type ObjectStorage, type OrgId, type Principal } from "@agentx/contracts";
import { CallbackCapabilities } from "../../callbacks.js";
import { registryModelPrices } from "../model-prices.js";
import { LOCAL_MODEL_PROVIDER_ORDER, chooseLocalModel, type LocalModelChoice, type LocalModelSetting } from "../model-choice.js";
import { createSecondReview, type SecondReview } from "../../core/second-review/index.js";
import { createLocalSecondReviewSeams } from "./second-review.js";
import { SecondReviewerSchema } from "@agentx/contracts";
import type { ProxyRoute } from "../model-proxy/types.js";
import { OneShotOperations, capabilityModelGrants, localRoute, readyProviders, registryModelProviderBook, withOneShotOperations, type LocalModelProxy, type LoopbackProxy, type ModelGrantSource } from "../model-proxy/index.js";
import { createCostLedger, costUsdOf } from "../../core/cost/ledger.js";
import { estimatePathOf, recordRunCost, runCostInputOf } from "../../core/cost/estimate.js";
import { remainingUsd, taskLimitUsd } from "../../core/cost/limits.js";
import { createModelSelection, type ModelSelectionService } from "../../core/model-selection/service.js";
import { createUsableModels } from "../../core/model-selection/usable-models.js";
import { createLocalModelSelectionSeams } from "./model-selection.js";
import { createDecisionGate, type DecisionGate } from "../../core/decisions/approval-gate.js";
import { createDecisionActions } from "../../core/decisions/local-actions.js";
import { createWorkflowDocumentSubject, currentDocumentType } from "../../core/decisions/workflow-subject.js";
import type { LocalPageSessions } from "../../core/local-pages/guard.js";
import { createLocalPagesServer, type LocalPagesServer } from "../../core/local-pages/server.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { breakdownForApproval } from "../../core/work-breakdown/plan-graph.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { WorkflowArtifactSchema } from "@agentx/contracts";
import { installBranchSyncDeciders } from "../../core/branch-sync/branch-sync.js";
import { installCiFixDecider } from "../../core/ci-fix/ci-fix.js";
import { registerMergeActionDecider } from "../../core/merge/merge-tracking.js";
import { startSessionProjector } from "../../core/sessions/projector.js";
import { createAsk } from "../../core/sessions/ask.js";
import { createAskDiffReader, createPeekClient } from "../../core/sessions/peek.js";
import { settleSteerDeliveriesFor } from "../../core/sessions/steer.js";
import { createLocalAskModel } from "../ask-model.js";
import { createLocalDiagnosisModel } from "../diagnosis-model.js";
import { createLocalDiagnosis, type LocalDiagnosis } from "./diagnosis.js";
import type { ProviderEndpoints } from "../model-proxy/providers.js";
import { sweepOpenSessions } from "../../core/sessions/sweep.js";
import { refreshSessionSummary, type SummaryDependencies } from "../../core/sessions/summary.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { createTaskFlowFromRegistry, TASK_FLOW_INDEXES, type TaskFlow } from "../../core/task-flow/flow.js";
import { createOwnerTaskAccess } from "../../core/task-flow/access.js";
import { createLocalE2EAuthority } from "../../core/e2e/local-authority.js";
import type { RoundRecordReaders } from "../../core/e2e/callbacks.js";
import { readWorkflowE2EBaselineRecord } from "../../core/e2e/baseline.js";
import { readWorkflowE2EReplayRecord } from "../../core/e2e/replay.js";
import { readWorkflowE2EGroundingRecord } from "../../core/e2e/grounding.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../core/task-flow/keys.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { createStandingInstructions } from "../../core/instructions/step-block.js";
import { createCodeHostPlaybookSource } from "../../core/playbook/source.js";
import { createPlaybookService, type PlaybookService } from "../../core/playbook/service.js";
import { readTask, workspaceOperations } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord } from "../../core/task-flow/records.js";
import { isTerminalStatus } from "../../core/task-flow/results.js";
import type { OperationModelChoice } from "../../core/task-flow/step-model.js";
import { planFeedbackKey } from "../../core/task-flow/stage-machine.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { localOwnerPrincipal } from "../../ports/policy-defaults.js";
import { modelKeyReadError, secretsPluginWords } from "../../ports/secret-stores.js";
import { RepositoryGrantService, type RepositoryCredential } from "../../repository-access.js";
import { openInSystemBrowser, type BrowserOpener } from "../open-browser.js";
import { CALLBACK_KEY_FILE_NAME, readOwnerFile, writeOwnerFile } from "../state-directory.js";
import { createCallbackHandler } from "./callbacks.js";
import { attachCitedCode } from "../../core/plan/store.js";
import { loadPlanDocument, planFactsOf } from "../../core/plan/document.js";
import { createLocalEvidence, type LocalEvidence } from "./evidence.js";
import { createLocalComments, type LocalComments } from "./comments.js";
import { createLocalLessons, type LocalLessons } from "./lessons.js";
import { createLessonRoutes } from "./lessons-routes.js";
import { createLocalMilestones, createLocalTracking, sessionTimeline, type LocalTracking } from "./tracking.js";
import type { DocumentMilestones } from "../../core/milestones/milestones.js";
import { createTaskFactsSource } from "./facts.js";
import { createLocalPageData, createPageExtraActions } from "./page-data.js";
import { createOwnerRoutes } from "./routes.js";
import { createLocalTestEnvironment } from "./test-environment.js";
import type { ServiceCatalogSource } from "../../core/test-env/dependency-plan.js";
import { nightlyHooks, subscribeNightly } from "../../core/test-env/nightly-wiring.js";
import { readApprovedTestEnvironment } from "../../core/test-env/environment.js";
import { nightlyRunsOn } from "../../core/test-env/health-switch.js";
import { savedEnvEnabled } from "../../core/test-env/saved-env-switch.js";
import { createSessionRoutes } from "./session-routes.js";
import { createLocalScriptTokens, type LocalScriptTokens } from "./script-tokens.js";
import { createLocalPlaybook } from "./playbook.js";
import { createLocalSetupAgent, setupDecisionSubjects, type LocalSetupAgent } from "./setup-agent.js";
import { createLocalConnections } from "./connections.js";
import type { TaskEndRegistrar } from "../../context-sources/quotes.js";

import { createSessionStartExtras } from "./session-start.js";
import { createLocalDesignReview } from "./design-review.js";
import { checkDesignApproval, designApprovalRecordItems, gradeApprovalRisk } from "../../core/design-review/decision.js";
import { createLocalChat } from "./chat.js";
import { createLocalIntake } from "./intake.js";
import { sessionBindingsOf } from "../../core/sessions/bindings.js";
import { createLocalAutomation, type LocalAutomation } from "./automation.js";
import { fixedAutomationSwitch, type AutomationSwitch } from "../../core/automation/switch.js";
import { createScheduleRouter } from "../../core/automation/schedule-router.js";
import { createChannelSink } from "../../core/channel/sink.js";
import { readTaskThread } from "../../core/channel/threads.js";
import { deliverAttention, queueAttention } from "../../core/notify/attention.js";

export { TASK_FLOW_INDEXES };

/** The line after the list in a notice: the task is opened on the page of the machine Rovara runs on, and the page address carries the owner's session, so it is never put in a chat. */
const ATTENTION_FOOTER = "Open it on the computer where Rovara runs: `rovara open`.";

/** The id the default identity adapter gives the machine's owner (`localOwnerPrincipal`). */
const LOCAL_OWNER_PERSON_ID = "local-owner";

export interface LocalAppOptions {
  /** Tells the model proxy an operation ended (it frees the operation's tokens and spend record). Set by the runtime, which makes the proxy after the servers. */
  operationEnded?: (operationId: string) => void;
  /** What one operation has spent through the model proxy so far in this process (the runtime reads it from the proxy). A re-minted token starts from the task's spend less this, so an operation's own spend is counted once. */
  operationSpend?: (operationId: string) => { micros: number; currency: string | undefined } | undefined;
  /** The model aliases an operation's calls went out on, from the model proxy: a second opinion counts only when its model was really called. Absent: the install cannot tell, and the opinion is taken as reported. */
  modelCalls?: (operationId: string) => ReadonlySet<string> | undefined;
  /** The environment the install runs in (the design review's switch is read from it). */
  environment?: NodeJS.ProcessEnv;
  /** The model proxy's key slots for the design review, read late (the proxy is made after the app). */
  slotKeys?: () => LocalModelProxy["slotKeys"] | undefined;
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
  /** Where each model provider is, for the Ask's own model call (the runtime's `modelProviderEndpoints`; tests point it at a fake provider). */
  modelProviderEndpoints?: Partial<ProviderEndpoints> | undefined;
  /** The transport of the Ask's model call (tests). */
  askFetch?: typeof fetch | undefined;
  /** Whether a message to a running step is handed to the worker as it is sent. The runtime sets it from `ROVARA_LIVE_STEER` (`0` turns it off); default on. */
  liveSteer?: boolean;
  /**
   * Whether the install holds a run limit: each task's model calls are held to the planning allowance plus the run limit its plan carries, on the model proxy, and a model with no price is then not used (the proxy
   * would refuse it). The runtime sets it from `ROVARA_RUN_LIMIT` (`0` turns it off); default on.
   */
  runLimit?: boolean;
  /** Whether the planning, understanding and coding steps read the people's notes. The runtime sets it from `ROVARA_STEP_NOTES` (`0` turns it off); default on. */
  stepNotes?: boolean;
  /** Whether Ask about a task is served. The runtime sets it from `ROVARA_ASK` (`0` turns it off); default on. */
  ask?: boolean;
  /** The model proxy and the loopback port of its listener, read late (the proxy is made after the app): what a diagnosis calls its model through. Absent: no diagnosis can run. */
  modelProxy?: () => LoopbackProxy | undefined;
  /** Whether Fix with agent is served. The runtime sets it from `ROVARA_DIAGNOSIS` (`0` turns it off); default on. */
  diagnosis?: boolean;
  /** Whether lessons are switched on. The runtime gives it from `ROVARA_LESSONS` (on unless exactly `0`); absent: the process environment, read the same way. */
  lessonsEnabled?: () => boolean;
  /** Whether the setup agent is served (`ROVARA_SETUP_AGENT=0` turns it off). The runtime gives it from its environment; default on. */
  setupAgent?: boolean;
  /** The websites this install's machines reach by their own list, so a setup run's ask for one of them is "already allowed". */
  installDomains?: () => readonly string[];
  /** For tests: the fetch under a connection's check, and the check that refuses an address that must not be called. */
  connectionsFetch?: typeof fetch;
  connectionsCheckEndpoint?: (url: string) => Promise<void>;
  connectionsServerPort?: NonNullable<Parameters<typeof createLocalConnections>[0]["serverPort"]>;
  /** Port of the review pages (0: a free one). */
  pagesPort?: number;
  /** The most pull request threads one comment poll reads (default 20): a test lowers it to see the rotation. */
  commentThreadsPerPoll?: number;
  /** The document a planning run is asked to write: a structured plan (the default) or the Markdown plan an older worker takes. */
  planFormat?: "structured" | "markdown";
  /** whether script tokens exist on this install (`ROVARA_SCRIPT_TOKENS=0` turns them off). The runtime gives it from its environment. Default: the process environment. */
  scriptTokensEnabled?: () => boolean;
  /** The signed service catalog a dependency is pinned from (absent: no dependency can be pinned). */
  serviceCatalog?: ServiceCatalogSource | undefined;
  /**
   * Whether automation (chains, triggers, automatic runs, custom agents) is on. OFF unless the owner switched it on when the install started: a boolean, or a switch the host reads on each use. It is never read from a
   * route, a token or a page. Off, nothing of it is mounted, shown or run.
   */
  automation?: boolean | AutomationSwitch;
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
  /** The milestone hook: an adapter (chat, tracker, outbound events) registers a handler that is told each milestone after its commit, and again by the sweep when it failed. */
  readonly milestones: Pick<DocumentMilestones, "register" | "deliverDue">;
  /** The second review by another AI company: its settings, state and the task flow's hooks. */
  readonly secondReview: SecondReview;
  /** Fix with agent: a diagnosis of the error a task shows, answered by the owner's own model through the proxy. */
  readonly diagnosis: LocalDiagnosis;
  /** Lessons: what was learned, the owner's decisions on it, and the pass that reflects on finished tasks. */
  readonly lessons: LocalLessons;
  /** The Metering the model proxy records through: a call of a task goes into the task's cost ledger. */
  readonly meter: Metering;
  /** The model each step uses: the owner's per-step setting, what each step would run on, and the choice made for a step (read on the local page, the API, the CLI and the MCP tool). */
  readonly modelSelection: ModelSelectionService;
  /** What a worker's capability entitles it to in the model proxy: the models of this install and no budget held yet (see docs/local.md). */
  readonly modelGrants: ModelGrantSource;
  /** Script tokens: serving a request that carries one, and the settings the local pages and routes use. */
  readonly scriptTokens: LocalScriptTokens;
  /** How we work: the project's playbook file (read through the code host), its effective view and what a draft would make. */
  readonly playbook: PlaybookService;
  /** The setup agent: its routes, its page and the hosts the owner approved. */
  readonly setupAgent: LocalSetupAgent;
  /** Chains, triggers, automatic runs and custom agents: hidden, off unless the owner switched them on. */
  readonly automation: LocalAutomation;
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

  // What a model costs (its provider's own table, then the catalog): the one lookup the metering port, the second review's cap and the per-step model rule share.
  const modelPrices = registryModelPrices(registry);
  const clock = (): Date => options.now?.() ?? new Date();
  // The model each step uses: the owner's per-step setting on the document store (the hosted layout), what the install can call and what a call costs. A model a call to which was refused (not enabled, or not priced under a
  // limit) is remembered for a while and left out of default choices.
  const usableModels = createUsableModels({ store, now: () => clock().getTime(), onProblem: (event, errorName) => log({ component: "model_selection", event, errorName }) });
  const modelSelection = createModelSelection({
    store, companyId, audit: registry.require("audit-sink"), approvers: registry.require("approvers"), prices: modelPrices, usable: usableModels,
    seams: createLocalModelSelectionSeams({ companyId, providers, keys, chosen }), capApplies: () => options.runLimit !== false, now: () => clock().getTime(),
  });
  // The second review. It asks the install what it can serve (the providers with a key), reaches a model through the same proxy, and keeps its settings and evidence in the document store under Cloud's keys.
  const projectSource = createStoreProjectSource(store, companyId);
  const secondReview = createSecondReview({
    store, companyId, audit: registry.require("audit-sink"), approvers: registry.require("approvers"), admission: registry.require("admission"),
    seams: createLocalSecondReviewSeams({
      companyId, providers, keys, chosen, projects: projectSource, prices: modelPrices,
      // What each step ran on is kept on its operation (the install's rule chose it); a step from before that was kept ran on the install's one model.
      taskModels: async (task) => {
        const record = await readTask(flow.deps, task.taskId);
        const fallback = await chosen();
        const installModel = fallback === undefined ? undefined : { provider: fallback.provider, modelId: fallback.model };
        const operations = record === undefined ? [] : await workspaceOperations(flow.deps, record.workspaceId);
        const builds = operations.filter((operation) => operation.workflowMode === "IMPLEMENT").map((operation) => operation.modelChoice?.model ?? installModel);
        const reviewed = operations.filter((operation) => operation.workflowMode === "REVIEW").at(-1);
        return { builds: builds.length === 0 && installModel !== undefined ? [installModel] : builds, firstReviewer: reviewed === undefined ? installModel : (reviewed.modelChoice?.model ?? installModel) };
      },
    }),
    now: () => clock().getTime(), log,
  });
  // Lane L12: the milestones ("fixing", "stuck", "ready") are rows and lines on the task's session, written in the transaction of the change that caused them.
  const timeline = sessionTimeline();
  // The milestone hook: rows and session lines in the change's transaction, delivered after the commit to the handlers an adapter registered (`app.milestones.register`); none by default.
  const milestones = createLocalMilestones({ store, now: () => clock().getTime(), log: (event, fields) => log({ component: "milestones", event, ...fields }) });

  const ledger = createCostLedger({ store, metering: registry.require("metering"), ...(options.now === undefined ? {} : { now: options.now }) });
  // What the model proxy meters. A call of a task is recorded in the task's cost ledger (the Metering port prices it, the ledger keeps it once), so the ledger is what the task has spent: the next step's budget, the plan page,
  // the cost line and the record the next estimate learns from all read it. A call with no task is recorded by the port alone. A record that fails is tried a few times, as concurrent calls of one task contend on its total.
  const meter: Metering = {
    price: (usage) => ledger.price(usage),
    async record(entry) {
      if (entry.taskId === undefined) return registry.require("metering").record(entry);
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { return await ledger.recordUsage(entry); } catch (error) { last = error; }
      }
      throw last;
    },
  };

  // Lane L12: the evidence of a run whose checks were recorded is kept in the object storage point (the proof page and the pull request read it).
  const evidence = createLocalEvidence({ flow: { store, companyId, log }, blobs });
  // The project's approved test environment: tasks pin it when they start, a coding or verification run is told its plan, and the owner approves a change on a page (the gate decides it).
  // `pages` and `gate` are made below; the module asks for them when it is used, never when it is built.
  const pagesServer: { current?: LocalPagesServer } = {};
  const testEnvironment = createLocalTestEnvironment({
    store, companyId, now: () => clock().getTime(), audit: registry.require("audit-sink"), log,
    gate: () => gate,
    openPage: async (path) => { if (pagesServer.current === undefined) throw new Error("the pages are not up yet"); await (options.openBrowser ?? openInSystemBrowser)(pagesServer.current.onceLink(path, { label: "browser" })); },
    // What this computer does not do yet, said on the page instead of left for the owner to find out.
    extraLines: async () => [
      ...(savedEnvEnabled(options.environment ?? process.env) ? ["Saved environments are on, but no image is built on this computer yet: the worker's Docker access does not allow it. Tasks set up fresh."] : []),
      ...(nightlyRunsOn(options.environment ?? process.env) ? ["The nightly run is scheduled, but this install cannot start the model-free full run yet, so a fire is skipped."] : []),
    ],
    // The nightly schedule follows the approved environment (on and at its time when the nightly is on, gone otherwise); a failure here never undoes the approval.
    onApproved: async (project) => {
      const approved = await readApprovedTestEnvironment({ store, now: () => clock().getTime() }, companyId, project);
      if (approved !== undefined) await nightlyHooks({ scheduling: { scheduler: registry.require("scheduler") } }, options.environment ?? process.env).onApproved(companyId, project, approved);
    },
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.serviceCatalog === undefined ? {} : { serviceCatalog: options.serviceCatalog }),
  });
  // How we work is the repository's `.rovara/playbook.yaml`, read through the code host at the default branch's head (a host nobody registered reads as no file). The company's rules come from the
  // `company-instructions` point. Both are put in front of every step that reads them, at the dispatch (core/instructions).
  const playbook = createPlaybookService({
    companyId, store, audit: registry.require("audit-sink"), projects: projectSource, now: () => options.now?.() ?? new Date(),
    source: createCodeHostPlaybookSource({ companyId, projects: projectSource, codeHosts: registry.names("code-host").length > 0 ? registry : undefined, ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }) }),
  });
  const standingInstructions = createStandingInstructions({
    companyId, playbook, ...(registry.names("company-instructions").length > 0 ? { company: registry.require("company-instructions") } : {}),
  });
  // The browser and API checks: a finished round is verified from what the broker stored, against the owner, the project, the source and the runtime as they are now. This install keeps no runtime
  // registration for a round to stand on (see docs/local.md), so the authority has no `currentSelection` and no round passes; everything else about a round is checked as Cloud checks it.
  const e2e = {
    state: { store, ...(options.now === undefined ? {} : { now: () => options.now!() }) },
    objects: blobs,
    authority: createLocalE2EAuthority({ companyId, state: { store }, objects: blobs, projects: projectSource, access: createOwnerTaskAccess(),
      operationsOf: async (task) => {
        const operations: OperationRecord[] = [];
        let cursor: string | undefined;
        do {
          const page = await store.query({ pk: `WORKSPACE#${task.workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" }, ...(cursor === undefined ? {} : { cursor }) });
          for (const item of page.items) if (item["entityType"] === "OPERATION") operations.push(item as unknown as OperationRecord);
          cursor = page.cursor;
        } while (cursor !== undefined);
        return operations;
      } }),
    readTask: (taskId: string) => readTask({ store }, taskId),
    log: (entry: Record<string, unknown>) => log({ component: "e2e", ...entry }),
  };
  // Connections, context sources and registered MCP servers (the monitoring port's adapters, the secrets socket, the document store). The owner's acts on them are made on a page; a stage reads them through the context tools.
  const taskEndHandlers: Array<(event: { orgId: OrgId; taskId: string }) => Promise<void>> = [];
  const onTaskEnd: TaskEndRegistrar = (handler) => { taskEndHandlers.push(handler); return () => { const at = taskEndHandlers.indexOf(handler); if (at >= 0) taskEndHandlers.splice(at, 1); }; };
  const connections = createLocalConnections({
    registry, store, companyId, owner, stateDirectory: options.stateDirectory, environment: options.environment ?? process.env, now: () => clock().getTime(), log, onTaskEnd,
    ...(options.connectionsFetch === undefined ? {} : { fetch: options.connectionsFetch }), ...(options.connectionsCheckEndpoint === undefined ? {} : { checkEndpoint: options.connectionsCheckEndpoint }),
    ...(options.connectionsServerPort === undefined ? {} : { serverPort: options.connectionsServerPort }),
  });
  const flow = createTaskFlowFromRegistry(registry, {
    companyId,
    testEnvironment: testEnvironment.taskEnvironment,
    contextSources: connections.contextSources,
    taskEnded: async (event) => { for (const handler of [...taskEndHandlers]) await handler(event); },
    projects: projectSource,
    standingInstructions,
    e2e,
    repositoryGrants: grants,
    secondReview,
    callbackSigningKey: signingKey,
    understandFirst: true,
    ...(options.planFormat === undefined ? {} : { planFormat: options.planFormat }),
    // The code a structured plan cites is read after the plan is committed, through the code host of each repository, and attached beside the plan.
    afterPlanStored: (input) => attachCitedCode(flow.deps, blobs, input),
    liveSteer: options.liveSteer ?? true,
    stepNotes: options.stepNotes ?? true,
    ...(options.machinesName === undefined ? {} : { machinesName: options.machinesName }),
    // No code host adapter registered (none is set up on a fresh laptop): a start is not refused for a host nobody knows, and publishing a pull request is simply not offered.
    checkCodeHosts: registry.names("code-host").length > 0,
    modelAccess: { route: modelRoute },
    stepModels: modelSelection,
    usableModels,
    // A closed task's cost (what its model calls cost, from the ledger) is kept for the estimate of the next runs of the project; a run with a call that had no price is marked, and never teaches the estimator.
    onTaskClosed: async (task, closedAt) => {
      const outcome = await recordRunCost({ store }, {
        orgId: companyId, project: task.project, taskId: task.taskId, path: estimatePathOf(task), endedAt: closedAt,
        ...runCostInputOf(await ledger.taskCost(companyId, task.taskId)),
      });
      log({ component: "cost", event: "cost.run_recorded", outcome });
    },
    // Every step runs on the install's one model, so the plan check says the model that wrote the plan checked it.
    installModel: async () => { const choice = await chosen(); return choice === undefined ? undefined : { provider: choice.provider, modelId: choice.model }; },
    ...(options.operationEnded === undefined ? {} : { onOperationEnded: options.operationEnded }),
    ...(options.modelCalls === undefined ? {} : { modelCalls: options.modelCalls }),
    startExtras: createSessionStartExtras(companyId),
    // The ticket a task started from: a pull request's description says which issue it fixes.
    sessionBindings: { read: (orgId, sessionId) => sessionBindingsOf(store, orgId, sessionId) },
    milestones,
    keepEvidence: (input) => evidence.keepAfterChecks(input),
    // Lane L10: the approved plan is read back for the coding step and the reviewers; Rovara's own fixing reads what the task has cost (nothing priced counts as nothing spent).
    artifacts: blobs,
    taskSpendUsd: async (taskId) => costUsdOf(await ledger.taskCost(companyId, taskId)),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });

  // Tickets that ask for work (the project's intake rule, the poll, the owner's list) and the write-back to the ticket a task started from. It registers its milestone handler now, before any milestone is written.
  const intake = createLocalIntake({ registry, flow, companyId, owner, milestones, now: () => clock().getTime(), fenceKey: deriveKey(rootKey, "intake-ticket-fence"), log });

  // The design review stage (a Full task's design is read by fresh reviewers before anyone approves it). It fills `flow.deps.designReview`; with the switch off no task enters it.
  const designReview = createLocalDesignReview({
    flow: flow.deps, blobs, registry, companyId, environment: options.environment ?? {}, chosen, routeOf, provider: (id) => providers.get(id), slotKeys: () => options.slotKeys?.(), timeline,
  });

  // Lane L12: merge tracking by polling. The publish step enrols a task's tracking row; a timer reads the due rows and calls the core's pass for each (pull request status, CI fix, branch sync, ready for review).
  const tracking = createLocalTracking({ flow: flow.deps, registry, companyId, milestones, timeline, now: () => clock().getTime(), log });

  // Merge tracking's action slots (L7A-3): a failing CI, a conflict and a branch that is behind are decided by the deciders of the code, which ask for a coding run (an IMPLEMENT row) or a merge of the
  // base (a SYNC row). They are installed only here, where the dispatch runner knows both kinds (the build step), and once per process.
  installCiFixDecider(registerMergeActionDecider);
  installBranchSyncDeciders(registerMergeActionDecider);
  // The model proxy asks, per call, what this operation's capability entitles it to. The models are the install's own choice, never the worker's; no budget is held yet (the flow has no
  // run limit before a price table exists, and Code's price table is empty), and the proxy keeps no spend record without one.
  // The broker's own one-shot calls (a diagnosis) are live operations of the proxy only while they run; a worker's capability never names one.
  const oneShot = new OneShotOperations();
  const modelGrants = withOneShotOperations(capabilityModelGrants({
    capabilities: new CallbackCapabilities(signingKey),
    ...designReview.slotGrants,
    async describe(operation) {
      // A design review's operation has no key of its own: only its slots get one (`describeSlot`).
      if (await designReview.isDesignReviewOperation(operation)) return undefined;
      const pointer = fromDocument<TaskPointerRecord>(await store.get(taskPointerKey(operation.workspaceId)));
      const task = pointer === undefined ? undefined : await readTask(flow.deps, pointer.taskId);
      // Second review: the models this REVIEW operation may also call are the ones the broker chose for its second reviewer (never the worker's say), each through its own route.
      const operationRecord = await store.get(operationKey(operation.workspaceId, operation.operationId));
      const second = SecondReviewerSchema.safeParse((operationRecord?.["dispatch"] as { payload?: Record<string, unknown> } | undefined)?.payload?.["workflowSecondReviewer"]);
      const caps = (operationRecord?.["secondReviewPlan"] as { caps?: Record<string, ProxyRoute["cap"]> } | undefined)?.caps ?? {};
      // Every extra route carries its own cap (never the first review's route): a second model is called within a limit of its own.
      const extra: ProxyRoute[] = second.success ? second.data.candidates.flatMap((candidate) => (candidate.modelRoute === undefined ? [] : [{ alias: candidate.modelRoute.alias, provider: candidate.model.provider, model: candidate.model.modelId, api: candidate.modelRoute.api, ...(caps[candidate.modelRoute.alias] === undefined ? {} : { cap: caps[candidate.modelRoute.alias] }) }])) : [];
      // The model the install's rule chose for this step (kept on the operation when it was handed to the worker), else the install's one model.
      const stepChoice = (operationRecord as { modelChoice?: OperationModelChoice } | undefined)?.modelChoice;
      let own: ProxyRoute;
      if (stepChoice !== undefined) own = { alias: stepChoice.route.alias, provider: stepChoice.model.provider, model: stepChoice.model.modelId, api: stepChoice.route.api };
      else {
        const choice = await chosen();
        if (choice === undefined) return undefined;
        own = routeOf(choice).route;
      }
      // A held run limit: the proxy is given what is left of the task's limit, so a call that could not fit is refused before it is made (and a model with no price is refused as not priced).
      // A task that cannot be read has nothing to be held to, so nothing is left: the proxy refuses rather than let a call through unheld.
      // The task's spend is what the cost ledger holds, which already includes this operation's own calls: they are counted once, by taking back what the proxy holds for this operation (it keeps counting those itself, and
      // survives a token being made again).
      let budget: { micros: number; currency: string } | undefined;
      if (options.runLimit !== false) {
        const own = options.operationSpend?.(operation.operationId);
        const ownUsd = own === undefined || (own.currency !== undefined && own.currency !== "USD") ? 0 : own.micros / 1_000_000;
        const spent = task === undefined ? undefined : costUsdOf(await ledger.taskCost(companyId, task.taskId));
        budget = { micros: task === undefined ? 0 : Math.round(remainingUsd(taskLimitUsd(task), spent === undefined ? undefined : Math.max(0, spent - ownUsd)) * 1_000_000), currency: "USD" };
      }
      return { routes: [own, ...extra.filter((route) => route.alias !== own.alias)], ...(budget === undefined ? {} : { budget }), ...(task === undefined ? {} : { taskId: task.taskId, projectName: task.project }) };
    },
    async holds(operation) {
      const [record, workspace] = await Promise.all([store.get(operationKey(operation.workspaceId, operation.operationId)), store.get(workspaceKey(operation.workspaceId))]);
      return record !== undefined && typeof record["status"] === "string" && !isTerminalStatus(record["status"]) && record["fence"] === operation.fence && workspace?.["activeOperationId"] === operation.operationId && workspace["fence"] === operation.fence;
    },
  }), oneShot);

  // Sessions: facts over the task records, the cost ledger over the metering seam.
  const summaryDeps: SummaryDependencies = {
    store,
    facts: createTaskFactsSource(flow.deps),
    cost: { async costUsd(company, taskId) { return costUsdOf(await ledger.taskCost(company, taskId)) ?? 0; } },
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
    // A person is told what needs them through the chat adapters the registry holds (`core/notify`); with none, nothing is queued. The row is only a queue entry: it is checked again before anything is sent.
    onChange: [async (change) => { if (registry.names("channel").length > 0) await queueAttention({ store, now: clock, log }, change); }, (change) => intake.onSessionChange(change)],
    // A step that read a message's note settles the message `delivered`; a session that ended closes the ones no step took.
    afterRefresh: (orgId, sessionId) => settleSteerDeliveriesFor({ store, ...(options.now === undefined ? {} : { now: options.now }), log }, orgId, sessionId),
  };

  // Decisions: the one gate, over the workflow document of the task. A change request starts planning again with the owner's words (L9-wire writes them where the planner's prompt reads them).
  const gate = createDecisionGate({
    store, approvers: registry.require("approvers"), audit: registry.require("audit-sink"),
    subjects: [testEnvironment.subject, ...setupDecisionSubjects(flow.deps), createWorkflowDocumentSubject({
      store,
      // The tier of the plan waiting now, read from the plan itself (the files it names, the claims nothing proves): a plan nobody could grade is never graded low, but a plan that names its files
      // and its proof is not high just for being a plan.
      riskOf: async (task, workflow) => {
        const artifact = workflow.artifacts.filter((entry) => entry.type === currentDocumentType(workflow)).at(-1);
        const parsed = artifact === undefined ? undefined : WorkflowArtifactSchema.safeParse(artifact);
        const loaded = parsed?.success === true ? await loadWorkflowDocument(textReaderOf(blobs), parsed.data, {}).catch(() => undefined) : undefined;
        // A design that went through design review is graded from the review's own facts (the areas it touches, the open blockers, how much of the review ran), never lower than the review says.
        const estimate = (task["runEstimate"] as { highUsd?: unknown } | undefined)?.highUsd;
        return gradeApprovalRisk({ loaded, workflow, requestText: typeof task["requestText"] === "string" ? task["requestText"] : undefined, ...(typeof estimate === "number" ? { costHighUsd: estimate } : {}) });
      },
      // The decided plan's own decisions, read from the checked document (the same load the work breakdown uses), so the owner's answers are held to the options it offered.
      planFactsOf: async (_task, _workflow, artifact) => {
        const loaded = await loadPlanDocument(blobs, artifact);
        return loaded.kind === "structured" ? planFactsOf(loaded.plan) : "unreadable";
      },
      // A plan with a work breakdown (spec 059) is approved WITH its graph: every surface that approves binds the graph in the stored document the approval's digest names.
      breakdown: ({ task, workflow, artifactDigest }) => breakdownForApproval(flow.deps, { taskId: String(task["taskId"]), project: String(task["project"]), startingRevision: Number(task["startingRevision"]) }, workflow, artifactDigest),
      // A design with an open blocker is approved only with a one-line reason.
      checkDecision: ({ workflow, attempt }) => checkDesignApproval(workflow, attempt),
      onDecided: ({ taskId, before, after, attempt, at, approver, risk }) => {
        // The plan was approved: coding starts with no one asking, as a row like every automatic step.
        if (after.stage === "IMPLEMENT" && after.state === "READY" && before.stage !== "IMPLEMENT") return [dispatchRowItem(flow.deps, taskId, after.revision, "IMPLEMENT", at)];
        if (after.stage !== "PLAN" || after.state !== "READY" || before.stage === "PLAN") return [];
        // An approved design leaves its approval record under its digest (who, at what tier, the blockers and the reason) for the pull request's Proof section.
        const approval = designApprovalRecordItems({ taskId, before, after, attempt, approverId: approver.personId, approverLabel: approver.displayName ?? approver.personId, risk, at });
        if (approval.length > 0) return [...approval, dispatchRowItem(flow.deps, taskId, after.revision, "PLAN", at)];
        const text = (attempt.reason ?? "").trim();
        return [
          ...(text === "" ? [] : [{ kind: "put" as const, item: { ...planFeedbackKey(taskId, after.revision), entityType: "PLAN_FEEDBACK", text, createdAt: at } }]),
          dispatchRowItem(flow.deps, taskId, after.revision, "PLAN", at),
        ];
      },
    }), designReview.choiceSubject],
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const designPageActions = designReview.pageActions({ gate, owner });
  const decisionActions = createDecisionActions({ gate, companyId });
  // Chat (owner decision 58): the owner's own acts on the chat page, and what an adapter may hand the core. Nothing here approves: see chat.ts.
  const chat = createLocalChat({ registry, flow, store, companyId, owner, now: () => clock().getTime(), gate, log });
  // Lessons: what Rovara learned from finished tasks, loaded into later steps and decided on the owner's page. On unless `ROVARA_LESSONS=0`, in Suggest mode (every lesson waits for the owner); the pages still show what exists.
  const lessonNames = registry.names("learning");
  const lessons = createLocalLessons({
    flow: flow.deps, registry, companyId, owner, blobs, milestones, audit: registry.require("audit-sink"), admission: registry.require("admission"), metering: registry.require("metering"), approvers: registry.require("approvers"), identity: registry.require("identity"),
    model: { choice: chosen, keys, providers, endpoints: options.modelProviderEndpoints, fetch: options.askFetch },
    learning: lessonNames.length === 0 ? undefined : registry.get("learning", lessonNames.find((name) => name !== "local") ?? lessonNames[0]!),
    ...(options.lessonsEnabled === undefined ? {} : { enabled: options.lessonsEnabled }), now: () => clock().getTime(), log,
  });
  flow.deps.learned = (input) => lessons.learnedFor(input);
  flow.deps.lessonsUsed = (task, repositoryId) => lessons.usedInPullRequest(task, repositoryId);
  // The setup agent: a run that sets a project up by running its commands in a sandbox, its journal, the websites it asks for and the owner's use of what it found. Its decisions go through the gate above.
  const setupAgent = createLocalSetupAgent({
    flow: flow.deps, registry, gate, owner, companyId, now: () => clock().getTime(), enabled: options.setupAgent ?? true,
    modelAccessConfigured: async () => (await chosen()) !== undefined,
    ...(options.installDomains === undefined ? {} : { installDomains: options.installDomains }),
  });
  const comments = createLocalComments({ flow: flow.deps, registry, companyId, owner, decisions: decisionActions, lessons, now: () => clock().getTime(), ...(options.commentThreadsPerPoll === undefined ? {} : { threadsPerPoll: options.commentThreadsPerPoll }), pauseUntil: (until) => tracking.pauseUntil(until), paused: () => tracking.pausedUntil(), log });

  // script tokens. The creator is asked of the identity port by Rovara id; the audit steps are the registry's sink's.
  const scriptTokens = createLocalScriptTokens({ store, audit: registry.require("audit-sink"), now: () => clock().getTime(), log, companyId, owner, identity: registry.require("identity"), ...(options.scriptTokensEnabled === undefined ? {} : { enabled: options.scriptTokensEnabled }) });
  // The switch is off: every token made before is ended now, so turning it back on later revives nothing.
  await scriptTokens.revokeAllForSwitchOff().catch((error: unknown) => log({ event: "local_app.script_tokens_switch_off_failed", error: error instanceof Error ? error.name : "unknown" }));
  const howWeWork = createLocalPlaybook({ playbook, store, companyId });
  // Fix with agent: the owner's own model, called through the model proxy (a one-shot operation of its own, capped), for the error a task shows.
  const diagnosis = createLocalDiagnosis({
    flow: flow.deps, registry, companyId, owner, tagKey: deriveKey(rootKey, "diagnosis-tag"), enabled: options.diagnosis ?? true, log, ...(options.now === undefined ? {} : { now: options.now }),
    answerer: createLocalDiagnosisModel({ choice: chosen, providers, proxy: () => options.modelProxy?.(), operations: oneShot }),
  });
  // Automation (hidden): off unless the owner switched it on. Built either way so the switch is read on each use, but while it is off it mounts, shows and runs nothing.
  // The scheduler keeps ONE handler, and the nightly run and schedule triggers both listen to it: they subscribe through one router, which subscribes once and lets each feature ignore the other's fires.
  const scheduleRouter = createScheduleRouter(registry.require("scheduler"));
  const automation = createLocalAutomation({
    store, companyId, owner, flow, projects: projectSource, admission: registry.require("admission"), audit: registry.require("audit-sink"), approvers: registry.require("approvers"),
    automation: typeof options.automation === "object" ? options.automation : fixedAutomationSwitch(options.automation === true), now: () => clock().getTime(), scheduler: scheduleRouter.view, log,
  });
  const pages = await createLocalPagesServer({
    data: {
      ...createLocalPageData({ flow: flow.deps, blobs, owner, companyId, evidence, comments, secondReview, modelSelection, cost: ledger, designReview, diagnosis, lessons }),
      howWeWork: howWeWork.page,
      getConnectionsPage: () => connections.getConnectionsPage(),
      getSourcesPage: (project, discover) => connections.getSourcesPage(project, discover),
      listScriptTokens: async () => (scriptTokens.enabled() ? { tokens: await scriptTokens.list(), projects: await scriptTokens.projects() } : undefined),
      ...testEnvironment.pageData,
      getChatPage: () => chat.view(),
      previewChatLink: (code) => chat.preview(code),
      ...(setupAgent.enabled ? { listSetupProjects: () => setupAgent.page.projects(), getSetupPage: (project: string) => setupAgent.page.view(project) } : {}),
      ...automation.pageData,
    },
    actions: {
      ...chat.actions,
      ...automation.pageActions,
      decidePlan: decisionActions.decidePlan, decideDesign: decisionActions.decideDesign, designChoice: designPageActions.designChoice, designResume: designPageActions.designResume, connectionAction: (input, context) => connections.action(input, context), decideTestEnvironment: (input) => testEnvironment.decideTestEnvironment(input),
      ...createPageExtraActions({ flow: flow.deps, companyId, owner, comments, secondReview, modelSelection, diagnosis, lessons, designAnswers: (input) => designPageActions.answerQuestions(input) }),
      ...(setupAgent.enabled ? {
        setupStart: setupAgent.page.start, setupStop: setupAgent.page.stop, setupCommand: setupAgent.page.command, setupConfirm: setupAgent.page.confirm, setupDiscard: setupAgent.page.discard, setupForgetHost: setupAgent.page.forgetHost,
        setupCheck: setupAgent.page.check, setupDecideHost: setupAgent.page.decideHost, setupDecideProposal: setupAgent.page.decideProposal,
      } : {}),
      async createScriptToken(input) {
        try {
          return { ok: true, created: await scriptTokens.create(input) };
        } catch (error) {
          if (!(error instanceof ScriptTokenAgentXError)) throw error;
          return { ok: false, reason: error.code === "NOT_FOUND" ? "not_found" : error.code === "CONFIG_INVALID" ? "invalid" : "refused", message: error.message.slice(error.code.length + 2) };
        }
      },
      async revokeScriptToken(input) {
        try {
          await scriptTokens.revoke(input.tokenId);
          return { ok: true };
        } catch (error) {
          if (!(error instanceof ScriptTokenAgentXError)) throw error;
          return { ok: false, reason: error.code === "NOT_FOUND" ? "not_found" : "refused", message: error.message.slice(error.code.length + 2) };
        }
      },
    },
    sessions: options.pageSessions,
    ...(options.pagesPort === undefined ? {} : { port: options.pagesPort }),
    // The pages age their sessions by the same clock as everything else (a test that sets the clock sees a page session grow old).
    ...(options.now === undefined ? {} : { now: () => clock().getTime() }),
  });

  pagesServer.current = pages;
  // A worker's reads of its round's admission and its evidence uploads are held to the round's own record (baseline, replay or grounding) or, for a candidate, to the task's current round.
  const roundRecords: RoundRecordReaders = {
    task: (taskId) => readTask({ store }, taskId),
    baseline: async (task) => { const full = await readTask({ store }, task.taskId); return full === undefined ? undefined : readWorkflowE2EBaselineRecord({ store }, full); },
    replay: (taskId, key) => readWorkflowE2EReplayRecord({ store }, taskId, key),
    grounding: (key) => readWorkflowE2EGroundingRecord({ store }, key),
  };
  const callbackHandler = createCallbackHandler({ flow: flow.deps, blobs, grants, e2e: { records: roundRecords }, contextSources: connections.runtime, onEvents: (operation, events) => lessons.onEvents(operation, events), ...(setupAgent.enabled ? { setupAgent: setupAgent.callback } : {}) });
  const ownerRoutes = createOwnerRoutes({ flow, blobs, secondReview, modelSelection, designReview, diagnosis, openPage: (path, openOptions) => (options.openBrowser ?? openInSystemBrowser)(pages.onceLink(path, { label: "browser", ...(openOptions?.fresh === true || path === "/second-review" ? { fresh: true } : {}) })), version: options.version });
  // Ask about a task: the owner's question is answered by one model call with no tools, with the model the install's steps use; the call's usage joins the task's cost.
  const ask = createAsk({
    store, audit: registry.require("audit-sink"), admission: registry.require("admission"), enabled: options.ask ?? true, artifacts: blobs, readers: () => ({ diff: createAskDiffReader({ peek: createPeekClient(flow.deps) }) }), questionHashKey: deriveKey(rootKey, "ask-question"), log,
    answerer: createLocalAskModel({ choice: chosen, keys, companyId, providers, ...(options.modelProviderEndpoints === undefined ? {} : { endpoints: options.modelProviderEndpoints }), ...(options.askFetch === undefined ? {} : { fetch: options.askFetch }) }),
    recordUsage: async ({ taskId, entryId, usage }) => ledger.recordUsage({
      companyId, entryId, at: (options.now?.() ?? new Date()).toISOString(), taskId, usage: { provider: usage.provider, modelId: usage.modelId, tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } },
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const sessionRoutes = createSessionRoutes({ flow, blobs, companyId, secondReview, ask, refresh: (orgId, sessionId) => refreshSessionSummary(summaryDeps, orgId, sessionId), origin: options.origin ?? (() => "http://127.0.0.1") });
  const lessonRoutes = createLessonRoutes({ lessons, flow: flow.deps });
  const routes = async (request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> => (await automation.routes(request)) ?? (await sessionRoutes(request, caller)) ?? (await scriptTokens.routes(request)) ?? (await connections.routes(request, caller)) ?? (await chat.routes(request)) ?? (await setupAgent.routes(request, caller)) ?? (await testEnvironment.routes(request, caller)) ?? (await lessonRoutes(request, caller)) ?? (await intake.routes(request, caller)) ?? (await howWeWork.routes(request)) ?? ownerRoutes(request, caller);

  const projector = await startSessionProjector(summaryDeps).catch((error: unknown) => { log({ event: "local_app.projector_failed", error: error instanceof Error ? error.name : "unknown" }); return undefined; });

  // The second review's track record is kept from the store's change feed (a store without one keeps none; nothing else depends on it).
  const trackIndexer = await secondReview.startTrackIndexer().catch((error: unknown) => { log({ event: "local_app.second_review_track_failed", error: error instanceof Error ? error.name : "unknown" }); return undefined; });

  const logFailure = (event: string) => (error: unknown) => log({ event, error: error instanceof Error ? error.name : "unknown" });
  const tickCore = async (): Promise<void> => {
    await flow.relayOnce().catch(logFailure("local_app.relay_failed"));
    await flow.dispatchOnce({ maxMessages: 10 }).catch(logFailure("local_app.dispatch_failed"));
    await flow.sweepOnce().catch(logFailure("local_app.sweep_failed"));
    await milestones.deliverDue().catch(logFailure("local_app.milestones_failed"));
    await designReview.sweepWaits().catch(logFailure("local_app.design_wait_sweep_failed"));
    await automation.tick().catch(logFailure("local_app.automation_failed"));
    await sweepOpenSessions(summaryDeps, { budgetMs: 5_000 }).catch(logFailure("local_app.session_sweep_failed"));
    // What needs the owner reaches them in their chat, batched (one message at most every few minutes). The sweep of the sessions above is what queues it.
    if (registry.names("channel").length > 0) {
      await deliverAttention({ store, registry, now: () => clock().getTime(), thread: (org, sessionId) => readTaskThread(store, org, sessionId), footer: ATTENTION_FOOTER, log }, { deadlineMs: clock().getTime() + 4_000 }).catch(logFailure("local_app.attention_failed"));
    }
  };
  // Reading pull requests asks the code host over the network and may take seconds, so the timer runs it apart from the dispatch (a slow host never holds a step back); a test's `tick()` runs both in order.
  const tickTracking = async (): Promise<void> => {
    await tracking.sweep().catch(logFailure("local_app.tracking_failed"));
    await comments.poll().catch(logFailure("local_app.comments_failed"));
    // The tickets that ask for work are read through the trackers the registry holds; a source that is not due costs nothing.
    await intake.poll().catch(logFailure("local_app.intake_failed"));
  };
  // What Rovara learns from finished tasks takes model calls that last tens of seconds, so it has its own timer: neither the dispatch nor the pull request reads wait for it.
  const tickLessons = async (): Promise<void> => {
    await lessons.tick().catch(logFailure("local_app.lessons_failed"));
  };
  const tick = async (): Promise<void> => {
    await tickCore();
    await tickTracking();
    await tickLessons();
  };
  // The in-process chat adapters begin to listen. What one hears goes through the sink, which applies the checks of the channel API (bound space, linked person, a card's request); a start that fails
  // (a token the chat does not accept) is reported and leaves the rest of Rovara running.
  const listening: Array<{ name: string; stop(): Promise<void> }> = [];
  for (const name of registry.names("channel")) {
    const adapter = registry.get("channel", name);
    if (adapter?.start === undefined) continue;
    const sink = createChannelSink({
      channel: name, adapter, store, orgId: companyId, now: () => clock().getTime(), work: chat.work(name), log: (entry) => log({ component: "channel", channel: name, ...entry }),
      linkWords: (code) => `Run \`rovara chat\` on the computer where Rovara runs, and paste this code: ${code}. It works once, for ten minutes.`,
    });
    try {
      listening.push({ name, ...(await adapter.start(sink)) });
    } catch (error) {
      console.error(JSON.stringify({ component: "broker", event: "channel.start_failed", channel: name, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  const timers: NodeJS.Timeout[] = [];
  let nightly: { stop(): Promise<void> } | undefined;
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
    // The nightly test run hears of its fires here. Without a way to start a model-free run (this install has none yet), a fire is answered "unavailable" and nothing is charged or claimed.
    await automation.startSchedules();
    const nightlyHeard = subscribeNightly({ scheduler: scheduleRouter.view, deps: testEnvironment.deps, ...(options.environment === undefined ? {} : { env: options.environment }), log: (entry) => log({ component: "nightly", ...entry }) });
    // Subscribed ONCE, after both features added their handlers. Stopping stops the nightly's handler, ours and the scheduler's subscription together.
    const routed = scheduleRouter.start();
    nightly = { stop: async () => { await nightlyHeard.stop(); await routed.stop(); } };
    every(10_000, tickLessons);
  }

  return {
    flow, meter, pages, gate, blobs, tracking, evidence, comments, lessons, modelGrants, secondReview, modelSelection, diagnosis, milestones, scriptTokens, playbook, setupAgent, automation,
    routes: (request, caller) => routes(request, caller),
    callbacks: callbackHandler,
    tick,
    async stop() {
      for (const timer of timers) clearInterval(timer);
      await nightly?.stop();
      await automation.stop().catch(() => undefined);
      for (const one of listening) await one.stop().catch(() => undefined);
      await tracking.idle();
      await projector?.stop();
      await trackIndexer?.stop();
      await pages.close();
    },
  };
}
