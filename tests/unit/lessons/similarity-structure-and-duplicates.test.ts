// A merge happens only when the two lessons are the same advice BY STRUCTURE, never on a judge's
// word alone. Code operators are words; a call is not sent with less than 200 ms left; a judge's "same" for a pair that is not the same by structure keeps the draft apart as a possible duplicate for a person
// ( and the rule behind it); an SDK that failed to load is "unavailable", not "loading".
import { beforeEach, describe, expect, it } from "vitest";
import { relate, sameByStructure, wordsOf } from "../../../packages/core/src/lessons/copy-match.js";
import { curateDraft, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { processDraft, settleLesson, type ProcessDeps } from "../../../packages/core/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { closeEnoughForSame, docOf, matchesRejected, resetNoEmbedderNotice } from "../../../packages/core/src/lessons/similarity.js";
import { trialBlockers } from "../../../packages/core/src/lessons/trial.js";
import { earnedAttention } from "../../../packages/core/src/lessons/process.js";
import type { LessonDraft } from "../../../packages/core/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, closeEmbedder, directory, draft, embedder, facts, lessonRecord, seed, settings, uniqueDraft, verifier } from "./lesson-helpers.js";

const answer = (...verdicts: string[]): string => JSON.stringify({ verdicts: verdicts.map((verdict, i) => ({ n: i + 1, verdict })) });
const textOf = (body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title: "Advice", description: "", body, citations: [], scope: {}, ...over });
const plain = (id: string, body: string, over: Partial<Parameters<typeof lessonRecord>[0]> = {}) => lessonRecord({ id, title: "Advice", description: "", body, citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [], scope: {}, ...over });

function setup(model: ScriptedModel, over: { embedder?: boolean } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  let n = 0;
  const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
    store, ...(over.embedder === true ? { embedder: closeEmbedder } : {}), vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit, alerts: new Alerts(), now: new Clock().now,
    verifier: verifier("valid"), settings: settings(), log: () => undefined, newId: () => `les_${String(++n).padStart(4, "0")}`, access: allowAllAccess,
  };
  return { deps, store, audit, model };
}
beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

const FAVOURABLE = [{ bodyMutual: 0.99, cosine: 0.99, sharedFile: true, bothUncited: false }, { bodyMutual: 0.99, sharedFile: true, bothUncited: false }] as const;

// ---- code operators are words ----
describe("wordsOf keeps code operators, so opposite code advice is never verbatim", () => {
  it("a `!` before an identifier, a call or a bracket is a not; && and || and the comparison operators are sign tokens", () => {
    expect(wordsOf("Guard the step with `!isProd`.")).toEqual(["guard", "the", "step", "with", "not", "isprod"]);
    expect(wordsOf("Guard the step with `isProd`.")).toEqual(["guard", "the", "step", "with", "isprod"]);
    expect(wordsOf("Run only if !(a) or ![b]")).toEqual(["run", "only", "if", "not", "(", "a", ")", "or", "not", "[", "b", "]"].filter((w) => !["(", ")", "[", "]"].includes(w)));
    expect(wordsOf("when a && b, or a || b")).toEqual(["when", "a", "&&", "b", "or", "a", "||", "b"]);
    expect(wordsOf("x === 1 and y !== 2 and z == 3 and w != 4 and a <= 5 and b >= 6 and c < 7 and d > 8")).toEqual(["x", "===", "1", "and", "y", "!==", "2", "and", "z", "==", "3", "and", "w", "!=", "4", "and", "a", "<=", "5", "and", "b", ">=", "6", "and", "c", "<", "7", "and", "d", ">", "8"]);
  });

  it("ordinary punctuation is not a negation: a sentence-final `!`, TypeScript's non-null assertion, and `!!x`", () => {
    expect(wordsOf("Always run the linter!")).toEqual(["always", "run", "the", "linter"]);
    expect(wordsOf("Read `user!.name` and `rows[0]!.id`.")).toEqual(["read", "user", "name", "and", "rows", "0", "id"]);
    expect(wordsOf("Coerce with `!!flag`.")).toEqual(["coerce", "with", "flag"]);
    // `not isProd` and `!isProd` say the same thing.
    expect(wordsOf("guard with not isProd")).toEqual(wordsOf("guard with !isProd"));
  });

  const PAIRS: Array<[string, string, string]> = [
    ["!isProd", "Guard the seed step with `!isProd` before writing fixtures in the importer.", "Guard the seed step with `isProd` before writing fixtures in the importer."],
    ["&& / ||", "Seed only when `a && b` holds in the importer fixtures step.", "Seed only when `a || b` holds in the importer fixtures step."],
  ];

  it.each(PAIRS)("%s: not verbatim, not near, never close enough for a judge's same, in either direction", (_name, a, b) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const r = relate(x, y);
      expect(r.verbatim, "verbatim").toBe(false);
      expect(r.near, "near").toBe(false);
      expect(r.opposed, "opposed").toBe(true);
      for (const ranked of FAVOURABLE) expect(closeEnoughForSame(ranked, x, y)).toBe(false);
      expect(sameByStructure(x, y)).toBe(false);
    }
  });

  it.each(PAIRS)("%s against a LIVE lesson: a judge that says same, contradicts or nothing at all never merges the opposite draft (the judge is asked: no verbatim shortcut)", async (_name, a, b) => {
    for (const reply of ["same", "contradicts", "different"] as const) {
      const s = setup(new ScriptedModel([answer(reply)]));
      await seed(s.store, plain("les_live0001", b, { status: "active", tier: 0, tierReasons: ["cited_fact"] }));
      const out = await curateDraft(s.deps, KEY, textOf(a));
      expect(out.outcome, reply).not.toBe("merged");
      expect(s.model.calls, reply).toHaveLength(1);
      expect((await s.store.get(KEY, "les_live0001"))!.version).toBe(1);
      expect(s.audit.actions()).not.toContain("lesson.merged");
      if (reply === "contradicts") expect(out).toMatchObject({ outcome: "contradiction", other: "les_live0001" });
      // The pair is flipped by the ordered test, which has the last word over a judge: a person sees it as a contradiction.
      if (reply === "same") expect(out).toMatchObject({ outcome: "contradiction", other: "les_live0001" });
    }
    // With no judge at all the pair is still not merged.
    const none = setup(new ScriptedModel());
    await seed(none.store, plain("les_live0001", b, { status: "active", tier: 0, tierReasons: ["cited_fact"] }));
    expect((await curateDraft(none.deps, KEY, textOf(a))).outcome).not.toBe("merged");
  });

  it.each(PAIRS)("%s against a REJECTED lesson: the correct opposite draft is not dropped as previously_rejected", async (_name, a, b) => {
    const s = setup(new ScriptedModel([answer("different")]));
    await seed(s.store, plain("les_rej00001", b, { status: "rejected" }));
    const out = await curateDraft(s.deps, KEY, textOf(a));
    expect(out.outcome).not.toBe("dropped");
    expect(matchesRejected(docOf(textOf(a)), docOf(plain("x", b)), 0.99, a, b)).toBe(false);
    // Positive control: the rejected advice itself coming back is dropped (the path ran).
    const again = setup(new ScriptedModel());
    await seed(again.store, plain("les_rej00001", b, { status: "rejected" }));
    expect(await curateDraft(again.deps, KEY, textOf(b))).toEqual({ outcome: "dropped", reason: "previously_rejected" });
  });

  it("positive control: the same code advice in other case, spacing and filler is the same", () => {
    expect(relate("Guard the seed step with `!isProd`.", "guard the seed step with not isProd").verbatim).toBe(true);
    expect(closeEnoughForSame(FAVOURABLE[0], "Guard the seed step with `!isProd`", "Guard the seed step with the `!isProd` flag too")).toBe(false);
    expect(closeEnoughForSame(FAVOURABLE[0], "Guard the seed step with `!isProd`", "Guard the seed step with `!isProd`")).toBe(true);
  });
});

// ---- the structural rule -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** The reviewer's pairs: each is a different piece of advice that no word list needs to know about. */
const NEVER_SAME: Array<[string, string, string]> = [
  ["unlisted negation (Hungarian nem + a swap)", "Nem hasznalj withRetry HTTP hivasokhoz az api szolgaltatasban mindig.", "Hasznalj withRetry HTTP hivasokhoz az api szolgaltatasban gyakran."],
  ["unlisted negation (Tagalog huwag + a swap)", "Huwag gamitin ang withRetry sa HTTP calls ng api service.", "Gamitin ang withRetry sa HTTP requests ng api service."],
  ["shun", "Shun withRetry for HTTP calls in the api service code.", "Use withRetry for HTTP calls in the api service code."],
  ["steer clear of", "Steer clear of withRetry for HTTP calls in the api service.", "Use withRetry for HTTP calls in the api service."],
  ["under no circumstances", "Under no circumstances use withRetry for HTTP calls in api.", "In all circumstances use withRetry for HTTP calls in api."],
  ["three content words, unlisted negation", "Ei cache auth tokens.", "Cache auth tokens."],
  ["three content words, nem", "Nem cache auth tokens.", "Cache auth tokens."],
  ["pause / resume", "Pause the queue consumer during the billing migration.", "Resume the queue consumer during the billing migration."],
  ["show / hide", "Show the stack trace in api error responses.", "Hide the stack trace in api error responses."],
  ["retain / delete", "Retain the audit rows after the account is closed.", "Delete the audit rows after the account is closed."],
  ["serial / parallel", "Run the migration steps serially in the deploy job.", "Run the migration steps in parallel in the deploy job."],
  ["allowlist / denylist", "Put the vendor IPs on the allowlist for the webhook route.", "Put the vendor IPs on the denylist for the webhook route."],
  ["earlier / later", "Run the cache warmup earlier than the api deploy.", "Run the cache warmup later than the api deploy."],
  ["strict / loose", "Use strict mode for the JSON schema validator in api.", "Use loose mode for the JSON schema validator in api."],
  ["throw / swallow", "Throw the error from the webhook handler on bad signatures.", "Swallow the error from the webhook handler on bad signatures."],
  ["readonly / readwrite", "Open the database readonly in the report job.", "Open the database readwrite in the report job."],
  ["sequential / concurrent", "Run the integration suites sequentially in CI.", "Run the integration suites concurrently in CI."],
  ["trust / distrust", "Trust the forwarded host header in the api gateway.", "Distrust the forwarded host header in the api gateway."],
  ["a benign paraphrase is not the same by structure either", "Wrap HTTP calls in the api service with withRetry helper.", "Wrap HTTP calls in the api service using the withRetry helper."],
  ["a benign added word", "Cache the auth tokens in memory.", "Cache the auth tokens in memory briefly."],
  ["a benign dropped word", "Cache the auth tokens in memory briefly.", "Cache the auth tokens in memory."],
  ["a benign swapped word", "Cache the auth tokens in memory.", "Cache the session tokens in memory."],
];

describe("a merge needs the same advice BY STRUCTURE: a judge's \"same\" never merges anything else", () => {
  it.each(NEVER_SAME)("%s: not close enough, whatever the shortlist figures, in either direction", (_name, a, b) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      expect(sameByStructure(x, y)).toBe(false);
      for (const ranked of FAVOURABLE) expect(closeEnoughForSame(ranked, x, y)).toBe(false);
    }
  });

  it.each(NEVER_SAME)("%s: a judge that says same does not merge it; the draft is kept apart (a possible duplicate or, where the words are flipped, a contradiction), and the target is untouched", async (_name, a, b) => {
    for (const withEmbedder of [false, true]) {
      const s = setup(new ScriptedModel([answer("same")]), { embedder: withEmbedder });
      await seed(s.store, plain("les_target01", b, { status: "candidate" }));
      const out = await curateDraft(s.deps, KEY, textOf(a));
      expect(s.model.calls, "the judge was asked").toHaveLength(1);
      expect(out.outcome, `embedder ${String(withEmbedder)}`).not.toBe("merged");
      expect(out.outcome).not.toBe("dropped");
      expect((await s.store.get(KEY, "les_target01"))!.version).toBe(1);
      expect(s.audit.actions()).not.toContain("lesson.merged");
      if (out.outcome === "possible_duplicate") expect(out).toMatchObject({ duplicateOf: "les_target01", lesson: { status: "pending", possibleDuplicateOf: "les_target01", tierReasons: ["possible_duplicate"] } });
      // The two lessons both exist afterwards: nothing was folded into the other.
      expect(await s.store.list(KEY)).toHaveLength(2);
    }
  });

  it("positive controls: a copy that differs only by case, punctuation, filler and a plural IS the same, and a judge's same merges it", async () => {
    const target = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const copies = [
      "use withRetry, from src/retry/index.ts for HTTP retries in the api service client calls!",
      "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call",
      "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls, please.",
    ];
    for (const copy of copies) {
      expect(sameByStructure(copy, target), copy).toBe(true);
      for (const ranked of FAVOURABLE) expect(closeEnoughForSame(ranked, copy, target)).toBe(true);
      const s = setup(new ScriptedModel([answer("same")]));
      await seed(s.store, plain("les_target01", target, { status: "candidate", citations: [], scope: {} }));
      expect((await curateDraft(s.deps, KEY, textOf(copy))).outcome, copy).toBe("merged");
      expect(s.model.calls.length).toBeLessThanOrEqual(1);
    }
  });

  it("the same words in a new order are not the same (pnpm over npm), and signs and numbers in another order are not either", () => {
    expect(sameByStructure("Prefer pnpm over npm for installs.", "Prefer npm over pnpm for installs.")).toBe(false);
    expect(sameByStructure("Retry 3 times then wait 9 seconds.", "Retry 9 times then wait 3 seconds.")).toBe(false);
    expect(sameByStructure("Alert when depth > 1000 and age < 30.", "Alert when depth < 1000 and age > 30.")).toBe(false);
    expect(sameByStructure("Prefer pnpm over npm for installs.", "Prefer pnpm over npm for the installs.")).toBe(true);
  });

  it("the order of the negation, direction and number tokens must agree even in a text too short for the reorder test (two words)", () => {
    expect(sameByStructure("on off", "off on")).toBe(false);
    expect(sameByStructure("3 9", "9 3")).toBe(false);
    expect(sameByStructure("on off", "on off")).toBe(true);
  });

  it("a text with a negation this module cannot classify merges only as a verbatim or near copy", () => {
    const de = "Verwende withRetry nicht fuer HTTP Aufrufe im api Dienst.";
    expect(closeEnoughForSame(FAVOURABLE[0], de, de)).toBe(true);
    expect(closeEnoughForSame(FAVOURABLE[0], de, "Verwende withRetry fuer HTTP Aufrufe im api Dienst.")).toBe(false);
    // Reordered unknown negation: equal words, but it cannot be classified, so it is not a judge's same.
    expect(closeEnoughForSame(FAVOURABLE[0], "Nicht oft withRetry verwenden im api Dienst.", "Oft nicht withRetry verwenden im api Dienst.")).toBe(false);
  });

  it("a REJECTED lesson a judge calls the same is dropped only when it is the same advice; a possible duplicate of one is still the draft's own, never merged anywhere", async () => {
    const s = setup(new ScriptedModel([answer("same")]));
    await seed(s.store, plain("les_rej00001", "Cache the auth tokens in memory.", { status: "rejected" }));
    const out = await curateDraft(s.deps, KEY, textOf("Cache the auth tokens in memory briefly."));
    expect(out.outcome).not.toBe("merged");
    expect(s.audit.actions()).not.toContain("lesson.merged");
  });
});

// ---- a possible duplicate is not applied by itself -------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("a possible duplicate waits for a person: no trial, no auto-apply, shown as Possible duplicate", () => {
  const STANDARD = settings({ preset: "standard" });
  function process(model: ScriptedModel, over: { settings?: ReturnType<typeof settings> } = {}) {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    let n = 0;
    const deps: ProcessDeps = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit, alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), facts: facts(), settings: over.settings ?? STANDARD,
      newId: () => `les_${String(++n).padStart(4, "0")}`, access: allowAllAccess, coldStartLessons: 0, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }),
    } as ProcessDeps;
    return { deps, store, audit };
  }
  const memberDraft = (body: string): LessonDraft => draft({ body, provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true } });
  const REWORDED = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
  const TARGET = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";

  it("positive control: the same member correction with no neighbour goes live on trial", async () => {
    const s = process(new ScriptedModel());
    expect((await processDraft(s.deps, KEY, memberDraft(REWORDED))).lesson).toMatchObject({ status: "active", trial: { state: "trial" } });
  });

  it("a reworded draft that a judge calls the same stays pending beside the other lesson: not merged, not on trial, not active, and audited as created with the link", async () => {
    const s = process(new ScriptedModel([answer("same")]));
    await seed(s.store, plain("les_target01", TARGET, { status: "candidate", citations: [draft().citations[0]!], scope: draft().scope, tier: 1, tierReasons: [] }));
    const out = await processDraft(s.deps, KEY, memberDraft(REWORDED));
    expect(out.outcome).toMatchObject({ outcome: "possible_duplicate", duplicateOf: "les_target01" });
    expect(out.lesson).toMatchObject({ status: "pending", possibleDuplicateOf: "les_target01" });
    expect(out.lesson!.trial).toBeUndefined();
    expect(out.lesson!.approvals).toEqual([]);
    expect(s.audit.actions()).not.toContain("lesson.trial_started");
    expect(s.audit.actions()).not.toContain("lesson.merged");
    expect(s.audit.events.find((e) => e.action === "lesson.candidate_created" && e.lessonId === out.lesson!.id)?.facts).toMatchObject({ possibleDuplicateOf: "les_target01" });
    // Settling again changes nothing: it is still waiting for a person.
    expect((await settleLesson(s.deps, KEY, out.lesson!.id))).toMatchObject({ status: "pending", possibleDuplicateOf: "les_target01" });
  });

  it("the trial rule names it, and the rule that puts a lesson in front of people counts it", () => {
    const base = plain("les_dup00001", TARGET, { status: "pending", provenance: { ...lessonRecord().provenance, supportTasks: ["task-1"], memberSignal: false, measured: false, sourceKinds: ["human_edit"] } });
    const linked = { ...base, possibleDuplicateOf: "les_target01" };
    expect(trialBlockers(base, 1, { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false } as never)).not.toContain("possible_duplicate");
    expect(trialBlockers(linked, 1, { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false } as never)).toContain("possible_duplicate");
    expect(earnedAttention(base, 1, [])).toBe(false);
    expect(earnedAttention(linked, 1, [])).toBe(true);
  });

  it("a tier-0 fact with every other condition for going live by itself is held for a person while it is linked", async () => {
    const s = process(new ScriptedModel([answer("same")]), { settings: settings({ preset: "standard", tier0Approval: "auto" }) });
    const prov = { sources: ["member:zed"], inputSources: ["member:zed"], authors: [], memberSignal: false, sourceKinds: ["send_back" as const], measured: true };
    const first = await processDraft(s.deps, KEY, uniqueDraft(7, prov));
    expect(first.lesson).toMatchObject({ status: "active", tier: 0 });
    // Another corroborated tier-0 draft about the same file, reworded, that the judge calls the same: it is the draft's own lesson and waits for a person.
    const [t0, t1] = Array.from({ length: 2 }, (_, j) => `w7x${String(j)}q${String(7 * 31 + j)}`);
    const second = await processDraft(s.deps, KEY, uniqueDraft(7, { ...prov, sources: ["member:yan"], inputSources: ["member:yan"] }, { body: `Look in src/m7/index.ts for the ${t0} ${t1}.` }));
    expect(second.outcome.outcome).toBe("possible_duplicate");
    expect(second.lesson).toMatchObject({ status: "pending", possibleDuplicateOf: first.lesson!.id });
    expect(second.lesson!.approvals).toEqual([]);
    // Positive control: without the link the same kind of draft (nothing to be a duplicate of) goes live by itself.
    const alone = process(new ScriptedModel(), { settings: settings({ preset: "standard", tier0Approval: "auto" }) });
    expect((await processDraft(alone.deps, KEY, uniqueDraft(8, prov))).lesson).toMatchObject({ status: "active" });
  });
});

// ---- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("a possible duplicate is never applied by itself, even as a tier-0 fact that was tiered before it was linked", () => {
  it("a corroborated tier-0 lesson with the link set and no tier reasons stays pending when settled", async () => {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), facts: facts(),
      settings: settings({ preset: "standard", tier0Approval: "auto" }), newId: () => `les_${String(++n).padStart(4, "0")}`, access: allowAllAccess, coldStartLessons: 0,
    } as ProcessDeps;
    const prov = { sources: ["member:zed"], inputSources: ["member:zed"], authors: [], memberSignal: false, sourceKinds: ["send_back" as const], measured: true };
    const alone = await processDraft(deps, KEY, uniqueDraft(11, prov));
    expect(alone.lesson).toMatchObject({ status: "active", tier: 0 });
    // The same draft shape, but linked: it must not go live by itself.
    const linked = await curateDraft(deps, KEY, uniqueDraft(12, prov));
    if (linked.outcome !== "added") throw new Error("expected add");
    const setVersion = await store.setVersion(KEY);
    await store.commit(KEY, setVersion, [{ ...linked.lesson, version: 2, possibleDuplicateOf: alone.lesson!.id }], 2);
    expect(await settleLesson(deps, KEY, linked.lesson.id)).toMatchObject({ status: "pending", tier: 0, possibleDuplicateOf: alone.lesson!.id });
  });
});

describe("merged from integ: a copy whose people would not fit one lesson is kept apart for a person (lessons capture), in the structural flow too", () => {
  it("a verbatim copy and a judge's same for a copy both stay apart as a reviewRequired candidate, audited, and the target is untouched", async () => {
    const BODY = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const authors = Array.from({ length: 20 }, (_, i) => `person-${String(i)}`);
    for (const [name, model, body] of [["verbatim", new ScriptedModel(), BODY], ["judge same on a near copy", new ScriptedModel([answer("same")]), "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call"]] as const) {
      const s = setup(model);
      await seed(s.store, plain("les_target01", BODY, { status: "candidate", provenance: { ...lessonRecord().provenance, authors } }));
      const out = await curateDraft(s.deps, KEY, textOf(body, { provenance: { ...draft().provenance, authors: ["newcomer"] } }));
      expect(out, name).toMatchObject({ outcome: "added", lesson: { status: "candidate", reviewRequired: true, tierReasons: ["merge_too_many_people"] } });
      expect((await s.store.get(KEY, "les_target01"))!.version, name).toBe(1);
      expect(s.audit.events.find((e) => e.action === "lesson.refused")?.facts, name).toMatchObject({ reason: "merge_too_many_people" });
      expect(s.audit.actions(), name).not.toContain("lesson.merged");
    }
  });
});

// ---- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
