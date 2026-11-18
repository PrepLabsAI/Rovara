import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_PROJECT_INDEX, workspaceProjectIndexValue, type LessonEmbedder } from "@agentx/contracts";
import { taskKey, workspaceKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { writeLearningMode } from "../../../packages/broker/src/lessons/document-settings.js";
import { loadLessonsForStage } from "../../../packages/broker/src/lessons/load.js";
import { replayProjectLessons } from "../../../packages/broker/src/lessons/replay-project.js";
import { compareLessonReplay } from "../../../packages/broker/src/lessons/replay.js";
import { createLessonsRuntime } from "../../../packages/broker/src/lessons/runtime.js";
import { withLessonAudiences } from "../../../packages/broker/src/lessons/task-audience.js";
import { Clock, KEY, PROJECT, WS, lessonRecord, wideAudience } from "./lesson-helpers.js";

describe("project lesson replay", () => {
  it.each([false, true])("checks historical and current lessons against the task audience (same denials: %s)", async (sameDenials) => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore({ indexes: [{
      name: WORKSPACE_PROJECT_INDEX.name, partitionAttribute: WORKSPACE_PROJECT_INDEX.partitionKey, sortAttribute: WORKSPACE_PROJECT_INDEX.sortKey,
    }] });
    const taskId = "task-replay";
    const runtime = createLessonsRuntime({
      store: documents, companyId: WS, now: clock.now, audit: { stage: () => [], record: async () => undefined },
      reader: { file: async () => undefined }, repositoriesOf: async () => [], owner: { id: "ann", name: "Ann" }, taskProject: async () => PROJECT,
    });
    const audiences = vi.fn(async (_org: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id,
      id === "task-missing" ? undefined : wideAudience({ denied: new Set(id === "task-private" || (id === taskId && sameDenials) ? ["bob"] : []) }),
    ])));
    runtime.load.access = {
      mayRead: async (_org, _viewer, places) => places.map((place) => !place.scopes.includes("slack:denied")),
      taskVisibility: withLessonAudiences(runtime.access.taskVisibility, { read: audiences }),
    };
    await documents.put({ item: {
      ...workspaceKey(WS, "workspace-replay"), entityType: "WORKSPACE", id: "workspace-replay", companyId: WS, orgId: WS,
      projectName: PROJECT, workspaceProject: workspaceProjectIndexValue(WS, PROJECT), workspaceCreatedAt: new Date(clock.now()).toISOString(),
    } });
    await documents.put({ item: { ...workspaceKey(WS, "workspace-replay"), sk: "DEVELOPER_TASK", taskId } });
    await documents.put({ item: {
      ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: WS, project: PROJECT,
      title: "Retry failed HTTP calls with withRetry", startingRevision: 1, closedAt: new Date(clock.now()).toISOString(),
    } });
    await writeLearningMode(documents, KEY, "On", clock.now());
    const lessons = [
      lessonRecord({ id: "les_aaaa1111", scope: {}, citations: [], citationChecks: [], tier: 1, approvals: [{ approvalId: "approved", by: "ann", at: clock.now(), mode: "one" }] }),
      lessonRecord({ id: "les_bbbb2222", status: "retired", citations: [{ kind: "task", taskId: "task-private" }] }),
      lessonRecord({ id: "les_cccc3333", status: "retired", citations: [{ kind: "task", taskId: "task-missing" }] }),
      lessonRecord({ id: "les_dddd4444", status: "retired", citations: [], provenance: { ...lessonRecord().provenance, sourceScopes: ["slack:denied"] } }),
    ];
    await runtime.store.commit(KEY, 0, lessons, clock.now());
    await runtime.store.putManifest({
      ...KEY, taskId, stage: "PLAN", round: 1, setVersion: 1, memory: "live", at: clock.now(), bytes: 0,
      lessons: [...lessons.map((lesson) => lesson.id), "les_eeee5555"].map((id) => ({ id, version: 1, score: 1, why: "scope", citation: "none" })),
    });
    const writes = [vi.spyOn(documents, "put"), vi.spyOn(documents, "update"), vi.spyOn(documents, "delete"), vi.spyOn(documents, "transact")];
    const result = await replayProjectLessons({
      companyId: WS, project: PROJECT, limit: 1, store: documents, projects: { revision: async () => undefined }, runtime, now: clock.now,
    });
    expect(result.tasks).toEqual([{
      taskId, stage: "PLAN", round: 1, actual: sameDenials ? ["les_aaaa1111", "les_bbbb2222"] : ["les_aaaa1111"],
      replayed: ["les_aaaa1111"], gained: [], lost: sameDenials ? ["les_bbbb2222"] : [], changed: sameDenials,
    }]);
    expect(audiences.mock.calls.some(([org, ids]) => org === WS && ids.includes(taskId) && ids.includes("task-private"))).toBe(true);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("suppresses a working runtime embedder that the normal load calls", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore({ indexes: [{
      name: WORKSPACE_PROJECT_INDEX.name, partitionAttribute: WORKSPACE_PROJECT_INDEX.partitionKey, sortAttribute: WORKSPACE_PROJECT_INDEX.sortKey,
    }] });
    const embed = vi.fn<LessonEmbedder["embed"]>(async () => [1, 0]);
    const embedMany = vi.fn<LessonEmbedder["embedMany"]>(async (texts) => texts.map(() => [1, 0]));
    const warm = vi.fn(async () => true);
    const embedder: LessonEmbedder = { spec: "replay-test-2", dimension: 2, embed, embedMany, warm };
    const complete = vi.fn(async () => { throw new Error("replay must not call the model gateway"); });
    const runtime = createLessonsRuntime({
      store: documents, companyId: WS, now: clock.now, audit: { stage: () => [], record: async () => undefined },
      reader: { file: async () => undefined }, repositoriesOf: async () => [], owner: { id: "ann", name: "Ann" },
      taskProject: async () => PROJECT, learning: { embedder: () => embedder }, model: { complete },
    });
    const taskId = "task-replay";
    const workspaceId = "workspace-replay";
    const title = "Retry failed HTTP calls with withRetry";
    await documents.put({ item: {
      ...workspaceKey(WS, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: WS, orgId: WS,
      projectName: PROJECT, workspaceProject: workspaceProjectIndexValue(WS, PROJECT), workspaceCreatedAt: new Date(clock.now()).toISOString(),
    } });
    await documents.put({ item: { ...workspaceKey(WS, workspaceId), sk: "DEVELOPER_TASK", taskId } });
    await documents.put({ item: {
      ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: WS, project: PROJECT,
      title, startingRevision: 1, closedAt: new Date(clock.now()).toISOString(),
    } });
    await writeLearningMode(documents, KEY, "On", clock.now());
    await runtime.store.commit(KEY, 0, [lessonRecord({
      id: "les_aaaa1111", scope: {}, citations: [], citationChecks: [], tier: 1,
      approvals: [{ approvalId: "approved", by: "ann", at: clock.now(), mode: "one" }],
    })], clock.now());

    // Positive control: this exact runtime reaches the real selector and embeds the task query,
    // even with no stored lesson vectors. Its manifest is also the replay's historical load.
    expect(runtime.load.embedder).toBe(embedder);
    const normal = await loadLessonsForStage(runtime.load, {
      workspaceId: WS, project: PROJECT, taskId, stage: "PLAN", round: 1, intent: title,
      repos: [], files: [], languages: [], taskAudience: { kind: "shared" },
    });
    expect(normal.skipped).toBeUndefined();
    expect(normal.context?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    expect(embedMany).toHaveBeenCalledTimes(1);
    const [texts, kind, call] = embedMany.mock.calls[0]!;
    expect(texts).toEqual([title]);
    expect(kind).toBe("query");
    expect(call?.deadline).toBeTypeOf("number");
    expect(complete).not.toHaveBeenCalled();
    embed.mockClear(); embedMany.mockClear(); warm.mockClear(); complete.mockClear();
    const writes = [vi.spyOn(documents, "put"), vi.spyOn(documents, "update"), vi.spyOn(documents, "delete"), vi.spyOn(documents, "transact")];

    const result = await replayProjectLessons({
      companyId: WS, project: PROJECT, limit: 1, store: documents,
      projects: { revision: async () => undefined }, runtime, now: clock.now,
    });
    expect(result.tasks).toEqual([{
      taskId, stage: "PLAN", round: 1, actual: ["les_aaaa1111"], replayed: ["les_aaaa1111"], gained: [], lost: [], changed: false,
    }]);
    expect(embedMany).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});

describe("lesson replay comparison", () => {
  it("is deterministic and reports gained and lost ids per load", () => {
    const input = [
      { taskId: "task-b", stage: "PLAN", round: 2, actual: ["old", "same"], replayed: ["same", "new"] },
      { taskId: "task-a", stage: "IMPLEMENT", round: 1, actual: ["same"], replayed: ["same"] },
    ];
    const first = compareLessonReplay(input);
    expect(compareLessonReplay(input)).toEqual(first);
    expect(first.tasks[1]).toMatchObject({ gained: ["new"], lost: ["old"], changed: true });
    expect(first.totals).toEqual({ changedTasks: 1, lessonsGained: 1, lessonsLost: 1 });
  });

  it("keeps task and project-local results isolated when ids overlap", () => {
    const companyA = compareLessonReplay([{ taskId: "same", stage: "PLAN", round: 1, actual: ["a"], replayed: ["a"] }]);
    const companyB = compareLessonReplay([{ taskId: "same", stage: "PLAN", round: 1, actual: ["b"], replayed: ["c"] }]);
    expect(companyA.tasks[0]?.gained).toEqual([]);
    expect(companyB.tasks[0]?.gained).toEqual(["c"]);
  });
});
