// The repository-file marks are gone: a reflection makes no repository-visibility answer and no second model call, a merge no longer keeps lessons apart for a mark, and rows stored with the old fields
// still read (the fields are dropped, so a row read and written again is clean).
import { describe, expect, it } from "vitest";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { reflectSubject, type ReflectDeps } from "../../../packages/broker/src/lessons/reflect.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonSchema } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, draft, embedder, lessonRecord, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

const PLACE = "github:repo/1001";

describe("rows stored with the removed marks", () => {
  const old = (): Record<string, unknown> => {
    const row = lessonRecord();
    return { ...row, repoTwins: ["les_twin0001"], provenance: { ...row.provenance, repoOnly: { place: PLACE }, repoBlockCodes: ["typed_in_rovara"] } };
  };
  it("parse, and the old fields are dropped from what is read", () => {
    const parsed = LessonSchema.parse(old());
    expect("repoTwins" in parsed).toBe(false);
    expect("repoOnly" in parsed.provenance).toBe(false);
    expect("repoBlockCodes" in parsed.provenance).toBe(false);
    expect(parsed).toEqual(lessonRecord());
  });
  it("a row without them parses as before, and the schema is still strict about every other field", () => {
    expect(LessonSchema.safeParse(lessonRecord()).success).toBe(true);
    expect(LessonSchema.safeParse({ ...old(), surprise: 1 }).success).toBe(false);
    expect(LessonSchema.safeParse({ ...lessonRecord(), provenance: { ...lessonRecord().provenance, surprise: 1 } }).success).toBe(false);
    expect(LessonSchema.safeParse(null).success).toBe(false);
    expect(LessonSchema.safeParse({ ...old(), provenance: "x" }).success).toBe(false);
  });
  it("a store that holds such a row hands it back clean", async () => {
    const store = new InMemoryLessonStore();
    const row = LessonSchema.parse(old());
    await store.commit(KEY, await store.setVersion(KEY), [row], 1);
    const read = await store.get(KEY, row.id);
    expect(JSON.stringify(read)).not.toMatch(/repoOnly|repoBlockCodes|repoTwins/u);
  });
});

describe("the reflection", () => {
  const reflectDeps = (model: ScriptedModel, seen: string[]): ReflectDeps => ({
    model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: new Clock().now, newId: () => "run-1",
    metrics: { count: (name: string) => { seen.push(name); } },
  });
  it("makes one model call, no repository-visibility count, and drafts with no repository mark", async () => {
    const seen: string[] = [];
    const model = new ScriptedModel([reply(candidateJson())]);
    const result = await reflectSubject(reflectDeps(model, seen), subject([memberSpan("Use withRetry for HTTP retries in api.", { kind: "pr_comment", scopes: [PLACE], audience: { kind: "project" } })]));
    expect(model.calls).toHaveLength(1);
    expect(result.drafts).toHaveLength(1);
    expect(JSON.stringify(result.drafts)).not.toMatch(/repoOnly|repoBlockCodes/u);
    expect(seen.filter((name) => /repo_visible/u.test(name))).toEqual([]);
  });
});

describe("the curator", () => {
  function setup() {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(),
      newId: () => `les_${String(++n).padStart(4, "0")}`,
    };
    return { deps, store };
  }
  it("merges the same advice from two drafts into one lesson with no twin link and no repository mark", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, draft());
    const outcome = await curateDraft(deps, KEY, draft());
    expect(outcome.outcome).toBe("merged");
    const lessons = await store.list(KEY);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.version).toBe(2);
    expect(JSON.stringify(lessons)).not.toMatch(/repoOnly|repoBlockCodes|repoTwins|repo_twin/u);
    void WS; void PROJECT;
  });
});
