// M1.4 Task 4.6b: `agentx admin task e2e-replay`, an administrator's audit replay of a task's qualified AI-navigated round (no model; the result is recorded apart from the task and never
// changes it). `start` asks for one; `show` reads the record of each attempt. Like every `agentx admin` command, the admin sign-in is the only confirmation.
import { adminResponseBody } from "./http.js";

const base = (controlPlaneUrl: string, taskId: string) => `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/tasks/${encodeURIComponent(taskId)}/e2e-replay`;

export async function startTaskE2EReplay(input: { controlPlaneUrl: string; accessToken: string; taskId: string; roundId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImplementation(base(input.controlPlaneUrl, input.taskId), {
    method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ roundId: input.roundId }),
  });
  return adminResponseBody(response);
}

export async function showTaskE2EReplays(input: { controlPlaneUrl: string; accessToken: string; taskId: string; roundId?: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const query = input.roundId === undefined ? "" : `?roundId=${encodeURIComponent(input.roundId)}`;
  const response = await fetchImplementation(`${base(input.controlPlaneUrl, input.taskId)}${query}`, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } });
  return adminResponseBody(response);
}
