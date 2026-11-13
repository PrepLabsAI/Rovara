// The curator with the fused shortlist and ONE listwise judge call per draft. Both modes: no embedder, and a fake embedder.
import { beforeEach, describe, expect, it } from "vitest";
import { curateDraft, retireLesson, type CurateDeps } from "../../../packages/lessons/src/curate.js";
import { LearningRefusal, type LessonsPauseStore } from "../../../packages/lessons/src/pause.js";
import type { PipelineModel } from "../../../packages/lessons/src/ports.js";
import type { LessonDraft } from "../../../packages/lessons/src/reflect.js";
import { resetNoEmbedderNotice, textHash, lessonTextOf } from "../../../packages/lessons/src/similarity.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, closeEmbedder, codeCite, draft, embedder, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

const text = (title: string, body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title, description: "", body, ...over });
const answer = (...verdicts: string[]): string => JSON.stringify({ verdicts: verdicts.map((verdict, i) => ({ n: i + 1, verdict })) });

/** A model that can quote, and says what it was asked. */
class Quoting extends ScriptedModel implements PipelineModel {
  quotes: Array<Record<string, unknown>> = [];
  constructor(replies: ConstructorParameters<typeof ScriptedModel>[0], public quote_: { ok: true; usd: number } | { ok: false; code: "no_provider" | "cost_too_high" } = { ok: true, usd: 0.002 }) { super(replies); }
  async quote(request: Record<string, unknown>) { this.quotes.push(request); return this.quote_; }
}

class Pause implements LessonsPauseStore {
  recorded: string[] = [];
  failures = 0;
  async record(_w: string, _p: string, code: string) { this.recorded.push(code); }
  async clear() { this.failures = 0; }
  async failed() { this.failures += 1; return this.failures; }
  async read() { return undefined; }
}

function setup(over: { model?: ScriptedModel; embedder?: boolean; spend?: Spend; pause?: Pause; store?: InMemoryLessonStore } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const clock = new Clock();
  const spend = over.spend ?? new Spend();
  const alerts = new Alerts();
  const model = over.model ?? new ScriptedModel();
  const logged: string[] = [];
  let n = 0;
  const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
    store, ...(over.embedder === false ? {} : { embedder }), vectors, judgeModel: model, spend, audit, alerts, now: clock.now, verifier: verifier("valid"), settings: settings(),
    ...(over.pause === undefined ? {} : { pause: over.pause }), log: (event) => { logged.push(event); }, newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, vectors, audit, alerts, model, spend, logged };
}

beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

// Three existing lessons about the retry helper, and a new draft that is the same as one, narrows another and has nothing to do with the third.
const A = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
const B = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
/** A copy of A that differs by filler and a plural only: the same advice BY STRUCTURE, so a judge's "same" may merge it. B is reworded, which is not. */
const A_FILLER = "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call";

describe.each([["no embedder", false], ["a fake embedder", true]] as const)("the curator's listwise judge (%s)", (_name, withEmbedder) => {
  const make = (over: Parameters<typeof setup>[0] = {}) => setup({ ...over, embedder: withEmbedder });

  it("ONE judge call per draft, however many neighbours: the call carries the draft and all its candidates, numbered, and its purpose and project", async () => {
    const s = make({ model: new Quoting([answer("different", "different", "different")]) });
    const bodies = [A, "Retries in the api service are configured in src/retry/index.ts through RETRY_MAX", "The api service client calls retry through withRetry in src/retry/index.ts when HTTP fails"];
    for (const [i, body] of bodies.entries()) await seed(s.store, lessonRecord({ id: `les_n${i}000001`, title: "Retries", description: "", body, status: "candidate" }));
    const out = await curateDraft(s.deps, KEY, text("Retries", B));
    expect(out.outcome).toBe("added");
    expect(s.model.calls).toHaveLength(1);
    const call = s.model.calls[0]!;
    expect(call).toMatchObject({ purpose: "judge", project: PROJECT, workspaceId: WS });
    const user = String(call.user);
    expect(user.match(/^\d\. state=/gmu)).toHaveLength(3);
    expect(user).toContain("New lesson:");
    expect(String(call.system)).toContain("exactly one verdict for every candidate");
  });

  it("at most five candidates go to the judge, best first", async () => {
    const s = make({ model: new Quoting([answer("different", "different", "different", "different", "different")]) });
    for (let i = 0; i < 8; i += 1) await seed(s.store, lessonRecord({ id: `les_m${i}000001`, title: "Retries", description: "", body: `${A} variant ${i}`, status: "candidate" }));
    await curateDraft(s.deps, KEY, text("Retries", B));
    expect(s.model.calls).toHaveLength(1);
    expect(String(s.model.calls[0]!.user).match(/^\d\. state=/gmu)).toHaveLength(5);
  });

  it("a draft with nothing like it makes no judge call at all", async () => {
    const s = make({ model: new Quoting([]) });
    await curateDraft(s.deps, KEY, text("Retries", A));
    const out = await curateDraft(s.deps, KEY, text("Makefile", "Makefile recipes need a literal tab character.", { citations: [], scope: { repos: ["api"] } }));
    expect(out.outcome).toBe("added");
    expect(s.model.calls).toHaveLength(0);
  });

  it("every outcome: same merges, refines supersedes after approval, contradicts goes to a person, different adds", async () => {
    // A judge's "same" merges only a pair that is the same advice by structure (A_FILLER); the reworded B is kept apart as a possible duplicate for a person.
    for (const [verdict, outcome, reply] of [["same", "merged", A_FILLER], ["same", "possible_duplicate", B], ["refines", "updated", B], ["contradicts", "contradiction", B], ["different", "added", B]] as const) {
      const s = make({ model: new Quoting([answer(verdict)]) });
      // A judge's "same" needs close vectors as well as close words; with an embedder here, it says the pair is as close as can be.
      if (s.deps.embedder !== undefined) s.deps.embedder = closeEmbedder;
      const first = await curateDraft(s.deps, KEY, text("Retries", A));
      if (first.outcome !== "added") throw new Error("expected add");
      const out = await curateDraft(s.deps, KEY, text("Retries", reply));
      expect(out.outcome, `${verdict} ${outcome}`).toBe(outcome);
      if (out.outcome === "possible_duplicate") expect(out).toMatchObject({ duplicateOf: first.lesson.id, lesson: { status: "pending", possibleDuplicateOf: first.lesson.id, tierReasons: ["possible_duplicate"] } });
      if (out.outcome === "updated") expect(out).toMatchObject({ supersedes: first.lesson.id, lesson: { status: "candidate" } });
      if (out.outcome === "contradiction") expect(out).toMatchObject({ other: first.lesson.id, lesson: { status: "pending", contradictsWith: first.lesson.id } });
      expect(s.model.calls, verdict).toHaveLength(1);
    }
  });

  it("a contradiction among several verdicts wins: the draft goes to a person even when it is also the same as another candidate", async () => {
    const s = make({ model: new Quoting([answer("same", "contradicts")]) });
    await seed(s.store, lessonRecord({ id: "les_same0001", title: "Retries", description: "", body: A, status: "candidate" }));
    await seed(s.store, lessonRecord({ id: "les_opp00001", title: "Retries", description: "", body: `${B} and keep it`, status: "candidate" }));
    const out = await curateDraft(s.deps, KEY, text("Retries", `${A} again`));
    expect(out).toMatchObject({ outcome: "contradiction" });
  });

  it("a candidate a person REJECTED that the judge calls the same: a structural copy drops the draft, a reworded one goes to a person; any other verdict about a rejected lesson changes nothing", async () => {
    const s = make({ model: new Quoting([answer("same")]) });
    await seed(s.store, lessonRecord({ id: "les_rej00001", title: "Retries", description: "", body: A, status: "rejected" }));
    expect(await curateDraft(s.deps, KEY, text("Retries", B))).toMatchObject({ outcome: "contradiction", matchesRejected: true, other: "les_rej00001", lesson: { status: "pending" } });
    expect(String(s.model.calls[0]!.user)).toContain("previously_rejected");
    const t = make({ model: new Quoting([answer("refines")]) });
    await seed(t.store, lessonRecord({ id: "les_rej00001", title: "Retries", description: "", body: A, status: "rejected" }));
    expect((await curateDraft(t.deps, KEY, text("Retries", B))).outcome).toBe("added");
  });

  it("a rejected lesson's verbatim copy is dropped by code, with no call", async () => {
    const s = make({ model: new Quoting([]) });
    await seed(s.store, lessonRecord({ id: "les_rej00001", title: "Retries", description: "", body: A, status: "rejected" }));
    expect(await curateDraft(s.deps, KEY, text("Retries", A))).toEqual({ outcome: "dropped", reason: "previously_rejected" });
    expect(s.model.calls).toHaveLength(0);
  });

  it("a verbatim copy merges by code with no call; a near-exact copy goes to the judge when there is one", async () => {
    const s = make({ model: new Quoting([answer("refines")]) });
    await curateDraft(s.deps, KEY, text("Retries", A));
    expect((await curateDraft(s.deps, KEY, text("Retries", A))).outcome).toBe("merged");
    expect(s.model.calls).toHaveLength(0);
    // The same words and one more clause: not verbatim, so the judge decides (and here narrows it).
    expect((await curateDraft(s.deps, KEY, text("Retries", `${A} today`))).outcome).toBe("updated");
    expect(s.model.calls).toHaveLength(1);
  });

  describe("answers that cannot be used are a failed call: no judge, counted toward model_failed, and the draft is treated as with no judge", () => {
    const bad: Array<[string, string]> = [
      ["not JSON", "I think they are the same."],
      ["a repeated number", JSON.stringify({ verdicts: [{ n: 1, verdict: "same" }, { n: 1, verdict: "same" }] })],
      ["a number out of range", JSON.stringify({ verdicts: [{ n: 2, verdict: "same" }] })],
      ["an unknown verdict", answer("matches-a-rejected")],
      ["an extra field", JSON.stringify({ verdicts: [{ n: 1, verdict: "same", reason: "x" }] })],
      ["the old single-verdict shape", JSON.stringify({ verdict: "same" })],
    ];
    it.each(bad)("%s", async (_label, reply) => {
      const pause = new Pause();
      const s = make({ model: new Quoting([reply]), pause });
      await curateDraft(s.deps, KEY, text("Retries", A));
      const out = await curateDraft(s.deps, KEY, text("Retries", B));
      expect(out.outcome).toBe("added");
      expect(pause.failures).toBe(1);
      expect(await s.store.list(KEY)).toHaveLength(2);
    });
    it("a candidate left without a verdict", async () => {
      const pause = new Pause();
      const s = make({ model: new Quoting([answer("same")]), pause });
      await seed(s.store, lessonRecord({ id: "les_one00001", title: "Retries", description: "", body: A, status: "candidate" }));
      await seed(s.store, lessonRecord({ id: "les_two00001", title: "Retries", description: "", body: `${A} with a second clause about the client`, status: "candidate" }));
      expect((await curateDraft(s.deps, KEY, text("Retries", B))).outcome).toBe("added");
      expect(s.model.calls).toHaveLength(1);
      expect(pause.failures).toBe(1);
    });
    it("a fenced JSON answer is accepted", async () => {
      const s = make({ model: new Quoting(["```json\n" + answer("different") + "\n```"]) });
      await curateDraft(s.deps, KEY, text("Retries", A));
      expect((await curateDraft(s.deps, KEY, text("Retries", B))).outcome).toBe("added");
    });
  });

  describe("no judge: only near-exact copies merge, a flipped copy goes to a person, and everything else stays its own candidate", () => {
    const refusals: Array<[string, () => ReturnType<typeof make>]> = [
      ["no provider", () => make({ model: new Quoting([], { ok: false, code: "no_provider" }), pause: new Pause() })],
      ["the cap reached", () => { const spend = new Spend(); spend.admitted = false; return make({ model: new Quoting([answer("same")]), spend }); }],
      ["the model refused", () => make({ model: new Quoting([new LearningRefusal("no_provider", "refused")]) })],
      ["the model failed", () => make({ model: new Quoting([new Error("provider down")]) })],
      ["no model at all", () => make()],
    ];
    it.each(refusals)("%s", async (_label, build) => {
      const s = build();
      await curateDraft(s.deps, KEY, text("Retries", A));
      // Not a copy: it stays its own candidate, and a person sees both.
      expect((await curateDraft(s.deps, KEY, text("Retries", B))).outcome).toBe("added");
      // A near-exact copy (the same cited file, the same polarity, nearly the same words) merges by code.
      expect((await curateDraft(s.deps, KEY, text("Retries", `${A} too`))).outcome).toBe("merged");
      // The same words with the opposite polarity are never merged by code: a person gets a contradiction card.
      const flipped = await curateDraft(s.deps, KEY, text("Retries", `Never ${A} too`));
      expect(flipped.outcome).toBe("contradiction");
      expect((await s.store.list(KEY)).length).toBe(3);
    });

    it("a near-exact copy of a lesson that is live may not lower its trust or narrow its audience even then: it is added", async () => {
      const s = make();
      await seed(s.store, lessonRecord({ id: "les_act00001", title: "Retries", description: "", body: A, status: "active" }));
      const out = await curateDraft(s.deps, KEY, text("Retries", `${A} too`, { provenance: { ...draft().provenance, minTrust: "system" } }));
      expect(out.outcome).toBe("added");
    });

    it("a near-exact copy of a REJECTED lesson is dropped", async () => {
      const s = make();
      await seed(s.store, lessonRecord({ id: "les_rej00001", title: "Retries", description: "", body: A, status: "rejected" }));
      expect(await curateDraft(s.deps, KEY, text("Retries", `${A} too`))).toEqual({ outcome: "dropped", reason: "previously_rejected" });
    });

    it("the same words citing another file are not a copy", async () => {
      const s = make();
      await curateDraft(s.deps, KEY, text("Retries", A));
      expect((await curateDraft(s.deps, KEY, text("Retries", `${A} too`, { citations: [codeCite({ path: "src/other/other.ts" })] }))).outcome).toBe("added");
    });
  });

  it("the judge is a learning call: it is quoted, looked at against the month, and held at the quote; a refused quote records its code", async () => {
    const pause = new Pause();
    const s = make({ model: new Quoting([answer("different")], { ok: true, usd: 0.004 }), pause });
    await curateDraft(s.deps, KEY, text("Retries", A));
    await curateDraft(s.deps, KEY, text("Retries", B));
    expect((s.model as Quoting).quotes).toHaveLength(1);
    expect(s.spend.asked).toEqual([0.004]);
    expect(s.model.calls[0]!.budgetUsd).toBe(0.004);
    const t = make({ model: new Quoting([], { ok: false, code: "cost_too_high" }), pause });
    await curateDraft(t.deps, KEY, text("Retries", A));
    await curateDraft(t.deps, KEY, text("Retries", B));
    expect(pause.recorded).toContain("cost_too_high");
    expect(t.model.calls).toHaveLength(0);
  });
});

describe("vectors with the lessons", () => {
  it("with an embedder, a lesson the curator creates gets its vector (spec and text hash) at once; with none, no vector is kept", async () => {
    const withIt = setup();
    const out = await curateDraft(withIt.deps, KEY, text("Retries", A));
    if (out.outcome !== "added") throw new Error("expected add");
    const row = withIt.vectors.rows.get(`${WS}\u0001${PROJECT}\u0001${out.lesson.id}`)!;
    expect(row).toMatchObject({ spec: embedder.spec, hash: textHash(lessonTextOf(out.lesson)) });
    const without = setup({ embedder: false });
    await curateDraft(without.deps, KEY, text("Retries", A));
    expect(without.vectors.rows.size).toBe(0);
    expect(without.logged).toContain("lessons.similarity_no_embedder");
  });

  it("an embedder that is down never drops or delays a draft: it is curated by keywords and paths, with one fixed log code", async () => {
    const s = setup({ model: new Quoting([answer("same")]) });
    await curateDraft(s.deps, KEY, text("Retries", A));
    embedder.fail = true;
    const out = await curateDraft(s.deps, KEY, text("Retries", A_FILLER));
    expect(out.outcome).toBe("merged");
    expect(s.logged).toContain("lessons.similarity_embedder_unavailable");
  });

  it("an embedder spec change makes every stored vector stale: the next curation embeds the pool again under the new spec", async () => {
    const s = setup({ model: new Quoting([answer("different"), answer("different", "different")]) });
    await curateDraft(s.deps, KEY, text("Retries", A));
    await curateDraft(s.deps, KEY, text("Retries", B));
    const before = [...s.vectors.rows.values()].map((r) => r.spec);
    expect(before.every((spec) => spec === embedder.spec)).toBe(true);
    const next = { ...embedder, spec: "test-bow-256-next", embedMany: embedder.embedMany.bind(embedder) } as typeof embedder;
    await curateDraft({ ...s.deps, embedder: next }, KEY, text("Retries", `${A} and then some more words`));
    expect([...s.vectors.rows.values()].every((r) => r.spec === "test-bow-256-next")).toBe(true);
    expect(s.vectors.rows.size).toBe(3);
  });

  it("a retired lesson loses its vector", async () => {
    const s = setup();
    const a = await curateDraft(s.deps, KEY, text("Retries", A));
    if (a.outcome !== "added") throw new Error("expected add");
    expect(s.vectors.rows.size).toBe(1);
    expect(await retireLesson(s.deps, KEY, a.lesson.id, "test", "ann")).toBe(true);
    expect(s.vectors.rows.size).toBe(0);
  });
});
