// N1 (S4 re-check): a worker whose start-up scratch check failed (worker-scratch.ts) must not answer /ping as Healthy. It answers the way a failed boot does (boot.sh's report_boot_failure):
// 503 and {"status":"BootFailed","reason":...}, which the broker already reads: provisioning fails the session at once (session-steps.ts probePing), and a READY session counts it as a failed
// probe, so the reconciler recycles the instance (session-reconciler.ts) instead of every task failing on it.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import { pingWorker } from "../../packages/broker/src/aws/session-steps.js";
import { workerBootFailureOf } from "../../packages/worker/src/worker-scratch.js";

afterEach(() => vi.restoreAllMocks());

async function stateWith(bootFailure?: string) {
  const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-boot-failure-")));
  return createWorkerServerState(journal, { execute: () => Promise.resolve(), ...(bootFailure === undefined ? {} : { bootFailure }) });
}

describe("/ping of a worker that failed its start-up scratch check", () => {
  it("positive control: a worker with no boot failure answers Healthy with 200", async () => {
    const response = await handleWorkerRequest(new Request("http://worker/ping"), await stateWith());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "Healthy" });
  });

  it("answers 503 BootFailed with the reason, and lists no features", async () => {
    const response = await handleWorkerRequest(new Request("http://worker/ping"), await stateWith("worker scratch: no scratch directory outside the workspace volume"));
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "BootFailed", reason: "worker scratch: no scratch directory outside the workspace volume" });
    expect(body["status"]).not.toBe("Healthy");
    expect(body["status"]).not.toBe("HealthyBusy");
  });

  it("is read by the broker's own probe as BootFailed with the reason (not healthy)", async () => {
    const answer = await handleWorkerRequest(new Request("http://worker/ping"), await stateWith("worker scratch: unavailable"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(answer);
    expect(await pingWorker("http://10.0.0.1:8080/ping")).toEqual({ status: "BootFailed", reason: "worker scratch: unavailable" });
  });
});

describe("the boot failure a scratch status gives", () => {
  it("is none for a ready worker, and the reason for an unavailable one", () => {
    expect(workerBootFailureOf({ status: "ready", base: "/tmp", offWorkspaceVolume: true })).toBeUndefined();
    expect(workerBootFailureOf({ status: "unavailable", reason: "no scratch" })).toBe("worker scratch: no scratch");
  });
});
