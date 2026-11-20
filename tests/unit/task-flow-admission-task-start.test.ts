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

});

it("captures the server quote once on the real idempotent start", async () => {
 const { startEstimates } = await import("../../packages/broker/src/core/cost/start-estimates.js");
 let captures = 0;
 const h = createHarness({ understandFirst: false, extra: () => ({ captureStartComparison: async ({ project, inputText }: { project: string; inputText: string }) => {
  captures++;
  h.clock.advance(1);
  return startEstimates({ store: h.store }, { orgId: h.deps.companyId, project, request: { quoteVersion: 2, inputText }, asOf: new Date(h.clock.now).toISOString(), context: { policyRevision: "test-policy", stages: { build: {
   model: { state: "available", value: { provider: "anthropic", modelId: "claude-test" } },
   source: { state: "available", value: { kind: "company_key", id: "own", name: "Own", provider: "anthropic", connectionRevision: "1" } },
   price: { state: "available", value: { authority: "gateway", version: "1", hash: "a".repeat(64), fetchedAt: "2026-11-09T09:00:00.000Z" } },
  } }, limits: [] } });
 } }) });
 await h.registerProject();
 const body = { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true as const, workflowPath: "QUICK" as const };
 const first = await h.flow.start(h.owner, body);
 const row = await h.store.get({ pk: `DEVTASK#${first.task.taskId}`, sk: "META" });
 expect(row?.["startComparison"]).toMatchObject({ selectedPath: "QUICK", quoteVersion: 2, policyRevision: "test-policy", options: [{ path: "QUICK" }, { path: "FULL" }] });
 expect(row?.["usageStartQuote"]).toMatchObject({ path: "QUICK", basis: "default", modelPriced: false, inputs: {
  model: { state: "available", value: { provider: "anthropic", modelId: "claude-test" } },
  source: { state: "available", value: { id: "own", connectionRevision: "1" } },
  price: { state: "available", value: { hash: "a".repeat(64) } },
  optionsVersion: { state: "available", value: "start-preview-v2:000" },
 } });
 const { recordClosedRunUsage, runUsageKey } = await import("../../packages/broker/src/core/cost/run-usage.js");
 await recordClosedRunUsage({ store: h.store }, { companyId: h.deps.companyId, project: "payments", taskId: first.task.taskId, usageStartQuote: row!["usageStartQuote"] } as Parameters<typeof recordClosedRunUsage>[1], "2026-11-09T10:01:00.000Z");
 expect((await h.store.get(runUsageKey(h.deps.companyId, "payments", first.task.taskId)))?.["sample"]).toMatchObject({ optionsVersion: { state: "available", value: "start-preview-v2:000" } });
 expect((await h.flow.start(h.owner, body)).duplicate).toBe(true);
 expect(captures).toBe(1);
});
