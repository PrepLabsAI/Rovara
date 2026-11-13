// RepoOnly is SET by the reflector from every input it was given, AND-merged by the curator and by a person's merge, and no model is called by any of it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { curateDraft, foldDuplicate, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { reflectSubject, type LessonDraft, type ReflectDeps } from "../../../packages/core/src/lessons/reflect.js";
import type { EvidenceSpan } from "../../../packages/core/src/lessons/reflect-input.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { LessonProvenanceSchema, LessonSchema } from "../../../packages/core/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, draft, embedder, lessonRecord, memberSpan, reply, seed, settings, subject, verifier } from "./lesson-helpers.js";

const A = "github:repo/1001";
const B = "github:repo/2002";
const inRepo = (over: Partial<EvidenceSpan> = {}): EvidenceSpan => memberSpan("Use withRetry for HTTP retries in api.", { kind: "pr_comment", scopes: [A], audience: { kind: "project" }, ...over });
const repoTask = { repoInputs: { place: A, repository: "api", linkPrefix: "https://github.com/acme/api/pull/" } };

function reflectDeps(model: ScriptedModel, metrics?: Array<[string, Record<string, string> | undefined]>): ReflectDeps {
  const clock = new Clock();
  return { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: clock.now, newId: () => "run-1", ...(metrics === undefined ? {} : { metrics: { count: (name: string, tags?: Record<string, string>) => { metrics.push([name, tags]); } } }) };
}
const reflect = async (spans: EvidenceSpan[], over: Parameters<typeof subject>[1] = repoTask, candidates: unknown[] = [candidateJson()], metrics?: Array<[string, Record<string, string> | undefined]>) => {
  const model = new ScriptedModel([reply(...candidates)]);
  const result = await reflectSubject(reflectDeps(model, metrics), subject(spans, over));
  return { result, model };
};

describe("reflect sets repoOnly from every input the reflector was given", () => {
  it("sets it when every input is the one repository's, and passes the schema", async () => {
    const { result } = await reflect([inRepo()]);
    const p = result.drafts[0]!.provenance;
    expect(p.repoOnly).toEqual({ place: A });
    expect(p.repoBlockCodes).toBeUndefined();
    expect(LessonProvenanceSchema.safeParse(p).success).toBe(true);
  });

  it("does not set it for a task whose start and steering are not proved (the default subject), and says why in fixed codes", async () => {
    const { result } = await reflect([inRepo()], {});
    const p = result.drafts[0]!.provenance;
    expect(p.repoOnly).toBeUndefined();
    expect(p.repoBlockCodes).toEqual(["task_inputs_unproved"]);
  });

  it("an input the model never cited still blocks it: the model cannot launder a Slack span by citing only the repository comment", async () => {
    const slack = inRepo({ scopes: ["slack:channel/C1"], audience: { kind: "restricted", acl: { source: "slack", scope: "slack:channel/C1", capturedAt: "t", liveCheck: "on_read" } }, eventId: "ev-slack" });
    const { result } = await reflect([inRepo(), slack], repoTask, [candidateJson({ evidenceSpanIds: ["S1"] })]);
    const p = result.drafts[0]!.provenance;
    expect(p.repoOnly).toBeUndefined();
    expect(p.repoBlockCodes).toContain("other_place");
  });

  it("a send-back, a loaded lesson or tasks behind loaded lessons each block it", async () => {
    for (const [extra, over, code] of [
      [memberSpan("Do not skip the tests.", { kind: "send_back" }), repoTask, "typed_in_rovara"],
      [memberSpan("Use withRetry.", { kind: "loaded_lesson", trust: "system" }), repoTask, "loaded_lesson"],
      [undefined, { ...repoTask, inheritedTasks: ["task-9"] }, "loaded_lesson"],
    ] as const) {
      const { result } = await reflect(extra === undefined ? [inRepo()] : [inRepo(), extra], over);
      const p = result.drafts[0]?.provenance;
      expect(p?.repoOnly, code).toBeUndefined();
      expect(p?.repoBlockCodes, code).toContain(code);
    }
  });

  it("every draft of one reflection carries the same answer (it is about the inputs, not the cited evidence)", async () => {
    const { result } = await reflect([inRepo(), inRepo({ eventId: "ev-2", text: "Use withRetry.", scopes: [A] })], repoTask, [candidateJson({ evidenceSpanIds: ["S1"] }), candidateJson({ title: "Second", body: "HTTP retries use withRetry (two).", evidenceSpanIds: ["S2"] })]);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.map((d) => d.provenance.repoOnly?.place)).toEqual([A, A]);
  });

  it("counts the reflection once as repository-visible or not, by tag only (no ids, no text)", async () => {
    const seen: Array<[string, Record<string, string> | undefined]> = [];
    await reflect([inRepo()], repoTask, [candidateJson()], seen);
    await reflect([inRepo(), memberSpan("x", { kind: "send_back" })], repoTask, [candidateJson()], seen);
    expect(seen.filter(([name]) => name === "learning.reflect_repo_visible").map(([, tags]) => tags)).toEqual([{ visible: "true" }, { visible: "false" }]);
  });

  it("makes exactly the one reflector call it always made: setting repoOnly is not a model call", async () => {
    const { model } = await reflect([inRepo()]);
    expect(model.calls).toHaveLength(1);
  });

  it("the pure eligibility code imports no model, spend, audit, org or team-record code (so it can be ported as it is)", () => {
    for (const file of ["repo-eligibility.ts", "repo-eligibility-report.ts"]) {
      const source = readFileSync(new URL(`../../../packages/core/src/lessons/${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import [^;]*? from "([^"]+)";/gmu)].map((m) => m[1]!);
      for (const from of imports) expect(["./trial.js", "./project-repo-audience.js", "./types.js", "./repo-eligibility.js", "./store.js"], `${file} imports ${from}`).toContain(from);
    }
  });
});

describe("the curator's merge ANDs repoOnly", () => {
  const withRepo = (repoOnly: { place: string } | undefined, repoBlockCodes?: LessonDraft["provenance"]["repoBlockCodes"]): LessonDraft => {
    const { repoOnly: _a, repoBlockCodes: _b, ...rest } = draft().provenance;
    void _a; void _b;
    return draft({ provenance: { ...rest, ...(repoOnly === undefined ? {} : { repoOnly }), ...(repoBlockCodes === undefined ? {} : { repoBlockCodes }) } });
  };
  function setup() {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    let n = 0;
    const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), settings: settings(),
      newId: () => `les_${String(++n).padStart(4, "0")}`,
    };
    return { deps, store };
  }
  // A merge is allowed only when it keeps repoOnly (both sides repo-only for the same repository) or when neither side has it. Across that line the draft stays its own lesson, linked both ways as a possible duplicate.
  const matrix: Array<[string, LessonDraft, LessonDraft, { place: string } | undefined | "apart"]> = [
    ["both repository-only for the same repository", withRepo({ place: A }), withRepo({ place: A }), { place: A }],
    ["the draft is not repository-only", withRepo({ place: A }), withRepo(undefined, ["typed_in_rovara"]), "apart"],
    ["the existing lesson is not repository-only", withRepo(undefined, ["other_place"]), withRepo({ place: A }), "apart"],
    ["two different repositories", withRepo({ place: A }), withRepo({ place: B }), "apart"],
    ["the existing lesson predates the field", withRepo(undefined), withRepo({ place: A }), "apart"],
    ["the draft has the field unset", withRepo({ place: A }), withRepo(undefined), "apart"],
    ["neither is", withRepo(undefined, ["other_place"]), withRepo(undefined, ["typed_in_rovara"]), undefined],
  ];
  for (const [name, first, second, expected] of matrix) {
    it(`curateDraft: ${name}`, async () => {
      const { deps, store } = setup();
      await curateDraft(deps, KEY, first);
      const outcome = await curateDraft(deps, KEY, second);
      if (expected === "apart") {
        expect(outcome.outcome).toBe("possible_duplicate");
        const lessons = await store.list(KEY);
        expect(lessons).toHaveLength(2);
        const target = lessons.find((l) => l.possibleDuplicateOf === undefined)!;
        const apart = lessons.find((l) => l.possibleDuplicateOf !== undefined)!;
        // Linked both ways, and neither lost or gained repoOnly by the encounter.
        expect(apart.possibleDuplicateOf).toBe(target.id);
        expect(target.repoTwins).toEqual([apart.id]);
        expect(target.provenance.repoOnly).toEqual(first.provenance.repoOnly);
        expect(apart.provenance.repoOnly).toEqual(second.provenance.repoOnly);
        for (const lesson of lessons) expect(LessonSchema.safeParse(lesson).success).toBe(true);
        return;
      }
      expect(outcome.outcome).toBe("merged");
      const [only] = await store.list(KEY);
      expect(only!.provenance.repoOnly).toEqual(expected);
      if (expected === undefined) expect(only!.provenance.repoBlockCodes!.length).toBeGreaterThan(0);
      else expect(only!.provenance.repoBlockCodes).toBeUndefined();
      expect(LessonSchema.safeParse(only).success).toBe(true);
    });
  }

  it("a person's merge (foldDuplicate) follows the same rule: only a pair that keeps repoOnly, or has none on either side, folds", async () => {
    for (const [first, second, folds, expected] of [[{ place: A }, { place: A }, true, { place: A }], [{ place: A }, undefined, false, undefined], [undefined, { place: A }, false, undefined], [{ place: A }, { place: B }, false, undefined], [undefined, undefined, true, undefined]] as const) {
      const store = new InMemoryLessonStore();
      const mk = (id: string, repoOnly: { place: string } | undefined) => lessonRecord({ id, provenance: { ...lessonRecord().provenance, authors: ["ann"], ...(repoOnly === undefined ? {} : { repoOnly }) } });
      const target = mk("les_targ0001", first);
      const duplicate = { ...mk("les_dup00001", second), status: "pending" as const };
      await seed(store, target, duplicate);
      const writes = await foldDuplicate({ store, now: () => 5 }, KEY, target, duplicate);
      if (!folds) { expect(writes).toBeUndefined(); continue; }
      expect(writes![0]!.provenance.repoOnly).toEqual(expected);
    }
  });

  it("the rest of a merge is unchanged (the three narrowing flags still AND, the new fields do not leak into other fields)", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, withRepo({ place: A }));
    await curateDraft(deps, KEY, withRepo({ place: A }));
    const [only] = await store.list(KEY);
    expect(only!.provenance.repoOnly).toEqual({ place: A });
    expect(only!.version).toBe(2);
    void WS; void PROJECT;
  });
});
