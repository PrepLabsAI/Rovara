// The loader: which lessons a stage is given. Poisoning classes on the loader side, and the independence of a reviewer's lessons.
import { describe, expect, it } from "vitest";
import { LearnedContextSchema } from "../../../packages/contracts/src/index.js";
import { applyLoadReport } from "../../../packages/broker/src/lessons/counters.js";
import { learnedContextForDispatch, loadLessonsForStage, scopeMatch, wilsonLower, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { readVisible } from "../../../packages/broker/src/lessons/read-visible.js";
import { LOAD_DEFAULT_BYTES, LOAD_DEFAULT_LESSONS } from "../../../packages/broker/src/lessons/policy.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, embedder, lessonRecord, seed, settings, allowAllAccess } from "./lesson-helpers.js";

const restrictedAudience = { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals: ["U-member"], capturedAt: "x", liveCheck: "none" as const } };

function setup(s = settings()) {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const clock = new Clock();
  const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: s, audit: new Audit(), now: clock.now };
  const add = async (...input: Lesson[]) => {
    // Only approved lessons load: a fixture with no person's approval gets one (the "approved only" tests below say otherwise on purpose).
    const lessons = input.map((l) => (l.approvals.some((a) => a.mode !== "auto") ? l : { ...l, approvals: [...l.approvals, { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  return { deps, store, vectors, clock, add };
}
const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [],
  taskAudience: { kind: "shared" }, ...over,
});
const ids = (r: Awaited<ReturnType<typeof loadLessonsForStage>>): string[] => r.context?.lessons.map((l) => l.id) ?? [];
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, ...over });

describe("selection", () => {
  it("loads active, in-scope lessons for the stage; skips pending, retired, stale, expired and withdrawn ones", async () => {
    const { deps, add, clock } = setup();
    await add(conv("les_ok000001"), conv("les_pend0001", { status: "pending" }), conv("les_retd0001", { status: "retired" }), conv("les_stal0001", { status: "stale" }),
      conv("les_expd0001", { expiresAt: clock.now() - 1 }), conv("les_with0001", { status: "withdrawn" }));
    const result = await loadLessonsForStage(deps, request());
    expect(ids(result)).toEqual(["les_ok000001"]);
    expect(LearnedContextSchema.safeParse(result.context).success).toBe(true);
  });

  it("scope: a lesson for another repository, another language or other paths is not loaded", async () => {
    const { deps, add } = setup();
    await add(conv("les_repo0001", { scope: { repos: ["web"] } }), conv("les_lang0001", { scope: { repos: ["api"], languages: ["python"] } }),
      conv("les_path0001", { scope: { repos: ["api"], paths: ["docs/**"] } }), conv("les_hit00001", { scope: { repos: ["api"], paths: ["src/**"] } }), conv("les_open0001", { scope: {} }));
    const result = await loadLessonsForStage(deps, request({ languages: ["typescript"] }));
    expect(ids(result).sort()).toEqual(["les_hit00001", "les_open0001"]);
    expect(result.manifest.lessons.find((e) => e.id === "les_hit00001")!.why).toBe("path");
    expect(scopeMatch(conv("x", { scope: { paths: ["src/**"] } }), { repos: [], files: [], languages: [] }).matches).toBe(true);
    expect(scopeMatch(conv("x", { scope: { paths: ["src/*.ts"] } }), { repos: [], files: ["src/a/b.ts"], languages: [] }).matches).toBe(false);
  });

  it("what each stage gets", async () => {
    // (A budget up to the caps, so this test sees every lesson the stage allows.)
    const { deps, add } = setup(settings({ loadBudget: { lessons: 12, bytes: 6 * 1024 } }));
    await add(
      lessonRecord({ id: "les_fact0001", type: "fact", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      lessonRecord({ id: "les_fnc00001", type: "fact", citations: [], stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_conv0001", { stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_pitf0001", { type: "pitfall", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_proc0001", { type: "procedure", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_pref0001", { type: "preference", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_rchk0001", { type: "review_check", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] }),
    );
    const sorted = async (stage: LoadRequest["stage"]) => ids(await loadLessonsForStage(deps, request({ stage, taskId: `t-${stage}` }))).sort();
    expect(await sorted("UNDERSTAND")).toEqual(["les_conv0001", "les_fact0001", "les_fnc00001", "les_pitf0001", "les_pref0001", "les_proc0001"]);
    expect(await sorted("PLAN")).toEqual(await sorted("UNDERSTAND"));
    expect(await sorted("IMPLEMENT")).toEqual(["les_conv0001", "les_fact0001", "les_pitf0001"]);
    expect(await sorted("CHECKS")).toEqual([]);
  });

  it("reviewer stages get only tier-2-approved review_check lessons, plus the list of what the planner and coder loaded", async () => {
    const { deps, add } = setup();
    const two = [{ approvalId: "a", by: "ann", at: 1, mode: "one" as const }, { approvalId: "b", by: "bob", at: 2, mode: "second_person" as const }];
    await add(
      conv("les_rok00001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: two }),
      conv("les_rone0001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [two[0]!] }),
      conv("les_rauto001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [{ approvalId: "c", by: "system:auto", at: 1, mode: "auto" }, two[0]!] }),
      conv("les_rtier1ab", { type: "review_check", tier: 1, stages: ["REVIEW"], approvals: two }),
      conv("les_rsole001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [{ approvalId: "d", by: "ann", at: 1, mode: "sole_owner_exception" }] }),
      conv("les_plain001", { stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] }),
    );
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    const review = await loadLessonsForStage(deps, request({ stage: "REVIEW" }));
    expect(ids(review).sort()).toEqual(["les_rok00001", "les_rsole001"]);
    expect(review.context!.priorLoaded).toEqual([{ id: "les_plain001", type: "convention", title: "Retries use withRetry" }]);
    // An implementation stage never gets the priorLoaded list.
    expect((await loadLessonsForStage(deps, request({ stage: "IMPLEMENT", round: 2 }))).context!.priorLoaded).toBeUndefined();
  });

  it("ranks by similarity, then helpfulness, deterministically; respects the default budget of 5 lessons and 2 KB", async () => {
    const { deps, add } = setup();
    await add(conv("les_aaaa0001", { title: "Retry failed HTTP calls", body: "Retry failed HTTP calls in the api service with withRetry" }), conv("les_bbbb0001", { title: "Logging", body: "Use structured logging for the billing worker queue" }));
    const result = await loadLessonsForStage(deps, request());
    expect(ids(result)).toEqual(["les_aaaa0001", "les_bbbb0001"]);
    expect(result.manifest.lessons[0]!.score).toBeGreaterThan(result.manifest.lessons[1]!.score);
    const again = await loadLessonsForStage(deps, request({ taskId: "task-2" }));
    expect(ids(again)).toEqual(ids(result));

    const many = setup();
    await many.add(...Array.from({ length: 20 }, (_, i) => conv(`les_many${String(i).padStart(4, "0")}`, { title: `Lesson ${i}`, body: `Advice number ${i} about retries in api` })));
    const capped = await loadLessonsForStage(many.deps, request());
    expect(capped.context!.lessons).toHaveLength(LOAD_DEFAULT_LESSONS);

    const big = setup();
    await big.add(...Array.from({ length: 8 }, (_, i) => conv(`les_big0${String(i).padStart(4, "0")}`, { title: `Big ${i}`, body: `retry ${"x".repeat(560)}`, description: "d".repeat(150) })));
    const bytes = await loadLessonsForStage(big.deps, request());
    expect(bytes.manifest.bytes).toBeLessThanOrEqual(LOAD_DEFAULT_BYTES);
    expect(bytes.context!.lessons.length).toBeLessThan(8);
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(9, 10)).toBeGreaterThan(wilsonLower(1, 2));
  });

  it("a lesson that was helpful outranks an untested one of equal similarity", async () => {
    const { deps, add } = setup();
    const same = { title: "Retries", body: "Retry failed HTTP calls in the api service" };
    await add(conv("les_aaa00001", { ...same }), conv("les_zzz00001", { ...same, counters: { loaded: 20, helpful: 18, harmful: 0, citationStale: 0 } }));
    expect(ids(await loadLessonsForStage(deps, request()))[0]).toBe("les_zzz00001");
  });

  it("writes the manifest once per stage dispatch; 'loaded' is counted only when the worker reports the lesson reached the prompt (once per task and lesson)", async () => {
    const { deps, add, store } = setup();
    await add(conv("les_ok000001"));
    await loadLessonsForStage(deps, request({ stage: "UNDERSTAND" }));
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(0);
    expect(await store.manifests(KEY, "task-1")).toHaveLength(2);
    const [m] = await store.manifests(KEY, "task-1");
    expect(m).toMatchObject({ memory: "live", setVersion: 1, round: 1 });
    const counter = { store, judge: { rate: async () => "unrelated" as const }, settings: settings(), audit: new Audit(), now: new Clock().now };
    const report = (stage: "UNDERSTAND" | "IMPLEMENT") => ({ v: 1 as const, stage, lessons: [{ id: "les_ok000001", version: 1, citation: "valid" as const }] });
    await applyLoadReport(counter, { ...KEY, taskId: "task-1", stage: "UNDERSTAND", round: 1, report: report("UNDERSTAND") });
    await applyLoadReport(counter, { ...KEY, taskId: "task-1", stage: "IMPLEMENT", round: 1, report: report("IMPLEMENT") });
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(1);
  });
});

describe("fail closed", () => {
  it("mode Off, Collect or an unreadable setting loads nothing", async () => {
    for (const s of [settings({ mode: "Off" }), settings({ mode: "Collect" }), settings({ companyLock: "Off" }), { read: async () => { throw new Error("down"); } }]) {
      const { deps, add } = setup(s);
      await add(conv("les_ok000001"));
      const result = await loadLessonsForStage(deps, request());
      expect(result).toMatchObject({ skipped: "mode" });
      expect(result.context).toBeUndefined();
    }
  });

  it("memory off (eval batches only) loads nothing and the manifest says so", async () => {
    const { deps, add } = setup();
    await add(conv("les_ok000001"));
    const result = await loadLessonsForStage(deps, request({ memory: { mode: "off" } }));
    expect(result).toMatchObject({ skipped: "memory_off", manifest: { memory: "off", lessons: [] } });
  });

  it("an unreachable vector store or a failing embedder never stops a load: the lessons are ranked by keywords and paths; an unreadable lesson store loads nothing", async () => {
    const { deps, add, vectors, store } = setup();
    await add(conv("les_ok000001"));
    vectors.fail = true;
    expect(ids(await loadLessonsForStage(deps, request()))).toEqual(["les_ok000001"]);
    vectors.fail = false;
    embedder.fail = true;
    try { expect(ids(await loadLessonsForStage(deps, request({ taskId: "task-2" })))).toEqual(["les_ok000001"]); } finally { embedder.fail = false; }
    const broken: LoadDeps = { ...deps, store: Object.assign(Object.create(store) as InMemoryLessonStore, { list: async () => { throw new Error("down"); } }) };
    expect(await loadLessonsForStage(broken, request({ taskId: "task-3" }))).toMatchObject({ skipped: "index_unreachable" });
  });
});

describe("audience and isolation", () => {
  it("a lesson from a restricted source is never loaded into a task (several people can see a task); a person it names reads it through the read path, a stranger does not", async () => {
    const { deps, add, store } = setup();
    const provenance = { ...lessonRecord().provenance, audience: restrictedAudience };
    await add(conv("les_rest0001", { provenance }), conv("les_open0001"));
    expect(ids(await loadLessonsForStage(deps, request({ taskAudience: { kind: "shared" } })))).toEqual(["les_open0001"]);
    const seenBy = async (principals: string[]) => (await readVisible({ access: deps.access, key: KEY, viewer: { principals, groups: [] }, lessons: [(await store.get(KEY, "les_rest0001"))!, (await store.get(KEY, "les_open0001"))!], where: "test" })).map((l) => l.id).sort();
    expect(await seenBy(["U-stranger"])).toEqual(["les_open0001"]);
    expect(await seenBy(["U-member"])).toEqual(["les_open0001", "les_rest0001"]);
  });

  it("a lesson of another workspace, or another project, is never loaded", async () => {
    const { deps, add } = setup();
    await add(conv("les_ours0001"), conv("les_ws2b0001", { workspaceId: "org_bbbbbbbbbbbbbbbbbbbb" }), conv("les_proj2001", { project: "proj-2" }));
    expect(ids(await loadLessonsForStage(deps, request()))).toEqual(["les_ours0001"]);
    expect(ids(await loadLessonsForStage(deps, request({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb" })))).toEqual(["les_ws2b0001"]);
  });
});

describe("the dispatch call", () => {
  it("returns a spreadable learnedContext only for a worker that lists the feature, and records nothing for an older worker", async () => {
    const { deps, add, store } = setup();
    await add(conv("les_ok000001"));
    expect(await learnedContextForDispatch(deps, request(), ["task.modelPolicy"])).toEqual({});
    expect(await store.manifests(KEY, "task-1")).toHaveLength(0);
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(0);
    const out = await learnedContextForDispatch(deps, request(), ["task.learnedContext.v1"]);
    expect(out.learnedContext!.lessons.map((l) => l.id)).toEqual(["les_ok000001"]);
    expect(await learnedContextForDispatch(deps, request({ stage: "CHECKS" }), ["task.learnedContext.v1"])).toEqual({});
  });

  it("never throws: a store that fails gives an empty result", async () => {
    const { deps } = setup();
    expect(await learnedContextForDispatch({ ...deps, store: new Proxy({}, { get: () => async () => { throw new Error("db down"); } }) as never }, request(), ["task.learnedContext.v1"])).toEqual({});
  });
});

describe("lessons are ranked against the task by the fused score", () => {
  const retry = (id: string, over: Partial<Lesson> = {}) => conv(id, { title: "Retries use withRetry", description: "", body: "HTTP retries in the api service use withRetry from src/retry/index.ts.", scope: { repos: ["api"] }, ...over });
  const billing = (id: string, over: Partial<Lesson> = {}) => conv(id, { title: "Money is integer cents", description: "", body: "Money amounts in the billing table are stored as integer cents, never floats.", scope: { repos: ["api"] }, ...over });

  for (const mode of ["no embedder", "a fake embedder"] as const) {
    describe(mode, () => {
      const make = () => { const s = setup(); return mode === "no embedder" ? { ...s, deps: { ...s.deps, embedder: undefined } as LoadDeps } : s; };

      it("the lesson that fits the task's intent and plan comes first, and one that does not is last; the similar one says why", async () => {
        const { deps, add } = make();
        await add(billing("les_bill0001"), retry("les_retr0001"));
        const result = await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls with withRetry in the api service", planSummary: "Wrap the client in withRetry from src/retry/index.ts", files: ["src/retry/client.ts"] }));
        expect(ids(result)).toEqual(["les_retr0001", "les_bill0001"]);
        const [first, second] = result.manifest.lessons;
        expect(first!.score).toBeGreaterThan(second!.score);
        expect(first!.why).toBe("similar");
        expect(second!.why).not.toBe("similar");
      });

      it("the files the task touches count: of two lessons about the same words, the one scoped to those files wins", async () => {
        const { deps, add } = make();
        await add(retry("les_far00001", { scope: { repos: ["api"], paths: ["src/legacy/**"] } }), retry("les_near0001", { scope: { repos: ["api"], paths: ["src/retry/**"] } }));
        const result = await loadLessonsForStage(deps, request({ intent: "Fix retries", files: ["src/retry/client.ts", "src/legacy/old.ts"] }));
        expect(ids(result)).toHaveLength(2);
        const none = await loadLessonsForStage(deps, request({ intent: "Fix retries", files: ["src/retry/client.ts"], taskId: "task-2" }));
        expect(ids(none)).toEqual(["les_near0001"]);
      });

      it("similarity ranks only: a lesson that is not live, out of scope or not readable is never loaded however well it fits", async () => {
        const { deps, add } = make();
        const perfect = { title: "Retries use withRetry", description: "", body: "Retry failed HTTP calls with withRetry in the api service." };
        await add(
          conv("les_pend0001", { ...perfect, status: "pending" }), conv("les_scop0001", { ...perfect, scope: { repos: ["web"] } }),
          conv("les_priv0001", { ...perfect, provenance: { ...lessonRecord().provenance, audience: restrictedAudience } }),
          billing("les_bill0001"),
        );
        const result = await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls with withRetry in the api service" }));
        expect(ids(result)).toEqual(["les_bill0001"]);
      });

      it("the ranking changes with the task: the same two lessons come in the other order for a billing task", async () => {
        const { deps, add } = make();
        await add(retry("les_retr0001"), billing("les_bill0001"));
        const result = await loadLessonsForStage(deps, request({ intent: "Amounts in the billing table are floats; store money as integer cents", files: [] }));
        expect(ids(result)[0]).toBe("les_bill0001");
      });
    });
  }

  it("a perfectly similar lesson nobody approved does not load (the approval gate is not a ranking matter)", async () => {
    const { deps, store } = setup();
    await seed(store, retry("les_noap0001", { approvals: [] }));
    expect(ids(await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls with withRetry in the api service" })))).toEqual([]);
  });

  it("with an embedder the loader embeds the task only (never a lesson): stored vectors are read, missing ones are skipped", async () => {
    const { deps, add, vectors } = setup();
    await add(retry("les_retr0001"));
    vectors.rows.clear();
    embedder.calls = 0;
    await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls" }));
    expect(embedder.calls).toBe(1);
    expect(vectors.rows.size).toBe(0);
  });

  it("an unreachable embedder or vector store does not change which lessons load, only how they are ranked", async () => {
    const { deps, add, vectors } = setup();
    await add(retry("les_retr0001"), billing("les_bill0001"));
    const healthy = ids(await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls with withRetry" })));
    embedder.fail = true;
    vectors.fail = true;
    try { expect(ids(await loadLessonsForStage(deps, request({ intent: "Retry failed HTTP calls with withRetry", taskId: "task-2" }))).sort()).toEqual([...healthy].sort()); } finally { embedder.fail = false; }
  });
});
