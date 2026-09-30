// Waiting for AWS during agentx destroy: never giving up early (the control-plane delete takes 20
// to 40 minutes while its VPC Lambda functions release their network interfaces, live 2026-09-28),
// and always saying what it is waiting for.
import { AgentXError, agentXError } from "@agentx/contracts";
import { isVolumeGone, type DestroyApi } from "./aws.js";

export const STACK_DELETE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 15_000;
const NOTICE_MS = 60_000;
const WORKER_TIMEOUT_MS = 30 * 60_000;

const minutes = (ms: number) => { const count = Math.round(ms / 60_000); return `${count} ${count === 1 ? "minute" : "minutes"}`; };
/** Whole hours as hours, anything else as minutes: never "0 hours". */
const duration = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} ${ms === 3_600_000 ? "hour" : "hours"}` : minutes(ms));

/** An AWS error that ends a wait says what to do next; AgentX's own errors already do. */
async function aws<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", `${what}: ${error instanceof Error ? error.message : String(error)}; run agentx destroy again to continue`);
  }
}

export async function waitForStackDelete(input: { api: DestroyApi; name: string; /** DeleteStack's ClientRequestToken, when this run started the delete. */ token?: string; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; pollMs?: number; noticeMs?: number; timeoutMs?: number }): Promise<void> {
  const { api, name } = input;
  const timeout = input.timeoutMs ?? STACK_DELETE_TIMEOUT_MS;
  const started = input.now();
  let noticed = started;
  const pollMs = input.pollMs ?? POLL_MS;
  for (;;) {
    // Sleep first: right after DeleteStack, a re-run can still read the earlier run's DELETE_FAILED.
    await input.sleep(pollMs);
    const stack = await aws(`reading stack ${name}`, () => api.stack(name));
    if (stack === undefined) {
      input.write(`deleted ${name} (${minutes(input.now() - started)})`);
      return;
    }
    if (stack.status === "DELETE_FAILED") {
      const reasons = await aws(`reading stack ${name}'s events`, () => api.failedResources(name, input.token));
      throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} could not be deleted: ${reasons.join("; ") || "no reason given"}. Fix that, then run agentx destroy again to continue`);
    }
    if (input.now() - started >= timeout) {
      throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} is still ${stack.status} after ${duration(timeout)}; it may still finish. Run agentx destroy again to keep waiting and continue`);
    }
    if (input.now() - noticed >= (input.noticeMs ?? NOTICE_MS)) {
      const event = await aws(`reading stack ${name}'s events`, () => api.latestEvent(name));
      input.write(`still deleting ${name}: ${minutes(input.now() - started)} so far${event === undefined ? "" : `; last event: ${event}`}`);
      noticed = input.now();
    }
  }
}

export async function waitForInstancesGone(input: { api: DestroyApi; env: string; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void> {
  const started = input.now();
  for (;;) {
    const left = (await aws("listing worker instances", () => input.api.workerInstances(input.env))).filter((instance) => input.ids.includes(instance.id) && instance.state !== "terminated");
    if (left.length === 0) return;
    if (input.now() - started >= (input.timeoutMs ?? WORKER_TIMEOUT_MS)) {
      throw agentXError("RUNTIME_UNAVAILABLE", `worker instances ${left.map((instance) => instance.id).join(", ")} are still ${left[0]?.state ?? "running"} after ${minutes(input.timeoutMs ?? WORKER_TIMEOUT_MS)}; check them in the EC2 console, then run agentx destroy again`);
    }
    await input.sleep(POLL_MS);
  }
}

export async function deleteVolumesWhenFree(input: { api: DestroyApi; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void> {
  const started = input.now();
  for (const id of input.ids) {
    for (;;) {
      try {
        await input.api.deleteVolume(id);
        break;
      } catch (error) {
        if (isVolumeGone(error)) break;
        if (!(error instanceof Error && error.name === "VolumeInUse")) {
          if (error instanceof AgentXError) throw error;
          throw agentXError("RUNTIME_UNAVAILABLE", `deleting volume ${id}: ${error instanceof Error ? error.message : String(error)}; run agentx destroy again to continue`);
        }
        if (input.now() - started >= (input.timeoutMs ?? WORKER_TIMEOUT_MS)) throw agentXError("RUNTIME_UNAVAILABLE", `volume ${id} is still attached after ${minutes(input.timeoutMs ?? WORKER_TIMEOUT_MS)}; check it in the EC2 console, then run agentx destroy again`);
        await input.sleep(POLL_MS);
      }
    }
  }
}
