// DEC 254zzz431 (review F2): the setup page's "starts from what the last run found" line is served only when a start would build a carry-over: an ended run within the 31 days with something to carry.
import { describe, expect, it } from "vitest";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { appendSetupJournal } from "../../packages/broker/src/core/setup-agent/journal.js";
import { createLocalSetupAgent } from "../../packages/broker/src/local/app/setup-agent.js";

async function started() {
  const h = createHarness(); await h.registerProject();
  const setup = createLocalSetupAgent({ flow: h.deps, registry: {} as never, gate: {} as never, owner: h.owner.principal, companyId: h.deps.companyId, now: () => h.clock.now, enabled: true, modelAccessConfigured: async () => true });
  const answer = await setup.routes({ method: "POST", path: "/v1/app/projects/payments/setup-agent", headers: {}, body: JSON.stringify({ requestId: newRequestId() }) }, h.owner);
  const taskId = (JSON.parse(answer!.body) as { taskId: string }).taskId;
  const end = async (ops: unknown[]) => { await h.store.update({ key: taskKey(taskId), ops } as never); };
  const journal = () => appendSetupJournal({ store: h.store, now: () => h.clock.now }, { orgId: h.deps.companyId, project: "payments", taskId }, [{ n: 1, source: "agent", command: "npm ci", exitCode: 0, durationMs: 9, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: new Date(h.clock.now).toISOString() }]);
  return { h, setup, taskId, end, journal };
}
const ended = (at: number) => [
  { op: "set", path: ["setupAgentResult"], value: { status: "failed", stop: "time_used", failure: "x" } },
  { op: "set", path: ["agentRunEnd"], value: { state: "FAILED", at: new Date(at).toISOString() } },
];

describe("the setup page's carry-over line is true", () => {
  it("is served for an ended run with something to carry, and not while it runs", async () => {
    const run = await started();
    expect((await run.setup.page.view("payments"))?.carriesOver).toBeUndefined();
    await run.journal();
    await run.end(ended(run.h.clock.now));
    expect((await run.setup.page.view("payments"))?.carriesOver).toBe(true);
  });
  it("is not served for an ended run with nothing to carry, one older than 31 days, or one that only reads as stale", async () => {
    const empty = await started();
    await empty.end(ended(empty.h.clock.now));
    expect((await empty.setup.page.view("payments"))?.carriesOver).toBeUndefined();
    const old = await started();
    await old.journal();
    await old.end(ended(old.h.clock.now - 32 * 86_400_000));
    expect((await old.setup.page.view("payments"))?.carriesOver).toBeUndefined();
    const stale = await started();
    await stale.journal();
    await stale.end([{ op: "set", path: ["setupAgentSeenAt"], value: new Date(stale.h.clock.now - 3_600_000).toISOString() }]);
    const view = await stale.setup.page.view("payments");
    expect(view?.status).toBe("failed");
    expect(view?.carriesOver).toBeUndefined();
  });
});
