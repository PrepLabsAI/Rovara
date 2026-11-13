// A judge's "same" is never acted on for a pure insertion or an unlisted negation; the card that
// names no rejected lesson stays in front of people when it is settled again; the judge sees five live lessons PLUS two reserved rejected ones; the embedder pause starts only when the function was really
// given time, the SDK load is outside the load budget and the vector read has its own timeout; the prefix-antonym rule refuses a merge but never lets a draft evade a rejected lesson.
import { beforeEach, describe, expect, it } from "vitest";
import { hasUnclassifiedNegation, relate } from "../../../packages/core/src/lessons/copy-match.js";
import { curateDraft, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { approveLesson, type ApproveDeps } from "../../../packages/core/src/lessons/approve.js";
import { earnedAttention, processDraft, settleLesson, type ProcessDeps } from "../../../packages/core/src/lessons/process.js";
import type { LessonEmbedder } from "../../../packages/core/src/lessons/ports.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { closeEnoughForSame, docOf, matchesRejected, resetNoEmbedderNotice } from "../../../packages/core/src/lessons/similarity.js";
import type { LessonDraft } from "../../../packages/core/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, directory, draft, embedder, facts, allowAllAccess, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

const answer = (...verdicts: string[]): string => JSON.stringify({ verdicts: verdicts.map((verdict, i) => ({ n: i + 1, verdict })) });
const textOf = (body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title: "Advice", description: "", body, citations: [], scope: {}, ...over });
const acl = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/C9", principals, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" as const } });

function setup(over: { model?: ScriptedModel; embedder?: LessonEmbedder; settings?: ProcessDeps["settings"] } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const model = over.model ?? new ScriptedModel();
  let n = 0;
  const deps: CurateDeps & ProcessDeps = {
    store, ...(over.embedder === undefined ? {} : { embedder: over.embedder }), vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit, alerts: new Alerts(), now: new Clock().now,
    verifier: verifier("valid"), facts: facts(), settings: over.settings ?? settings(), log: () => undefined, newId: () => `les_${String(++n).padStart(4, "0")}`,
    access: allowAllAccess,
  };
  return { deps, store, audit, model };
}
const plain = (id: string, body: string, over: Partial<Parameters<typeof lessonRecord>[0]> = {}) => lessonRecord({ id, title: "Advice", description: "", body, citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [], scope: {}, ...over });
const rejectedLesson = (body: string, over: Partial<Parameters<typeof lessonRecord>[0]> = {}) => plain("les_rej00001", body, { status: "rejected", ...over });
beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

// ---- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Every pair is a statement and its opposite (or a statement and the same statement with a negation this module cannot classify). None may ever be merged on a judge's "same".
const OPPOSITES: Array<[string, string, string]> = [
  ["italian non", "Non usare withRetry per le chiamate HTTP del servizio api.", "Usare withRetry per le chiamate HTTP del servizio api."],
  ["norwegian ikke", "Bruk ikke withRetry for HTTP kall i api tjenesten.", "Bruk withRetry for HTTP kall i api tjenesten."],
  ["indonesian jangan", "Jangan pakai withRetry untuk panggilan HTTP di layanan api.", "Pakai withRetry untuk panggilan HTTP di layanan api."],
  ["romanian nu", "Nu folositi withRetry pentru apelurile HTTP din serviciul api.", "Folositi withRetry pentru apelurile HTTP din serviciul api."],
  ["czech ne", "Ne pouzivejte withRetry pro volani HTTP ve sluzbe api.", "Pouzivejte withRetry pro volani HTTP ve sluzbe api."],
  ["afrikaans nie", "Gebruik withRetry nie vir HTTP oproepe in die api diens.", "Gebruik withRetry vir HTTP oproepe in die api diens."],
  // Negations the word list does not know: only the structural guard (one added word is never the same) stops these.
  ["hungarian nem (unlisted)", "Nem hasznalj withRetry HTTP hivasokhoz az api szolgaltatasban.", "Hasznalj withRetry HTTP hivasokhoz az api szolgaltatasban."],
  ["finnish ei (unlisted)", "Ei kayteta withRetry HTTP kutsuissa api palvelussa.", "Kayteta withRetry HTTP kutsuissa api palvelussa."],
  ["tagalog huwag (unlisted)", "Huwag gumamit ng withRetry sa HTTP calls ng api service.", "Gumamit ng withRetry sa HTTP calls ng api service."],
  ["refrain from", "Refrain from using withRetry for HTTP calls in the api service.", "Use withRetry for HTTP calls in the api service."],
  ["quit using", "Quit using withRetry for HTTP calls in the api service.", "Use withRetry for HTTP calls in the api service."],
  ["enabling / disabling", "Keep caching for the build step by enabling the flag in CI.", "Keep caching for the build step by disabling the flag in CI."],
  ["raising / lowering", "Fix flaky importer runs by raising the lambda timeout.", "Fix flaky importer runs by lowering the lambda timeout."],
  ["skipping / running", "Speed up release builds by skipping the integration tests.", "Speed up release builds by running the integration tests."],
  ["encrypt / decrypt", "Encrypt the export before uploading it to the bucket.", "Decrypt the export before uploading it to the bucket."],
  ["ascending / descending", "Sort the audit rows in ascending order by time.", "Sort the audit rows in descending order by time."],
  ["inside / outside", "Run the migration inside the transaction.", "Run the migration outside the transaction."],
  ["optional / mandatory", "The request id header is optional for internal callers.", "The request id header is mandatory for internal callers."],
  ["success / failure", "Send the alert on success of the nightly job.", "Send the alert on failure of the nightly job."],
];

describe("a judge's \"same\" is never acted on for opposite advice", () => {
  const both = (a: string, b: string) => [[a, b], [b, a]] as const;
  it.each(OPPOSITES)("%s: not close enough for a judge's same, with or without an embedder, in either direction", (_name, a, b) => {
    for (const [x, y] of both(a, b)) {
      expect(closeEnoughForSame({ bodyMutual: 0.95, cosine: 0.97, sharedFile: false, bothUncited: true }, x, y)).toBe(false);
      expect(closeEnoughForSame({ bodyMutual: 0.95, sharedFile: false, bothUncited: true }, x, y)).toBe(false);
    }
  });

  it.each(OPPOSITES)("%s: a judge that says same never merges the draft into the lesson (it is a refinement or a contradiction for a person)", async (_name, a, b) => {
    for (const [draftBody, lessonBody] of both(a, b)) {
      const s = setup({ model: new ScriptedModel([answer("same")]) });
      await seed(s.store, plain("les_live0001", lessonBody, { status: "active", tier: 0, tierReasons: ["cited_fact"] }));
      const out = await curateDraft(s.deps, KEY, textOf(draftBody));
      // Positive control: the judge was asked, and answered same.
      expect(s.model.calls).toHaveLength(1);
      expect(out.outcome).not.toBe("merged");
      expect((await s.store.get(KEY, "les_live0001"))!.version).toBe(1);
    }
  });

  it("the structural guard: one inserted word is a refinement, never the same (the first text holds the second's words and more)", () => {
    const longer = "Use withRetry sparingly for HTTP calls in the api service.";
    const shorter = "Use withRetry for HTTP calls in the api service.";
    expect(relate(longer, shorter).narrows).toBe(true);
    expect(closeEnoughForSame({ bodyMutual: 0.95, cosine: 0.97, sharedFile: false, bothUncited: true }, longer, shorter)).toBe(false);
    expect(closeEnoughForSame({ bodyMutual: 0.95, cosine: 0.97, sharedFile: false, bothUncited: true }, shorter, longer)).toBe(false);
  });

  it("a verbatim copy, a near copy and a close paraphrase of the same advice are still the same", () => {
    const a = "Use withRetry for HTTP calls in the api service.";
    expect(closeEnoughForSame({ bodyMutual: 1, sharedFile: false, bothUncited: true }, a, a)).toBe(true);
    expect(closeEnoughForSame({ bodyMutual: 0.9, sharedFile: false, bothUncited: true }, a, "Use the withRetry for the HTTP calls in api service.")).toBe(true);
    expect(closeEnoughForSame({ bodyMutual: 0.9, cosine: 0.96, sharedFile: false, bothUncited: true }, "Wrap HTTP calls in the api service with withRetry helper.", "Wrap HTTP calls in the api service with the withRetry helper.")).toBe(true);
  });

  describe("the word lists", () => {
    it("a de- prefix makes the opposite of a verb", () => {
      for (const [a, b] of [["Compress the export before upload to the bucket.", "Decompress the export before upload to the bucket."], ["Register the webhook with the gateway at startup.", "Deregister the webhook with the gateway at startup."], ["Allocate the buffer pool upfront for the importer.", "Deallocate the buffer pool upfront for the importer."]] as const) {
        const r = relate(a, b);
        expect(r.polaritySame).toBe(false);
        expect(r.criticalSame).toBe(false);
        expect(closeEnoughForSame({ bodyMutual: 0.95, cosine: 0.97, sharedFile: false, bothUncited: true }, a, b)).toBe(false);
      }
    });

    it("-ing and -ed forms of the listed verbs are read as the verb", () => {
      expect(relate("Keep caching by enabling the flag in CI.", "Keep caching by disabling the flag in CI.").polaritySame).toBe(false);
      expect(relate("Keep caching by enabling the flag in CI.", "Keep caching by disabling the flag in CI.").opposed).toBe(true);
      expect(relate("The tests were skipped on release branches in CI.", "The tests were run on release branches in CI.").polaritySame).toBe(false);
      expect(relate("Raised the lambda timeout for the importer.", "Lowered the lambda timeout for the importer.").polaritySame).toBe(false);
      // The same verb in another form is the same word: a control.
      expect(relate("Enabling the flag in CI for the build step.", "Enable the flag in CI for the build step.").polaritySame).toBe(true);
      expect(relate("Enabling the flag in CI for the build step.", "Enable the flag in CI for the build step.").near).toBe(true);
    });

    it("refrain, quit, cease and the new antonyms are polarity words", () => {
      for (const [a, b] of [["Refrain from caching the token in CI.", "Cache the token in CI."], ["Cease caching the token in CI.", "Cache the token in CI."], ["Sort rows in ascending order.", "Sort rows in descending order."], ["Run it inside the transaction block.", "Run it outside the transaction block."], ["Encrypt the export file.", "Decrypt the export file."]] as const) {
        expect(relate(a, b).polaritySame).toBe(false);
      }
    });

    it("the listed foreign negations are unclassified, and an English \"non-\" compound is not one", () => {
      for (const text of ["Non usare withRetry.", "Bruk ikke withRetry.", "Jangan pakai withRetry.", "Nu folositi withRetry.", "Ne pouzivejte withRetry.", "Gebruik withRetry nie.", "Anvand inte withRetry.", "Tidak menggunakan withRetry."]) expect(hasUnclassifiedNegation(text)).toBe(true);
      for (const text of ["Use non-blocking calls for withRetry.", "Use withRetry for HTTP calls.", "The nine retries are fine."]) expect(hasUnclassifiedNegation(text)).toBe(false);
    });
  });
});

// ---- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("a card that names no rejected lesson stays in front of people when it is settled again", () => {
  const REJ = "HTTP retries in the api service use withRetry from src/retry/index.ts.";
  const D = "HTTP retries in the api service use withRetry from src/retry/index.ts module.";
  const member = (body: string, over: Partial<LessonDraft["provenance"]> = {}) => draft({ body, provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true, ...over } });
  const standard = () => settings({ preset: "standard" });

  it("with no rejected lesson, a code-cited member correction goes live on trial under the standard preset", async () => {
    const s = setup({ settings: standard() });
    const result = await processDraft(s.deps, KEY, member(D));
    expect(result.lesson).toMatchObject({ status: "active" });
    expect(result.lesson!.trial).toBeDefined();
  });

  it("a second identical member correction merging into the card keeps it pending, never on trial", async () => {
    const s = setup({ settings: standard() });
    await seed(s.store, lessonRecord({ id: "les_rej00001", body: REJ, status: "rejected", approvals: [], tierReasons: [], provenance: { ...lessonRecord().provenance, audience: acl(["U-x"]) } }));
    const first = await processDraft(s.deps, KEY, member(D));
    expect(first.outcome).toMatchObject({ outcome: "contradiction", matchesRejected: true });
    expect(first.lesson).toMatchObject({ status: "pending" });
    expect(first.lesson!.contradictsWith).toBeUndefined();
    expect(first.lesson!.tierReasons).toContain("matches_rejected");
    const second = await processDraft(s.deps, KEY, member(D, { supportTasks: ["task-2"], sourceEvents: ["ev-2"] }));
    expect(second.outcome.outcome).toBe("merged");
    expect(second.lesson!.id).toBe(first.lesson!.id);
    expect(second.lesson!.provenance.supportTasks).toEqual(expect.arrayContaining(["task-1", "task-2"]));
    expect(second.lesson).toMatchObject({ status: "pending" });
    expect(second.lesson!.trial).toBeUndefined();
    expect(JSON.stringify(s.audit.events)).not.toContain("les_rej00001");
  });

  it("settling a single-support card again keeps it pending (earnedAttention knows the reason; nothing else needs a link)", async () => {
    const s = setup({ settings: standard() });
    const card = lessonRecord({
      id: "les_card0001", status: "candidate", tier: 1, tierReasons: ["contradiction", "matches_rejected"], type: "convention", approvals: [],
      provenance: { ...lessonRecord().provenance, supportTasks: ["task-1"], memberSignal: false, memberCorrection: undefined, claimsSupported: undefined, fromSharedTask: undefined, sourceKinds: ["human_edit"] },
    });
    await seed(s.store, card);
    expect((await settleLesson(s.deps, KEY, "les_card0001"))!.status).toBe("pending");
    // Control: the same lesson without the reason has a single supporting task and stays a candidate.
    const t = setup({ settings: standard() });
    await seed(t.store, { ...card, tierReasons: [] });
    expect((await settleLesson(t.deps, KEY, "les_card0001"))!.status).toBe("candidate");
  });

  it("earnedAttention: the reason alone is enough, a lone single-support lesson without it is not", () => {
    const lone = lessonRecord({ provenance: { ...lessonRecord().provenance, supportTasks: ["task-1"], memberSignal: false } });
    expect(earnedAttention(lone, 1, [])).toBe(false);
    expect(earnedAttention(lone, 1, ["matches_rejected"])).toBe(true);
  });

  it("an edit-and-approve on such a card keeps the contradiction reason (approve re-reads matches_rejected as a contradiction)", async () => {
    const store = new InMemoryLessonStore();
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit: new Audit(), now: new Clock().now, newId: () => "ap-1" };
    await seed(store, lessonRecord({ id: "les_card0001", status: "pending", tier: 1, tierReasons: ["matches_rejected"], type: "convention", approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] } }));
    const result = await approveLesson(deps, { ...KEY, lessonId: "les_card0001", approverId: "ann", edit: { title: "Retries", description: "", body: "Use withRetry for api calls." } });
    expect(result).toMatchObject({ ok: true });
    expect((await store.get(KEY, "les_card0001"))!.tierReasons).toContain("contradiction");
  });
});

// ---- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the judge sees up to five live lessons PLUS up to two reserved rejected lessons, in one call", () => {
  const BODY = "Use withRetry for HTTP retries in the api service.";
  const seedLive = async (store: InMemoryLessonStore, count: number) => { for (let i = 0; i < count; i += 1) await seed(store, plain(`les_live${i}000`, `Use withRetry for HTTP retries in the api service when calling vendor ${i} endpoints for build ${i}.`, { status: "candidate" })); };
  const seedRejected = async (store: InMemoryLessonStore, count: number) => { for (let i = 0; i < count; i += 1) await seed(store, plain(`les_rej${i}0000`, `Wrap HTTP retries in the api service with withRetry for worker ${i} during release ${i}.`, { status: "rejected" })); };
  const count = (prompt: string, state: string) => (prompt.match(new RegExp(`^\\d+\\. state=${state}`, "gmu")) ?? []).length;

  it("six live and three rejected lessons: five live and two rejected go to the judge in ONE call", async () => {
    const s = setup({ model: new ScriptedModel([answer("different", "different", "different", "different", "different", "different", "different")]) });
    await seedLive(s.store, 6);
    await seedRejected(s.store, 3);
    await curateDraft(s.deps, KEY, textOf(BODY));
    expect(s.model.calls).toHaveLength(1);
    const prompt = String(s.model.calls[0]!.user);
    expect(count(prompt, "existing")).toBe(5);
    expect(count(prompt, "previously_rejected")).toBe(2);
  });

  it("no rejected lesson: five live lessons; one rejected lesson: five live and one rejected", async () => {
    const a = setup({ model: new ScriptedModel([answer("different", "different", "different", "different", "different")]) });
    await seedLive(a.store, 6);
    await curateDraft(a.deps, KEY, textOf(BODY));
    expect(count(String(a.model.calls[0]!.user), "existing")).toBe(5);
    expect(count(String(a.model.calls[0]!.user), "previously_rejected")).toBe(0);
    const b = setup({ model: new ScriptedModel([answer("different", "different", "different", "different", "different", "different")]) });
    await seedLive(b.store, 6);
    await seedRejected(b.store, 1);
    await curateDraft(b.deps, KEY, textOf(BODY));
    expect(b.model.calls).toHaveLength(1);
    expect(count(String(b.model.calls[0]!.user), "existing")).toBe(5);
    expect(count(String(b.model.calls[0]!.user), "previously_rejected")).toBe(1);
  });
});

// ---- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ---- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the prefix-antonym rule refuses a merge but never lets a draft evade a rejected lesson", () => {
  const REJECTED = "Keep connecting to the staging database pool during importer runs.";
  const EVADING = "Keep connecting to the staging database pool during importer runs, disconnecting only at shutdown.";

  it("matchesRejected: adding a prefixed antonym of one of the rejected lesson's words does not clear the match", () => {
    expect(matchesRejected(docOf(textOf(EVADING)), docOf(textOf(REJECTED)), undefined, EVADING, REJECTED)).toBe(true);
    expect(matchesRejected(docOf(textOf(EVADING)), docOf(textOf(REJECTED)), 0.95, EVADING, REJECTED)).toBe(true);
    // Control: the unmodified draft matched before; a draft that really drops the advice does not.
    expect(matchesRejected(docOf(textOf(REJECTED)), docOf(textOf(REJECTED)), undefined, REJECTED, REJECTED)).toBe(true);
    expect(matchesRejected(docOf(textOf("Retry the payment webhook 9 times before failing.")), docOf(textOf(REJECTED)), undefined, "Retry the payment webhook 9 times before failing.", REJECTED)).toBe(false);
  });

  it("the curator holds the evading draft for a person (no judge), never a plain candidate", async () => {
    const s = setup();
    await seed(s.store, rejectedLesson(REJECTED));
    const out = await curateDraft(s.deps, KEY, textOf(EVADING));
    expect(out).toMatchObject({ outcome: "contradiction", other: "les_rej00001", matchesRejected: true });
  });

  it("the antonym rule still refuses a merge: connecting / disconnecting is never the same on a judge's word", () => {
    expect(closeEnoughForSame({ bodyMutual: 0.95, cosine: 0.97, sharedFile: false, bothUncited: true }, "Keep connecting to the staging database pool during importer runs.", "Keep disconnecting from the staging database pool during importer runs.")).toBe(false);
    expect(relate("Use the connected pool for importer runs.", "Use the disconnected pool for importer runs.").polaritySame).toBe(false);
  });
});
