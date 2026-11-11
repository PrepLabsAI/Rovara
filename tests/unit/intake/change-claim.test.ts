// a Jira change id is used once per COMPANY. A real label-add that a person made, handed to a second project's hook (by someone who holds that hook's secret) must not start a task
// as that person. The claim is written only after Jira confirmed the change, so a made-up change id cannot use up a real one.
import { describe, expect, it } from "vitest";
import { intakeChangeKey, intakeItemIdOf, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../../packages/broker/src/core/intake/engine.js";
import { claimIntakeChange, listWaitingIntakeItems } from "../../../packages/broker/src/core/intake/store.js";
import { jiraActOf as adapterJiraActOf } from "../../../packages/broker/src/plugins/tracker/jira/index.js";

const jiraActOf = (histories: readonly unknown[], act: { kind: "label" | "assignee"; value: string }) => adapterJiraActOf(histories, act, "https://acme.atlassian.net");
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
/** The tracker account of a person, in the neutral outside-account shape. */
const acct = (accountId: string) => ({ provider: "jira", tenant: "", accountId });
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MEMBER = "a".repeat(64);
const SITE = "https://acme.atlassian.net";

function world() {
  const db = new RecordingStore();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const started: Array<{ orgId: OrgId; project: string; developerId: string; binding: unknown }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const failNext: { error?: Error | undefined } = {};
  let tasks = 0;
  const ended = new Set<string>();
  const sessions = new Map<string, string>();
  const ports: IntakePorts = {
    table: { store: db, now: () => clock.now },
    log: (event, fields) => { logs.push({ event, fields }); },
    memberOfAccount: async (_org, account) => (account.provider === "jira" && account.accountId === "acct-dana" ? MEMBER : undefined),
    mayStart: async () => true,
    start: async (orgId, developerId, request: CodeIntentRequest) => {
      if (failNext.error !== undefined) { const error = failNext.error; failNext.error = undefined; throw error; }
      started.push({ orgId, project: request.project, developerId, binding: request.binding });
      tasks += 1;
      if (request.binding?.kind === "tracker_item") sessions.set(`${orgId}:${request.binding.id}`, `ses_${String(tasks).padStart(20, "0")}`);
      return { task: { taskId: `task-${String(tasks)}` }, sessionId: `ses_${String(tasks).padStart(20, "0")}` };
    },
    sessionOfTicket: async (org, binding) => { const sessionId = sessions.get(`${org}:${binding.id}`); return sessionId === undefined ? undefined : { sessionId, ...(ended.has(sessionId) ? { ended: true } : {}) }; },
    freeTicket: async (_org, sessionId) => { for (const [id, value] of sessions) if (value === sessionId) sessions.delete(id); },
  };
  const endAll = (): void => { for (const sessionId of sessions.values()) ended.add(sessionId); };
  return { db, clock, ports, started, logs, failNext, endAll };
}

const candidate = (over: Partial<IntakeCandidate> & { key?: string; changeId?: string } = {}): IntakeCandidate => {
  const key = over.key ?? "PAY-12";
  return {
    orgId: ORG, project: "web", channel: "jira", externalRef: { system: "jira", id: key, url: `${SITE}/browse/${key}` }, title: "Refunds fail", body: "Refunds fail.",
    actor: { kind: "person", account: acct("acct-dana"), display: "Dana" }, act: { kind: "label", value: "rovara" },
    // This tracker's deliveries are believed only on its own word (`confirmActor`).
    trackerWord: "required" as const,
    eventId: `jira:issue:10042:labeled:rovara:${over.changeId ?? "10124"}`, occurredAt: new Date(Date.parse("2026-10-31T10:00:00.000Z") - 5_000).toISOString(), ...over,
  };
};
const real = async () => "person" as const;

describe("a Jira change is used once per company", () => {
  it("refuses the same change handed to a second project's hook in the company, and starts no second task", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    const second = await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real });
    expect(second).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toEqual([expect.objectContaining({ project: "web", developerId: MEMBER })]);
    // The loser is visible, not silent: a maintainer sees the waiting ticket and can press Start.
    expect(await listWaitingIntakeItems(w.ports.table, ORG, "api")).toMatchObject([{ id: "API-3", reason: "unverified" }]);
    expect(w.logs.filter((entry) => entry.event === "intake.change_replayed")).toEqual([{ event: "intake.change_replayed", fields: { orgId: ORG, project: "api", system: "jira" } }]);
  });

  it("refuses the same change for another ticket of the same project too", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    expect(await ingestIntake(w.ports, candidate({ key: "PAY-99" }), { confirmActor: real })).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toHaveLength(1);
  });

  it("allows the same change id in two different companies (it is a different Jira site's change)", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, candidate({ orgId: OTHER_ORG }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started.map((entry) => entry.orgId)).toEqual([ORG, OTHER_ORG]);
  });

  it("allows the same change id on a different Jira site of one company", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const other = candidate({ project: "api", key: "API-3" });
    other.externalRef = { system: "jira", id: "API-3", url: "https://other.atlassian.net/browse/API-3" };
    expect(await ingestIntake(w.ports, other, { confirmActor: real })).toMatchObject({ outcome: "started" });
  });

  it("keeps a retry of the same delivery to the same hook idempotent: one task, a duplicate, no error", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(w.started).toHaveLength(1);
  });

  it("lets a second label of the same change on the same ticket through (one change may add several labels)", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const again = candidate({ eventId: "jira:issue:10042:labeled:other:10124", act: { kind: "label", value: "other" } });
    expect(await ingestIntake(w.ports, again, { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
  });

  it("starts exactly one task when two deliveries of one change race, to two projects or to one", async () => {
    const twoProjects = world();
    const results = await Promise.all([
      ingestIntake(twoProjects.ports, candidate({ project: "web" }), { confirmActor: real }),
      ingestIntake(twoProjects.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real }),
    ]);
    expect(results.filter((outcome) => outcome.outcome === "started")).toHaveLength(1);
    expect(twoProjects.started).toHaveLength(1);
    const oneProject = world();
    await Promise.all([1, 2, 3].map(() => ingestIntake(oneProject.ports, candidate(), { confirmActor: real })));
    expect(oneProject.started).toHaveLength(1);
  });

  it("does not use a change up when the tracker did not confirm it (a made-up change id cannot burn a real one)", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: async () => "unverified" })).toMatchObject({ outcome: "waiting", reason: "unverified" });
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started).toHaveLength(1);
  });

  it("uses a change up when the member could not start in the first project (a replay into one they can is refused)", async () => {
    const w = world();
    w.ports.mayStart = async (_org, _developer, project) => project === "web";
    expect(await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real })).toMatchObject({ outcome: "waiting", reason: "no_authority" });
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toEqual([]);
  });

  it("gives the change back when the start has a fault that may pass, so the redelivery starts the task", async () => {
    const w = world();
    w.failNext.error = Object.assign(new Error("away"), { statusCode: 503 });
    await expect(ingestIntake(w.ports, candidate(), { confirmActor: real })).rejects.toThrow("away");
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started).toHaveLength(1);
  });

  it("keeps the claim for longer than the 24 hour replay window, and keys it by company, site and change", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const act = { kind: "label", value: "rovara" };
    const key = intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124", act);
    const stored = { Item: await w.db.get(key) as Record<string, unknown> | undefined };
    expect(stored.Item).toMatchObject({ entityType: "INTAKE_CHANGE", project: "web", itemId: intakeItemIdOf("jira", "PAY-12") });
    expect(Number(stored.Item?.["indexExpiresAt"])).toBeGreaterThan(w.clock.now / 1000 + 2 * 86_400);
    expect(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124", act)).not.toEqual(intakeChangeKey(OTHER_ORG, "jira", "acme.atlassian.net", "10124", act));
    expect(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124", act)).not.toEqual(intakeChangeKey(ORG, "jira", "other.atlassian.net", "10124", act));
    expect(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124", act)).not.toEqual(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124", { kind: "label", value: "other" }));
    expect(await claimIntakeChange(w.ports.table, { orgId: ORG, system: "jira", site: "acme.atlassian.net", changeId: "10124", act, project: "api", itemId: intakeItemIdOf("jira", "API-3") })).toBe("taken");
  });

  it("asks nobody and claims nothing for an outsider's act", async () => {
    const w = world();
    let asked = 0;
    const outsider = candidate({ actor: { kind: "person", account: acct("acct-stranger") } });
    expect(await ingestIntake(w.ports, outsider, { confirmActor: async () => { asked += 1; return "person"; } })).toMatchObject({ outcome: "waiting", reason: "unlinked" });
    expect(asked).toBe(0);
  });

  it("the same real change re-sent to the same project's hook with another issue id starts no new task, even after the task ended", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "started" });
    w.endAll();
    // The body's own issue id (part of the event key) was never checked by Jira; the confirmed parts (site, change, act) are the same.
    const resent = candidate({ eventId: "jira:issue:99999:labeled:rovara:10124" });
    expect(await ingestIntake(w.ports, resent, { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(await ingestIntake(w.ports, candidate({ eventId: "jira:issue:12345:labeled:rovara:10124" }), { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(w.started).toHaveLength(1);
  });

  it("a genuinely new change after the task ended still starts a new task (the check is sensitive)", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    w.endAll();
    expect(await ingestIntake(w.ports, candidate({ eventId: "jira:issue:10042:labeled:rovara:10200" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started).toHaveLength(2);
  });

  it("the task starts on the confirmed ticket (the key the tracker confirmed), not on a field of the body", async () => {
    const w = world();
    const resent = candidate({ eventId: "jira:issue:99999:labeled:rovara:10124", alternateIds: ["99999"] });
    await ingestIntake(w.ports, resent, { confirmActor: real });
    expect(w.started).toHaveLength(1);
    expect(w.started[0]!.binding).toMatchObject({ kind: "tracker_item", system: "jira", id: "PAY-12", url: `${SITE}/browse/PAY-12` });
  });

  it("one change that adds two labels, each for a different project, starts both (the act is part of the key)", async () => {
    const w = world();
    const webFix = candidate({ project: "web", eventId: "jira:issue:10042:labeled:web-fix:10124", act: { kind: "label", value: "web-fix" } });
    const apiFix = candidate({ project: "api", key: "API-3", eventId: "jira:issue:10042:labeled:api-fix:10124", act: { kind: "label", value: "api-fix" } });
    expect(await ingestIntake(w.ports, webFix, { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, apiFix, { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started.map((entry) => entry.project)).toEqual(["web", "api"]);
  });

  it("two projects watching the same label for the same change: one starts, the other waits visibly (nothing starts as the person twice)", async () => {
    const w = world();
    const results = await Promise.all([
      ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real }),
      ingestIntake(w.ports, candidate({ project: "api" }), { confirmActor: real }),
    ]);
    expect(results.map((outcome) => outcome.outcome).sort()).toEqual(["started", "waiting"]);
    expect(w.started).toHaveLength(1);
    const loser = w.started[0]!.project === "web" ? "api" : "web";
    expect(await listWaitingIntakeItems(w.ports.table, ORG, loser)).toMatchObject([{ id: "PAY-12", reason: "unverified" }]);
  });

  it("a poll that read the change from Jira's change log claims it, so a replay into another project waits", async () => {
    const w = world();
    const polled = candidate({ eventId: undefined, occurredAt: undefined, change: { id: "10124", act: { kind: "label", value: "rovara" } } });
    expect(await ingestIntake(w.ports, polled)).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, polled)).toMatchObject({ outcome: "duplicate" });
    expect(await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real })).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(await ingestIntake(w.ports, { ...polled, project: "api", externalRef: { system: "jira", id: "API-4", url: `${SITE}/browse/API-4` } })).toMatchObject({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toHaveLength(1);
  });

  it("a poll gives its claim back when the start has a fault that may pass", async () => {
    const w = world();
    const polled = candidate({ eventId: undefined, occurredAt: undefined, change: { id: "10124", act: { kind: "label", value: "rovara" } } });
    w.failNext.error = Object.assign(new Error("away"), { statusCode: 503 });
    await expect(ingestIntake(w.ports, polled)).rejects.toThrow("away");
    expect(await ingestIntake(w.ports, polled)).toMatchObject({ outcome: "started" });
  });

  it("a webhook body cannot carry a poll's change (only a poll's search sets it)", async () => {
    const w = world();
    // With an event id, the engine ignores `change`: the tracker's confirmation decides.
    const body = candidate({ change: { id: "10124", act: { kind: "label", value: "rovara" } } });
    expect(await ingestIntake(w.ports, body)).toMatchObject({ outcome: "waiting", reason: "unverified" });
  });

  it("jiraActOf names the change that made the act, and nothing for a customer or an app", () => {
    const histories = [
      { id: "10100", created: "2026-10-31T09:00:00.000+0000", author: { accountId: "acct-old", accountType: "atlassian" }, items: [{ field: "labels", fromString: "", toString: "rovara" }] },
      { id: "10124", created: "2026-10-31T09:59:00.000+0000", author: { accountId: "acct-dana", accountType: "atlassian" }, items: [{ field: "labels", fromString: "bug", toString: "bug rovara" }] },
    ];
    expect(jiraActOf(histories, { kind: "label", value: "rovara" })).toMatchObject({ actor: { kind: "person", account: { provider: "jira", tenant: "acme.atlassian.net", accountId: "acct-dana" } }, changeId: "10124" });
    expect(jiraActOf([{ ...histories[1], author: { accountId: "x", accountType: "app" } }], { kind: "label", value: "rovara" })).toEqual({ actor: { kind: "bot" }, at: "2026-10-31T09:59:00.000Z" });
    expect(jiraActOf([{ ...histories[1], author: { accountId: "x", accountType: "customer" } }], { kind: "label", value: "rovara" })).toEqual({});
  });
});
