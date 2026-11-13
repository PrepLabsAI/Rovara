// The intake loop guard does not trust the event's actor alone. A label or an assignment that Rovara wrote itself, through a member's own key, comes back from the tracker as that member's act. Rovara notes what it
// writes (before it sends it), and an event that matches a note is Rovara's own and starts nothing; an event on a ticket Rovara just changed in a way that can't be matched is not taken for a member's act (it waits for
// Start); a read of the notes that fails is no guess.
import { describe, expect, it } from "vitest";
import { DocumentStoreError, intakeItemIdOf, type CodeIntentRequest, type OrgId } from "@rovara-code/contracts";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../../packages/core/src/core/intake/engine.js";
import {
  OWN_WRITE_DELIVERY_LAG_MS, OWN_WRITE_LABEL_WINDOW_MS, OWN_WRITE_SKEW_MS, OWN_WRITE_TOUCH_WINDOW_MS, OWN_WRITE_WIDE_CAP_MS, noteOwnWrite, ownWriteVerdictOf,
} from "../../../packages/core/src/core/intake/own-writes.js";
import { readIntakeItem } from "../../../packages/core/src/core/intake/store.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "web";
const MEMBER = "a".repeat(64);
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const REF = { system: "sim", id: "T-12", url: "https://sim.example.test/T-12" };
const SCOPED = { system: "sim", id: "acme/web/7", url: "https://sim.example.test/acme/web/7" };

function world() {
  const db = new RecordingStore();
  const clock = { now: T0 };
  const started: Array<{ developerId: string; request: CodeIntentRequest }> = [];
  const ports: IntakePorts = {
    table: { store: db, now: () => clock.now },
    log: () => undefined,
    memberOfAccount: async (_org, account) => (account.provider === "sim" && account.accountId === "u1" ? MEMBER : undefined),
    mayStart: async () => true,
    start: async (_org, developerId, request) => { started.push({ developerId, request }); return { task: { taskId: `task-${String(started.length)}` }, sessionId: `ses_${String(started.length).padStart(20, "0")}` }; },
    sessionOfTicket: async () => undefined,
  };
  return { db, clock, ports, started };
}

const label = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "tracker", externalRef: REF, title: "Refunds fail", body: "Fails.", actor: { kind: "person", account: { provider: "sim", tenant: "", accountId: "u1" } },
  act: { kind: "label", value: "rovara" }, occurredAt: new Date(T0).toISOString(), eventId: "sim:evt:1", ...over,
});

describe("a label Rovara wrote through a member's key is Rovara's, not the member's", () => {
  it("starts nothing for the event that matches a note, and keeps no item for it", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, label())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.started).toEqual([]);
    expect(await readIntakeItem(w.ports.table, ORG, PROJECT, intakeItemIdOf("sim", "T-12"))).toBeUndefined();
  });

  it("is still Rovara's when the tracker delivers the same event again (a note is not used up)", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    for (let i = 0; i < 3; i += 1) expect(await ingestIntake(w.ports, label())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("matches the label whatever its case, and the ticket whatever the case of its id", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "ACME/Web/7", labels: ["ROVARA"] });
    expect(await ingestIntake(w.ports, label({ externalRef: SCOPED, act: { kind: "label", value: "Rovara" } }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("matches an assignment the same way", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", assignees: ["acct-rovara-bot"] });
    expect(await ingestIntake(w.ports, label({ act: { kind: "assignee", value: "acct-rovara-bot" }, eventId: "sim:evt:2" }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("does not match another label, another ticket, or another company", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    expect((await ingestIntake(w.ports, label({ act: { kind: "label", value: "urgent" }, eventId: "e-urgent" }))).outcome).toBe("started");
    expect((await ingestIntake(w.ports, label({ externalRef: { ...REF, id: "T-13", url: "https://sim.example.test/T-13" }, eventId: "e-13" }))).outcome).toBe("started");
    const other = world();
    await noteOwnWrite(other.ports.table, OTHER_ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    expect((await ingestIntake(other.ports, label())).outcome).toBe("started");
  });

  it("does not take an event from before the write for its echo (a member who labelled first still starts the work)", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    w.clock.now = T0 + OWN_WRITE_DELIVERY_LAG_MS + 1_000;
    expect((await ingestIntake(w.ports, label({ occurredAt: new Date(T0 - OWN_WRITE_SKEW_MS - 1_000).toISOString() }))).outcome).toBe("started");
  });

  it("stops matching after its window", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS + 1_000;
    expect((await ingestIntake(w.ports, label({ occurredAt: new Date(w.clock.now).toISOString() }))).outcome).toBe("started");
  });

  it("a new write extends the window, and the first write still covers an early event", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS - 1_000;
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS + 60_000;
    expect(await ingestIntake(w.ports, label({ occurredAt: new Date(w.clock.now).toISOString() }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(await ingestIntake(w.ports, label({ occurredAt: new Date(T0).toISOString(), eventId: "e-early" }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("a note for a whole repository is never `own`: an issue in it waits for a member, so a member's label on another issue is not lost", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", scope: "acme/web", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, label({ externalRef: SCOPED }))).toEqual({ outcome: "waiting", reason: "unverified" });
    const elsewhere = label({ externalRef: { system: "sim", id: "acme/other/7", url: "https://sim.example.test/acme/other/7" }, eventId: "e-other" });
    expect((await ingestIntake(w.ports, elsewhere)).outcome).toBe("started");
  });

  it("an event stamped by a clock far behind ours is still Rovara's echo when we received it right after the write", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", labels: ["rovara"] });
    w.clock.now = T0 + 20_000;
    expect(await ingestIntake(w.ports, label({ occurredAt: new Date(T0 - 30 * 60_000).toISOString() }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("Rovara labelled by a numeric id and the event names the ticket by its key: still Rovara's", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "10042", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, label({ alternateIds: ["10042"] }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect((await ingestIntake(w.ports, label({ eventId: "other", externalRef: { ...REF, id: "T-13", url: "https://sim.example.test/T-13" }, alternateIds: ["10099"] }))).outcome).toBe("started");
  });
});

describe("a ticket Rovara just changed in a way a note can't match is not taken for a member's act", () => {
  it("waits for Start (unverified) instead of starting, and starts nothing", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", touch: true });
    expect(await ingestIntake(w.ports, label())).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toEqual([]);
    expect(await readIntakeItem(w.ports.table, ORG, PROJECT, intakeItemIdOf("sim", "T-12"))).toMatchObject({ state: "waiting", reason: "unverified", requester: { standing: "outsider" } });
  });

  it("is only for a short while after the write", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", ticket: "T-12", touch: true });
    w.clock.now = T0 + OWN_WRITE_TOUCH_WINDOW_MS + 1_000;
    expect((await ingestIntake(w.ports, label({ occurredAt: new Date(w.clock.now).toISOString() }))).outcome).toBe("started");
  });
});

describe("wide notes are held per project and capped", () => {
  it("a wide write holds only the project it came from", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "sim", wide: true, project: PROJECT });
    expect(await ownWriteVerdictOf(w.ports.table, { orgId: ORG, project: PROJECT, externalRef: REF, act: { kind: "label", value: "rovara" }, occurredAt: new Date(T0).toISOString() })).toBe("touched");
    expect(await ownWriteVerdictOf(w.ports.table, { orgId: ORG, project: "api", externalRef: REF, act: { kind: "label", value: "rovara" }, occurredAt: new Date(T0).toISOString() })).toBe("none");
  });

  it("repeated writes cannot keep a project waiting past the cap, and the cap is logged", async () => {
    const w = world();
    const logs: string[] = [];
    for (let minute = 0; minute <= 70; minute += 5) {
      w.clock.now = T0 + minute * 60_000;
      await noteOwnWrite(w.ports.table, ORG, { system: "sim", wide: true, project: PROJECT }, (event) => { logs.push(event); });
    }
    expect(logs).toContain("intake.own_write_wide_cap");
    w.clock.now = T0 + OWN_WRITE_WIDE_CAP_MS + OWN_WRITE_TOUCH_WINDOW_MS + 1_000;
    expect(await ownWriteVerdictOf(w.ports.table, { orgId: ORG, project: PROJECT, externalRef: REF, occurredAt: new Date(w.clock.now).toISOString() })).toBe("none");
  });
});

describe("a read of the notes that fails is not a guess", () => {
  it("throws, so the delivery is made again, and starts nothing", async () => {
    const w = world();
    w.db.injectFault(new DocumentStoreError("unavailable", "the store is away"));
    const outcome = await ingestIntake(w.ports, label()).then(() => "no fault", (error: unknown) => (error instanceof DocumentStoreError ? error.code : "other"));
    expect(outcome).toBe("unavailable");
    expect(w.started).toEqual([]);
  });
});
