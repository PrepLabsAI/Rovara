// Plan 4 Task 10: the chain-session contract Plan 5 reads. The keys of what the server writes are pinned here. Removing or renaming a key (or changing a type or a meaning)
// needs Plans 4 and 5 and a new CHAIN_SESSION_CONTRACT_VERSION; adding an optional field, an event type or a status stays in version 1.
import { describe, expect, it } from "vitest";
import { CHAIN_SESSION_CONTRACT_VERSION, ChainRunSectionSchema, ChainRunViewSchema } from "../../packages/contracts/src/chain-session.js";
import { CHAIN_RUN_EVENTS_PAGE_MAX, CHAIN_RUN_EVENT_TEXT_MAX, CHAIN_RUN_LIST_PAGE_MAX, ChainRunEventPageReaderSchema, ChainRunEventPageSchema, ChainRunEventReaderSchema, ChainRunEventSchema, ChainRunListReaderSchema, ChainRunListSchema, ChainRunSectionReaderSchema, ChainRunViewReaderSchema, ChainStepTaskViewReaderSchema, ChainStepTaskViewSchema } from "../../packages/contracts/src/chain-session.js";
import { openEnum } from "../../packages/contracts/src/forward-reader.js";

const HEX = "a".repeat(64);
const RUN = `crn_${"a".repeat(20)}`;
const CHAIN = `chn_${"b".repeat(20)}`;
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

});

describe("what clients read: a newer server's view", () => {

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

  it("reads a start of a kind it does not know as unknown, with its other fields", () => {
    const read = ChainRunViewReaderSchema.parse(view({ startedBy: { kind: "webhook", hookId: "h1" } }));
    expect(read.startedBy).toMatchObject({ kind: "unknown", hookId: "h1" });
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
  // One definition for both plans (forward-reader.ts): Plan 4's read a missing or non-string value as "unknown" too; Plan 5's, which won, keeps that an error.
  it("keeps a missing or non-string value an error", () => {
    expect(color.safeParse(undefined).success).toBe(false);
    expect(color.safeParse(3).success).toBe(false);
  });
});
