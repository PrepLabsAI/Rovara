// The curator's judge holds from the task's one Public cap: it is asked what the task has left, and its hold is added to the task's total.
import { describe, expect, it } from "vitest";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, draft, embedder, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

describe("the curator's judge is given what the task has left of its Public cap, and its hold is added", () => {
  async function run(taskBudget: { heldUsd: number } | undefined) {
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const judge = Object.assign(new ScriptedModel(['{"verdicts":[{"n":1,"verdict":"different"}],"escalate":false}']), { quote: async () => ({ ok: true as const, usd: 0.02 }) });
    const target = lessonRecord({ id: "les_near0001", title: "Retries use withRetry", description: "HTTP retries use withRetry.", body: "HTTP retries in the api service go through withRetry in src/retry/index.ts." });
    await seed(store, target);
    await vectors.upsert(target.workspaceId, target.project, target.id, await embedder.embed(`${target.title}\n${target.description}\n${target.body}`), { status: "active" });
    const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
      store, embedder, vectors, judgeModel: judge, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(), edition: "public",
      newId: () => "les_new00001", ...(taskBudget === undefined ? {} : { taskBudget }),
    };
    await curateDraft(deps, KEY, draft({ title: "Retries use withRetry in api", description: "HTTP retries in api use withRetry.", body: "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls." }));
    return judge;
  }
  it("with no task total the judge is asked, at the whole cap", async () => {
    const judge = await run(undefined);
    expect(judge.calls).toHaveLength(1);
    expect(Number(judge.calls[0]!["maxHoldUsd"])).toBeCloseTo(0.15, 6);
  });
  it("with a task total it is asked what is left, and the hold is added to it", async () => {
    const held = { heldUsd: 0.05 };
    const judge = await run(held);
    expect(judge.calls).toHaveLength(1);
    expect(Number(judge.calls[0]!["maxHoldUsd"])).toBeCloseTo(0.1, 6);
    expect(held.heldUsd).toBeCloseTo(0.07, 6);
  });
  it("a task with no room left, or a judge dearer than the room, makes no judge call (the draft goes to a person)", async () => {
    expect((await run({ heldUsd: 0.15 })).calls).toEqual([]);
    expect((await run({ heldUsd: 0.14 })).calls).toEqual([]);
  });
});
