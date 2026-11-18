// L4-AK3H: the laptop app's route chain keeps the wiki build controls (Stop, Delete, refresh) and nightly upkeep's off switch next to the knowledge routes. A merge once dropped the two from the chain, so they fell through to the owner
// routes with no error; this reaches them through `rovara up` itself (the real wiring, on a fake worker machine).
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { startLocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };

describe("the laptop app's route chain", () => {
  it("answers the wiki build's controls and the upkeep switch (not the owner routes' 'route not found'), and the knowledge suggestion route", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-chain-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const runtime = await startLocalRuntime({
      stateDirectory, cwd: join(root, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
      machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, openBrowser: async () => undefined,
    });
    cleanup.push(() => runtime.stop());
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${runtime.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as { error?: { message?: string }; [key: string]: unknown } };
    };
    expect((await api("/v1/admin/projects", "POST", PROJECT)).status).toBeLessThan(300);
    const upkeep = await api("/v1/app/projects/payments/upkeep");
    expect(upkeep.status).toBe(200);
    expect(upkeep.body).toMatchObject({ canManage: true });
    const build = await api("/v1/app/projects/payments/wiki-build");
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    // The suggestion route is answered by the lessons routes (a bad body is that route's own fixed refusal, not a missing route).
    const proposed = await api("/v1/dev/projects/payments/knowledge/propose", "POST", { advice: "Wrap network calls in withRetry", tool: "bash" });
    expect(proposed.status).toBe(400);
    expect(proposed.body.error?.message).toBe("body: has a field this route does not take");
  });
});
