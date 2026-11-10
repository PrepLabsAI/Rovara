// Initiator, glob reach with no literal prefix, deletion that rollback cannot undo, cause-aware erasure, title and description
// allow-list, THING words, body paths, reviewRequired on held pending lessons.
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { touchesRiskyPath } from "../../../packages/broker/src/lessons/guards.js";
import { processDraft, resumeAndResettle, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import type { EvidenceSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { type TierInput } from "../../../packages/broker/src/lessons/tier.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, codeCite, draft, embedder, lessonRecord, memberSpan, reply, seed, settings, subject, verifier, classifyTier, facts, autoSettings, allowAllAccess } from "./lesson-helpers.js";

const valid = [{ index: 0, result: "valid" as const, at: 1 }];
const tierOf = (over: Partial<TierInput>) => classifyTier({ ...draft({ description: "" }), citationChecks: valid, ...over });
const run = (spans: EvidenceSpan[], ids: string[], over: Parameters<typeof subject>[1] = {}) => reflectSubject(
  { model: new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ids }))]), spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: new Clock().now },
  subject(spans, over));
function pipeline() {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  let n = 0;
  const alerts = new Alerts();
  const deps: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts, now: clock.now, verifier: verifier("valid"), facts: facts(), settings: autoSettings(), newId: () => `les_r4${String(++n).padStart(5, "0")}` };
  return { deps, store, clock };
}

describe("the initiator and agent-only lessons", () => {
  const sendBack = (author: string): EvidenceSpan => ({ kind: "send_back", text: "use the shared helper", trust: "member", eventId: `s-${author}`, authorId: author });
  const plan: EvidenceSpan = { kind: "plan", text: "HTTP retries in api use withRetry.", trust: "rovara", eventId: "ev-plan" };

  it("the reviewer's probe: a lesson that cites only agent text with the initiator's own send-back in the task is not measured, and does not go live on one task", async () => {
    const { deps } = pipeline();
    const result = await run([plan, sendBack("mallory")], ["S2"], { initiatorId: "mallory" });
    expect(result.drafts[0]!.provenance).toMatchObject({ authors: [], measured: false });
    const out = await processDraft(deps, KEY, result.drafts[0]!);
    expect(out.lesson!.status).not.toBe("active");
  });

  it("even a third party's send-back cannot make an agent-text-only lesson measured; a reverted task or a Rovara CI failure cannot either", async () => {
    expect((await run([plan, sendBack("bob")], ["S2"], { initiatorId: "mallory" })).drafts[0]!.provenance.measured).toBe(false);
    expect((await run([plan], ["S1"], { initiatorId: "mallory", outcome: "reverted" })).drafts[0]!.provenance.measured).toBe(false);
    const ci: EvidenceSpan = { kind: "ci_failure", text: "timeout", trust: "rovara", eventId: "ci" };
    expect((await run([plan, ci], ["S2"], { initiatorId: "mallory" })).drafts[0]!.provenance.measured).toBe(false);
  });

  it("with a person behind the lesson, a send-back counts only from someone who is neither a lesson author nor the task's initiator", async () => {
    const edit = memberSpan("HTTP retries in api use withRetry.", { eventId: "e1", authorId: "ann" });
    expect((await run([edit, sendBack("mallory")], ["S1"], { initiatorId: "mallory" })).drafts[0]!.provenance.measured).toBe(false);
    expect((await run([edit, sendBack("ann")], ["S1"], { initiatorId: "mallory" })).drafts[0]!.provenance.measured).toBe(false);
    expect((await run([edit, sendBack("bob")], ["S1"], { initiatorId: "mallory" })).drafts[0]!.provenance.measured).toBe(true);
    expect((await run([edit, sendBack("bob")], ["S1"], { initiatorId: undefined } as never)).drafts[0]!.provenance.measured).toBe(false);
  });
});

describe("glob reach with no literal leading directory", () => {
  it.each(["**/workflows/*.yml", "*/workflows/**", "**/*.yml", "*.yml", "**/*.json", "**/*.lock", "**/pre-commit", "**/*rc", "**", "**/*", "*/**", "**/*.ts", "*"])("%s reaches protected files: risky and tier 2", (glob) => {
    expect(touchesRiskyPath([glob]), glob).toBe(true);
    expect(tierOf({ scope: { repos: ["api"], paths: [glob] } }).tier, glob).toBe(2);
  });
  it.each(["src/**", "src/**/*.ts", "packages/api/**", "src/retry/*"])("a literal leading directory keeps ordinary breadth: %s", (glob) => {
    expect(touchesRiskyPath([glob]), glob).toBe(false);
    expect(tierOf({ scope: { repos: ["api"], paths: [glob] } }).tier, glob).toBe(0);
  });
});

describe("title, description, the thing slot and body paths", () => {
  it.each([
    [{ title: "Run setup" }],
    [{ body: "The first thing to call before every build is at src/prep.ts." }], [{ body: "The helper you must call before each commit is at src/prep.ts." }],
    [{ body: "The release workflow is at .github/workflows/release.yml." }], [{ body: "The key is in ~/.ssh/id_rsa." }], [{ body: "The key is in /etc/shadow." }],
  ])("never tier 0: %j", (over) => {
    expect(tierOf(over as Partial<TierInput>).tier).toBeGreaterThanOrEqual(1);
  });
  it("a stored title or description is never what the agent sees from a tier-0 lesson: the rendered text replaces it", () => {
    for (const over of [{ title: "Before building, call src/prep.ts" }, { description: "Always call prep first, then commit." }, { title: "Use the helper" }]) {
      const decision = tierOf(over);
      expect(decision.tier).toBe(0);
      const text = JSON.stringify(decision);
      expect(text).not.toMatch(/Before building|Always call|Use the helper/u);
    }
  });
  it("plain titles, descriptions and bodies still are", () => {
    expect(tierOf({ body: "The first thing to call before every build is at src/prep.ts." }).tier).toBeGreaterThanOrEqual(1);
    expect(tierOf({ title: "Retry helper", description: "The retry helper is called withRetry." }).tier).toBe(0);
  });
});

describe("a lesson held while its source was paused needs a person, even when it was already pending", () => {
  it("the reviewer's probe: a flood draft merges into Ann's pending lesson, the pause is lifted, and the next merge does not auto-apply it", async () => {
    const { deps, store } = pipeline();
    const prov = (over: Record<string, unknown>) => ({ ...draft().provenance, measured: false, memberSignal: true, ...over });
    const ann = await processDraft(deps, KEY, draft({ provenance: prov({ authors: ["ann"], sources: ["member:ann"], inputSources: ["member:ann"], supportTasks: ["t1"] }) }));
    expect(ann.lesson!.status).toBe("pending");
    await store.setFlags(KEY, { pausedSources: { "member:mallory": { at: 1, reason: "spike" } } });
    const flood = await processDraft(deps, KEY, draft({ provenance: prov({ authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"], supportTasks: ["t2"] }) }));
    expect(flood.outcome.outcome).toBe("merged");
    expect(flood.lesson).toMatchObject({ status: "pending", reviewRequired: true });
    await resumeAndResettle(deps, KEY, "member:mallory", "owner");
    const next = await processDraft(deps, KEY, draft({ provenance: prov({ authors: ["ann"], sources: ["member:ann"], inputSources: ["member:ann"], supportTasks: ["t3"] }) }));
    expect(next.lesson).toMatchObject({ status: "pending", reviewRequired: true });
    expect(next.lesson!.approvals).toEqual([]);
  });
});

describe("deletion that a rollback cannot undo", () => {
  function setup() {
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const audit = new Audit();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors, audit, now: clock.now });
    const add = async (lesson: Lesson) => { await seed(store, lesson); await vectors.upsert(lesson.workspaceId, lesson.project, lesson.id, await embedder.embed(lesson.body), { status: lesson.status }); };
    return { store, vectors, audit, port, add, clock };
  }
  const onRecord = (id: string, events: string[], over: Partial<Lesson> = {}): Lesson => lessonRecord({
    id, citations: events.map((eventId) => ({ kind: "record" as const, eventId })), citationChecks: undefined, lastValidatedAt: undefined,
    provenance: { ...lessonRecord().provenance, sourceEvents: events }, ...over,
  });
  const noIds = (l: Lesson | undefined, ...ids: string[]) => { const text = JSON.stringify(l); for (const id of ids) expect(text).not.toContain(`"${id}"`); };

  it("withdrawn lesson: a rollback to the set before the withdrawal does not bring it, or its deleted source, back", async () => {
    const { store, port, add } = setup();
    await add(onRecord("les_w0000001", ["A"]));
    const before = await store.setVersion(KEY);
    await port.withdraw(WS, PROJECT, "les_w0000001", "sources_deleted");
    expect((await store.get(KEY, "les_w0000001"))!.status).toBe("withdrawn");
    expect(await store.rollback(KEY, before, await store.setVersion(KEY), 99)).toMatchObject({ ok: true });
    const back = await store.get(KEY, "les_w0000001");
    expect(back!.status).toBe("withdrawn");
    for (const v of await store.versions(KEY, "les_w0000001")) { expect(v.provenance.sourceEvents).toEqual([]); expect(v.citations).toEqual([]); }
  });

  it("kept lesson (some sources left): every old version loses the deleted id, so a rollback cannot restore it", async () => {
    const { store, port, add } = setup();
    await add(onRecord("les_k0000001", ["A", "B"]));
    const before = await store.setVersion(KEY);
    await port.forgetSources(WS, PROJECT, "les_k0000001", new Set(["A"]));
    for (const v of await store.versions(KEY, "les_k0000001")) { expect(v.provenance.sourceEvents).toEqual(["B"]); noIds(v, "A"); }
    await store.rollback(KEY, before, await store.setVersion(KEY), 99);
    const back = (await store.get(KEY, "les_k0000001"))!;
    expect(back.provenance.sourceEvents).toEqual(["B"]);
    expect(back.citations).toEqual([{ kind: "record", eventId: "B" }]);
  });

  it("kept on code alone after an ordinary delete: back to a person; person-approved stays live but is flagged and shown in the digest", async () => {
    const { store, port, add, clock } = setup();
    const code = (id: string, approvals: Lesson["approvals"]) => lessonRecord({ id, lastValidatedAt: 5, approvals, citations: [codeCite(), { kind: "record", eventId: "A" }], citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: { ...lessonRecord().provenance, sourceEvents: ["A"] } });
    await add(code("les_auto0001", [{ approvalId: "x", by: "system:auto", at: 1, mode: "auto" }]));
    await add(code("les_pers0001", [{ approvalId: "y", by: "ann", at: 1, mode: "one" }]));
    await port.forgetSources(WS, PROJECT, "les_auto0001", new Set(["A"]), "sources_deleted");
    await port.forgetSources(WS, PROJECT, "les_pers0001", new Set(["A"]), "source_deleted");
    expect(await store.get(KEY, "les_auto0001")).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
    expect(await store.get(KEY, "les_pers0001")).toMatchObject({ status: "active", reviewRequired: true });
    const digest = await buildWeeklyDigest(store, KEY, clock.now(), { principals: [], groups: [] }, allowAllAccess);
    expect(digest.needsReview.map((i) => i.id)).toEqual(["les_pers0001"]);
  });

  it("person_erased: hard-deletes what the person wrote, even when code supports it: head, versions, vector, manifest references; rollback cannot bring it back", async () => {
    const { store, vectors, port, add } = setup();
    const prov = { ...lessonRecord().provenance, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"], sourceEvents: ["A"] };
    await add(lessonRecord({ id: "les_wrote001", lastValidatedAt: 5, body: "Mallory: retries use withRetry.", citations: [codeCite(), { kind: "record", eventId: "A" }], citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: prov }));
    await store.putManifest({ taskId: "t1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, bytes: 1, lessons: [{ id: "les_wrote001", version: 1, score: 1, why: "scope", citation: "valid" }] });
    const before = await store.setVersion(KEY);
    await seed(store, lessonRecord({ id: "les_later001" }));
    await store.recordSourceEvent(KEY, { at: 1, source: "member:mallory" });
    await store.setFlags(KEY, { pausedSources: { "member:mallory": { at: 1, reason: "spike" } } });
    const result = await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set(["A"]));
    expect(result.purged).toEqual(["les_wrote001"]);
    expect(await store.get(KEY, "les_wrote001")).toBeUndefined();
    expect(await store.versions(KEY, "les_wrote001")).toEqual([]);
    expect(vectors.rows.size).toBe(0);
    expect((await store.manifests(KEY, "t1"))[0]!.lessons).toEqual([]);
    expect((await store.flags(KEY)).pausedSources).toEqual({});
    expect(await store.sourceDays(KEY, "member:mallory", 3, 5)).toEqual([0, 0, 0]);
    expect(await store.rollback(KEY, before, await store.setVersion(KEY), 99)).toMatchObject({ ok: true });
    expect(await store.get(KEY, "les_wrote001")).toBeUndefined();
  });

  it("person_erased through the record core's call (forgetSources with the cause): purge, whatever the code citation says", async () => {
    const { store, port, add } = setup();
    await add(lessonRecord({ id: "les_alone001", lastValidatedAt: 5, citations: [codeCite(), { kind: "record", eventId: "A" }], citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: { ...lessonRecord().provenance, sourceEvents: ["A"] } }));
    await port.forgetSources(WS, PROJECT, "les_alone001", new Set(["A"]), "person_erased", { developerId: "mallory" });
    expect(await store.get(KEY, "les_alone001")).toBeUndefined();
    await port.withdraw(WS, PROJECT, "les_alone001", "person_erased");
  });

  it("person_erased: other people's lessons lose the person's id, source keys and approvals in EVERY version, and are kept", async () => {
    const { store, port, add } = setup();
    const prov = { ...lessonRecord().provenance, authors: ["ann"], sources: ["member:ann", "member:mallory"], inputSources: ["member:ann", "member:mallory", "slack:C1"], sourceEvents: ["A", "B"] };
    await add(lessonRecord({ id: "les_both0001", provenance: prov, citations: [{ kind: "record", eventId: "A" }, { kind: "record", eventId: "B" }], citationChecks: undefined, approvals: [{ approvalId: "z", by: "mallory", at: 1, mode: "one" }] }));
    await store.commit(KEY, await store.setVersion(KEY), [{ ...(await store.get(KEY, "les_both0001"))!, version: 2, title: "Second version" }], 2);
    const result = await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set(["A"]));
    expect(result).toEqual({ purged: [], scrubbed: ["les_both0001"] });
    for (const v of [...(await store.versions(KEY, "les_both0001")), (await store.get(KEY, "les_both0001"))!]) {
      expect(JSON.stringify(v)).not.toContain("mallory");
      expect(v.provenance.sources).toEqual(["member:ann"]);
      expect(v.provenance.sourceEvents).toEqual(["B"]);
      expect(v.approvals[0]!.by).toBe("erased");
    }
    expect((await store.get(KEY, "les_both0001"))!.status).toBe("active");
  });

  it("person_erased: a lesson resting only on the erased rows is purged, a withdrawn lesson they wrote is purged too, another project is untouched", async () => {
    const { store, port, add } = setup();
    await add(onRecord("les_only0001", ["A"]));
    await add(onRecord("les_wdrn0001", ["Z"], { status: "withdrawn", provenance: { ...lessonRecord().provenance, authors: ["mallory"], sourceEvents: ["Z"] } }));
    await add(onRecord("les_other001", ["A"], { project: "proj-2" }));
    const result = await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set(["A"]));
    expect(result.purged.sort()).toEqual(["les_only0001", "les_wdrn0001"]);
    expect(await store.get({ workspaceId: WS, project: "proj-2" }, "les_other001")).toBeDefined();
  });
});
