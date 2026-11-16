import { logWorkspacePointerIntegrity } from "./workspace-pointer.js";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError, type DocumentKey, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { operationEventPrefix, operationRequestKey, OPERATION_SK_PREFIX, workspaceKey } from "./keys.js";
import { legacyOperationRequestKey, legacyWorkspaceKey } from "./legacy-keys.js";

type WorkspaceDeps = { store: Pick<DocumentStore, "get">; companyId: string };
export interface WorkspaceKeys {
  scope: "company" | "legacy";
  workspaceKey: DocumentKey;
  row(sk: string): DocumentKey;
  operationKey(operationId: string): DocumentKey;
  taskPointerKey(): DocumentKey;
  conversationKey(conversationId: string): DocumentKey;
  operationEventKey(operationId: string, sequence: number): DocumentKey;
  operationRequestKey(ownerKey: string, requestId: string): DocumentKey;
}
export interface WorkspaceLocation extends WorkspaceKeys { workspace: StoredDocument }
function owned(row: { companyId?: unknown; orgId?: unknown }, companyId: string): boolean {
  return [row.companyId, row.orgId].every((value) => value === undefined || (OrgIdSchema.safeParse(value).success && value === companyId));
}
function keys(companyId: string, workspaceId: string, scope: "company" | "legacy"): WorkspaceKeys {
  const meta = scope === "legacy" ? legacyWorkspaceKey(workspaceId) : workspaceKey(companyId, workspaceId);
  const row = (sk: string): DocumentKey => ({ pk: meta.pk, sk });
  return { scope, workspaceKey: meta, row,
    operationKey: (id) => row(`${OPERATION_SK_PREFIX}${id}`),
    taskPointerKey: () => row("DEVELOPER_TASK"),
    conversationKey: (id) => row(`CONVERSATION#${id}`),
    operationEventKey: (id, sequence) => row(`${operationEventPrefix(id)}${String(sequence).padStart(10, "0")}`),
    operationRequestKey: (owner, request) => scope === "legacy" ? legacyOperationRequestKey(owner, workspaceId, request) : operationRequestKey(companyId, owner, workspaceId, request),
  };
}
/** No process cache: the caller retains this location for the duration of its operation. */
export async function locateWorkspace(deps: WorkspaceDeps, workspaceId: string): Promise<WorkspaceLocation | undefined> {
  const scoped = workspaceKey(deps.companyId, workspaceId);
  const read = async (key: DocumentKey): Promise<StoredDocument | undefined> => {
    try { return await deps.store.get(key); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "workspace unavailable"); }
  };
  const current = await read(scoped);
  if (current !== undefined && current["companyId"] === deps.companyId && owned({ companyId: current["companyId"], orgId: current["orgId"] }, deps.companyId)) return { ...keys(deps.companyId, workspaceId, "company"), workspace: current };
  const legacy = await read(legacyWorkspaceKey(workspaceId));
  if (legacy?.["entityType"] === "WORKSPACE_COMPANY_POINTER") {
    // The scoped read above failed this pointer's own company check. Never follow another company's pointer from a company-bound reader.
    if (legacy["companyId"] === deps.companyId) logWorkspacePointerIntegrity();
    return undefined;
  }
  if (current !== undefined || deps.companyId !== IMPLICIT_COMPANY_ID) return undefined;
  return legacy !== undefined && owned({ companyId: legacy["companyId"], orgId: legacy["orgId"] }, deps.companyId) ? { ...keys(deps.companyId, workspaceId, "legacy"), workspace: legacy } : undefined;
}
/** Missing workspaces address only company keys; this helper can never create a legacy workspace. */
export async function workspaceKeys(deps: WorkspaceDeps, workspaceId: string): Promise<WorkspaceKeys> {
  return await locateWorkspace(deps, workspaceId) ?? keys(deps.companyId, workspaceId, "company");
}
/** Synchronous operation construction uses the already located workspace, including for a new start transaction. */
export function keysOfWorkspace(deps: { companyId: string }, workspace: { id: string; pk: string; companyId?: unknown; orgId?: unknown }): WorkspaceKeys {
  const scoped = workspaceKey(deps.companyId, workspace.id);
  if (!owned(workspace, deps.companyId)) throw agentXError("NOT_FOUND", "workspace not found");
  if (workspace.pk === scoped.pk) return keys(deps.companyId, workspace.id, "company");
  if (deps.companyId === IMPLICIT_COMPANY_ID && workspace.pk === legacyWorkspaceKey(workspace.id).pk) return keys(deps.companyId, workspace.id, "legacy");
  throw agentXError("NOT_FOUND", "workspace not found");
}
