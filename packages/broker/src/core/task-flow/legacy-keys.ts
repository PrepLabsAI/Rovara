// Legacy addressing for workspace-location, the offline backfill and tests; start also uses META for the thin company-discovery pointer.
import type { DocumentKey } from "@agentx/contracts";
export const legacyWorkspaceKey = (workspaceId: string): DocumentKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
export const legacyOperationRequestKey = (ownerKey: string, workspaceId: string, requestId: string): DocumentKey => ({ pk: `IDEMPOTENCY#${ownerKey}#${workspaceId}`, sk: `REQUEST#${requestId}` });
