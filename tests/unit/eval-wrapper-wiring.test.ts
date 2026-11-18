// L4-EVW3: the setup run's wrapper seam as a host fills it (`setupRunEvalWrapper`): the actor is the run, the audit is written before the host write, a failed audit is no write, and no run named is no proposal.
import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditSink } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { proposeEvalWrappers } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { setupRunActorOf, setupRunEvalWrapper } from "../../packages/broker/src/core/setup-agent/eval-wrapper-wiring.js";
import { A, NOW, company, project, reportOf } from "../support/eval-card-world.js";

const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } } as const;
const URL_WEB = "https://github.com/acme/web";

function setup(audit: Partial<AuditSink> = {}) {
  const model = new FakeHostModel({ url: URL_WEB, id: "4242", fullName: "acme/web", webBase: "https://github.com" });
  const fake = new FakeCodeHost(model);
  const events: AuditEvent[] = [];
  const sink: AuditSink = { stage: () => [], record: async (event) => { events.push(event); }, ...audit };
  const w = company(A);
  const deps = setupRunEvalWrapper({ store: w.store, companyId: A, now: () => NOW, targets: async () => [{ name: "web", place: "fake:repo/4242", repository: { url: URL_WEB }, scope: { orgId: A }, host: fake }], audit: sink });
  return { model, events, deps };
}

describe("the setup run's eval wrapper seam", () => {
  it("audits as the setup run, before the write, and opens the one pull request", async () => {
    const h = setup({ record: async (event) => { expect(h.model.changeRequests).toHaveLength(0); h.events.push(event); } });
    const outcomes = await proposeEvalWrappers(h.deps, project, { report: reportOf(2, { output: ROWS }), taskId: "task-1", by: setupRunActorOf("task-1") });
    expect(outcomes).toMatchObject([{ state: "open", number: "1" }]);
    expect(h.model.changeRequests).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ companyId: A, actor: { type: "system", id: "setup-run:task-1" }, action: "eval_wrapper.proposed", subject: { type: "project", id: project }, details: { project, taskId: "task-1", language: "python" } });
    expect(h.events[0]!.eventId).toContain("task-1");
  });

  it("a record that cannot be written means no pull request", async () => {
    const h = setup({ record: async () => { throw new Error("down"); } });
    expect(await proposeEvalWrappers(h.deps, project, { report: reportOf(2, { output: ROWS }), taskId: "task-1", by: "setup-run:task-1" })).toMatchObject([{ state: "failed", failure: "audit" }]);
    expect(h.model.changeRequests).toHaveLength(0);
  });

  it("a proposal that names no setup run is not audited and not written", async () => {
    const h = setup();
    await expect(h.deps.audit({ action: "eval_wrapper.proposed", project, details: { repository: "web" } })).rejects.toThrow();
    expect(h.events).toEqual([]);
  });

  it("two repositories of one run with the same shape are two audit records (the event id names the repository)", async () => {
    const h = setup();
    for (const repository of ["web", "api"]) await h.deps.audit({ action: "eval_wrapper.proposed", project, details: { repository, language: "python", digest: "d".repeat(16), taskId: "task-1" } });
    expect(h.events).toHaveLength(2);
    expect(new Set(h.events.map((event) => event.eventId)).size).toBe(2);
  });
});
