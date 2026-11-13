// The lease of a start is fenced by its holder, and a ticket's body survives a cut-short direct start.
import { describe, expect, it } from "vitest";
import { agentXError, intakeItemIdOf, type CodeIntentRequest, type OrgId } from "@rovara-code/contracts";
import { ingestIntake, startWaitingIntake, type IntakeCandidate, type IntakePorts } from "../../../packages/core/src/core/intake/engine.js";
import { readIntakeItem, INTAKE_START_LEASE_MS } from "../../../packages/core/src/core/intake/store.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
/** The tracker account of a person, in the neutral outside-account shape. */
const acct = (accountId: string) => ({ provider: "jira", tenant: "", accountId });
const PROJECT = "web";
const A = "a".repeat(64);
const B = "b".repeat(64);
const REF = { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
const ITEM = intakeItemIdOf("jira", "PAY-12");

function world() {
  const db = new RecordingStore();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const starts: Array<{ developerId: string; request: CodeIntentRequest }> = [];
  const gates: Array<{ release: (outcome: "ok" | "refuse" | "crash") => void }> = [];
  let tasks = 0;
  const ports: IntakePorts = {
    table: { store: db, now: () => clock.now },
    log: () => undefined,
    memberOfAccount: async (_o, account) => (account.accountId === "acct-a" ? A : undefined),
    mayStart: async (_o, developerId) => developerId === A || developerId === B,
    start: (_o, developerId, request) => new Promise((resolve, reject) => {
      starts.push({ developerId, request });
      gates.push({ release: (outcome) => {
        if (outcome === "ok") { tasks += 1; resolve({ task: { taskId: `task-${String(tasks)}` }, sessionId: `ses_${String(tasks).padStart(20, "0")}` }); }
        else if (outcome === "refuse") reject(agentXError("CONFIG_INVALID", "refused"));
        else reject(new Error("crash"));
      } });
    }),
    sessionOfTicket: async () => undefined,
  };
  return { db, clock, ports, starts, gates };
}

const ticket = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "jira", externalRef: REF, title: "Refunds fail", body: "Refunds over 100 fail with a 500.", reporter: { display: "Dana" },
  actor: { kind: "person", account: acct("acct-a"), display: "Maya" }, ...over,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = async (w: ReturnType<typeof world>) => (await readIntakeItem(w.ports.table, ORG, PROJECT, ITEM));

describe("only the holder of the lease can give back, release or finish a start", () => {
  async function takenOver() {
    const w = world();
    const first = ingestIntake(w.ports, ticket());
    await tick();
    w.clock.now += INTAKE_START_LEASE_MS + 1;
    const second = startWaitingIntake(w.ports, { orgId: ORG, project: PROJECT, itemId: ITEM, approver: B });
    await tick(); await tick();
    expect(w.starts).toHaveLength(2);
    return { w, first, second };
  }

  it("a stale holder's late refusal leaves the taker's start where it was, and the taker's success is recorded as started", async () => {
    const { w, first, second } = await takenOver();
    w.gates[0]!.release("refuse");
    await first;
    expect((await state(w))?.state).toBe("starting");
    w.gates[1]!.release("ok");
    expect(await second).toMatchObject({ outcome: "started" });
    expect(await state(w)).toMatchObject({ state: "started", startedBy: B });
  });

  it("a stale holder's late crash does not forget the taker's item", async () => {
    const { w, first, second } = await takenOver();
    w.gates[0]!.release("crash");
    await expect(first).rejects.toThrow();
    expect(await state(w)).toMatchObject({ state: "starting", startedBy: B });
    w.gates[1]!.release("ok");
    await second;
    expect((await state(w))?.state).toBe("started");
  });

  it("a stale holder's late success cannot overwrite the taker's: it counts as a duplicate, and never throws", async () => {
    const { w, first, second } = await takenOver();
    w.gates[1]!.release("ok");
    expect(await second).toMatchObject({ outcome: "started" });
    w.gates[0]!.release("ok");
    expect(["started", "duplicate"]).toContain((await first).outcome);
    expect(await state(w)).toMatchObject({ state: "started", startedBy: B });
  });

  it("a start that worked is never a thrown fault when the item can no longer be marked (the taker finished first)", async () => {
    const w = world();
    const first = ingestIntake(w.ports, ticket());
    await tick();
    // The item is gone (expired or removed) while the start runs.
    await w.db.delete({ key: { pk: `ORG#${ORG}#INTAKE_ITEM#${PROJECT}`, sk: ITEM } });
    w.gates[0]!.release("ok");
    expect(["started", "duplicate"]).toContain((await first).outcome);
  });
});

describe("a direct start that was cut short keeps the ticket's body for the next start", () => {
  it("a member's Start after the lease ran out carries the body", async () => {
    const w = world();
    void ingestIntake(w.ports, ticket());
    await tick();
    w.clock.now += INTAKE_START_LEASE_MS + 1;
    const second = startWaitingIntake(w.ports, { orgId: ORG, project: PROJECT, itemId: ITEM, approver: B });
    await tick(); await tick();
    expect(w.starts[1]!.request.input.context?.[0]?.body).toContain("Refunds over 100");
    w.gates[1]!.release("ok");
    await second;
  });
});
