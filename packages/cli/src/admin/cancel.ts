import { agentXError } from "@agentx/contracts";

/** Cancels a workspace's running coding task as an administrator (#126). */
export async function cancelWorkspaceTask(
  input: { controlPlaneUrl: string; accessToken: string; workspaceId: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(
    `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/workspaces/${input.workspaceId}/cancel`,
    { method: "POST", headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = (result as { error?: { code?: string; message?: string } } | null)?.error;
    // The cancel raced its task: the broker's own code and message say to try again.
    if (error?.code === "WORKSPACE_BUSY") throw agentXError("WORKSPACE_BUSY", error.message ?? "the workspace is busy; try again");
    throw agentXError("RUNTIME_UNAVAILABLE", `workspace cancel failed with HTTP ${response.status}${error?.message ? `: ${error.message}` : ""}`);
  }
  return result;
}
