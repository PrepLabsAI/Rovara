// Plan 4 Task 10: the chain-session contract Plan 5 reads. The keys of what the server writes are pinned here. Removing or renaming a key (or changing a type or a meaning)
// needs Plans 4 and 5 and a new CHAIN_SESSION_CONTRACT_VERSION; adding an optional field, an event type or a status stays in version 1.
import { describe, expect, it } from "vitest";
import { CHAIN_SESSION_CONTRACT_VERSION, ChainRunSectionSchema, ChainRunViewSchema } from "../../packages/contracts/src/chain-session.js";
import { CHAIN_RUN_EVENTS_PAGE_MAX, CHAIN_RUN_EVENT_TEXT_MAX, CHAIN_RUN_LIST_PAGE_MAX, ChainRunEventPageReaderSchema, ChainRunEventPageSchema, ChainRunEventReaderSchema, ChainRunEventSchema, ChainRunListReaderSchema, ChainRunListSchema, ChainRunSectionReaderSchema, ChainRunViewReaderSchema, ChainStepTaskViewReaderSchema, ChainStepTaskViewSchema } from "../../packages/contracts/src/chain-session.js";
import { openEnum } from "../../packages/contracts/src/forward-reader.js";

const HEX = "a".repeat(64);
const RUN = `crn_${"a".repeat(20)}`;
const CHAIN = `chn_${"b".repeat(20)}`;
const TRIGGER = `ctr_${"c".repeat(20)}`;
const AT = "2026-10-22T09:00:00.000Z";

const section = (extra: Record<string, unknown> = {}) => ({ seq: 1, stepId: "look", name: "Look into it", kind: "agent", status: "running", attempt: 1, startedAt: AT, ...extra });
const view = (extra: Record<string, unknown> = {}) => ({
  contractVersion: 1, sessionId: RUN, kind: "chain", chain: { chainId: CHAIN, name: "Investigate", version: 2 }, project: "web",
  chainOwner: { kind: "member", id: HEX, name: "Priya" }, owner: { developerId: HEX, name: "Priya" }, startedBy: { kind: "member", developerId: HEX, name: "Priya" },
  status: "running", currentSeq: 1, createdAt: AT, updatedAt: AT, cost: { spentUsd: 0.5, runLimitUsd: 30 }, sections: [section()], ...extra,
});
const event = (extra: Record<string, unknown> = {}) => ({ seq: 1, at: AT, type: "started", text: "Started.", ...extra });
const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

describe("the keys the server writes (version 1)", () => {
  it("is version 1", () => {
    expect(CHAIN_SESSION_CONTRACT_VERSION).toBe(1);
  });

  // Removing or renaming a key below needs Plans 4 and 5 (and a new version).
  it("pins the keys of the view, a section and an event", () => {
    expect(keys(ChainRunViewSchema)).toEqual([
      "chain", "chainOwner", "contractVersion", "cost", "createdAt", "currentSeq", "endedAt", "failure", "kind", "owner", "project", "sections", "sessionId", "startedBy", "status", "updatedAt",
    ]);
    expect(keys(ChainRunSectionSchema)).toEqual([
      "agent", "attempt", "branchTaken", "costUsd", "detail", "endedAt", "gate", "kind", "links", "name", "pendingApprovals", "report", "seq", "startedAt", "status", "stepId", "stopAtUsd",
    ]);
    expect(keys(ChainRunEventSchema)).toEqual(["at", "seq", "stepSeq", "text", "type"]);
    expect(keys(ChainStepTaskViewSchema)).toEqual(["rovaraCode", "seq", "task", "taskId"]);
  });

  it("names the owner once: `owner` is the run's, `chainOwner` the design's, and there is no other owner field", () => {
    const names = keys(ChainRunViewSchema);
    expect(names).toContain("owner");
    expect(names).toContain("chainOwner");
    expect(names).not.toContain("ownerDeveloperId");
    expect(ChainRunViewSchema.safeParse({ ...view(), ownerDeveloperId: HEX }).success).toBe(false);
  });

  it("parses a view of each way a run starts, and refuses a key it does not know at every level", () => {
    expect(ChainRunViewSchema.safeParse(view()).success).toBe(true);
    expect(ChainRunViewSchema.safeParse(view({ startedBy: { kind: "event", triggerId: TRIGGER, source: "sentry", type: "issue.created", title: "Errors", url: "https://sentry.example.com/1" } })).success).toBe(true);
    expect(ChainRunViewSchema.safeParse(view({ startedBy: { kind: "schedule", triggerId: TRIGGER, scheduledAt: AT } })).success).toBe(true);
    expect(ChainRunViewSchema.safeParse(view({ extra: 1 })).success).toBe(false);
    expect(ChainRunViewSchema.safeParse(view({ cost: { spentUsd: 0, runLimitUsd: 1, extra: 1 } })).success).toBe(false);
    expect(ChainRunViewSchema.safeParse(view({ sections: [section({ extra: 1 })] })).success).toBe(false);
    expect(ChainRunViewSchema.safeParse(view({ startedBy: { kind: "event", triggerId: TRIGGER, source: "sentry", type: "issue.created", title: "x", eventKey: "k" } })).success).toBe(false);
    expect(ChainRunEventSchema.safeParse(event({ extra: 1 })).success).toBe(false);
  });

  it("refuses an event's text over 500 characters, counting characters and not code units", () => {
    expect(ChainRunEventSchema.safeParse(event({ text: "😀".repeat(500) })).success).toBe(true);
    expect(ChainRunEventSchema.safeParse(event({ text: "😀".repeat(501) })).success).toBe(false);
  });

  it("refuses a view of another version", () => {
    expect(ChainRunViewSchema.safeParse(view({ contractVersion: 2 })).success).toBe(false);
  });
});

describe("what clients read: a newer server's view", () => {
  const newer = view({
    brandNew: { nested: true },
    status: "frozen",
    cost: { spentUsd: 0.5, runLimitUsd: 30, currency: "usd" },
    sections: [section({ kind: "review", status: "snoozed", futureField: 7, gate: { prompt: "Go?", status: "PARKED", approvers: "Max", confirmUrl: "https://cell.example.com/v1/app/approve/apr_x", extra: 1 } })],
  });

  it("is refused by the strict schemas", () => {
    expect(ChainRunViewSchema.safeParse(newer).success).toBe(false);
    expect(ChainRunEventSchema.safeParse(event({ type: "comment_added" })).success).toBe(false);
  });

  it("parses with the readers, keeps the extra fields and reads each new value as unknown", () => {
    const read = ChainRunViewReaderSchema.parse(newer);
    expect(read).toMatchObject({ brandNew: { nested: true }, status: "unknown", cost: { currency: "usd", spentUsd: 0.5 } });
    expect(read.sections[0]).toMatchObject({ kind: "unknown", status: "unknown", futureField: 7, gate: { status: "unknown", extra: 1, prompt: "Go?" } });
  });

  it("reads a new event type as unknown and keeps its text, and an unknown field", () => {
    const read = ChainRunEventReaderSchema.parse(event({ type: "comment_added", text: "Max commented.", by: "max" }));
    expect(read).toMatchObject({ type: "unknown", text: "Max commented.", by: "max", seq: 1 });
    expect(ChainRunEventPageReaderSchema.parse({ events: [event({ type: "comment_added" }), event({ seq: 2 })], next: 2, more: true })).toMatchObject({ events: [{ type: "unknown" }, { type: "started" }], more: true });
  });

  it("reads a known value as itself and keeps a section of a known kind whole", () => {
    expect(ChainRunSectionReaderSchema.parse(section({ status: "waiting", kind: "gate" }))).toMatchObject({ status: "waiting", kind: "gate" });
  });

  it("pins the page sizes", () => {
    expect([CHAIN_RUN_EVENTS_PAGE_MAX, CHAIN_RUN_LIST_PAGE_MAX, CHAIN_RUN_EVENT_TEXT_MAX]).toEqual([200, 50, 500]);
  });

  it("does not read a start of a kind it knows, with a field missing, as unknown", () => {
    expect(ChainRunViewReaderSchema.safeParse(view({ startedBy: { kind: "member", developerId: HEX } })).success).toBe(false);
  });

  it("reads a start of a kind it does not know as unknown, with its other fields", () => {
    const read = ChainRunViewReaderSchema.parse(view({ startedBy: { kind: "webhook", hookId: "h1" } }));
    expect(read.startedBy).toMatchObject({ kind: "unknown", hookId: "h1" });
  });

  it("still refuses what is not a view at all: a missing field that is not an enum, and a wrong type", () => {
    expect(ChainRunViewReaderSchema.safeParse({ ...view(), sessionId: 7 }).success).toBe(false);
    expect(ChainRunViewReaderSchema.safeParse({ ...view(), sections: "none" }).success).toBe(false);
  });

  it("builds the step task's and the list's readers the same way", () => {
    const task = { taskId: "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d", title: "t", project: "web", status: "RUNNING", startingRevision: 1, client: "app", shared: false, createdAt: AT, updatedAt: AT, events: [] };
    expect(ChainStepTaskViewSchema.safeParse({ seq: 3, taskId: "t1", rovaraCode: true, task }).success).toBe(true);
    expect(ChainStepTaskViewReaderSchema.parse({ seq: 3, taskId: "t1", rovaraCode: true, extra: 1, task: { ...task, status: "HOVERING" } })).toMatchObject({ extra: 1, task: { status: "unknown" } });
    const summary = { contractVersion: 1, sessionId: RUN, kind: "chain", chain: { chainId: CHAIN, name: "Investigate", version: 2 }, project: "web", owner: { developerId: HEX, name: "Priya" }, status: "running", currentSeq: 1, createdAt: AT, updatedAt: AT, cost: { spentUsd: 0, runLimitUsd: 30 } };
    expect(ChainRunListSchema.safeParse({ runs: [summary] }).success).toBe(true);
    expect(ChainRunListReaderSchema.parse({ runs: [{ ...summary, status: "frozen", more: 1 }], next: "abc" })).toMatchObject({ runs: [{ status: "unknown", more: 1 }] });
    expect(ChainRunEventPageSchema.safeParse({ events: [event()], next: 1 }).success).toBe(true);
  });
});

describe("openEnum", () => {
  const color = openEnum(["red", "green"] as const);
  it("reads a listed value as itself and anything else as unknown", () => {
    expect(color.parse("red")).toBe("red");
    expect(color.parse("blue")).toBe("unknown");
  });
  // One definition for both plans (forward-reader.ts): Plan 4's read a missing or non-string value as "unknown" too; Plan 5's, which won, keeps that an error.
  it("keeps a missing or non-string value an error", () => {
    expect(color.safeParse(undefined).success).toBe(false);
    expect(color.safeParse(3).success).toBe(false);
  });
});
