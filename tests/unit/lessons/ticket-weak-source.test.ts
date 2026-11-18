// Ticket comments are a WEAK source (L4-SRC-TK): a lesson that rests only on them waits for a second sighting (two tasks AND two comments), is then suggested to a person, and never goes live without one.
// Also: the new span kind in the reflector (a person's words, untrusted data, never a member correction or signal), the repository file rule, the stored shape, and erase.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { erasePersonLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { DocumentLessonStore } from "../../../packages/broker/src/lessons/document-store.js";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { earnedAttention, processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { reflectSubject, type LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { repoVisibilityOf } from "../../../packages/broker/src/lessons/repo-eligibility.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonProvenanceSchema, SPAN_KINDS } from "../../../packages/broker/src/lessons/types.js";
import { STRONG_SPAN_KINDS, WEAK_SIGHTINGS_NEEDED, WEAK_SPAN_KINDS, hasWeakKind, isWeakOnly, seenEnoughTimes, weakSourceWaits } from "../../../packages/broker/src/lessons/weak-source.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, autoSettings, candidateJson, closeEmbedder, draft, embedder, facts, lessonRecord, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const RULE = "Error messages shown to customers must come from copy/errors.ts, not inline strings.";
const ticketSpan = (over: Record<string, unknown> = {}) => memberSpan(RULE, { kind: "ticket_comment", eventId: "ticket:linear:ENG-12:c1", authorId: "ann", sourceKey: "linear:payments", audience: { kind: "project" }, ...over });

describe("the gate itself", () => {
  it("ticket_comment is the weak kind, and a lesson is weak only when EVERY kind it rests on is weak", () => {
    expect([...WEAK_SPAN_KINDS]).toEqual(["ticket_comment"]);
    expect(isWeakOnly({ sourceKinds: ["ticket_comment"] })).toBe(true);
    expect(isWeakOnly({ sourceKinds: ["ticket_comment", "ticket_comment"] })).toBe(true);
    // A neutral kind beside it (the task's own words, Rovara's plan, an outcome, CI text) does not make it strong.
    for (const kind of ["intent", "plan", "outcome", "fact", "ci_failure", "loaded_lesson", "other"]) expect(isWeakOnly({ sourceKinds: ["ticket_comment", kind as never] }), kind).toBe(true);
    for (const kind of STRONG_SPAN_KINDS) expect(isWeakOnly({ sourceKinds: ["ticket_comment", kind as never] }), kind).toBe(false);
    expect(hasWeakKind({ sourceKinds: ["intent", "ticket_comment"] })).toBe(true);
    expect(hasWeakKind({ sourceKinds: ["human_edit"] })).toBe(false);
    expect(isWeakOnly({ sourceKinds: ["ticket_comment", "human_edit"] })).toBe(false);
    expect(isWeakOnly({ sourceKinds: ["pr_comment"] })).toBe(false);
    expect(isWeakOnly({ sourceKinds: [] })).toBe(false);
    expect(isWeakOnly({ sourceKinds: ["other"] })).toBe(false);
    expect(weakSourceWaits({ sourceKinds: ["ticket_comment", "intent"], supportTasks: ["t1"], sourceEvents: ["e1"] })).toBe(true);
  });
  it("seen twice needs two different tasks AND two different comments", () => {
    expect(WEAK_SIGHTINGS_NEEDED).toBe(2);
    expect(seenEnoughTimes({ supportTasks: ["t1"], sourceEvents: ["e1"] })).toBe(false);
    expect(seenEnoughTimes({ supportTasks: ["t1", "t1"], sourceEvents: ["e1", "e2"] })).toBe(false);
    expect(seenEnoughTimes({ supportTasks: ["t1", "t2"], sourceEvents: ["e1", "e1"] })).toBe(false);
    expect(seenEnoughTimes({ supportTasks: ["t1", "t2"], sourceEvents: ["e1", "e2"] })).toBe(true);
  });
  it("a weak-only lesson waits until it is seen twice; any other lesson never waits on this gate", () => {
    expect(weakSourceWaits({ sourceKinds: ["ticket_comment"], supportTasks: ["t1"], sourceEvents: ["e1"] })).toBe(true);
    expect(weakSourceWaits({ sourceKinds: ["ticket_comment"], supportTasks: ["t1", "t2"], sourceEvents: ["e1", "e2"] })).toBe(false);
    expect(weakSourceWaits({ sourceKinds: ["ticket_comment", "send_back"], supportTasks: ["t1"], sourceEvents: ["e1"] })).toBe(false);
    expect(weakSourceWaits({ sourceKinds: ["human_edit"], supportTasks: ["t1"], sourceEvents: ["e1"] })).toBe(false);
  });
  it("earnedAttention: a weak-only lesson does not earn it by a member signal, a measured outcome, a contradiction or a possible duplicate until seen twice", () => {
    const weak = (over: Partial<LessonDraft["provenance"]> = {}) => lessonRecord({ provenance: { ...draft().provenance, sourceKinds: ["ticket_comment"], supportTasks: ["t1"], sourceEvents: ["e1"], memberSignal: true, measured: true, ...over } });
    expect(earnedAttention(weak(), 0)).toBe(false);
    expect(earnedAttention({ ...weak(), contradictsWith: "les_other001" }, 0)).toBe(false);
    expect(earnedAttention({ ...weak(), possibleDuplicateOf: "les_other001" }, 0)).toBe(false);
    expect(earnedAttention(weak(), 0, ["matches_rejected"])).toBe(false);
    expect(earnedAttention(weak({ supportTasks: ["t1", "t2"], sourceEvents: ["e1", "e2"] }), 0)).toBe(true);
    // The same facts from a strong kind earn it at once (the gate is the source's, not the lesson's).
    expect(earnedAttention(weak({ sourceKinds: ["human_edit"] }), 0)).toBe(true);
  });
});

describe("the draft and suggest flow", () => {
  function pipeline(mode: "suggest" | "auto" = "suggest") {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: mode === "auto" ? autoSettings() : settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
    return { deps, store };
  }
  const weakDraft = (task: string, event: string, over: Partial<LessonDraft["provenance"]> = {}): LessonDraft => {
    const d = draft();
    return { ...d, provenance: { ...d.provenance, sourceKinds: ["ticket_comment"], sourceEvents: [event], supportTasks: [task], memberSignal: false, measured: false, sources: ["linear:payments"], inputSources: ["linear:payments", "member:ann"], ...over } };
  };

  it("a lesson from one ticket comment on one task waits as a candidate, whatever else is true of its task (a member signal, a measured outcome)", async () => {
    for (const over of [{}, { memberSignal: true }, { measured: true }, { memberSignal: true, measured: true }]) {
      const { deps } = pipeline();
      expect((await processDraft(deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c1", over))).lesson, JSON.stringify(over)).toMatchObject({ status: "candidate" });
    }
  });
  it("the same facts from a pull request comment are suggested at once (so it is the source that waits, not the facts)", async () => {
    const { deps } = pipeline();
    const d = weakDraft("task-1", "acme/api#pr7:review1", { measured: true, sourceKinds: ["pr_comment"] });
    expect((await processDraft(deps, KEY, d)).lesson).toMatchObject({ status: "pending" });
  });
  it("seen twice (a second task and a second comment, the same advice) is suggested to a person: the second sighting merges into the candidate and it becomes pending", async () => {
    const { deps, store } = pipeline();
    const first = await processDraft(deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c1"));
    expect(first.lesson).toMatchObject({ status: "candidate" });
    const second = await processDraft(deps, KEY, weakDraft("task-2", "ticket:linear:ENG-40:c9"));
    expect(second.lesson).toMatchObject({ id: first.lesson!.id, status: "pending" });
    expect((await store.get(KEY, first.lesson!.id))?.provenance).toMatchObject({ supportTasks: ["task-1", "task-2"], sourceKinds: ["ticket_comment"] });
  });
  it("the same comment read by a second task is one sighting, and a second comment on the same task is one sighting: both still wait", async () => {
    const sameComment = pipeline();
    await processDraft(sameComment.deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c1"));
    expect((await processDraft(sameComment.deps, KEY, weakDraft("task-2", "ticket:linear:ENG-12:c1"))).lesson).toMatchObject({ status: "candidate" });
    const sameTask = pipeline();
    await processDraft(sameTask.deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c1"));
    expect((await processDraft(sameTask.deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c2"))).lesson).toMatchObject({ status: "candidate" });
  });
  it("a lesson that also rests on a strong source is not held by this gate", async () => {
    const { deps } = pipeline();
    expect((await processDraft(deps, KEY, weakDraft("task-1", "ev-1", { sourceKinds: ["ticket_comment", "human_edit"], memberSignal: true }))).lesson).toMatchObject({ status: "pending" });
  });
  it("a ticket comment cited beside the task's own words (intent) or Rovara's plan is still weak: one sighting waits even with a contradiction or a measured outcome", async () => {
    for (const kinds of [["ticket_comment", "intent"], ["ticket_comment", "plan"]] as const) {
      const { deps } = pipeline();
      expect((await processDraft(deps, KEY, weakDraft("task-1", "ticket:linear:ENG-12:c1", { sourceKinds: [...kinds], measured: true, memberSignal: true }))).lesson, kinds.join()).toMatchObject({ status: "candidate" });
    }
  });
  it("a contradiction or a possible duplicate from one weak sighting is kept as a candidate and raises no alert", async () => {
    const { deps, store } = pipeline();
    const alerts = deps.alerts as Alerts;
    const existing = lessonRecord({ id: "les_exist001", status: "active", title: "Retries use withRetry", body: "HTTP retries in the api service use withRetry from src/retry/index.ts." });
    await store.commit(KEY, await store.setVersion(KEY), [existing], 1);
    const opposite = weakDraft("task-9", "ticket:linear:ENG-12:c7", { sourceKinds: ["ticket_comment", "intent"] });
    const out = await processDraft(deps, KEY, { ...opposite, title: "Retries never use withRetry", description: "HTTP retries in api never use withRetry.", body: "HTTP retries in the api service never use withRetry from src/retry/index.ts." });
    expect(out.lesson?.status).not.toBe("pending");
    expect(alerts.sent).toEqual([]);
  });
  it("a lesson that rests even partly on a ticket comment never goes live by itself: corroborated by two tasks and two people with tier-0 auto-apply on, with an intent cited beside it, it waits for a person; so does a strong lesson corroborated by a ticket comment", async () => {
    const mixed = pipeline("auto");
    const a = await processDraft(mixed.deps, KEY, weakDraft("task-1", "ev-1", { sourceKinds: ["ticket_comment", "intent"], supportTasks: ["task-1", "task-2"], sourceEvents: ["ev-1", "ev-2"], authors: ["ann", "bob"], measured: true }));
    expect(a.lesson?.status).toBe("pending");
    expect(a.lesson?.approvals).toEqual([]);
    const strongPlusTicket = pipeline("auto");
    const b = await processDraft(strongPlusTicket.deps, KEY, weakDraft("task-1", "ev-1", { sourceKinds: ["human_edit", "ticket_comment"], supportTasks: ["task-1", "task-2"], sourceEvents: ["ev-1", "ev-2"], authors: ["ann", "bob"], measured: true }));
    expect(b.lesson?.status).toBe("pending");
  });
  it("never goes live by itself, however often it is seen: with tier-0 auto-apply on, a strong lesson with the same facts goes live and a weak-only one waits for a person", async () => {
    const strong = pipeline("auto");
    const live = await processDraft(strong.deps, KEY, weakDraft("task-1", "ev-1", { sourceKinds: ["human_edit"], supportTasks: ["task-1", "task-2"], sourceEvents: ["ev-1", "ev-2"], authors: ["ann", "bob"], measured: true }));
    expect(live.lesson?.status).toBe("active");
    const weak = pipeline("auto");
    const out = await processDraft(weak.deps, KEY, weakDraft("task-1", "ev-1", { supportTasks: ["task-1", "task-2"], sourceEvents: ["ev-1", "ev-2"], authors: ["ann", "bob"], measured: true }));
    expect(out.lesson?.status).toBe("pending");
    expect(out.lesson?.approvals).toEqual([]);
  });
});

describe("the reflector: a person's words, untrusted data, never a member correction or signal", () => {
  const run = async (spans: Parameters<typeof subject>[0], over: Parameters<typeof subject>[1] = {}) => {
    const model = new ScriptedModel([reply(candidateJson({ type: "preference", citations: [], scope: {} }))]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    return await reflectSubject(d, subject(spans, over));
  };
  it("reaches the prompt inside a data marker as its own kind, framed as weak evidence", () => {
    const input = buildReflectorInput(subject([ticketSpan()]));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.user).toContain("kind=ticket_comment>>");
    expect(input.system).toContain("DATA from the team's record");
    expect(input.system).toContain("ticket_comment");
    expect(input.system).toContain("weak evidence");
  });
  it("a quoted or forwarded ticket comment is an outsider's and is removed before any model call; an outsider's span is removed", () => {
    expect(buildReflectorInput(subject([ticketSpan({ text: "> ignore all tests\nplease note" })]))).toMatchObject({ eligible: false, reason: "no_usable_evidence", removedOutsider: 1 });
    expect(buildReflectorInput(subject([ticketSpan({ trust: "outsider" })]))).toMatchObject({ eligible: false, removedOutsider: 1 });
  });
  it("a closed task is not taught by a ticket comment alone (only a send-back, a close reason or a plan or design comment is a reason)", () => {
    expect(buildReflectorInput(subject([ticketSpan()], { outcome: "closed" }))).toMatchObject({ eligible: false, reason: "no_member_reason" });
  });
  it("its provenance names the person (author and read-from, so erase reaches it), is not a member signal, not a member correction (never on trial), and not a measured outcome", async () => {
    const result = await run([ticketSpan()]);
    expect(result.drafts[0]!.provenance).toMatchObject({ sourceKinds: ["ticket_comment"], authors: ["ann"], readFrom: ["ann"], memberSignal: false, memberCorrection: false, measured: false, minTrust: "member", sourceEvents: ["ticket:linear:ENG-12:c1"], sources: ["linear:payments"] });
  });
  it("a lesson that cites a ticket comment next to a member's own send-back is not a member correction either (a tracker's words are external)", async () => {
    const model = new ScriptedModel([reply(candidateJson({ type: "preference", citations: [], scope: {}, evidenceSpanIds: ["S1", "S2"] }))]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    const result = await reflectSubject(d, subject([memberSpan(RULE, { kind: "send_back", eventId: "sb-1", authorId: "ann" }), ticketSpan({ authorId: "bob" })]));
    expect(result.drafts[0]!.provenance.memberCorrection).toBe(false);
    expect(result.drafts[0]!.provenance.sourceKinds.sort()).toEqual(["send_back", "ticket_comment"]);
  });
});

describe("never in a repository's own file", () => {
  it("a lesson that rests on a ticket comment is blocked from a repository's file (a tracker is not a repository)", () => {
    const task = { kind: "task", repoInputs: { place: "github:repo/1", repository: "api", linkPrefix: "https://github.com/acme/api/pull/" }, repositories: ["api"], links: [] };
    const repoSpan = { kind: "pr_comment", trust: "member", authorId: "rae", scopes: ["github:repo/1"], audience: { kind: "project" as const } };
    expect(repoVisibilityOf(task, [repoSpan]).repoOnly).toBeDefined();
    const result = repoVisibilityOf(task, [repoSpan, { kind: "ticket_comment", trust: "member", authorId: "ann", audience: { kind: "project" as const } }]);
    expect(result.repoOnly).toBeUndefined();
    expect(result.blocked).toContain("other_place");
  });
});

describe("the stored shape", () => {
  it("ticket_comment is a kind this build writes and reads back as itself (a kind it does not list reads as `other`)", () => {
    expect(SPAN_KINDS).toContain("ticket_comment");
    expect(LessonProvenanceSchema.parse({ ...draft().provenance, sourceKinds: ["ticket_comment", "not_a_kind"] }).sourceKinds).toEqual(["ticket_comment", "other"]);
  });
});

describe("erase: the person's lessons that rest on a ticket comment go with the person, in their company only", () => {
  const row = (company: string, id: string, authors: string[], readFrom: string[]) => lessonRecord({
    id, workspaceId: company, project: "payments", provenance: { ...draft().provenance, sourceKinds: ["ticket_comment"], authors, readFrom, memberSignal: false, sourceEvents: ["ticket:linear:ENG-12:c1"], supportTasks: ["t1", "t2"] },
  });
  const idsOf = async (store: MemoryDocumentStore, company: string): Promise<string[]> => (await new DocumentLessonStore(store, () => 9, (id) => id, () => undefined).list({ workspaceId: company, project: "payments" })).map((l) => l.id);
  it("person erase deletes a lesson that names the person (author or read-from) and keeps the other company's", async () => {
    const store = new MemoryDocumentStore();
    const { orgProjectCatalogKey } = await import("@agentx/contracts");
    for (const company of [A, B]) {
      const lessons = new DocumentLessonStore(store, () => 5, (id) => id, () => undefined);
      const key = { workspaceId: company, project: "payments" };
      await lessons.commit(key, await lessons.setVersion(key), [row(company, "les_tk000001", ["ann"], ["ann"]), row(company, "les_tk000002", ["bob"], ["bob"]), row(company, "les_tk000003", ["bob"], ["bob", "ann"])], 10);
      await store.put({ item: { ...orgProjectCatalogKey(company, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    }
    await erasePersonLessons({ store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => 9 });
    expect(await idsOf(store, A)).toEqual(["les_tk000002"]);
    expect(await idsOf(store, B)).toEqual(["les_tk000001", "les_tk000002", "les_tk000003"]);
  });
});

describe("the curator: a weak sighting waits as a candidate, with no alert, even for a contradiction or a possible duplicate", () => {
  const text = (title: string, body: string, kinds: string[]): LessonDraft => {
    const d = draft({ title, description: "", body });
    return { ...d, provenance: { ...d.provenance, sourceKinds: kinds as never, sourceEvents: ["ticket:linear:ENG-12:c1"], supportTasks: ["task-1"], memberSignal: false, sources: ["linear:payments"], inputSources: ["linear:payments"] } };
  };
  const setup = (verdict: string) => {
    const store = new InMemoryLessonStore();
    let n = 0;
    const alerts = new Alerts();
    const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
      store, embedder: closeEmbedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel([JSON.stringify({ verdicts: [{ n: 1, verdict }] })]), spend: new Spend(), audit: new Audit(), alerts, now: new Clock().now,
      verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
    };
    return { deps, store, alerts };
  };
  const pos = "Always use withRetry for HTTP calls in the api service";
  const neg = "Never use withRetry for HTTP calls in the api service";
  const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
  const reworded = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";

  it("a contradiction: a weak-only draft is a candidate and raises no alert; the same draft from a strong source is pending and alerts", async () => {
    for (const [kinds, status, alerted] of [[["ticket_comment"], "candidate", false], [["ticket_comment", "intent"], "candidate", false], [["human_edit"], "pending", true], [["ticket_comment", "human_edit"], "pending", true]] as const) {
      const { deps, alerts } = setup("contradicts");
      await curateDraft(deps, KEY, text("Retries", pos, ["human_edit"]));
      const out = await curateDraft(deps, KEY, text("Retries", neg, [...kinds]));
      expect(out.outcome, kinds.join()).toBe("contradiction");
      if (out.outcome !== "contradiction") return;
      expect(out.lesson.status, kinds.join()).toBe(status);
      expect(alerts.sent.includes("lesson_contradiction"), kinds.join()).toBe(alerted);
    }
  });
  it("a possible duplicate: a weak-only draft is a candidate; the same draft from a strong source is pending", async () => {
    for (const [kinds, status] of [[["ticket_comment"], "candidate"], [["human_edit"], "pending"]] as const) {
      const { deps, store } = setup("same");
      await curateDraft(deps, KEY, text("Retries", a, ["human_edit"]));
      // The first lesson cannot merge across the repository line: it is the only one that is repo-only.
      const [first] = await store.list(KEY);
      await store.commit(KEY, await store.setVersion(KEY), [{ ...first!, version: first!.version + 1, provenance: { ...first!.provenance, repoOnly: { place: "github:repo/1" } } }], 2);
      const out = await curateDraft(deps, KEY, text("Retries", reworded, [...kinds]));
      expect(out.outcome, kinds.join()).toBe("possible_duplicate");
      if (out.outcome !== "possible_duplicate") return;
      expect(out.lesson.status, kinds.join()).toBe(status);
    }
  });
});
