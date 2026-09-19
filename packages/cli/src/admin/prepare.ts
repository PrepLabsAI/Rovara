import { agentXError } from "@agentx/contracts";

export async function requestWorkspacePreparation(
  options: {
    controlPlaneUrl: string;
    accessToken: string;
    requestId: string;
    projectName: string;
    projectRevision: number;
    ownerSubject: string;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(
    `${options.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/workspaces/prepare`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: options.requestId,
        projectName: options.projectName,
        projectRevision: options.projectRevision,
        ownerSubject: options.ownerSubject,
      }),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    throw agentXError("CONFIG_INVALID", `workspace preparation failed with HTTP ${response.status}`);
  }
  return result;
}
