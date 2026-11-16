// Task actions (owner decision 198) on `rovara up`: the owner's routes reach the core moves (they used to answer "not on this install yet"), against a real local runtime.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStateDirectory } from "../../packages/broker/src/local/state-directory.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { readLocalRuntime } from "../../packages/cli/src/up/local-runtime.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
interface Answer { status: number; body: { task?: { taskId: string; workflow?: { revision: number } }; error?: { code: string; message: string } } }

async function launch() {
  const home = await mkdtemp(join(tmpdir(), "rovara-task-actions-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const stateDirectory = defaultStateDirectory(home);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(home, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "0.1.0",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, storage: "memory", openBrowser: async () => undefined,
  });
  cleanup.push(() => runtime.stop());
  const owner = async (path: string, method: string, body?: unknown): Promise<Answer> => {
    const address = (await readLocalRuntime(home))!;
    const response = await fetch(`${address.url}${path}`, { method, headers: { authorization: `Bearer ${address.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Answer["body"] };
  };
  await owner("/v1/admin/projects", "POST", PROJECT);
  const started = await owner("/v1/dev/tasks", "POST", { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  return { owner, taskId: started.body.task!.taskId, revision: started.body.task!.workflow!.revision };
}

describe("send back on rovara up", () => {
  it("reaches the core move: a task that is not blocked is told so in plain words, and a missing revision is asked for", async () => {
    const { owner, taskId, revision } = await launch();
    const early = await owner(`/v1/dev/tasks/${taskId}/workflow/send-back`, "POST", { requestId: "22222222-2222-4222-8222-222222222222", instructions: "Fix it.", expectedRevision: revision });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(early.body.error?.message).toContain("no current failed check or review finding");
    expect(early.body.error?.message).not.toContain("not on this install");
    const noRevision = await owner(`/v1/dev/tasks/${taskId}/workflow/send-back`, "POST", { requestId: "22222222-2222-4222-8222-222222222222", instructions: "Fix it." });
    expect(noRevision.body.error?.message).toContain("current revision");
    const other = await owner(`/v1/dev/tasks/44444444-4444-4444-8444-444444444444/workflow/send-back`, "POST", { requestId: "22222222-2222-4222-8222-222222222222", instructions: "Fix it.", expectedRevision: 1 });
    expect(other.status).toBe(404);
  });
});

describe("review findings on rovara up", () => {
  it("reaches the core move: a task with no blocked review is told so in plain words, and a body that is not valid is refused by field", async () => {
    const { owner, taskId, revision } = await launch();
    const digest = "a".repeat(64);
    const none = await owner(`/v1/dev/tasks/${taskId}/workflow/review-findings`, "POST", { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: revision, candidateDigest: digest, resolutions: [{ findingId: digest, action: "ACCEPT", note: "Fine." }] });
    expect(none.status).toBe(409);
    expect(none.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(none.body.error?.message).not.toContain("not on this install");
    const noReason = await owner(`/v1/dev/tasks/${taskId}/workflow/review-findings`, "POST", { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: revision, candidateDigest: digest, resolutions: [{ findingId: digest, action: "ACCEPT", note: "" }] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error?.message).toContain("give a reason");
    const other = await owner(`/v1/dev/tasks/44444444-4444-4444-8444-444444444444/workflow/review-findings`, "POST", {});
    expect(other.status).toBe(400);
  });
});

describe("continue on rovara up", () => {
  it("reaches the core move: a workflow task is told to use its approvals, a task still starting is told it is working, and another task is no such task", async () => {
    const { owner, taskId } = await launch();
    const workflowTask = await owner(`/v1/dev/tasks/${taskId}/continue`, "POST", { requestId: "55555555-5555-4555-8555-555555555555", instructions: "Also add a test." });
    expect(workflowTask.body.error?.message).toContain("approval steps");
    expect(workflowTask.body.error?.message).not.toContain("not on this install");
    const plain = await owner("/v1/dev/tasks", "POST", { requestId: "66666666-6666-4666-8666-666666666666", project: "payments", instructions: "Just do it" });
    const starting = await owner(`/v1/dev/tasks/${plain.body.task!.taskId}/continue`, "POST", { requestId: "55555555-5555-4555-8555-555555555555", instructions: "Also add a test." });
    expect(starting.body.error).toMatchObject({ code: "TASK_BUSY" });
    const other = await owner("/v1/dev/tasks/44444444-4444-4444-8444-444444444444/continue", "POST", { requestId: "55555555-5555-4555-8555-555555555555", instructions: "Also add a test." });
    expect(other.status).toBe(404);
  });
});
