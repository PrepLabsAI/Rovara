// REDACT-BLOCK-REASON scope 5: the four sites the security read could not classify. Each is SAFE, and these tests hold the reason.
//  - worker/src/parallel-parts.ts (the collected part errors, and the error of the checkout of the integrated tree): the raw errors stay in `causes`; what is thrown has fixed words, and the run's end reads only `message`.
//  - worker/src/verification/checks.ts (a runner that rejects, and the error with the workspace root taken out): the text goes to a check entry through `storedCheckOutput`, which redacts it.
import { describe, expect, it } from "vitest";
import { taskGraphDigest, redactText, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import { WorkflowPartsHaltedError, executeParallelWorkflowDependencies } from "../../packages/worker/src/parallel-parts.js";
import { runChecks, withoutRootError, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const PASSWORD = "Tr0ub4dor&3";
const dirty = (where: string): string => `${where} failed for https://x-access-token:${token()}@github.com/org/repo (password ${PASSWORD})`;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const item = (id: string) => ({ id, title: id.slice(0, 2), description: "Do it.", repository: "repo", dependsOn: [] as string[] });
const graph: TaskGraphV1 = { schemaVersion: 1, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items: [item(A), item(B)] };
const initial = "a".repeat(40);
const partTree = "b".repeat(40);

function partsInput(over: { executeFailsFor?: string; checkoutFails?: boolean }) {
  const events: WorkItemProgressV1[] = [];
  return {
    graph, graphDigest: taskGraphDigest(graph), runId: "8c330a74-b4c6-4f01-9356-5fe54fc55b21", operationId: "8c330a74-b4c6-4f01-9356-5fe54fc55b20", initialTreeSha: initial, maxParallel: 1,
    now: () => "2026-11-25T12:00:00.000Z",
    persist: async (entry: WorkItemProgressV1) => { events.push(entry); },
    execute: async (workItem: { id: string }) => {
      if (workItem.id === over.executeFailsFor) throw new Error(dirty("agent loop"));
      return { treeSha: partTree };
    },
    integrate: async () => ({ ok: true as const, treeSha: partTree }),
    checkout: async () => { if (over.checkoutFails === true) throw new Error(dirty("git checkout")); },
  };
}

describe("parallel parts: a failing part", () => {
  it("throws fixed words; the raw error stays in causes and is never part of the message or its text", async () => {
    const failure = await executeParallelWorkflowDependencies(partsInput({ executeFailsFor: B })).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowPartsHaltedError);
    const halted = failure as WorkflowPartsHaltedError;
    expect(halted.message).toBe("work breakdown is paused after a failed part");
    expect(String(halted)).not.toContain(token());
    // What the run's end sends is `message` (worker/src/server.ts reads only that, through redactText).
    expect(redactText(halted.message)).toBe(halted.message);
    expect(halted.causes.map((cause) => cause.message).join("\n")).toContain("agent loop failed");
  });

  it("the error of the checkout of the integrated tree is collected the same way, not thrown as it is", async () => {
    const failure = await executeParallelWorkflowDependencies(partsInput({ executeFailsFor: B, checkoutFails: true })).then(() => undefined, (error: unknown) => error);
    const halted = failure as WorkflowPartsHaltedError;
    expect(halted.message).toBe("work breakdown is paused after a failed part");
    expect(halted.causes.some((cause) => cause.message.includes("git checkout failed"))).toBe(true);
    expect(String(halted)).not.toContain(token());
    expect(String(halted)).not.toContain(PASSWORD);
  });
});

describe("check runners: a rejection becomes a check entry", () => {
  const plan: CheckPlan = { source: "project", readiness: [{ cwd: ".", executable: "make", args: ["test"], timeoutSeconds: 60 }], projectBefore: ["passed"] };
  const runnersOf = (runProjectCommand: CheckRunners["runProjectCommand"]): CheckRunners => ({ runProjectCommand, runAgentCommand: async () => { throw new Error("not used"); } });
  const budget = { budgetMs: 600_000, signal: new AbortController().signal };

  it("stores a runner's error text redacted, as the output of a failed check", async () => {
    const round = await runChecks(plan, runnersOf(async () => { throw new Error(dirty("docker exec")); }), budget);
    const entry = round.entries[0]!;
    expect(entry.after).toBe("failed");
    expect(entry.output).toContain("docker exec failed for");
    expect(entry.output).toContain("[REDACTED]");
    expect(entry.output).not.toContain(token());
    expect(entry.output).not.toContain(PASSWORD);
  });

  it("stores the error with the workspace root taken out, and redacted", async () => {
    const root = "/mnt/workspace/acme";
    const rewrapped = withoutRootError(new Error(`${dirty("cd")} in ${root}/service`), root) as Error;
    expect(rewrapped.message).toContain("<workspace>/service");
    expect(rewrapped.message).not.toContain(root);
    const round = await runChecks(plan, runnersOf(async () => { throw rewrapped; }), budget);
    expect(round.entries[0]!.output).toContain("<workspace>/service");
    expect(round.entries[0]!.output).not.toContain(token());
  });
});
