import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";

const run = promisify(execFile);

/**
 * How well a capability is evidenced on this exact branch.
 *
 * `observed_offline` means an offline test on this tree exercised the real code path.
 * It never means the behaviour was seen in a deployed environment; that is `observed_live`,
 * which nothing in this repository can currently claim.
 */
type Support = "observed_offline" | "observed_live" | "unsupported" | "unknown";

type CapabilityReport = {
  sourceCommit: string;
  requestLookup: Support;
  nativeConversationRestore: Support;
  frozenCandidate: Support;
  cancellation: Support;
  workerDeadlineEnforcement: Support;
  workerBudgetEnforcement: Support;
  workerScopeEnforcement: Support;
};

/**
 * Per-field enforcement of the proposed execution request contract.
 *
 * Separate from CapabilityReport because a single value per capability cannot distinguish
 * "the worker enforces a fixed runtime limit" from "the worker enforces the limit this job
 * asked for". These fields are absent from the current wire body, so nothing enforces them.
 */
const WIRE_CONTRACT_ENFORCEMENT: Record<string, Support> = {
  approved_plan_digest: "unsupported",
  test_plan_digest: "unsupported",
  allowed_paths: "unsupported",
  deadline: "unsupported",
  maximum_microunits: "unsupported",
  allowed_actions: "unsupported",
  forbidden_actions: "unsupported",
};

async function workspaceRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-capability-"));
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(
    join(rootPath, ".agentx/preparation-manifest.json"),
    JSON.stringify({
      schemaVersion: 1, projectName: "payments", projectRevision: 1,
      environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
      repositories: [], completedSetupSteps: [], readinessResults: [],
      creationIdentity: "test", complete: true, updatedAt: new Date().toISOString(),
    }),
  );
  return rootPath;
}

function taskInvocation(conversationId: string): WorkerInvocation {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(),
    fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId, prompt: "continue where we left off" },
  };
}

/** Records exactly what the task path asked the native adapter to do. */
function observingAdapter(mintedConversationId: string) {
  const calls: Array<{ method: "create" | "open"; conversationId?: string }> = [];
  const adapter: PiSessionAdapter = {
    async create({ sessionDirectory }) {
      calls.push({ method: "create" });
      const sessionFile = join(sessionDirectory, `${randomUUID()}.jsonl`);
      await writeFile(sessionFile, "", { flag: "wx" });
      return {
        conversationId: mintedConversationId, sessionFile,
        async prompt() {}, async abort() {},
        subscribe: () => () => undefined, dispose() {},
      };
    },
    async open(input) {
      calls.push({ method: "open", conversationId: input.conversationId });
      throw new Error("unreachable in the current task path");
    },
  };
  return { adapter, calls };
}

describe("unified execution capability characterization", () => {
  it("starts a new native conversation rather than restoring the requested one", async () => {
    const rootPath = await workspaceRoot();
    const requested = randomUUID();
    const minted = randomUUID();
    const { adapter, calls } = observingAdapter(minted);

    const result = await runTaskInvocation(taskInvocation(requested), {
      rootPath, model: { provider: "fixture", modelId: "fixture" },
      piAdapter: adapter, eventSink: async () => {}, artifactSink: async () => ({}) as never,
    });

    // The task path only ever creates. It never reopens a registered session, and it never
    // hands the requested conversation id to the adapter, so the native agent cannot
    // continue a prior conversation through this route.
    expect(calls).toEqual([{ method: "create" }]);
    expect(calls.some((call) => call.method === "open")).toBe(false);
    expect(calls.some((call) => call.conversationId === requested)).toBe(false);

    // The returned conversation is whatever the adapter minted, not what the caller asked for.
    expect(result.conversationId).toBe(minted);
    expect(result.conversationId).not.toBe(requested);
  });

  it("keeps saved-session reopen available but unreferenced by the task path", async () => {
    const source = await run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
    const repository = source.stdout.trim();
    // Working tree, not HEAD, so wiring it up is noticed before it is committed.
    const { stdout } = await run("git", [
      "-C", repository, "grep", "-l", "--", "openRegisteredWorkspacePiSession", "--", "packages", "tests",
    ]);
    const referencing = stdout.trim().split("\n").filter(Boolean);
    const productionCallers = referencing.filter(
      (file) => file.startsWith("packages/") && !file.includes("pi-session.ts"),
    );

    // The helper and its conversation manifest exist and are tested, but nothing under
    // packages/ calls them. Restoration is plumbing, not a wired-up product capability.
    expect(referencing).toContain("packages/worker/src/pi-session.ts");
    expect(referencing).toContain("tests/integration/resumption.test.ts");
    expect(productionCallers).toEqual([]);
  });

  // Excluded conformance expectation, not a defect in the current suite. This is the
  // behaviour a follow-up turn needs; it is deliberately skipped so the default suite
  // reports the truth rather than silently failing. Enabling it is the acceptance test for
  // the successor package described in docs/unified-execution-capabilities.md.
  it.skip("DESIRED: a follow-up turn resumes the requested native conversation", async () => {
    const rootPath = await workspaceRoot();
    const requested = randomUUID();
    const { adapter, calls } = observingAdapter(randomUUID());

    const result = await runTaskInvocation(taskInvocation(requested), {
      rootPath, model: { provider: "fixture", modelId: "fixture" },
      piAdapter: adapter, eventSink: async () => {}, artifactSink: async () => ({}) as never,
    });

    expect(calls).toEqual([{ method: "open", conversationId: requested }]);
    expect(result.conversationId).toBe(requested);
  });

  it("emits a capability report that matches the evidence on this tree", async () => {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    const report: CapabilityReport = {
      sourceCommit: stdout.trim(),
      requestLookup: "observed_offline",
      nativeConversationRestore: "unsupported",
      frozenCandidate: "observed_offline",
      cancellation: "observed_offline",
      workerDeadlineEnforcement: "unsupported",
      workerBudgetEnforcement: "unsupported",
      workerScopeEnforcement: "observed_offline",
    };

    expect(report.sourceCommit).toMatch(/^[0-9a-f]{40}$/);

    // Nothing in this repository has been observed in a deployed environment.
    expect(Object.values(report)).not.toContain("observed_live");

    // The request contract's own limit fields are enforced by nothing.
    expect(new Set(Object.values(WIRE_CONTRACT_ENFORCEMENT))).toEqual(new Set(["unsupported"]));
    expect(report.workerDeadlineEnforcement).toBe(WIRE_CONTRACT_ENFORCEMENT.deadline);
    expect(report.workerBudgetEnforcement).toBe(WIRE_CONTRACT_ENFORCEMENT.maximum_microunits);

    // The restore helper exists, so this is a wiring gap; it is still not a supported resume.
    expect(report.nativeConversationRestore).not.toBe("observed_offline");
  });

  it("refuses to publish an exact candidate, keeping creation separate from publication", async () => {
    const project = {
      schemaVersion: 2, name: "payments", revision: 1,
      controlPlaneUrl: "https://agentx.example.test",
      auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
      environment: { image: `registry.example.test/worker@sha256:${"a".repeat(64)}` },
      repositories: [{ name: "app", url: "https://github.com/example/app.git", path: "repo/app",
        defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate",
    };
    const authorization = {
      actor: "reviewer@example.test", jobId: randomUUID(), candidateId: randomUUID(),
      candidateDigest: "a".repeat(64), action: "create-pull-request", repository: "app",
      baseBranch: "main", evidencePacketRef: "packet-1",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const invocation = {
      protocolVersion: 1, kind: "publish", operationId: randomUUID(), workspaceId: randomUUID(),
      fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { project, authorization, repository: "app", title: "Add filtering",
        headBranch: `agentx/${randomUUID()}`, repositoryGrant: "grant", mode: "create" as const },
    };

    // The refusal is the first check in publishWorkspace, before any filesystem or network
    // work, so no workspace is needed to reach it.
    await expect(publishWorkspace({
      rootPath: await workspaceRoot(),
      invocation: invocation as never,
      credentialProvider: () => { throw new Error("credentials must not be requested"); },
      pullRequestSink: () => { throw new Error("publication must not run"); },
    })).rejects.toThrow(/exact candidate publication is not enabled/);
  });

  it("does not treat prompt text as an enforcement mechanism", () => {
    // A prompt asking an agent to stay within a budget, a deadline or a path allowlist is
    // model input. It is not a control. Recording it as enforcement would let an executor
    // qualify its own constraint compliance, which the objective forbids.
    const promptAskingForLimits = "Stay under budget, finish before the deadline, and only edit backend/tasks.py";
    const invocation = taskInvocation(randomUUID());
    invocation.payload.prompt = promptAskingForLimits;

    expect(WIRE_CONTRACT_ENFORCEMENT.maximum_microunits).toBe("unsupported");
    expect(WIRE_CONTRACT_ENFORCEMENT.deadline).toBe("unsupported");
    expect(WIRE_CONTRACT_ENFORCEMENT.allowed_paths).toBe("unsupported");
    expect(Object.keys(invocation.payload)).toEqual(["conversationId", "prompt"]);
  });
});
