// DEC 254zzz447 + 254zzz495 (N3): a project whose approved setup is "Ready, no automated tests" is not blocked by setup. A task starts on it exactly as on any project, and what the worker is sent never carries the fact.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, change, projectRevisionKey } from "@agentx/contracts";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

const FACT = { at: "2026-11-24T10:00:00.000Z", looked: ["tests_folder"] };

describe("a task on a project that was set up with no automated tests", () => {
  it("starts and is dispatched like any task, with no setup refusal", async () => {
    const h = createHarness();
    await h.registerProject(definition);
    // The fact is an attribute of the revision row beside the definition.
    await h.store.update({ key: projectRevisionKey(IMPLICIT_COMPANY_ID, "payments", 1), ops: [change.set("noAutomatedTests", FACT)] });
    expect((await h.deps.projects.latest("payments"))?.noAutomatedTests).toEqual(FACT);
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Fix the typo in the README" });
    expect(started.task.project).toBe("payments");
    for (let round = 0; round < 6; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break; h.clock.advance(70); }
    const workspace = (await h.store.get(workspaceKey(IMPLICIT_COMPANY_ID, started.task.workspaceId))) as unknown as WorkspaceRecord;
    const delivered = h.machines.delivered(workspace.machine!.machineId);
    expect(delivered.length).toBeGreaterThan(0);
    // What a worker is sent is the project without the control plane's own facts.
    for (const job of delivered) expect(JSON.stringify(job.payload)).not.toContain("noAutomatedTests");
  });
});
