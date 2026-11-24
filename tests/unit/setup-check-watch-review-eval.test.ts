// REVIEW (Opus, 5b42d1b7b): the eval health run's preparation carries the whole health run (worker main.ts runEvalHealthRider runs inside the prepare invocation), and the run is
// allowed EVAL_HEALTH_RUN_MAX_MS = 58 minutes by its own contract (the worker's job deadline alone is 48 minutes, counted after the clone/setup). The 50-minute preparation watch ends it first.
// This test is RED on 5b42d1b7b on purpose: a healthy, running health run, 51 minutes after its launch, still inside its own claim window, is ended FAILED and its workspace closed.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVAL_HEALTH_RUN_MAX_MS, type ProjectDefinition } from "@agentx/contracts";
import { launchEvalHealthRun } from "../../packages/broker/src/core/setup-agent/eval-health-launch.js";
import { PREPARATION_TIMEOUT_MS } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY, createHarness } from "../support/task-flow-harness.js";

const HEAD = "a".repeat(40);
const definition: ProjectDefinition = { name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };

describe("review: the preparation watch and the eval health run", () => {
  it("the health run's own window is longer than the watch", () => {
    expect(EVAL_HEALTH_RUN_MAX_MS).toBeGreaterThan(PREPARATION_TIMEOUT_MS);
  });

  it("does not end a healthy health run that is still inside its own 58-minute window", async () => {
    const h = createHarness();
    await h.registerProject(definition);
    const ok = await launchEvalHealthRun(h.deps, { project: "payments", requestId: randomUUID(), claimId: randomUUID(), bases: [{ repositoryId: "web", baseCommitSha: HEAD }], owner: "maintainer" });
    expect(ok).toBe(true);
    const [message] = await (await h.queues.queue("task-dispatch")).receive();
    const { workspaceId, operationId } = message!.body as { workspaceId: string; operationId: string };
    // The worker took it and is measuring (RUNNING), well inside its own window.
    const key = operationKey(COMPANY, workspaceId, operationId);
    await h.store.put({ item: { ...(await h.store.get(key))!, status: "RUNNING" } });
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 60);
    expect(PREPARATION_TIMEOUT_MS + 60_000).toBeLessThan(EVAL_HEALTH_RUN_MAX_MS);
    await h.flow.sweepRunsOnce();
    expect({ status: (await h.store.get(key))?.["status"], error: (await h.store.get(key))?.["error"] }).toEqual({ status: "RUNNING", error: undefined });
    expect((await h.store.get(workspaceKey(COMPANY, workspaceId)))?.["status"]).toBe("PREPARING");
  });
});
