// Existing developer feedback contracts, shared by the laptop and hosted broker.
import { AgentXError, WorkflowTransitionError, agentXError } from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { readPrFeedbackView } from "./pr-feedback-view.js";
import { committedResponse } from "../core/task-flow/committed-response.js";
import { auditViaCaller } from "../core/audit-read/index.js";
import { decidePrFeedback, retryPrFeedback } from "../core/pr-feedback/decide.js";
import { keepPrFeedback } from "../core/pr-feedback/keep.js";

// The handler registration is the capability: scoped to this flow in this process,
// never inferred from host mode, company settings or a persisted feature switch.
const servedFlows = new WeakSet<TaskFlowDeps>();
export function servesPrFeedbackDecisions(deps: TaskFlowDeps): boolean {
  return servedFlows.has(deps);
}

export function propagatePrFeedbackDecisions(base: TaskFlowDeps, derived: TaskFlowDeps): void {
  if (servesPrFeedbackDecisions(base)) servedFlows.add(derived);
}

type FeedbackView = (caller: TaskCaller, taskId: string) => Promise<Record<string, unknown>>;
const hostedRoutes = new WeakMap<TaskFlowDeps, ReturnType<typeof createPrFeedbackRoutes>>();
/** Composed before scheduled services, with every hosted authority and paid-work seam present. */
export function composeHostedPrFeedbackRoutes(deps: TaskFlowDeps): void {
  if (deps.access?.ownerActing === undefined || deps.taskCapUsd === undefined || deps.taskSpendUsd === undefined
    || deps.feedbackArtifacts === undefined || deps.codeHosts === undefined) return;
  hostedRoutes.set(deps, createPrFeedbackRoutes(deps, async () => { throw new Error("hosted feedback needs its request task view"); }));
}
export function hostedPrFeedbackRoutes(deps: TaskFlowDeps) { return hostedRoutes.get(deps); }

const READ = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/workflow\/feedback$/u;
const ACTION = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/workflow\/(feedback-decision|feedback-retry|keep-pull-requests)$/u;
export function isPrFeedbackPath(path: string, method: string): boolean {
  return method === "GET" && READ.test(path) || method === "POST" && ACTION.test(path);
}
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
function bodyOf(request: BrokerRequest): unknown {
  try { return JSON.parse(request.body ?? "{}"); }
  catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

async function act(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, action: string, body: unknown) {
  if (action === "feedback-retry") return retryPrFeedback(deps, caller, taskId, body);
  if (action === "feedback-decision") return { task: await decidePrFeedback(deps, caller, taskId, body) };
  return { task: await keepPrFeedback(deps, caller, taskId, body) };
}

export function createPrFeedbackRoutes(deps: TaskFlowDeps, view: FeedbackView) {
  servedFlows.add(deps);
  // `via`: the caller word the engine audit names (DEC 254zzz334 "made via tool": the same `details.via` a plan approval from a tool carries). Absent: the sink as it is (a browser session, the laptop).
  return async (request: BrokerRequest, caller: TaskCaller, requestView: FeedbackView = view, via?: string): Promise<BrokerResponse | undefined> => {
    const path = request.path.split("?")[0]!;
    if (!isPrFeedbackPath(path, request.method)) return undefined;
    const match = (request.method === "GET" ? READ : ACTION).exec(path)!;
    const refuse = (error: unknown): BrokerResponse => {
      const refusal = error instanceof WorkflowTransitionError ? agentXError("CONFIG_INVALID", error.message) : error;
      if (refusal instanceof AgentXError) return json(refusal.statusCode, { error: { code: refusal.code, message: refusal.message.slice(refusal.code.length + 2) } });
      throw error;
    };
    let result: Awaited<ReturnType<typeof act>>;
    try {
      if (request.method === "GET") return json(200, { review: await readPrFeedbackView(deps, caller, match[1]!) });
      result = await act(via === undefined ? deps : { ...deps, audit: auditViaCaller(deps.audit, via) }, caller, match[1]!, match[2]!, bodyOf(request));
    } catch (error) {
      return refuse(error);
    }
    // The move has committed (or replayed): a failed response read must never read as a refused write (the Cloud card unlocks on refusals), so it answers COMMITTED_REFRESH_NEEDED.
    try {
      const task = await committedResponse(() => requestView(caller, match[1]!));
      return json(200, { task, ...("started" in result ? { started: result.started } : {}) });
    } catch (error) {
      return refuse(error);
    }
  };
}
