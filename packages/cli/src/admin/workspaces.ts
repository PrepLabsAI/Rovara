import { AdminWorkspacesResponseSchema, agentXError, type AdminWorkspacesResponse } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

export async function listAdminWorkspaces(input: { controlPlaneUrl: string; accessToken: string }, fetchImplementation: typeof fetch = fetch): Promise<AdminWorkspacesResponse> {
  const response = await fetchImplementation(`${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/workspaces`, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } });
  const parsed = AdminWorkspacesResponseSchema.safeParse(await adminResponseBody(response));
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid workspace list");
  return parsed.data;
}
