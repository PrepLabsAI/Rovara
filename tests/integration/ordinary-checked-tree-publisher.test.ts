import { describe, expect, it } from "vitest";
import { createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

describe("ordinary checked-tree workflow publication", () => {
  it.each([
    ["structured plan", undefined],
    ["legacy Markdown plan", "# Plan\n\n1. Add greet to greeting.ts.\n2. Verify the assertion module.\n"],
  ])("allows an empty-baseline E2E policy with an approved %s through the normal publisher", async (_label, legacyPlanMarkdown) => {
    const plan = planAnswer(planDocument({
      title: "Add greet(name)",
      why: [{ text: "Users should be greeted by name.", author: "Maya" }],
      claims: [{ id: "1", text: "Add greet to greeting.ts." }, { id: "2", text: "Verify the assertion module." }],
      decisions: [],
    }));
    const edits = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];
    const e2ePolicy = {
      schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [],
      targets: [{ targetId: "web-main", applicationId: "app-main", runtimeProfileId: "browser-linux", accountProfileId: "synthetic-tenant", kind: "web", browser: "chromium", viewport: { width: 1280, height: 800 } }],
      defaultSandboxProfileId: "sandbox-v1", fallback: "mock-unconnected", modelRouteRevision: null,
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null },
    };
    const markdown = "# Plan\n\n1. Add greet to greeting.ts.\n2. Verify the assertion module.\n";
    const command = {
      cwd: "repo/demo",
      executable: "node",
      args: ["--input-type=module", "-e", "import assert from 'node:assert/strict'; import { answer } from './assertion.mjs'; assert.equal(answer, 42);"],
      timeoutSeconds: 30,
    };
    const e2e = await createWorkflowE2E({
      realPublication: true,
      realProjectCommands: true,
      readiness: [command],
      initialRepositoryFiles: [{ path: "assertion.mjs", content: "export const answer = 42;\n" }],
      ...(legacyPlanMarkdown === undefined ? {} : { legacyPlanMarkdown }),
      e2ePolicy,
      model: { plan, edits },
    });

    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();

    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE" });
    expect(workflow.reviews?.map((review) => [review.role, review.status])).toEqual([["CRITIC", "PASS"], ["SECURITY", "PASS"]]);
    expect(e2e.checkRuns.some((run) => run.command.executable === command.executable && run.command.args.join(" ") === command.args.join(" "))).toBe(true);
    const publishInvocation = e2e.invocations.find((invocation) => invocation.kind === "publish");
    expect(publishInvocation?.kind).toBe("publish");
    if (publishInvocation?.kind !== "publish") throw new Error("the normal workflow produced no publication invocation");
    expect(publishInvocation.payload).toMatchObject({ publicationMode: "CHECKED_TREE", candidateTreeSha: workflow.candidate?.repositories[0]?.treeSha });
    expect(publishInvocation.payload.candidateCommitSha).toBeUndefined();
    expect(e2e.github.pushLog).toHaveLength(1);
    expect(e2e.github.pullRequests).toEqual([expect.objectContaining({ draft: true, tree: workflow.candidate?.repositories[0]?.treeSha })]);

  });

  it("runs a real approved implementation and check through the broker-signed worker and production publisher", async () => {
    const plan = planAnswer(planDocument({
      title: "Add greet(name)",
      why: [{ text: "Users should be greeted by name.", author: "Maya" }],
      claims: [{ id: "1", text: "Add greet to greeting.ts." }, { id: "2", text: "Verify the assertion module." }],
      decisions: [],
    }));
    const edits = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];
    const markdown = "# Plan\n\n1. Add greet to greeting.ts.\n2. Verify the assertion module.\n";
    const command = {
      cwd: "repo/demo",
      executable: "node",
      args: ["--input-type=module", "-e", "import assert from 'node:assert/strict'; import { answer } from './assertion.mjs'; assert.equal(answer, 42);"],
      timeoutSeconds: 30,
    };
    const e2e = await createWorkflowE2E({
      realPublication: true,
      realProjectCommands: true,
      readiness: [command],
      initialRepositoryFiles: [{ path: "assertion.mjs", content: "export const answer = 42;\n" }],
      legacyPlanMarkdown: markdown,
      model: { plan, edits },
    });

    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();

    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(workflow.decisions.at(-1)).toMatchObject({ decision: "APPROVE" });
    expect(workflow.reviews?.map((review) => [review.role, review.status])).toEqual([["CRITIC", "PASS"], ["SECURITY", "PASS"]]);
    expect(e2e.checkRuns.some((run) => run.command.executable === command.executable && run.command.args.join(" ") === command.args.join(" "))).toBe(true);

    const publishInvocation = e2e.invocations.find((invocation) => invocation.kind === "publish");
    expect(publishInvocation?.kind).toBe("publish");
    if (publishInvocation?.kind !== "publish") throw new Error("the normal workflow produced no publication invocation");
    expect(publishInvocation.payload).toMatchObject({ publicationMode: "CHECKED_TREE", candidateTreeSha: workflow.candidate?.repositories[0]?.treeSha });
    expect(publishInvocation.payload.candidateCommitSha).toBeUndefined();
    expect(JSON.stringify(publishInvocation)).not.toContain("candidateCommitSha");
    expect(e2e.github.pushLog).toHaveLength(1);
    expect(e2e.github.pushLog[0]).toMatchObject({ during: "publish", tree: workflow.candidate?.repositories[0]?.treeSha });
    expect(e2e.github.pushLog[0]?.commit).not.toBe(e2e.baseCommit);
    expect(e2e.github.pullRequests).toEqual([expect.objectContaining({ draft: true, tree: workflow.candidate?.repositories[0]?.treeSha })]);
  });
});
