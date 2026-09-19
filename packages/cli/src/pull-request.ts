import { randomUUID } from "node:crypto";
import type { ControlPlaneApi } from "./control-plane-api.js";
import { acceptedOperationId } from "./control-plane-api.js";

export async function createPullRequestAndWait(input: {
  api: ControlPlaneApi;
  workspaceId: string;
  repository: string;
  title: string;
  body?: string;
  requestId?: string;
  onProgress?: (progress: { operationId: string; status: string; message: string }) => void;
}): Promise<unknown> {
  const accepted = await input.api.createPullRequest({
    workspaceId: input.workspaceId,
    requestId: input.requestId ?? randomUUID(),
    repository: input.repository,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  const operationId = acceptedOperationId(accepted);
  return input.api.pullRequestResult(
    { workspaceId: input.workspaceId, operationId },
    input.onProgress === undefined ? {} : { onProgress: input.onProgress },
  );
}
