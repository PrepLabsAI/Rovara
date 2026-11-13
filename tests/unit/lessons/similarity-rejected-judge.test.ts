// A rejected lesson a judge calls "same" drops the draft only when the two are the same advice BY STRUCTURE (the test that lets a judge's "same" merge two live lessons).
// Any other pair (a paraphrase, an opposite no word list knows such as pause / resume) becomes a pending card for a person ("matches a rejected lesson"): never dropped, never on trial.
import { beforeEach, describe, expect, it } from "vitest";
import { curateDraft, type CurateDeps } from "../../../packages/lessons/src/curate.js";
import { processDraft, type ProcessDeps } from "../../../packages/lessons/src/process.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import { resetNoEmbedderNotice } from "../../../packages/lessons/src/similarity.js";
import type { LessonDraft } from "../../../packages/lessons/src/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, draft, embedder, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

const answer = (...verdicts: string[]): string => JSON.stringify({ verdicts: verdicts.map((verdict, i) => ({ n: i + 1, verdict })) });
const textOf = (body: string): LessonDraft => draft({ title: "Advice", description: "", body, citations: [], scope: {} });
const rejectedOf = (body: string) => lessonRecord({ id: "les_rej00001", title: "Advice", description: "", body, status: "rejected", citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [], scope: {} });

function setup(model: ScriptedModel) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  let n = 0;
  const deps: CurateDeps & ProcessDeps = {
    store, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit, alerts: new Alerts(), now: new Clock().now,
    verifier: verifier("valid"), settings: settings(), log: () => undefined, newId: () => `les_${String(++n).padStart(4, "0")}`, access: allowAllAccess,
  } as unknown as CurateDeps & ProcessDeps;
  return { deps, store, audit, model };
}
beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

const REJECTED = "Pause the nightly sync job while the billing service deploys to production.";

describe("a judge's same against a REJECTED lesson drops the draft only when it is the same advice by structure", () => {
  it("a verbatim copy and a near copy (filler, case, plurals) with a judge's same are dropped", async () => {
    for (const body of [REJECTED, "pause nightly sync job while the billing services deploy to production"]) {
      const s = setup(new ScriptedModel([answer("same")]));
      await seed(s.store, rejectedOf(REJECTED));
      const out = await curateDraft(s.deps, KEY, textOf(body));
      // A verbatim copy is dropped by code, with no call; the near copy reaches the judge and its same is confirmed by structure.
      expect(out).toEqual({ outcome: "dropped", reason: "previously_rejected" });
    }
  });

  it("an UNLISTED antonym (pause / resume) the judge wrongly calls same reaches a person, as a pending card that names the rejected lesson", async () => {
    const s = setup(new ScriptedModel([answer("same")]));
    await seed(s.store, rejectedOf(REJECTED));
    const out = await curateDraft(s.deps, KEY, textOf("Resume the nightly sync job while the billing service deploys to production."));
    expect(s.model.calls).toHaveLength(1);
    expect(out).toMatchObject({ outcome: "contradiction", other: "les_rej00001", matchesRejected: true, lesson: { status: "pending", contradictsWith: "les_rej00001" } });
    expect(out.outcome === "contradiction" && out.lesson.tierReasons).toContain("matches_rejected");
    expect((await s.store.list(KEY, { statuses: ["pending"] })).map((l) => l.body)).toContain("Resume the nightly sync job while the billing service deploys to production.");
  });

  it("show / hide, start / stop and a paraphrase the judge calls same are never dropped either", async () => {
    for (const [rejected, reworded] of [
      ["Show the billing banner to every member of the project.", "Hide the billing banner to every member of the project."],
      ["Never commit generated protobuf files to the repository.", "Do not check generated protobuf files into git."],
      ["Start the importer before the seed step runs in staging.", "Stop the importer before the seed step runs in staging."],
    ] as const) {
      const s = setup(new ScriptedModel([answer("same")]));
      await seed(s.store, rejectedOf(rejected));
      expect(await curateDraft(s.deps, KEY, textOf(reworded))).toMatchObject({ outcome: "contradiction", matchesRejected: true, lesson: { status: "pending" } });
    }
  });

  it("the card is a pending lesson that is never started on trial or applied by itself, and a person sees it", async () => {
    const s = setup(new ScriptedModel([answer("same")]));
    await seed(s.store, rejectedOf(REJECTED));
    const outcome = await processDraft(s.deps, KEY, textOf("Resume the nightly sync job while the billing service deploys to production."));
    const [card] = await s.store.list(KEY, { statuses: ["pending", "candidate", "active"] });
    expect(card).toMatchObject({ status: "pending" });
    expect(card!.trial).toBeUndefined();
    expect(card!.approvals).toEqual([]);
    expect(card!.tierReasons).toContain("matches_rejected");
    expect(outcome).toBeDefined();
  });

  it("a judge that answers different leaves an ordinary candidate (the judge had the say), as before", async () => {
    const s = setup(new ScriptedModel([answer("different")]));
    await seed(s.store, rejectedOf(REJECTED));
    expect((await curateDraft(s.deps, KEY, textOf("Resume the nightly sync job while the billing service deploys to production."))).outcome).toBe("added");
  });
});
