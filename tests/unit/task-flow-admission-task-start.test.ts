// The admission request for task.start says which path the task takes (Quick or Full) and the flow options that matter, so a host can set a different minimum room for each.
// The field is optional and additive: Code's own admission ignores it.
import { describe, expect, it } from "vitest";
import type { Admission, AdmissionRequest, TransactItem } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

function capturingAdmission(refuse?: (request: AdmissionRequest) => { code: string; message: string } | undefined): Admission & { requests: AdmissionRequest[] } {
  const requests: AdmissionRequest[] = [];
  const decide = (request: AdmissionRequest) => {
    requests.push(request);
    const refusal = refuse?.(request);
    return refusal === undefined ? { allowed: true as const } : { allowed: false as const, ...refusal };
  };
  return {
    requests,
    async admit(request) { return decide(request); },
    async stage(request) { return { decision: decide(request), items: [] as readonly TransactItem[] }; },
    async settle() {},
    async release() {},
  };
}

const startRequests = (admission: { requests: AdmissionRequest[] }): AdmissionRequest[] => admission.requests.filter((request) => request.action === "task.start");

describe("the task.start admission request", () => {
  it.each(["QUICK", "FULL"] as const)("names the %s path the request asked for", async (path) => {
    const admission = capturingAdmission();
    const h = createHarness({ admission, understandFirst: false });
    await h.registerProject();
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: path });
    const [request, ...rest] = startRequests(admission);
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ action: "task.start", projectName: "payments", taskStart: { workflow: true, path, pathFrom: "request" } });
  });

  it("names the path of a task that understands first and was told one, and says Understand chooses when it was not", async () => {
    const admission = capturingAdmission();
    const h = createHarness({ admission, understandFirst: true });
    await h.registerProject();
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Another change", workflow: true });
    const [told, unsure] = startRequests(admission);
    expect(told!.taskStart).toEqual({ workflow: true, path: "FULL", pathFrom: "request" });
    expect(unsure!.taskStart).toEqual({ workflow: true, pathFrom: "understand" });
  });

  it("says a task without the workflow has no path, and leaves the field off every other admission request", async () => {
    const admission = capturingAdmission();
    const h = createHarness({ admission });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Just do it" });
    expect(startRequests(admission)[0]!.taskStart).toEqual({ workflow: false });
    // The machine the first step starts is asked for under its own action, without it.
    await h.flow.dispatchOnce();
    const machine = admission.requests.find((request) => request.action === "machine.start");
    expect(machine).toBeDefined();
    expect(machine).not.toHaveProperty("taskStart");
    expect(started.task.taskId).toBeDefined();
  });

  it("lets a host refuse by path, with its own sentence, and never starts the task it refused", async () => {
    const admission = capturingAdmission((request) => request.taskStart?.path === "FULL" ? { code: "budget_exhausted", message: "Not enough room left for a Full task this month." } : undefined);
    const h = createHarness({ admission, understandFirst: false });
    await h.registerProject();
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Big change", workflow: true, workflowPath: "FULL" })).rejects.toThrow("Not enough room left for a Full task");
    const quick = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Small change", workflow: true, workflowPath: "QUICK" });
    expect(quick.duplicate).toBe(false);
  });

  it("starts as before on Code's own allow-all admission, which ignores the field", async () => {
    const h = createHarness({ understandFirst: false });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "QUICK" });
    expect(started.duplicate).toBe(false);
  });
});
