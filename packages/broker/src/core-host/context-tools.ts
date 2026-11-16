// Team-record-only context on the core. Verify before routing reads; the workspace owns the company.
// Configured MCP sources have no connection/secret ports here and are deliberately not opened.
import { z } from "zod";
import { ContextToolCallRequestSchema, OrgIdSchema, SEARCH_TEAM_KNOWLEDGE_TOOL, isContextSourceStage, type ContextSource, type OrgId } from "@agentx/contracts";
import type { CallbackCapabilities } from "../callbacks.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { CONTEXT_TOOLS_PATH, CONTEXT_TOOLS_CALL_PATH, GATEWAY_MCP_PATH } from "../services/context-tools.js";
import { frameResult, inertSentence } from "../context-sources/present.js";
import { TEAM_SEARCH_LIMIT_MAX, type TeamRecordSearch } from "../context-sources/team-record.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { operationKey, taskPointerKey, workspaceKey } from "../core/task-flow/keys.js";
import { readTask } from "../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord, type WorkspaceRecord } from "../core/task-flow/records.js";
import { withinTaskTokenDeadline } from "../core/model-gateway/deadline.js";

const REFUSED = "this operation cannot use context tools";
const NOT_YET = "not on the core yet";
const MAX_REQUEST_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const fail = (): never => { throw new Error(REFUSED); };
const answer = (value: unknown, statusCode = 200): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const refuse = (text = REFUSED) => answer({ status: "REFUSED", text }, 403);
const SearchArguments = z.object({ query: z.string().trim().min(1).max(300), sources: z.array(z.literal("team-record")).max(1).optional() }).strict();
const Hit = z.object({ title: z.string().max(200), system: z.literal("team-record"), itemRef: z.string().max(200), snippet: z.string().max(280).optional() });

export interface CoreContextToolsPorts {
  capabilities: Pick<CallbackCapabilities, "verify">;
  ownerOfWorkspace(workspaceId: string): Promise<"core" | "workflow">;
  companyOfWorkspace(workspaceId: string): Promise<OrgId | undefined>;
  runtimeFor(companyId: OrgId): Promise<{ flow: TaskFlowDeps; teamSearch: TeamRecordSearch | undefined }>;
}

/** All reads and search share the existing 30-second callback deadline. A late read cannot begin the next step. */
export async function handleCoreContextTools(request: BrokerRequest, ports: CoreContextToolsPorts): Promise<BrokerResponse | undefined> {
  const path = request.path.split("?")[0];
  if (path !== CONTEXT_TOOLS_PATH && path !== CONTEXT_TOOLS_CALL_PATH && path !== GATEWAY_MCP_PATH) return undefined;
  try {
    return await withinTaskTokenDeadline(async (deadline) => {
      const token = path === GATEWAY_MCP_PATH ? /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/u.exec(request.headers.authorization ?? "")?.[1] : request.headers["x-agentx-callback-capability"];
      if (typeof token !== "string" || token.length === 0 || token.length > 4096) return refuse();
      const claims = ports.capabilities.verify(token, "context-tools");
      // Validate signed fields too: signing is not a substitute for a readable capability.
      if (!UUID.test(claims.workspaceId) || !UUID.test(claims.operationId) || !Number.isSafeInteger(claims.fence) || claims.fence < 1
        || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= Math.floor(Date.now() / 1000)
        || request.headers["x-rovara-workspace"] !== claims.workspaceId) return refuse();
      deadline.check();
      if ((path === CONTEXT_TOOLS_PATH ? request.method !== "GET" : request.method !== "POST") || (request.body?.length ?? 0) > MAX_REQUEST_BYTES
        || Buffer.byteLength(request.body ?? "") > MAX_REQUEST_BYTES) return refuse();
      if (await ports.ownerOfWorkspace(claims.workspaceId) !== "core") return undefined;
      deadline.check();
      const companyId = await ports.companyOfWorkspace(claims.workspaceId);
      deadline.check();
      if (!OrgIdSchema.safeParse(companyId).success) return refuse();
      const { flow, teamSearch } = await ports.runtimeFor(companyId!);
      deadline.check();
      if (flow.companyId !== companyId) return refuse();
      const workspace = fromDocument<WorkspaceRecord>(await flow.store.get(workspaceKey(claims.workspaceId)));
      deadline.check();
      if (workspace === undefined || workspace.id !== claims.workspaceId || workspace.companyId !== companyId
        || (workspace.orgId !== undefined && workspace.orgId !== companyId) || workspace.activeOperationId !== claims.operationId || workspace.fence !== claims.fence) return refuse();
      const operation = fromDocument<OperationRecord>(await flow.store.get(operationKey(claims.workspaceId, claims.operationId)));
      deadline.check();
      if (operation === undefined || operation.id !== claims.operationId || operation.workspaceId !== claims.workspaceId || operation.companyId !== companyId
        || operation.fence !== claims.fence || !["ACCEPTED", "DISPATCHING", "RUNNING"].includes(operation.status) || !isContextSourceStage(operation.workflowMode)) return refuse();
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get(taskPointerKey(claims.workspaceId)));
      deadline.check();
      if (pointer === undefined || typeof pointer.taskId !== "string" || !UUID.test(pointer.taskId)) return refuse();
      const task = await readTask(flow, pointer.taskId);
      deadline.check();
      if (task === undefined || task.taskId !== pointer.taskId || task.companyId !== companyId || task.workspaceId !== claims.workspaceId
        || typeof task.developerId !== "string" || task.developerId === "" || typeof task.project !== "string" || task.project !== workspace.projectName) return refuse();
      // The flow's deployed access rule re-reads the owner's live membership AND project grant on every request.
      const requireAuthority = async () => { if (!(await flow.access.checkStep(task)).allowed) fail(); deadline.check(); };
      await requireAuthority();
      if (path === GATEWAY_MCP_PATH) return refuse(NOT_YET);
      if (path === CONTEXT_TOOLS_PATH) return answer({ sources: [], tools: [], searchTeamKnowledge: teamSearch !== undefined, unavailable: [], disabled: [] });
      const parsed = ContextToolCallRequestSchema.safeParse(JSON.parse(request.body ?? ""));
      if (!parsed.success) return refuse();
      if (parsed.data.tool !== SEARCH_TEAM_KNOWLEDGE_TOOL) return refuse(NOT_YET);
      const args = SearchArguments.safeParse(parsed.data.arguments);
      if (!args.success || teamSearch === undefined) return refuse();
      // None of the worker's fields choose a company, task or project. The per-company root supplied this search.
      const hits = await teamSearch.search({ orgId: companyId, projectId: task.project, asAgentForTask: task.taskId, query: args.data.query,
        ...(args.data.sources === undefined ? {} : { sources: args.data.sources }), limit: TEAM_SEARCH_LIMIT_MAX });
      deadline.check();
      if (!Array.isArray(hits) || hits.length > TEAM_SEARCH_LIMIT_MAX) return refuse();
      const checked = z.array(Hit).safeParse(hits);
      if (!checked.success) return refuse();
      if (checked.data.length === 0) return answer({ status: "OK", text: "No results." });
      const text = checked.data.map((hit) => `- ${inertSentence(hit.title, 200)} (${hit.system}, ${inertSentence(hit.itemRef, 200)}): ${inertSentence(hit.snippet ?? "", 280)}`).join("\n");
      const framed = frameResult({ source: { label: "Team record" } as ContextSource, itemRef: "search", fetchedAt: (flow.now?.() ?? new Date()).toISOString(), text, maxBytes: 8 * 1024, standing: "outsider" });
      const response = answer({ status: "OK", text: framed.text, ...(framed.truncated ? { truncated: true } : {}) });
      deadline.check();
      return Buffer.byteLength(response.body) <= MAX_RESPONSE_BYTES ? response : refuse();
    });
  } catch { return refuse(); }
}
