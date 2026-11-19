// a re-label after the ticket's task has ended starts a NEW task, linked to the old one. Only a member's act, with the same checks as the first
// start; each label event counts once (a replayed webhook starts nothing more); a re-label while the earlier task runs is a duplicate; a ticket that still carries its label after its task ended
// never restarts by itself (a poll has no label event).
import { describe, expect, it } from "vitest";
import { agentXError, intakeItemIdOf, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { ingestIntake, startWaitingIntake, type IntakeCandidate, type IntakePorts } from "../../../packages/broker/src/core/intake/engine.js";
import { listWaitingIntakeItems, readIntakeItem } from "../../../packages/broker/src/core/intake/store.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
/** The tracker account of a person, in the neutral outside-account shape. */
const acct = (accountId: string) => ({ provider: "github", tenant: "", accountId });
const PROJECT = "web";
const MEMBER = "a".repeat(64);
const OTHER_MEMBER = "b".repeat(64);
const REF = { system: "github", id: "acme/web/7", url: "https://github.com/acme/web/issues/7" };
const ITEM = intakeItemIdOf("github", "acme/web/7");

function world() {
  const db = new RecordingStore();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const started: Array<{ developerId: string; request: CodeIntentRequest }> = [];
  const links = new Map<string, string>([["github:1", MEMBER], ["github:2", OTHER_MEMBER]]);
  /** The session each ticket follows, and which have ended. */
  const bound = new Map<string, string>();
  const ended = new Set<string>();
  const freed: string[] = [];
  const linked: Array<{ next: string; previous: string }> = [];
  const state: { fail?: Error | undefined } = {};
  let tasks = 0;
  const key = (binding: { system: string; id: string }) => `${binding.system}:${binding.id}`;
  const ports: IntakePorts = {
    table: { store: db, now: () => clock.now },
    log: () => undefined,
    memberOfAccount: async (_o, account) => links.get(`${account.provider}:${account.accountId}`),
    mayStart: async (_o, developerId) => developerId === MEMBER || developerId === OTHER_MEMBER,
    start: async (_o, developerId, request) => {
      if (state.fail !== undefined) { const error = state.fail; state.fail = undefined; throw error; }
      // The start's own idempotency: the same request id is the first task.
      const seen = started.findIndex((entry) => entry.request.requestId === request.requestId);
      if (seen >= 0) return { task: { taskId: `task-${String(seen + 1)}` }, sessionId: `ses_${String(seen + 1).padStart(20, "0")}` };
      started.push({ developerId, request });
      tasks += 1;
      const sessionId = `ses_${String(tasks).padStart(20, "0")}`;
      if (request.binding?.kind === "tracker_item") {
        if (bound.has(key(request.binding))) throw agentXError("CONFIG_INVALID", "This ticket already follows another session.");
        bound.set(key(request.binding), sessionId);
      }
      return { task: { taskId: `task-${String(tasks)}` }, sessionId };
    },
    sessionOfTicket: async (_o, binding) => {
      const sessionId = bound.get(key(binding));
      return sessionId === undefined ? undefined : { sessionId, ended: ended.has(sessionId) };
    },
    freeTicket: async (_o, sessionId) => { freed.push(sessionId); for (const [ticket, id] of bound) if (id === sessionId) bound.delete(ticket); },
    linkPrevious: async (_o, next, previous) => { linked.push({ next, previous }); },
  };
  return { db, clock, ports, started, links, bound, ended, freed, linked, state };
}

const label = (eventId: string, over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "github_issue", externalRef: REF, title: "Checkout fails", body: "Checkout returns 500.", eventId,
  actor: { kind: "person", account: acct("1"), display: "maya" }, ...over,
});

async function firstTaskEnded() {
  const w = world();
  expect(await ingestIntake(w.ports, label("e1"))).toMatchObject({ outcome: "started", taskId: "task-1" });
  w.ended.add("ses_00000000000000000001");
  return w;
}

describe("a re-label by a member after the task ended", () => {
  it("starts a new task, bound to the ticket again, as that member, and links it to the old one", async () => {
    const w = await firstTaskEnded();
    const outcome = await ingestIntake(w.ports, label("e2", { actor: { kind: "person", account: acct("2") } }));
    expect(outcome).toMatchObject({ outcome: "started", taskId: "task-2" });
    expect(w.started).toHaveLength(2);
    expect(w.started[1]!.developerId).toBe(OTHER_MEMBER);
    expect(w.started[1]!.request.binding).toMatchObject({ kind: "tracker_item", system: "github", id: "acme/web/7" });
    expect(w.started[1]!.request.requestId).not.toBe(w.started[0]!.request.requestId);
    // The old session let go of the ticket first, and the new one points back to it.
    expect(w.freed).toEqual(["ses_00000000000000000001"]);
    expect(w.linked).toEqual([{ next: "ses_00000000000000000002", previous: "ses_00000000000000000001" }]);
    expect(await readIntakeItem(w.ports.table, ORG, PROJECT, ITEM)).toMatchObject({ state: "started", generation: 2, previousSessionId: "ses_00000000000000000001", previousTaskId: "task-1", sessionId: "ses_00000000000000000002" });
  });

  it("starts a new task even for the same member (the request id is not the first task's)", async () => {
    const w = await firstTaskEnded();
    expect(await ingestIntake(w.ports, label("e2"))).toMatchObject({ outcome: "started", taskId: "task-2" });
    expect(w.started.map((entry) => entry.developerId)).toEqual([MEMBER, MEMBER]);
  });

  it("works the third time too: each ended task can be followed by another", async () => {
    const w = await firstTaskEnded();
    await ingestIntake(w.ports, label("e2"));
    w.ended.add("ses_00000000000000000002");
    expect(await ingestIntake(w.ports, label("e3"))).toMatchObject({ outcome: "started", taskId: "task-3" });
    expect(w.linked.at(-1)).toEqual({ next: "ses_00000000000000000003", previous: "ses_00000000000000000002" });
  });

  it("also restarts when the ticket's session is gone altogether (its hold expired)", async () => {
    const w = await firstTaskEnded();
    w.bound.clear();
    expect(await ingestIntake(w.ports, label("e2"))).toMatchObject({ outcome: "started", taskId: "task-2" });
  });

  it("never lets Rovara's own label change start anything", async () => {
    const w = await firstTaskEnded();
    expect(await ingestIntake(w.ports, label("e2", { actor: { kind: "rovara" } }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.started).toHaveLength(1);
  });
});

describe("a re-label by someone who is not a member after the task ended", () => {
  it("makes the ticket wait for a member to say Start, and starts nothing", async () => {
    const w = await firstTaskEnded();
    expect(await ingestIntake(w.ports, label("e2", { actor: { kind: "person", account: acct("999") } }))).toEqual({ outcome: "waiting", reason: "unlinked" });
    expect(w.started).toHaveLength(1);
    const waiting = await listWaitingIntakeItems(w.ports.table, ORG, PROJECT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: "acme/web/7", reason: "unlinked" });
  });

  it("starts, linked to the old task, when a member then presses Start", async () => {
    const w = await firstTaskEnded();
    await ingestIntake(w.ports, label("e2", { actor: { kind: "unknown" } }));
    const outcome = await startWaitingIntake(w.ports, { orgId: ORG, project: PROJECT, itemId: ITEM, approver: OTHER_MEMBER });
    expect(outcome).toMatchObject({ outcome: "started", taskId: "task-2" });
    expect(w.started[1]!.request.input.context?.[0]?.body).toContain("Checkout returns 500.");
    expect(w.linked).toEqual([{ next: "ses_00000000000000000002", previous: "ses_00000000000000000001" }]);
  });

  it("an automation's re-label waits too", async () => {
    const w = await firstTaskEnded();
    expect(await ingestIntake(w.ports, label("e2", { actor: { kind: "bot", account: acct("1") } }))).toEqual({ outcome: "waiting", reason: "bot" });
  });
});

describe("a re-label while the earlier task still runs", () => {
  it("starts nothing and is a duplicate, and lets go of nothing", async () => {
    const w = world();
    await ingestIntake(w.ports, label("e1"));
    expect(await ingestIntake(w.ports, label("e2"))).toEqual({ outcome: "duplicate", state: "started" });
    expect(w.started).toHaveLength(1);
    expect(w.freed).toEqual([]);
  });
});

describe("each label event counts once", () => {
  it("a replayed re-label starts one new task", async () => {
    const w = await firstTaskEnded();
    const outcomes = [await ingestIntake(w.ports, label("e2")), await ingestIntake(w.ports, label("e2"))];
    expect(outcomes[0]).toMatchObject({ outcome: "started" });
    expect(outcomes[1]!.outcome).toBe("duplicate");
    expect(w.started).toHaveLength(2);
  });

  it("two re-labels at the same moment start one new task", async () => {
    const w = await firstTaskEnded();
    const outcomes = await Promise.all([ingestIntake(w.ports, label("e2")), ingestIntake(w.ports, label("e3"))]);
    expect(outcomes.filter((entry) => entry.outcome === "started")).toHaveLength(1);
    expect(w.started).toHaveLength(2);
  });

  it("a replay of the FIRST label event after the task ended starts nothing", async () => {
    const w = await firstTaskEnded();
    expect(await ingestIntake(w.ports, label("e1"))).toMatchObject({ outcome: "duplicate" });
    expect(w.started).toHaveLength(1);
  });

  it("a fault that may pass gives the event back, and the redelivery starts the new task once", async () => {
    const w = await firstTaskEnded();
    w.state.fail = new Error("away");
    await expect(ingestIntake(w.ports, label("e2"))).rejects.toThrow();
    expect(await ingestIntake(w.ports, label("e2"))).toMatchObject({ outcome: "started", taskId: "task-2" });
    expect(w.started).toHaveLength(2);
  });
});

describe("a ticket that still has its label after its task ended", () => {
  it("is not started again by a poll, however often it sees it (a poll has no label event)", async () => {
    const w = await firstTaskEnded();
    for (let tick = 0; tick < 5; tick += 1) expect((await ingestIntake(w.ports, label("x", { eventId: undefined }))).outcome).toBe("duplicate");
    expect(w.started).toHaveLength(1);
    expect(w.freed).toEqual([]);
  });
});
