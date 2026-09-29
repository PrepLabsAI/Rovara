// Spec 025 C25: `agentx admin task share-mode`, a person typing an admin command (D12: no
// confirmation beyond the admin sign-in, like every other `agentx admin` command).
import { randomUUID } from "node:crypto";
import { adminResponseBody } from "./http.js";

export async function setTaskShareMode(
  input: { controlPlaneUrl: string; accessToken: string; taskId: string; mode: "view" | "continue"; requestId?: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(
    `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/tasks/${encodeURIComponent(input.taskId)}/share-mode`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: input.requestId ?? randomUUID(), shareMode: input.mode }),
    },
  );
  // Ruling F10: the admin commands' shared reading, so a refusal keeps AgentX's own code.
  return adminResponseBody(response);
}
