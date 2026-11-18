// Lead 4, slice A4: merge tracking writes the work events of a workflow change it makes (a fix or a sync started while the task waited for its merge) in the same transaction, and an event is never why a pass fails.
import { describe, expect, it } from "vitest";
import { listWorkEvents } from "../../packages/broker/src/core/work-events/work-events.js";
import { flowWorkEventItems } from "../../packages/broker/src/core/work-events/flow-events.js";
import { registerMergeActionDecider, trackPullRequest } from "../../packages/broker/src/core/merge/index.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const request = (world: MergeWorld, workflow: Awaited<ReturnType<MergeWorld["task"]>>["workflow"]) => ({
  slot: "sync" as const, workflow: { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: "2026-11-09T10:00:01.000Z" } as typeof workflow,
  steps: [{ kind: "put" as const, item: { pk: "ACTION#1", sk: "A", ok: true } }], dispatch: undefined, milestones: [] as never[],
});
const events = (world: MergeWorld) => listWorkEvents(world.store, { orgId: ORG, from: "2026-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" }).then((read) => read.events);

describe("merge tracking and work events", () => {
  it("a change a pass makes to the workflow writes its events with it: the review wait ends and a step starts, for the task's company and project", async () => {
    const world = await mergeWorld();
    const release = registerMergeActionDecider("sync", ({ workflow }) => request(world, workflow));
    try {
      const workEvents = (task: { orgId: typeof ORG; project: string }, before: never, after: never, room: number) => flowWorkEventItems({ enabled: true, orgId: task.orgId, project: task.project, before, after, room });
      await trackPullRequest({ ...world.tracking, workEvents: workEvents as never }, TASK_ID);
    } finally { release(); }
    const written = await events(world);
    const kinds = written.map((event) => `${event.kind}${event.kind === "waiting_changed" ? `:${event.waitingOn}` : ""}`).sort();
    expect(kinds).toEqual(["step_started", "waiting_changed:agent"]);
    expect(written.every((event) => event.orgId === ORG && event.project === "web" && event.taskId === TASK_ID && event.actor.kind !== "person")).toBe(true);
    // Same transaction: the workflow moved and the events exist together.
    expect((await world.task()).workflow.revision).toBeGreaterThan(9);
  });

  it("without the hook (events off) a pass writes none", async () => {
    const quiet = await mergeWorld();
    const release = registerMergeActionDecider("sync", ({ workflow }) => request(quiet, workflow));
    try {
      await trackPullRequest(quiet.tracking, TASK_ID);
      expect((await quiet.task()).workflow.revision).toBeGreaterThan(9);
      expect(await events(quiet)).toEqual([]);
    } finally { release(); }
  });

  it("a hook that throws never fails the pass: the workflow moves and no event is written", async () => {
    const broken = await mergeWorld();
    const release = registerMergeActionDecider("sync", ({ workflow }) => request(broken, workflow));
    try {
      await trackPullRequest({ ...broken.tracking, workEvents: () => { throw new Error("no events today"); } }, TASK_ID);
      expect((await broken.task()).workflow.revision).toBeGreaterThan(9);
      expect(await events(broken)).toEqual([]);
    } finally { release(); }
  });

  it("the events are appended last, with the room that is really left in the transaction", async () => {
    const world = await mergeWorld();
    const seen: Array<{ room: number }> = [];
    const taken: number[] = [];
    const store = world.store;
    const original = store.transact.bind(store);
    store.transact = (async (items: Parameters<typeof original>[0]) => { taken.push(items.length); return original(items); });
    const dummy = [{ kind: "put" as const, item: { pk: "EVENT#1", sk: "A" } }, { kind: "put" as const, item: { pk: "EVENT#2", sk: "A" } }];
    const release = registerMergeActionDecider("sync", ({ workflow }) => request(world, workflow));
    try {
      await trackPullRequest({ ...world.tracking, workEvents: (_task: unknown, _before: unknown, _after: unknown, room: number) => { seen.push({ room }); return dummy; } }, TASK_ID);
    } finally { release(); }
    expect(seen).toHaveLength(1);
    // The transaction held the room's complement plus the two events: nothing was added after the events.
    expect(taken.at(-1)).toBe(100 - seen[0]!.room + dummy.length);
    expect(await world.store.get({ pk: "EVENT#1", sk: "A" })).toBeDefined();
  });
});
