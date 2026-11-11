// A stage's context tools on a laptop: `GET /v1/internal/context-tools` and `POST /v1/internal/context-tools/call`, the two routes a running Understand, Plan, Plan-check or Review stage reaches
// the project's read-only sources through. Built on the task flow's ports, in the way `design-review/packet-route.ts` is:
//   - the callback capability must name the `context-tools` action (a purpose of its own; a `model-access` capability alone is refused);
//   - the worker's own egress gateway stamps the workspace the call comes from, and a capability is good only for its own workspace's worker;
//   - the operation must exist in this company, carry the capability's fence, not be over, and be the workspace's active one; its task must belong to the same workspace;
//   - what a stage may use, and every check before a source is asked, is `context-sources/routes.ts`. Nothing the worker sends decides any of it.
import { agentXError } from "@agentx/contracts";
import type { CallbackCapabilities } from "../../callbacks.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { boundedSink, droppingSink, emptySearch, type TeamRecordSink } from "../../context-sources/team-record.js";
import type { ContextSourcesRuntime } from "../../context-sources/runtime.js";
import { callContextTool, listContextTools, type ContextToolsDependencies, type ContextToolsRun } from "../../context-sources/routes.js";
import { documentContextSourceStore } from "../../context-sources/store.js";
import { documentUsageStore } from "../../context-sources/usage.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord, type WorkspaceRecord } from "../../core/task-flow/records.js";
import { isTerminalStatus } from "../../core/task-flow/results.js";
import { workspaceKey } from "../../core/task-flow/keys.js";

export const CONTEXT_TOOLS_PATH = "/v1/internal/context-tools";
export const CONTEXT_TOOLS_CALL_PATH = "/v1/internal/context-tools/call";
const CAPABILITY_HEADER = "x-agentx-callback-capability";
const WORKSPACE_HEADER = "x-rovara-workspace";
/** The one text every refusal about the operation carries: it says nothing of which check failed. */
const REFUSED = "this operation cannot use context tools";

/** The empty answer of an install with no sources set up. */
const NO_SOURCES = { sources: [], tools: [], searchTeamKnowledge: false, unavailable: [], disabled: [] } as const;

/** One bounded queue to the Team record per install runtime, kept across requests so that its limit means something. */
const sinks = new WeakMap<ContextSourcesRuntime, TeamRecordSink>();
function sinkOf(runtime: ContextSourcesRuntime, log: TaskFlowDeps["log"]): TeamRecordSink {
  let sink = sinks.get(runtime);
  if (sink === undefined) {
    sink = boundedSink(runtime.teamSink ?? droppingSink, { onDrop: (orgId, reason, total) => log?.({ component: "broker", event: "context_source.team_sink_dropped", orgId, reason, total }) });
    sinks.set(runtime, sink);
  }
  return sink;
}

/** The dependencies of the context-tool routes, from the task flow's store and what the install supplied. */
export function contextToolsDependencies(flow: Pick<TaskFlowDeps, "store" | "log">, runtime: ContextSourcesRuntime, now: () => number = Date.now): ContextToolsDependencies {
  const table = { store: flow.store, now };
  const sources = documentContextSourceStore(table);
  return {
    now,
    requireAuthority: runtime.requireAuthority,
    sources: (orgId, project) => sources.readDocument(orgId, project),
    servers: runtime.servers,
    usage: documentUsageStore(table),
    teamSink: sinkOf(runtime, flow.log),
    teamSearch: runtime.teamSearch ?? emptySearch,
    teamRecordAvailable: runtime.teamRecordAvailable === true,
    citations: runtime.citations,
    results: runtime.results,
    standingOf: runtime.standingOf,
    callTimeoutMs: runtime.callTimeoutMs,
    log: (event, fields) => flow.log?.({ component: "broker", event, ...fields }),
  };
}

export async function handleContextTools(
  flow: TaskFlowDeps, capabilities: Pick<CallbackCapabilities, "verify">, runtime: ContextSourcesRuntime | undefined, request: BrokerRequest, kind: "list" | "call",
): Promise<BrokerResponse> {
  const token = request.headers[CAPABILITY_HEADER];
  if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  const claims = (() => { try { return capabilities.verify(token, "context-tools"); } catch { throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability"); } })();
  // The worker's own egress gateway stamps the workspace the call comes from: a capability is good only for its own workspace's worker.
  if (request.headers[WORKSPACE_HEADER] !== claims.workspaceId) throw agentXError("CALLBACK_FORBIDDEN", REFUSED);
  const operation = fromDocument<OperationRecord>(await flow.store.get(operationKey(claims.workspaceId, claims.operationId)));
  if (operation === undefined || operation.companyId !== flow.companyId) throw agentXError("CALLBACK_FORBIDDEN", REFUSED);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED") throw agentXError("STALE_FENCE", "a finished or stopped step cannot use context tools");
  const workspace = fromDocument<WorkspaceRecord>(await flow.store.get(workspaceKey(operation.workspaceId)));
  if (workspace === undefined || workspace.activeOperationId !== operation.id) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const pointer = fromDocument<TaskPointerRecord>(await flow.store.get(taskPointerKey(operation.workspaceId)));
  const task = pointer === undefined ? undefined : await readTask(flow, pointer.taskId);
  if (task === undefined || task.companyId !== flow.companyId || task.workspaceId !== workspace.id) throw agentXError("NOT_FOUND", "no task belongs to this operation");
  const orgId = flow.companyId;
  const run: ContextToolsRun = { orgId, task: { taskId: task.taskId, project: task.project }, operation: { id: operation.id, workflowMode: operation.workflowMode } };
  const answer = (value: unknown): BrokerResponse => ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
  if (runtime === undefined) return answer(kind === "list" ? NO_SOURCES : { status: "REFUSED" as const, text: "Sources are not set up on this install." });
  const deps = contextToolsDependencies(flow, runtime, () => (flow.now?.() ?? new Date()).getTime());
  if (kind === "list") return answer(await listContextTools(deps, run));
  let body: unknown;
  try { body = request.body === undefined || request.body === "" ? {} : JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  return answer(await callContextTool(deps, run, body));
}
