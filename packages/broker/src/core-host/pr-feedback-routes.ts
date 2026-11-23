// Existing developer API contracts, mounted locally; the hosted HTTP/panel adapter is task 4.
import { AgentXError, WorkflowTransitionError, agentXError } from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { decidePrFeedback, retryPrFeedback } from "../core/pr-feedback/decide.js";
import { keepPrFeedback } from "../core/pr-feedback/keep.js";

// The handler registration is the capability: scoped to this flow in this process,
// never inferred from host mode, company settings or a persisted feature switch.
const servedFlows = new WeakSet<TaskFlowDeps>();
export function servesPrFeedbackDecisions(deps: TaskFlowDeps): boolean {
  return servedFlows.has(deps);
}

const ACTION = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/workflow\/(feedback-decision|feedback-retry|keep-pull-requests)$/u;
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

export function createPrFeedbackRoutes(deps: TaskFlowDeps, view: (caller: TaskCaller, taskId: string) => Promise<Record<string, unknown>>) {
  servedFlows.add(deps);
  return async (request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> => {
    const match = ACTION.exec(request.path.split("?")[0]!);
    if (match === null || request.method !== "POST") return undefined;
    try {
      const result = await act(deps, caller, match[1]!, match[2]!, bodyOf(request));
      return json(200, { task: await view(caller, match[1]!), ...("started" in result ? { started: result.started } : {}) });
    } catch (error) {
      const refusal = error instanceof WorkflowTransitionError ? agentXError("CONFIG_INVALID", error.message) : error;
      if (refusal instanceof AgentXError) return json(refusal.statusCode, { error: { code: refusal.code, message: refusal.message.slice(refusal.code.length + 2) } });
      throw error;
    }
  };
}
