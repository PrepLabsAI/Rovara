import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_INVOCATION_FEATURES, type WorkerInvocation } from "@agentx/contracts";
import { inspectContainedRuntimeReadinessForHost } from "@agentx/verifier";
import {
  type JournalStatus,
  OperationJournal,
  createWorkerServerState,
  handleWorkerRequest,
} from "../../packages/worker/src/index.js";
import { WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import { createDefaultProjectSetupExecutor, createReadinessGatedProjectSetupRuntime } from "../../packages/worker/src/project-setup-executor.js";
import { describe, expect, it, vi } from "vitest";

function hasProjectSetupSmokeFeature(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("invocationFeatures" in body)
    || !Array.isArray(body.invocationFeatures)) return true;
  return body.invocationFeatures.includes("project.setupSmoke");
}

describe("worker HTTP contract", () => {
  it("composes real unavailable Linux readiness with healthy worker service and a refused setup invocation", async () => {
    const readiness = await inspectContainedRuntimeReadinessForHost("linux", "arm64");
    expect(readiness.status).toBe("unavailable");
    if (readiness.status !== "unavailable") return;
    const root = await mkdtemp(join(tmpdir(), "agentx-setup-runtime-gate-"));
    const journal = new OperationJournal(root);
    const runtime = createReadinessGatedProjectSetupRuntime(readiness, () => createDefaultProjectSetupExecutor({
      sourceRoot: "/mnt/workspace",
      evidenceRoot: "/mnt/workspace/.agentx-runtime/evidence",
      controlPlaneUrl: "https://control.example.test",
    }));
    const state = createWorkerServerState(journal, {
      execute: (invocation) => invocation.kind === "project-setup-smoke" ? runtime.execute(invocation) : Promise.resolve(),
      invocationFeatures: runtime.invocationFeatures,
      invocationFeatureDiagnostics: runtime.invocationFeatureDiagnostics,
    });
    const pingResponse = await handleWorkerRequest(new Request("http://worker/ping"), state);
    const pingBody: unknown = await pingResponse.json();
    expect(pingBody).toMatchObject({
      status: "Healthy",
      invocationFeatureDiagnostics: { "project.setupSmoke": readiness },
    });
    expect(hasProjectSetupSmokeFeature(pingBody)).toBe(false);
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      operationId: randomUUID(),
      workspaceId: randomUUID(),
      fence: 1,
      projectRevision: 1,
      callbackCapability: "setup-capability-".padEnd(32, "x"),
      kind: "project-setup-smoke",
      payload: { domain: "project-setup-source-interface/v1", setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1,
        transportCorrelationId: randomUUID(), executionRef: { key: `project-setup-executions/sha256/${"a".repeat(64)}.json`, sha256: "a".repeat(64), byteLength: 1 } },
    };
    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(async () => expect((await journal.get(invocation.operationId))?.status).toBe("FAILED"));
    expect((await journal.get(invocation.operationId))?.error).toContain(`project.setupSmoke is unavailable: ${readiness.reason}`);
  });

  it("keeps ordinary worker health available and reports an unavailable optional setup feature", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-optional-feature-"));
    const state = createWorkerServerState(new OperationJournal(root), {
      execute: async () => undefined,
      invocationFeatures: [],
      invocationFeatureDiagnostics: { "project.setupSmoke": { status: "unavailable", reason: "pinned-contained-image-unavailable" } },
    });
    const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
    expect(ping.status).toBe(200);
    const pingBody: unknown = await ping.json();
    expect(pingBody).toMatchObject({
      status: "Healthy",
      invocationFeatureDiagnostics: { "project.setupSmoke": { status: "unavailable", reason: "pinned-contained-image-unavailable" } },
    });
    expect(hasProjectSetupSmokeFeature(pingBody)).toBe(false);
  });

  it("journals before acknowledging and reports HealthyBusy during background execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-journal-"));
    const journal = new OperationJournal(root);
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    const state = createWorkerServerState(journal, {
      execute: async () => {
        executions += 1;
        await executionGate;
      },
    });
    const invocation = taskInvocation();

    const accepted = await handleWorkerRequest(invocationRequest(invocation), state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, status: "ACCEPTED" });
    expect(await journal.get(invocation.operationId)).toBeDefined();

    await vi.waitFor(() => expect(executions).toBe(1));
    const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
    await expect(ping.json()).resolves.toMatchObject({ status: "HealthyBusy", activeOperations: 1 });

    const duplicate = await handleWorkerRequest(invocationRequest(invocation), state);
    await expect(duplicate.json()).resolves.toMatchObject({ accepted: true, duplicate: true });
    expect(executions).toBe(1);

    releaseExecution();
    // Wait on the ping, not the journal: the journal reads SUCCEEDED a moment before the operation
    // leaves the active set (see the test below).
    await vi.waitFor(async () => {
      const healthy = await handleWorkerRequest(new Request("http://worker/ping"), state);
      await expect(healthy.json()).resolves.toMatchObject({ status: "Healthy", activeOperations: 0 });
    });
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
    // Spec 053: what this build parses, so the dispatcher sends the thinking level only to it; spec 051 adds readiness,
    // and publish's reportChecks (P-2), so only this build is asked to publish despite a failing check.
    await expect((await handleWorkerRequest(new Request("http://worker/ping"), state)).json())
      .resolves.toMatchObject({ invocationFeatures: ["task.modelPolicy", "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview", "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode", "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate", "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "task.workflowReviewers", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission", "task.workflowE2EApplicationPlan", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks", "task.workflowE2EBaselineSource", "task.workflowE2EAgentSteps.v1", "task.workflowE2ECaptureExtras.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EModelFreeLimits.v1", "task.workflowE2EAgentModelChoice.v1", "model.route", "task.agentStep", "task.agentRun", "task.agentGrounding.v1", "task.workflowUnderstand", "task.workflowPlanCritique", "task.setupDraft", "task.setupProposal.v2", "task.workflowReviewRisk", "task.workflowFix", "task.workflowFeedbackAutonomy", "task.workflowParallelParts", "maintain.workflowSync", "task.workflowPlanDryRun.v1", "task.workflowE2EGroundingChecks.v1", "task.workflowE2EMidStepSync.v1", "task.liveSteer.v1", "task.setupAgent.v1", "task.setupRecipes.v1", "prepare.metaRepo", "task.contextSources.v1", "task.specWrite.v1", "task.workflowReviewSpec.v1", "task.ownerRedirect.v1", "task.peek.v1", "publish.attribution", "task.diagnosis.v1", "task.evidenceCapture.v1", "task.learnedContext.v1", "task.testEnvDetect.v1", "task.testEnvironment.v1", "task.testEnvCoveragePath.v1", "prepare.registries.v1", "prepare.savedEnv.v1", "prepare.savedEnvBuild.v1", "prepare.pins.v1", "repository.credentialKinds.v1", "task.workflowSecondReviewer.v1", "task.designReview.v1", "task.nightlyRun.v1"] });
  });

  it("advertises only the invocation features it implements, not those it merely parses", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-features-"));
    const state = createWorkerServerState(new OperationJournal(root), { execute: async () => undefined });
    const body = await (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as { invocationFeatures: string[] };
    // Task 16a knows these three. Task 18 added "task.agentStep", Task 23 "task.agentRun", Task 27 "model.route".
    for (const feature of ["task.agentStep", "task.agentRun", "model.route"]) expect(WORKER_INVOCATION_FEATURES).toContain(feature);
    expect(body.invocationFeatures).toContain("task.agentRun");
    expect(WORKER_INVOCATION_FEATURES).toContain("task.agentGrounding.v1");
    expect(body.invocationFeatures).toContain("task.agentGrounding.v1");
    expect(body.invocationFeatures).toContain("task.agentStep");
    expect(body.invocationFeatures).toContain("model.route");
    for (const feature of body.invocationFeatures) expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain(feature);
  });

  it("withholds the agent step feature (Task 4.3a) from /ping with its reason exactly as it withholds another feature, and lists it once nothing withholds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-withheld-agent-"));
    let withheld: Record<string, unknown> = { "task.workflowE2EAgentSteps.v1": { status: "unavailable", reason: "agent-route-not-derivable", detail: "no route" } };
    const state = createWorkerServerState(new OperationJournal(root), { execute: () => Promise.resolve(), withheldInvocationFeatures: () => withheld });
    const ping = async () => (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as Promise<{ invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> }>;
    const held = await ping();
    expect(held.invocationFeatures).not.toContain("task.workflowE2EAgentSteps.v1");
    expect(held.invocationFeatures).toContain("task.workflowE2EApplicationChecks");
    expect(held.invocationFeatureDiagnostics).toMatchObject({ "task.workflowE2EAgentSteps.v1": { status: "unavailable", reason: "agent-route-not-derivable", detail: "no route" } });
    withheld = {};
    expect((await ping()).invocationFeatures).toContain("task.workflowE2EAgentSteps.v1");
    // A withholding check that throws fails closed for the agent feature too, when it is one the executor may withhold.
    const failing = createWorkerServerState(new OperationJournal(root), { execute: () => Promise.resolve(), withholdableInvocationFeatures: ["task.workflowE2EAgentSteps.v1"], withheldInvocationFeatures: () => { throw new Error("boom"); } });
    const failed = await (await handleWorkerRequest(new Request("http://worker/ping"), failing)).json() as { invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> };
    expect(failed.invocationFeatures).not.toContain("task.workflowE2EAgentSteps.v1");
    expect(failed.invocationFeatureDiagnostics).toMatchObject({ "task.workflowE2EAgentSteps.v1": { reason: "availability-check-failed" } });
  });

  it("withholds a feature the executor reports as unavailable from /ping, with the reason, and lists it again once it is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-withheld-feature-"));
    let withheld: Record<string, unknown> = { "task.workflowE2EApplicationChecks": { status: "unavailable", reason: "executor-image-not-on-host" } };
    const state = createWorkerServerState(new OperationJournal(root), { execute: () => Promise.resolve(), withheldInvocationFeatures: () => withheld });
    const ping = async () => (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as Promise<{ invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> }>;
    const first = await ping();
    expect(first.invocationFeatures).not.toContain("task.workflowE2EApplicationChecks");
    expect(first.invocationFeatures).toContain("task.workflowE2EApplicationPlan");
    expect(first.invocationFeatureDiagnostics).toMatchObject({ "task.workflowE2EApplicationChecks": { status: "unavailable", reason: "executor-image-not-on-host" } });
    withheld = {};
    expect((await ping()).invocationFeatures).toContain("task.workflowE2EApplicationChecks");
  });

  it("withholds every feature the executor may withhold, with a reason, when asking which are withheld throws (fails closed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-withheld-throws-"));
    const state = createWorkerServerState(new OperationJournal(root), { execute: () => Promise.resolve(),
      withholdableInvocationFeatures: ["task.workflowE2EApplicationChecks"],
      withheldInvocationFeatures: () => { throw new Error("availability unknown"); } });
    const ping = await (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as { invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> };
    expect(ping.invocationFeatures).not.toContain("task.workflowE2EApplicationChecks");
    expect(ping.invocationFeatures).toContain("task.workflowE2EApplicationPlan");
    expect(ping.invocationFeatureDiagnostics).toMatchObject({ "task.workflowE2EApplicationChecks": { status: "unavailable", reason: "availability-check-failed" } });
  });

  // The journal reads SUCCEEDED a moment before the operation leaves the active set: the write lands,
  // then transition() returns, then executeInBackground clears it. The worker stays busy until the
  // operation is fully recorded, so a caller that saw SUCCEEDED in the journal must wait on /ping.
  it("reports HealthyBusy until a finished operation is fully recorded, though the journal already reads SUCCEEDED", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-recorded-"));
    let releaseRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    class HeldJournal extends OperationJournal {
      override async transition(operationId: string, status: JournalStatus, error?: string) {
        const record = await super.transition(operationId, status, error);
        if (status === "SUCCEEDED") await recordGate;
        return record;
      }
    }
    const journal = new HeldJournal(root);
    const state = createWorkerServerState(journal, { execute: async () => undefined });
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(async () => {
      expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
    });
    const busy = await handleWorkerRequest(new Request("http://worker/ping"), state);
    await expect(busy.json()).resolves.toMatchObject({ status: "HealthyBusy", activeOperations: 1 });

    releaseRecord();
    await vi.waitFor(async () => {
      const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
      await expect(ping.json()).resolves.toMatchObject({ status: "Healthy", activeOperations: 0 });
    });
  });

  it("reports the persisted terminal state after background execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const terminal: Array<{ operationId: string; status: string; error?: string }> = [];
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async (result) => {
          terminal.push(result);
        },
      },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(terminal).toEqual([
      { operationId: invocation.operationId, status: "SUCCEEDED" },
    ]));
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
  });

  it("redacts a failed operation's error before it is journaled or reported (#170)", async () => {
    const token = `ghp_${"Q1w2E3r4T5".repeat(4)}`;
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const terminal: Array<{ operationId: string; status: string; error?: string }> = [];
    const state = createWorkerServerState(
      journal,
      { execute: async () => { throw new Error(`fatal: could not read from https://github.com/x?token=1 ${token}`); } },
      { onTerminal: async (result) => { terminal.push(result); } },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(terminal).toHaveLength(1));
    expect(terminal[0]).toMatchObject({ status: "FAILED" });
    expect(terminal[0]!.error).toContain("[REDACTED]");
    expect(terminal[0]!.error).not.toContain(token);
    const record = await journal.get(invocation.operationId);
    expect(record?.error).toBe(terminal[0]!.error);
    expect(await readFile(join(root, ".agentx/operations", `${invocation.operationId}.json`), "utf8")).not.toContain(token);
  });

  it("sends the regression a failed or cancelled task carries as its result, and nothing for other failures (spec 051 Ruling Y)", async () => {
    const checks = { status: "regression", checks: [] };
    for (const [thrown, expected] of [
      [Object.assign(new Error("model down"), { checks }), { status: "FAILED", result: { checks } }],
      [Object.assign(new WorkerOperationCancelledError("op"), { checks }), { status: "CANCELLED", result: { checks } }],
      [new Error("model down"), { status: "FAILED" }],
    ] as const) {
      const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-terminal-")));
      const terminal: Array<Record<string, unknown>> = [];
      const state = createWorkerServerState(journal, { execute: async () => { throw thrown; } }, { onTerminal: async (result) => { terminal.push(result as unknown as Record<string, unknown>); } });
      await handleWorkerRequest(invocationRequest(taskInvocation()), state);
      await vi.waitFor(() => expect(terminal).toHaveLength(1));
      expect(terminal[0]).toMatchObject(expected);
      if (!("result" in expected)) expect(terminal[0]).not.toHaveProperty("result");
    }
  });

  it("F5: a stopped setup run ends cancelled and carries only its partial proposal and summary; nothing else it holds is sent", async () => {
    const setupRun = { workflowMode: "SETUP_AGENT", setupProposal: { setup: [] }, setupRunSummary: { stop: "infrastructure", partial: true }, conversationId: "c", secret: "x", checks: { status: "regression" } };
    const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-terminal-")));
    const terminal: Array<Record<string, unknown>> = [];
    const state = createWorkerServerState(journal, { execute: async () => { throw new WorkerOperationCancelledError("op", setupRun); } }, { onTerminal: async (result) => { terminal.push(result as unknown as Record<string, unknown>); } });
    await handleWorkerRequest(invocationRequest(taskInvocation()), state);
    await vi.waitFor(() => expect(terminal).toHaveLength(1));
    expect(terminal[0]).toMatchObject({ status: "CANCELLED", result: { workflowMode: "SETUP_AGENT", setupProposal: { setup: [] }, setupRunSummary: { stop: "infrastructure", partial: true } } });
    expect(Object.keys(terminal[0]!["result"] as object).sort()).toEqual(["setupProposal", "setupRunSummary", "workflowMode"]);
    // A cancelled error whose carried value is not a setup run's report sends nothing of it.
    const other: Array<Record<string, unknown>> = [];
    const second = createWorkerServerState(new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-terminal-"))), { execute: async () => { throw new WorkerOperationCancelledError("op", { workflowMode: "PLAN", setupProposal: {} }); } }, { onTerminal: async (result) => { other.push(result as unknown as Record<string, unknown>); } });
    await handleWorkerRequest(invocationRequest(taskInvocation()), second);
    await vi.waitFor(() => expect(other).toHaveLength(1));
    expect(other[0]).not.toHaveProperty("result");
  });

  it("sends the findings of a run that left the code as it was, redacted again, and nothing of them for another failure", async () => {
    const token = ["ghp_", "Ab12".repeat(9)].join("");
    const findings = { commands: [{ command: "grep -rn retry app", output: `app/a.ts: ${token}` }], conclusion: "We use retry in one file." };
    const send = async (thrown: Error) => {
      const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-terminal-")));
      const terminal: Array<Record<string, unknown>> = [];
      const state = createWorkerServerState(journal, { execute: async () => { throw thrown; } }, { onTerminal: async (result) => { terminal.push(result as unknown as Record<string, unknown>); } });
      await handleWorkerRequest(invocationRequest(taskInvocation()), state);
      await vi.waitFor(() => expect(terminal).toHaveLength(1));
      return terminal[0]!;
    };
    const sent = await send(Object.assign(new Error("CONFIG_INVALID: the coding run left the code as it was when the task started"), { noChangeFindings: findings }));
    expect(sent).toMatchObject({ status: "FAILED", result: { noChangeFindings: { commands: [{ command: "grep -rn retry app" }], conclusion: "We use retry in one file." } } });
    expect(JSON.stringify(sent)).not.toContain(token);
    expect(JSON.stringify(sent)).toContain("[REDACTED]");
    expect(await send(new Error("model down"))).not.toHaveProperty("result");
    expect(await send(Object.assign(new Error("model down"), { noChangeFindings: "not a block" }))).not.toHaveProperty("result");
  });

  it("retries a failed terminal callback three times, waiting 2 s, 8 s and 30 s", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const waits: number[] = [];
    let attempts = 0;
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async () => {
          attempts += 1;
          throw new Error("ThrottlingException");
        },
        retrySleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    const invocation = taskInvocation();

    await handleWorkerRequest(invocationRequest(invocation), state);
    await vi.waitFor(() => expect(attempts).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(4);
    expect(waits).toEqual([2_000, 8_000, 30_000]);
    expect((await journal.get(invocation.operationId))?.status).toBe("SUCCEEDED");
  });

  it("stops retrying the terminal callback once it succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-terminal-"));
    const journal = new OperationJournal(root);
    const waits: number[] = [];
    let attempts = 0;
    const state = createWorkerServerState(
      journal,
      { execute: async () => undefined },
      {
        onTerminal: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("ThrottlingException");
        },
        retrySleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    await handleWorkerRequest(invocationRequest(taskInvocation()), state);
    await vi.waitFor(() => expect(attempts).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(3);
    expect(waits).toEqual([2_000, 8_000]);
  });

  it("accepts a prepare invocation whose stored project has a connector of an unknown type", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-journal-"));
    const journal = new OperationJournal(root);
    const state = createWorkerServerState(journal, { execute: async () => undefined });
    const invocation = prepareInvocationWithUnknownConnector();

    const accepted = await handleWorkerRequest(invocationRequest(invocation), state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, status: "ACCEPTED" });
  });
});

function invocationRequest(invocation: WorkerInvocation): Request {
  return new Request("http://worker/invocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invocation),
  });
}

function taskInvocation(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "task",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Inspect the fixture" },
  };
}

/** A revision written by a later control plane, before a rollback to this one: the worker never
 * reads integrations.connectors, and StoredProjectDefinitionSchema passes an unknown type through. */
function prepareInvocationWithUnknownConnector(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "prepare",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      project: {
        name: "payments",
        revision: 1,
        repositories: [
          {
            name: "api",
            url: "https://git.example.test/api.git",
            path: "repo/api",
            defaultBranch: "main",
            credentialRef: "api-readwrite",
          },
        ],
        setup: [],
        readiness: [],
        orchestratorInstructions: "Delegate coding to the remote worker.",
        integrations: {
          connectors: [
            { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["api"] },
          ],
        },
      },
      repositoryGrant: "signed-grant",
    },
  };
}
