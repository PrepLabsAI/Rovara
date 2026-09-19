import { agentXError } from "@agentx/contracts";

export async function stopWorkspace(
  input: { controlPlaneUrl: string; accessToken: string; workspaceId: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(
    `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/workspaces/${input.workspaceId}/stop`,
    { method: "POST", headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  const result: unknown = await response.json();
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `workspace stop failed with HTTP ${response.status}`);
  return result;
}
