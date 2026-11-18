// Plan and design comments as a learning source (lane L4-LM1a, step 2). A person's request for changes at a plan or design approval step (the gate's REQUEST_CHANGES decision and its `reason`) is a learning
// subject of its own span kind (`plan_comment`, `design_comment`), read through the same correction filter as a review comment, a STRONG source (a person's direct correction), company and project scoped, only the
// deciding person's own typed words while they are on the project's roster, framed as untrusted data, and erased with the person (and with the company).
import { randomUUID } from "node:crypto";
import { OrgIdSchema, type JsonValue, type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { erasePersonLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { PAGE_CHANGES_DEFAULT_REASON } from "../../../packages/broker/src/developer/gate-default-reasons.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { runCompanyPurge, requestCompanyPurge, COMPANY_PURGE_COOLING_OFF_MS, type CompanyPurgeDeps } from "../../../packages/broker/src/core/company/purge.js";
import { DocumentLessonStore } from "../../../packages/broker/src/lessons/document-store.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import { repoVisibilityOf } from "../../../packages/broker/src/lessons/repo-eligibility.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonProvenanceSchema, SPAN_KINDS } from "../../../packages/broker/src/lessons/types.js";
import { buildTaskReflectSubject } from "../../../packages/broker/src/lessons/task-subject.js";
import { createLocalLessonSources } from "../../../packages/broker/src/local/app/lessons-sources.js";
import type { LessonRepositories } from "../../../packages/broker/src/local/app/lessons-repos.js";
import { recordEndedTask } from "../../../packages/broker/src/team-record/capture.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { DocumentAuditSink } from "../../../packages/local-adapters/src/document-audit-sink.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, candidateJson, draft, embedder, facts, lessonRecord, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PLAN = "a".repeat(64);
const DESIGN = "b".repeat(64);
const REQS = "c".repeat(64);
const ARTIFACTS = [
  { id: "plan-1", type: "plan", version: 1, sha256: PLAN }, { id: "design-1", type: "design", version: 1, sha256: DESIGN }, { id: "reqs-1", type: "requirements", version: 1, sha256: REQS },
  { id: "tp-1", type: "test_plan", version: 1, sha256: "d".repeat(64) },
];
const USE_HELPER = "Use the shared retry helper in the plan instead of writing a new retry loop by hand.";

interface DecisionOver { id?: string; actor?: string; task?: string; actorId?: string; role?: string; source?: string | undefined; reason?: string; digest?: string | undefined; decision?: string }
const decision = (o: DecisionOver = {}): Record<string, JsonValue> => ({
  requestId: o.id ?? randomUUID(), workflowRevision: 1, decision: o.decision ?? "REQUEST_CHANGES", actorId: o.actorId ?? taskOwnerKey(o.actor ?? "ann", o.task ?? "task-pc"), actorRole: o.role ?? "TASK_OWNER", reason: o.reason ?? USE_HELPER,
  ...(o.digest === undefined && "digest" in o ? {} : { artifactDigest: o.digest ?? PLAN }), ...(o.source === undefined ? {} : { source: o.source }), at: "2026-11-15T10:00:00.000Z",
});

/** The deployment's people port over fixed rosters per company and project; `erased` are gone. */
function people(roster: Record<string, string[]>, erased: string[] = []): HostedLessonPeople {
  return {
    async approvers(c) { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: roster[`${c}/payments`] ?? [], lastEligibleLossAtMs: null }; },
    async onProjectRoster(c, project, person) { return (roster[`${c}/${project}`] ?? []).includes(person); },
    async linkedAccounts() { return []; },
    async displayName() { return undefined; },
    async isErased(_c, person) { return erased.includes(person); },
  };
}

async function world(over: { company?: OrgId; project?: string; taskId?: string; decisions: Array<Record<string, JsonValue>>; roster?: Record<string, string[]>; erased?: string[]; hosted?: boolean; developerId?: string }) {
  const store = new MemoryDocumentStore();
  const company = over.company ?? A;
  const taskId = over.taskId ?? "task-pc";
  const task = { taskId, companyId: company, project: over.project ?? "payments", developerId: over.developerId ?? "ann", startingRevision: 1, title: "t", requestText: "Add a retry to the sync",
    workflow: { revision: 3, artifacts: ARTIFACTS, reviews: [], pullRequests: [], outcome: "MERGED", decisions: over.decisions } };
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVTASK", ...task } });
  const repos = { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories;
  const sources = createLocalLessonSources({
    flow: { store, projects: undefined as never }, companyId: OrgIdSchema.parse(company), ownerId: "local-owner", repos, now: () => 1,
    ...(over.hosted === false ? {} : { hosted: { people: people(over.roster ?? { [`${A}/payments`]: ["ann", "bob"], [`${B}/payments`]: ["ann", "bob"] }, over.erased ?? []) } }),
  });
  return { store, sources, taskId, company };
}
const planSpans = async (w: Awaited<ReturnType<typeof world>>, company: OrgId = w.company) => ((await w.sources.source.read({ workspaceId: company, taskId: w.taskId }))?.facts.rest.spans ?? []).filter((s) => s.kind === "plan_comment" || s.kind === "design_comment");

describe("the capture: a gate decision's reason becomes a learning subject", () => {
  it("a person's request for changes with a reason that reads as a correction becomes a plan_comment span of its own person, by the document the decision was about", async () => {
    const w = await world({ decisions: [decision({ id: "11111111-1111-4111-8111-111111111111" }), decision({ digest: DESIGN, reason: "The design must not add a new table; store the retry state on the existing job row." }), decision({ digest: REQS, reason: "The requirements should say that retries stop after five attempts, never loop forever." })] });
    const spans = await planSpans(w);
    expect(spans.map((s) => [s.kind, s.authorId, s.trust])).toEqual([["plan_comment", "ann", "member"], ["design_comment", "ann", "member"], ["design_comment", "ann", "member"]]);
    expect(spans[0]).toMatchObject({ text: USE_HELPER, eventId: "task:task-pc:plancomment:11111111-1111-4111-8111-111111111111" });
  });

  it("a local install (no people port) reads the owner's own words the same way", async () => {
    const w = await world({ decisions: [decision({ actor: "anyone" })], hosted: false });
    expect((await planSpans(w)).map((s) => [s.kind, s.authorId])).toEqual([["plan_comment", "local-owner"]]);
  });

  it("on a laptop a repository collaborator's `/rovara changes` (a PROJECT_ADMIN decision under their own id) is never credited to the owner; on a hosted install only the task's own person's decision counts, and another decider's id cannot be resolved to a person", async () => {
    const collaborator = await world({ decisions: [decision({ role: "PROJECT_ADMIN", actorId: "f".repeat(64) })], hosted: false });
    expect(await planSpans(collaborator)).toEqual([]);
    const hostedAdmin = await world({ decisions: [decision({ role: "PROJECT_ADMIN" }), decision({ actor: "bob" }), decision({ actorId: "ann" })] });
    expect(await planSpans(hostedAdmin)).toEqual([]);
  });

  it("the correction filter drops praise, nits, bare questions, short words and acknowledgements, and keeps a question that asks for a change", async () => {
    const dropped = ["Looks good to me, nice plan, ship it please", "nit: rename the second heading to something shorter", "Why is this step needed here at all?", "Changes requested.", "ok thanks", "typo in the third paragraph of the plan"];
    const w = await world({ decisions: [...dropped.map((reason) => decision({ reason })), decision({ reason: "Should we use the shared helper here instead of a new loop?" })] });
    expect((await planSpans(w)).map((s) => s.text)).toEqual(["Should we use the shared helper here instead of a new loop?"]);
  });

  it("words code itself wrote on a gate decision (the live-steer revise, the redirect, the spec re-plan, the page's ticked-comments default, the empty-box default) are not a person's correction", async () => {
    const { WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON } = await import("@agentx/contracts");
    const w = await world({ decisions: [WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON, PAGE_CHANGES_DEFAULT_REASON, "Changes requested."].map((reason) => decision({ reason })) });
    expect(await planSpans(w)).toEqual([]);
  });

  it("Rovara's own decisions, approvals, rejections, skips, send-backs, findings answers and other sources are not plan comments", async () => {
    const w = await world({ decisions: [
      decision({ role: "AGENTX", source: "AUTO_FIX" }), decision({ decision: "APPROVE" }), decision({ decision: "REJECT" }), decision({ decision: "SKIP" }),
      decision({ source: "SEND_BACK" }), decision({ source: "FINDINGS" }), decision({ source: "AUTO_RETRY" }), decision({ role: "AGENTX" }),
    ] });
    expect(await planSpans(w)).toEqual([]);
  });

  it("a decision that binds no known document of the task, or an unrelated one (a test plan), says nothing about a plan or design", async () => {
    const w = await world({ decisions: [decision({ digest: "e".repeat(64) }), decision({ digest: "d".repeat(64) }), decision({ digest: undefined })] });
    expect(await planSpans(w)).toEqual([]);
  });

  it("only the newest ten are read (one total limit)", async () => {
    const w = await world({ decisions: Array.from({ length: 14 }, (_, i) => decision({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, reason: `${USE_HELPER} Round ${String(i)}.` })) });
    const spans = await planSpans(w);
    expect(spans).toHaveLength(10);
    expect(spans[0]!.text.endsWith("Round 4.")).toBe(true);
    expect(spans[9]!.text.endsWith("Round 13.")).toBe(true);
  });

  it("its team record is unchanged: a plan comment is not written to the Team record", async () => {
    const w = await world({ decisions: [decision()] });
    const written: unknown[] = [];
    const record = { companyId: A, put: async (d: unknown) => { written.push(d); return true; } } as never;
    const out = await recordEndedTask({ record, source: w.sources.source, rows: w.sources.rows, companyId: A, taskId: w.taskId, now: () => 1, origin: "app" });
    expect(written.every((d) => !JSON.stringify(d).includes("retry helper"))).toBe(true);
    expect(out.written).toBe(written.length);
  });
});

describe("whose words: the deciding person, in their own project, now", () => {
  const byTask = (task: string, developerId: string) => decision({ actor: developerId, task });
  it("a task owner off the project's roster is not a member: nothing of theirs is carried; an erased person's task teaches nothing; a member's words are kept", async () => {
    const roster = { [`${A}/payments`]: ["ann", "gone"] };
    const off = await world({ roster, erased: ["gone"], taskId: "task-off", developerId: "otto", decisions: [byTask("task-off", "otto")] });
    expect(await planSpans(off)).toEqual([]);
    const erased = await world({ roster, erased: ["gone"], taskId: "task-gone", developerId: "gone", decisions: [byTask("task-gone", "gone")] });
    expect(await erased.sources.source.read({ workspaceId: A, taskId: "task-gone" })).toBeUndefined();
    const member = await world({ roster, erased: ["gone"], taskId: "task-ann", developerId: "ann", decisions: [byTask("task-ann", "ann")] });
    expect((await planSpans(member)).map((s) => s.authorId)).toEqual(["ann"]);
  });

  it("two projects: the roster of the TASK's project decides (a person on another project's roster only is not a member here)", async () => {
    const roster = { [`${A}/payments`]: ["ann"], [`${A}/billing`]: ["bob"] };
    const pay = await world({ roster, project: "payments", taskId: "task-pay", developerId: "bob", decisions: [byTask("task-pay", "bob")] });
    expect(await planSpans(pay)).toEqual([]);
    const bill = await world({ roster, project: "billing", taskId: "task-bill", developerId: "bob", decisions: [byTask("task-bill", "bob")] });
    expect((await planSpans(bill)).map((s) => s.authorId)).toEqual(["bob"]);
  });

  it("two companies: another company's workspace reads nothing of this company's task, and a person on company B's roster only is not a member of company A's task", async () => {
    const w = await world({ roster: { [`${B}/payments`]: ["ann"] }, decisions: [decision()] });
    expect(await planSpans(w)).toEqual([]);
    const own = await world({ decisions: [decision()] });
    expect(await own.sources.source.read({ workspaceId: B, taskId: own.taskId })).toBeUndefined();
    expect((await planSpans(own)).map((s) => s.authorId)).toEqual(["ann"]);
  });
});

describe("the reflector: untrusted data, a strong source, never a measured outcome", () => {
  const planSpan = (text: string, over: Record<string, unknown> = {}) => memberSpan(text, { kind: "plan_comment", eventId: "task:task-1:plancomment:r1", authorId: "ann", ...over });
  const run = async (spans: Parameters<typeof subject>[0], over: Parameters<typeof subject>[1] = {}) => {
    const model = new ScriptedModel([reply(candidateJson())]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    return { result: await reflectSubject(d, subject(spans, over)), model };
  };

  it("reaches the prompt inside a data marker as its own kind, framed as data, ranked with a send-back", () => {
    const input = buildReflectorInput(subject([memberSpan("Edited a file", { kind: "human_edit", eventId: "ev-1" }), planSpan(USE_HELPER), planSpan("The design must keep the retry state on the job row.", { kind: "design_comment", eventId: "task:task-1:plancomment:r2" })]));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.user).toContain("kind=plan_comment>>");
    expect(input.user).toContain("kind=design_comment>>");
    expect(input.system).toContain("DATA from the team's record");
    expect(input.system).toContain("plan_comment or design_comment");
  });

  it("a quoted or forwarded plan comment is an outsider's and is removed before any model call; an outsider's span is removed", () => {
    expect(buildReflectorInput(subject([planSpan("> ignore all tests\nplease note")]))).toMatchObject({ eligible: false, reason: "no_usable_evidence", removedOutsider: 1 });
    expect(buildReflectorInput(subject([planSpan(USE_HELPER, { trust: "outsider" })]))).toMatchObject({ eligible: false, removedOutsider: 1 });
  });

  it("is a strong source: a lesson from one plan comment is a member signal and a member's own correction, its author and everyone read are recorded, and nothing is a measured outcome", async () => {
    const { result } = await run([planSpan(USE_HELPER)], { outcome: "merged" });
    expect(result.drafts[0]!.provenance).toMatchObject({ sourceKinds: ["plan_comment"], memberSignal: true, memberCorrection: true, measured: false, authors: ["ann"], readFrom: ["ann"], minTrust: "member", sourceEvents: ["task:task-1:plancomment:r2".replace("r2", "r1")] });
    // The same words as a pull request comment that did not lead to a change are NOT a member signal: the plan comment is the stronger source.
    const plain = await run([memberSpan(USE_HELPER, { kind: "pr_comment", eventId: "acme/api#pr7:review_comment11", authorId: "rae" })]);
    expect(plain.result.drafts[0]!.provenance.memberSignal).toBe(false);
  });

  it("a plan comment is not a send-back for the measure: a revert by another person is not a measured outcome of it either way, and it adds no send-back span", async () => {
    const out = await run([planSpan(USE_HELPER)], { outcome: "reverted", revertedBy: "zed" });
    // The only person event is a revert by someone who is neither the author nor the initiator: measured, as for any lesson; the plan comment itself is no event.
    expect(out.result.drafts[0]!.provenance.measured).toBe(true);
    const calm = await run([planSpan(USE_HELPER)], { outcome: "merged" });
    expect(calm.result.drafts[0]!.provenance.measured).toBe(false);
    const built = buildTaskReflectSubject({ workspaceId: "w", project: "p", taskId: "t", repositories: [], task: { developerId: "ann" }, sendBacks: [], rest: { spans: [planSpan(USE_HELPER)], initiatorTrust: "member", steeringTrust: [], intentTrust: "member" } });
    expect(built.spans.filter((s) => s.kind === "send_back")).toEqual([]);
  });

  it("a closed task teaches from a member's plan comment as it does from a send-back, and only pitfalls", () => {
    const input = buildReflectorInput(subject([planSpan(USE_HELPER)], { outcome: "closed" }));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.allowedTypes).toEqual(["pitfall"]);
    expect(buildReflectorInput(subject([planSpan(USE_HELPER, { trust: "system" })], { outcome: "closed" }))).toMatchObject({ eligible: false, reason: "no_member_reason" });
  });

  it("a lesson that rests on a plan comment is never eligible for a repository's own file (typed in Rovara)", () => {
    const task = { kind: "task", repoInputs: { place: "github:repo/1", repository: "api", linkPrefix: "https://github.com/acme/api/pull/" }, repositories: ["api"], links: [] };
    const repoSpan = { kind: "pr_comment", trust: "member", authorId: "rae", scopes: ["github:repo/1"], audience: { kind: "project" as const } };
    expect(repoVisibilityOf(task, [repoSpan]).repoOnly).toBeDefined();
    for (const kind of ["plan_comment", "design_comment"]) {
      const result = repoVisibilityOf(task, [repoSpan, { ...repoSpan, kind }]);
      expect(result.repoOnly, kind).toBeUndefined();
      expect(result.blocked, kind).toContain("typed_in_rovara");
    }
  });
});

describe("the stored shape", () => {
  it("plan_comment and design_comment are kinds this build writes and reads back as themselves (only a kind it does not list reads as `other`)", () => {
    expect(SPAN_KINDS).toContain("plan_comment");
    expect(SPAN_KINDS).toContain("design_comment");
    expect(LessonProvenanceSchema.parse({ ...draft().provenance, sourceKinds: ["plan_comment", "design_comment", "not_a_kind"] }).sourceKinds).toEqual(["plan_comment", "design_comment", "other"]);
  });
});

describe("the draft and suggest flow: a plan comment becomes a suggestion (pending, for a person)", () => {
  function pipeline() {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
    return { deps, store };
  }
  const planSpan = (text: string, over: Record<string, unknown> = {}) => memberSpan(text, { kind: "plan_comment", eventId: "task:task-1:plancomment:r1", authorId: "ann", ...over });

  it("one plan comment on one task (a strong source) is drafted and suggested to people at once; the same words as a plain pr_comment wait for a second sighting", async () => {
    const model = new ScriptedModel([reply(candidateJson({ type: "preference", citations: [], scope: {} }))]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    const reflected = await reflectSubject(d, subject([planSpan(USE_HELPER)]));
    expect(reflected.drafts).toHaveLength(1);
    const { deps, store } = pipeline();
    const out = await processDraft(deps, KEY, reflected.drafts[0]!);
    expect(out.lesson).toMatchObject({ status: "pending" });
    expect((await store.get(KEY, out.lesson!.id))?.provenance).toMatchObject({ sourceKinds: ["plan_comment"], authors: ["ann"], readFrom: ["ann"] });
    // Not a strong source: a draft from one task with no member signal and nothing measured waits.
    const weak = pipeline();
    const waiting = await processDraft(weak.deps, KEY, { ...reflected.drafts[0]!, provenance: { ...reflected.drafts[0]!.provenance, memberSignal: false, sourceKinds: ["pr_comment"] } });
    expect(waiting.lesson).toMatchObject({ status: "candidate" });
  });
});

describe("erase: the person's lessons that rest on a plan comment go with the person and with the company", () => {
  const row = (company: string, id: string, authors: string[], readFrom: string[]) => lessonRecord({
    id, workspaceId: company, project: "payments", provenance: { ...draft().provenance, sourceKinds: ["plan_comment"], authors, readFrom, memberSignal: true },
  });
  async function seed(store: MemoryDocumentStore): Promise<void> {
    for (const company of [A, B]) {
      const lessons = new DocumentLessonStore(store, () => 5, (id) => id, () => undefined);
      const key = { workspaceId: company, project: "payments" };
      await lessons.commit(key, await lessons.setVersion(key), [row(company, "les_pc000001", ["ann"], ["ann"]), row(company, "les_pc000002", ["bob"], ["bob"])], 10);
      const { orgProjectCatalogKey } = await import("@agentx/contracts");
      await store.put({ item: { ...orgProjectCatalogKey(company, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    }
  }
  const idsOf = async (store: MemoryDocumentStore, company: string): Promise<string[]> => (await new DocumentLessonStore(store, () => 9, (id) => id, () => undefined).list({ workspaceId: company, project: "payments" })).map((l) => l.id);

  it("person erase deletes the lessons that name the person (authors or readFrom) in their company only", async () => {
    const store = new MemoryDocumentStore();
    await seed(store);
    const report = await erasePersonLessons({ store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => 9 });
    expect(report.purged).toBe(1);
    expect(await idsOf(store, A)).toEqual(["les_pc000002"]);
    expect(await idsOf(store, B)).toEqual(["les_pc000001", "les_pc000002"]);
  });

  it("a lesson whose only link to the person is that the model READ their plan comment is erased too", async () => {
    const store = new MemoryDocumentStore();
    const lessons = new DocumentLessonStore(store, () => 5, (id) => id, () => undefined);
    const key = { workspaceId: A, project: "payments" };
    await lessons.commit(key, await lessons.setVersion(key), [row(A, "les_pc000003", ["bob"], ["bob", "ann"])], 10);
    const { orgProjectCatalogKey } = await import("@agentx/contracts");
    await store.put({ item: { ...orgProjectCatalogKey(A, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    await erasePersonLessons({ store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => 9 });
    expect(await idsOf(store, A)).toEqual([]);
  });

  it("the company purge removes the company's plan-comment lessons and leaves the other company's", async () => {
    const store = new MemoryDocumentStore();
    await seed(store);
    const audit = new DocumentAuditSink({ store: () => store });
    const clock = { now: Date.parse("2026-11-15T10:00:00.000Z") };
    const deps: CompanyPurgeDeps = { store, objects: { deleteEveryVersion: async () => true }, audit, now: () => clock.now, companyClosure: async () => ({ closed: true, closeId: "close-1" }) };
    await requestCompanyPurge(deps, { companyId: A, by: { kind: "operator", operatorId: "ops" }, requestId: "11111111-2222-4333-8444-555555555555" });
    clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    for (let call = 0; call < 50; call += 1) { if ((await runCompanyPurge(deps, A, 60_000)).outcome === "done") break; clock.now += 70_000; }
    expect(await idsOf(store, A)).toEqual([]);
    expect(await idsOf(store, B)).toEqual(["les_pc000001", "les_pc000002"]);
  });
});
