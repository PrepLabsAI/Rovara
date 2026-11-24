// The website ask a parked run left behind stays decidable after the run ended on the 2-hour limit (DEC 254zzz428): the decision does not need the run to be going (`setupRunStarterOf` asks for a running run only
// for a NEW ask), so an admin can allow the website later, and the setup run again finds it allowed. The run again joins the same open ask (never a second card) until it is decided.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_FAILURES } from "../../packages/broker/src/core/setup-agent/agent.js";
import { approvedHostsOf, hostAskDigest, hostDecisionRequestId, listHostAsks, requestHostAsk, type SetupHostAsk } from "../../packages/broker/src/core/setup-agent/host-ask.js";
import { SETUP_AGENT_LIMITS_DEFAULT } from "@agentx/contracts";
import { SETUP_OPEN_HOST_NOTE, renderSetupPage } from "../../packages/broker/src/core/local-pages/setup-page.js";
import type { SetupPageView } from "../../packages/broker/src/core/local-pages/views.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import type { FakeWorld } from "../support/core-host-fakes.js";
import { FAKE_COMPANY, RUN, post, setupWorld } from "../support/hosted-setup-world.js";

const HOST = "deps.exampledeps.dev";
const DECIDE = `${RUN}/host-decide`;
const table = (world: FakeWorld) => ({ store: world.store, now: () => world.clock.now });

async function seedRun(world: FakeWorld, project: string): Promise<string> {
  const taskId = randomUUID();
  await world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", purpose: "setup_agent", companyId: FAKE_COMPANY, project, developerId: "p-starter", provider: HOSTED_IDENTITY_PROVIDER, workspaceId: randomUUID() } });
  return taskId;
}
/** The run ended on the 2-hour limit: its stored end, as the broker writes it (`recordSetupAgentEnd`). */
async function endRunWaiting(world: FakeWorld, taskId: string): Promise<void> {
  await world.store.update({ key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ops: [
    { op: "set", path: ["agentRunEnd"], value: { state: "failed", at: new Date(world.clock.now).toISOString() } },
    { op: "set", path: ["setupAgentResult"], value: { status: "failed", stop: "hosts_waiting", failure: SETUP_AGENT_FAILURES.hosts_waiting } },
  ] } as never);
}
const bodyFor = (ask: SetupHostAsk) => ({ requestId: hostDecisionRequestId(ask), host: ask.host, outcome: "approve", seen: { revision: 1, artifactDigest: hostAskDigest(ask) } });

describe("the website ask of a run that waited its 2 hours", () => {
  it("is still open and decidable after the run ended; allowing it works, and the setup run again sees the website allowed", async () => {
    const { world, person, call } = await setupWorld();
    const first = await seedRun(world, "payments");
    const made = await requestHostAsk(table(world), { orgId: FAKE_COMPANY, project: "payments", host: HOST, taskId: first, projectDomains: [] });
    if (made.outcome !== "created") throw new Error(`the ask was not made: ${made.outcome}`);
    await endRunWaiting(world, first);
    // The ended run asks nothing new, but its ask is still there.
    expect((await requestHostAsk(table(world), { orgId: FAKE_COMPANY, project: "payments", host: "other.exampledeps.dev", taskId: first, projectDomains: [] })).outcome).toBe("no_run");
    expect((await listHostAsks(table(world), FAKE_COMPANY, "payments")).map((ask) => ask.host)).toEqual([HOST]);
    // Run again, before anyone decided: the new run joins the same open ask (no second card).
    const second = await seedRun(world, "payments");
    expect((await requestHostAsk(table(world), { orgId: FAKE_COMPANY, project: "payments", host: HOST, taskId: second, projectDomains: [] })).outcome).toBe("joined");
    expect(await listHostAsks(table(world), FAKE_COMPANY, "payments")).toHaveLength(1);
    // An admin allows it (the run that asked is long gone): decided.
    const answered = await call(post(DECIDE, bodyFor(made.ask)), person("p-admin", FAKE_COMPANY, "admin"));
    expect(answered.status, answered.raw).toBe(200);
    expect(await approvedHostsOf(table(world), FAKE_COMPANY, "payments")).toEqual([HOST]);
    // The setup run again: the website is on the project's list, so the run needs no ask for it.
    const third = await seedRun(world, "payments");
    expect((await requestHostAsk(table(world), { orgId: FAKE_COMPANY, project: "payments", host: HOST, taskId: third, projectDomains: await approvedHostsOf(table(world), FAKE_COMPANY, "payments") })).outcome).toBe("already_allowed");
  });
});

describe("the Code setup page for a run that ended on a website with a partial setup", () => {
  const context = { base: "/local", nonce: "nonce", sessionId: "session", formToken: () => "token" };
  const page = (over: Partial<SetupPageView>): SetupPageView => ({
    project: "demo", revision: 1, status: "ready", limits: { ...SETUP_AGENT_LIMITS_DEFAULT }, items: [], verified: false, journal: [], hostAsks: [{ host: HOST, status: "open" }], check: { status: "unchecked" }, approvedHosts: [],
    summary: { commandsRun: 1, spendCents: 5, elapsedMin: 3, hostAsks: 1, partial: true, stop: "hosts_waiting" }, ...over,
  } as SetupPageView);
  it("says a website decision is still open and what to do (the status line alone says only \"finished\")", () => {
    const html = renderSetupPage(context, page({}));
    expect(html).toContain("Rovara finished and has a setup to use.");
    expect(html).toContain(SETUP_OPEN_HOST_NOTE);
    expect(SETUP_OPEN_HOST_NOTE).toBe("A website decision is still open: allow it, then run the setup again to include it.");
  });
  it("says nothing of the kind when no ask is open, when the run ended another way, or when the run did not finish with a setup", () => {
    expect(renderSetupPage(context, page({ hostAsks: [{ host: HOST, status: "approved", international: false }] }))).not.toContain(SETUP_OPEN_HOST_NOTE);
    expect(renderSetupPage(context, page({ summary: { commandsRun: 1, spendCents: 5, elapsedMin: 3, hostAsks: 1, partial: true, stop: "time_used" } }))).not.toContain(SETUP_OPEN_HOST_NOTE);
    expect(renderSetupPage(context, page({ status: "failed" }))).not.toContain(SETUP_OPEN_HOST_NOTE);
  });
});
