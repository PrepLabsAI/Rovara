import { agentXError } from "@agentx/contracts";

export async function requestCancellation(
  input: { controlPlaneUrl: string; accessToken: string; workspaceId: string; operationId: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(
    `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/workspaces/${input.workspaceId}/operations/${input.operationId}/cancel`,
    { method: "POST", headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  const value: unknown = await response.json();
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `cancellation request failed with HTTP ${response.status}`);
  return value;
}
