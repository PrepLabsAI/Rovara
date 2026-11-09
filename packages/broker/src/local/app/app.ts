// Lane L9-wire: the wiring. `createLocalApp` joins what the wave-1 lanes built, over the registry `rovara up` made (the lanes know the ports, not each other):
//
//   L3 the storage and queue the registry holds ->  L6a the task flow (start, stage machine, dispatch to the registry's worker machines)
//   L6b sessions (created in the task's own start transaction, kept current by the change feed and a sweep), the approval gate and the cost ledger
//   L8  the local review pages, over a `LocalPageData` made from the task records, and the owner's decisions through the gate
//   the callback endpoints a worker posts to, and the timers that keep the dispatch, the recovery sweep and the outbox relay going.
//
// Decision 51: nothing here names a provider; it asks the registry for `storage`, `queue`, `worker-machines`, `admission`, `audit-sink`, `approvers`, `identity` and `metering`.
// Decision 53: the object (artifact) store is the one port W0 lacks; lane L9a builds it. TODO(L9a): replace `createDocumentEvidenceBlobStore` below with the registry's `object-storage` adapter.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, type AdapterRegistry, type OrgId, type Principal } from "@agentx/contracts";
import { createCostLedger, costUsdOf } from "../../core/cost/ledger.js";
import { createDecisionGate, type DecisionGate } from "../../core/decisions/approval-gate.js";
import { createDecisionActions } from "../../core/decisions/local-actions.js";
import { createWorkflowDocumentSubject } from "../../core/decisions/workflow-subject.js";
import type { LocalPageSessions } from "../../core/local-pages/guard.js";
import { createLocalPagesServer, type LocalPagesServer } from "../../core/local-pages/server.js";
import { createDocumentEvidenceBlobStore, type EvidenceBlobStore } from "../../core/proof/evidence-blob-store.js";
import { startSessionProjector } from "../../core/sessions/projector.js";
import { sweepOpenSessions } from "../../core/sessions/sweep.js";
import type { SummaryDependencies } from "../../core/sessions/summary.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { createTaskFlowFromRegistry, TASK_FLOW_INDEXES, type TaskFlow } from "../../core/task-flow/flow.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { planFeedbackKey } from "../../core/task-flow/stage-machine.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { localOwnerPrincipal } from "../../ports/policy-defaults.js";
import { RepositoryGrantService, type RepositoryCredential } from "../../repository-access.js";
import { CALLBACK_KEY_FILE_NAME, readOwnerFile, writeOwnerFile } from "../state-directory.js";
import { createCallbackHandler } from "./callbacks.js";
import { createTaskFactsSource } from "./facts.js";
import { createLocalPageData, createPageExtraActions } from "./page-data.js";
import { createOwnerRoutes } from "./routes.js";
import { createSessionRoutes } from "./session-routes.js";
import { createSessionStartExtras } from "./session-start.js";

export { TASK_FLOW_INDEXES };

/** The id the default identity adapter gives the machine's owner (`localOwnerPrincipal`). */
const LOCAL_OWNER_PERSON_ID = "local-owner";

/**
 * Where the worker's model calls go (lane L9a, K1: a local model proxy, so the worker never holds a model key). This is the narrow seam L9-wire codes against; the proxy is not built here.
 * TODO(L9a): K1 fills it. Two things it must settle, found while wiring: the worker asks the broker for a short-lived key with `GET /v1/internal/model-access`, which the callback
 * listener (POST only) and the egress gateway (relays only `/v1/internal/workspaces/<id>/operations/<id>/<action>`) both refuse, so K1 either moves that call under the operation's
 * prefix as a POST or opens one more path in both; and the key it issues must be the proxy's own, never the owner's provider key.
 */
export interface ModelProxyEndpoint {
  /** The proxy's address as a worker sees it (`AGENTX_MODEL_PROXY_URL`). */
  url: string;
}

export interface LocalAppOptions {
  /** TODO(L9a): the local model proxy. Absent: a worker has no model access and its Understand and Plan steps fail with a plain reason. */
  modelProxyEndpoint?: ModelProxyEndpoint;
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
  /** Port of the review pages (0: a free one). */
  pagesPort?: number;
  /** Run the timers. Tests pass false and call `tick()`. Default true. */
  timers?: boolean;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface LocalApp {
  readonly flow: TaskFlow;
  readonly pages: LocalPagesServer;
  readonly gate: DecisionGate;
  readonly blobs: EvidenceBlobStore;
  /** The owner's routes. `undefined` when the path is not one of them. The caller authenticated the principal. */
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  /** The worker's callbacks (`/v1/internal/...`). */
  callbacks(request: BrokerRequest): Promise<BrokerResponse>;
  /** One pass of everything the timers do: relay the outbox, dispatch, sweep the dispatch rows, refresh the sessions. */
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

export async function createLocalApp(options: LocalAppOptions): Promise<LocalApp> {
  const { registry } = options;
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const store = registry.require("storage");
  const log = options.log ?? (() => undefined);
  const owner: Principal = (await registry.require("identity").getPrincipal(companyId, LOCAL_OWNER_PERSON_ID).catch(() => undefined)) ?? localOwnerPrincipal({ companyId });
  // TODO(L9a): the `object-storage` plug-in point. Until it lands, artifacts are kept as documents (the evidence store's own adapter); a plan is small.
  const blobs = createDocumentEvidenceBlobStore(store, { companyId, ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }), retentionDays: { "evidence-std": 180 } });

  const signingKey = await loadCallbackKey(options.stateDirectory);
  const grants = new RepositoryGrantService(signingKey, options.resolveRepositoryCredential ?? (async () => { throw new Error("no GitHub access is set up: run `gh auth login` or set GH_TOKEN"); }));

  const flow = createTaskFlowFromRegistry(registry, {
    companyId,
    projects: createStoreProjectSource(store, companyId),
    repositoryGrants: grants,
    callbackSigningKey: signingKey,
    understandFirst: true,
    ...(options.machinesName === undefined ? {} : { machinesName: options.machinesName }),
    // No code host adapter registered (none is set up on a fresh laptop): a start is not refused for a host nobody knows, and publishing a pull request is simply not offered.
    checkCodeHosts: registry.names("code-host").length > 0,
    ...(options.modelProxyEndpoint === undefined ? {} : { machineEnvironment: { AGENTX_MODEL_PROXY_URL: options.modelProxyEndpoint.url } }),
    startExtras: createSessionStartExtras(companyId),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });

  // Sessions: facts over the task records, the cost ledger over the metering seam.
  const ledger = createCostLedger({ store, metering: registry.require("metering"), ...(options.now === undefined ? {} : { now: options.now }) });
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
      onDecided: ({ taskId, before, after, attempt, at }) => {
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

  const pages = await createLocalPagesServer({
    data: createLocalPageData({ flow: flow.deps, blobs, owner, companyId }),
    actions: { decidePlan: decisionActions.decidePlan, decideDesign: decisionActions.decideDesign, ...createPageExtraActions({ flow: flow.deps, companyId, owner }) },
    sessions: options.pageSessions,
    ...(options.pagesPort === undefined ? {} : { port: options.pagesPort }),
  });

  const callbackHandler = createCallbackHandler({ flow: flow.deps, blobs, grants });
  const ownerRoutes = createOwnerRoutes({ flow, blobs, pages: () => pages, version: options.version });
  const sessionRoutes = createSessionRoutes({ flow, blobs, companyId, origin: options.origin ?? (() => "http://127.0.0.1") });
  const routes = async (request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> => (await sessionRoutes(request, caller)) ?? ownerRoutes(request, caller);

  const projector = await startSessionProjector(summaryDeps).catch((error: unknown) => { log({ event: "local_app.projector_failed", error: error instanceof Error ? error.name : "unknown" }); return undefined; });

  const tick = async (): Promise<void> => {
    await flow.relayOnce().catch((error: unknown) => log({ event: "local_app.relay_failed", error: error instanceof Error ? error.name : "unknown" }));
    await flow.dispatchOnce({ maxMessages: 10 }).catch((error: unknown) => log({ event: "local_app.dispatch_failed", error: error instanceof Error ? error.name : "unknown" }));
    await flow.sweepOnce().catch((error: unknown) => log({ event: "local_app.sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
    await sweepOpenSessions(summaryDeps, { budgetMs: 5_000 }).catch((error: unknown) => log({ event: "local_app.session_sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
  };
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  if (options.timers !== false) {
    timer = setInterval(() => {
      if (running) return;
      running = true;
      void tick().finally(() => { running = false; });
    }, 2_000);
    timer.unref();
  }

  return {
    flow, pages, gate, blobs,
    routes: (request, caller) => routes(request, caller),
    callbacks: callbackHandler,
    tick,
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      await projector?.stop();
      await pages.close();
    },
  };
}
