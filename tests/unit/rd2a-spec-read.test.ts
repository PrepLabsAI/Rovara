// RD-2a: `GET /v1/dev/tasks/{taskId}/spec`, the task page's spec in one answer, through the core host's dev routes on a real core flow (in-memory adapters). What is proved here:
//  - the read's rule is the task read's: the owner and a reader the host admits read it; a colleague who may not, another company's person, and a missing task all get the SAME "no such task" answer, byte for byte;
//  - a layer not written is `not_written`, never an error (a Quick task has the coding plan alone, a Full task three layers);
//  - state, version, versions, digest, approval, comment counts and the decisions' derived status come from what is stored (workflow, plan documents, comments), never from a stored status;
//  - an unreadable structured document is `unreadable` with no content and an older version is NOT served in its place (arch rule 9); a Markdown document is not served;
//  - the answer reads with its row's schema in the Code API table, whole, and every status word is one of the fixed ones;
//  - model text is redacted; nothing of the task shows in the refusal.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalPlanJson, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type PlanDocument, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import { TaskSpecReadSchema } from "@preplabsai/rovara-code-api";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { PLAN_RETENTION, planDocumentPrefix, structuredArtifactOf } from "../../packages/broker/src/core/plan/store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { specOf } from "../../packages/broker/src/core/task-view/spec.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { planDocument } from "../support/plan-documents.js";
import { readsAsRow } from "../support/code-api-row-read.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const READER_ID = "person-reader-0000000001";
const COLLEAGUE_ID = "person-colleague-0000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example" };
const get = (path: string) => ({ method: "GET", path, headers: {} });
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const STATES = ["not_written", "waiting", "approved", "changes_requested", "rejected", "written", "superseded", "unreadable"];
const STATUSES = ["proposed", "agreed", "changed_by_reviewer", "needs_you"];

/** The company's rule as a deployment wires it: the task's own person, and the named readers, may read it. A colleague who is neither gets "no such task". */
function hostedRule(readers: Set<string>): TaskFlowDeps["access"] {
  return {
    ...createOwnerTaskAccess(),
    async checkStart() { return { allowed: true }; },
    async canAct(principal, task) { return principal.personId === task.developerId || readers.has(principal.personId); },
  };
}

function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

type Layer = Record<string, unknown>;
interface SpecBody { taskId: string; path: string; layers: Layer[]; decisions: Array<Record<string, unknown>>; waitingDocumentDigest?: string; biggerThanQuick?: { reasons: string[] } }
const errorCodeOf = (answer: { body: string } | undefined): unknown => (JSON.parse(answer!.body) as { error: { code: unknown } }).error.code;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function world() {
  const fake = createFakeWorld();
  await registerProject(fake, FAKE_COMPANY);
  await registerProject(fake, OTHER);
  const readers = new Set<string>();
  const app = appWith(fake, hostedRule(readers));
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  const person = (personId: string, companyId: string): DeployedCaller => {
    members.set(`${personId}|${companyId}`, { companyId, role: "member" });
    return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const blobs = (await app.registry()).require("object-storage");
  const taskOf = async (owner: DeployedCaller, path: "QUICK" | "FULL") => {
    const runtime = await app.runtimeFor(owner.principal.companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: path });
    return task.taskId;
  };
  const record = async (taskId: string) => (await readTask({ store: fake.store }, taskId))!;
  /** Changes the stored workflow of a task, as the engine would have left it. */
  const edit = async (taskId: string, change: (workflow: WorkflowSnapshot) => WorkflowSnapshot) => {
    const stored = (await fake.store.get(taskKey(taskId)))!;
    await fake.store.put({ item: { ...stored, workflow: change(stored["workflow"] as WorkflowSnapshot) } as never });
  };
  /** Stores one version of a document in the task's own object folder and adds its artifact (structured, or Markdown when `text` is given). Returns the digest. */
  const write = async (taskId: string, type: "requirements" | "design" | "plan", content: PlanDocument | { markdown: string }, options: { stage?: "waiting" | "stay"; skipBlob?: boolean; tamper?: boolean } = {}) => {
    const task = await record(taskId);
    const version = (task.workflow!.artifacts.filter((artifact) => artifact.type === type).length) + 1;
    const markdown = "markdown" in content;
    const text = markdown ? content.markdown : canonicalPlanJson(content);
    const artifactId = `${type}-v${version}`;
    const prefix = planDocumentPrefix(task, artifactId);
    const artifact = markdown
      ? { id: artifactId, type, version, sha256: sha(text), producer: "agentx-planner", objectKey: `${prefix}.md`, createdAt: "2026-11-25T10:00:00.000Z" }
      : structuredArtifactOf({ artifactId, type, version, canonical: text, prefix, createdAt: "2026-11-25T10:00:00.000Z" });
    if (options.skipBlob !== true) await blobs.put(artifact.objectKey, new TextEncoder().encode(options.tamper === true ? `${text} ` : text), { contentType: "application/json", metadata: {}, retention: PLAN_RETENTION }, { overwrite: true });
    await edit(taskId, (workflow) => ({ ...workflow, artifacts: [...workflow.artifacts, artifact], ...(options.stage === "waiting" ? { stage: "PLAN_REVIEW", state: "WAITING" } : {}) }));
    return artifact.sha256;
  };
  const decide = async (taskId: string, decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT", artifactDigest: string, extra: Record<string, unknown> = {}) =>
    edit(taskId, (workflow) => ({
      ...workflow,
      decisions: [...workflow.decisions, { requestId: randomUUID(), workflowRevision: workflow.revision, decision, actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "ok", artifactDigest, at: "2026-11-25T11:00:00.000Z", ...extra } as never],
    }));
  const comment = async (taskId: string, fields: Record<string, unknown>) => {
    const commentId = randomUUID();
    await fake.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", taskId, commentId, text: "x", author: { kind: "person", name: "Pat" }, ...fields } });
  };
  const read = (caller: DeployedCaller, taskId: string) => routes.route(get(`/v1/dev/tasks/${taskId}/spec`), caller);
  const spec = async (caller: DeployedCaller, taskId: string) => {
    const answer = await read(caller, taskId);
    expect(answer?.statusCode).toBe(200);
    const parsed = JSON.parse(answer!.body) as { spec: SpecBody };
    readsAsRow("tasks.spec", parsed);
    return parsed.spec;
  };
  return { fake, app, routes, readers, person, taskOf, record, edit, write, decide, comment, read, spec, blobs };
}

const quickPlan = (overrides: Partial<PlanDocument> = {}) => planDocument(overrides);
const layerOf = (spec: { layers: Layer[] }, name: string) => spec.layers.find((layer) => layer["layer"] === name);

describe("GET /v1/dev/tasks/{id}/spec", () => {
  it("a Quick task with no plan yet: the coding plan layer is not written, not an error, and nothing else is served", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    const spec = await w.spec(owner, taskId);
    expect(spec.taskId).toBe(taskId);
    expect(spec.path).toBe("quick");
    expect(spec.layers).toEqual([{ layer: "steps", document: "plan", state: "not_written", versions: [] }]);
    expect(spec.decisions).toEqual([]);
    expect(spec.waitingDocumentDigest).toBeUndefined();
    expect(spec.biggerThanQuick).toBeUndefined();
  });

  it("a Quick plan at its gate: version, versions, digest, the document whole, comment counts of the current version only, the decision as proposed and the digest the task waits on", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    await w.write(taskId, "plan", quickPlan({ title: "Old title" }));
    const digest = await w.write(taskId, "plan", quickPlan({ title: "Retry failed payments" }), { stage: "waiting" });
    await w.comment(taskId, { document: "plan", version: 2 });
    await w.comment(taskId, { document: "plan", version: 2, lockedBy: { requestId: randomUUID(), decision: "REQUEST_CHANGES", at: "2026-11-25T12:00:00.000Z" } });
    await w.comment(taskId, { document: "plan", version: 2, deletedAt: "2026-11-25T12:00:00.000Z", text: "" });
    await w.comment(taskId, { document: "plan", version: 2, author: { kind: "agentx", source: "planner" } });
    await w.comment(taskId, { document: "plan", version: 1 });
    await w.comment(taskId, { document: "design", version: 2 });
    const spec = await w.spec(owner, taskId);
    const steps = layerOf(spec, "steps")!;
    expect(steps).toMatchObject({ layer: "steps", document: "plan", state: "waiting", version: 2, versions: [1, 2], sha256: digest, approved: false, current: true, commentCount: 2, resolvedCommentCount: 1 });
    expect(steps["content"]).toMatchObject({ title: "Retry failed payments", claims: [{ id: "1" }, { id: "2" }], notChanging: ["The refund flow stays as it is."] });
    expect(spec.waitingDocumentDigest).toBe(digest);
    expect(spec.decisions).toEqual([expect.objectContaining({ id: "d1", claimId: "1", layer: "steps", status: "proposed", recommended: "three" })]);
    expect(spec.decisions[0]!["answer"]).toBeUndefined();
  });

  it("an approved plan: the decision is agreed with the recommended answer, or changed by the reviewer with the answer the approval holds; no digest is waited on", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const agreed = await w.taskOf(owner, "QUICK");
    const agreedDigest = await w.write(agreed, "plan", quickPlan(), { stage: "waiting" });
    await w.decide(agreed, "APPROVE", agreedDigest);
    await w.edit(agreed, (workflow) => ({ ...workflow, stage: "IMPLEMENT", state: "RUNNING" }));
    const spec = await w.spec(owner, agreed);
    expect(layerOf(spec, "steps")).toMatchObject({ state: "approved", approved: true });
    expect(spec.decisions).toEqual([expect.objectContaining({ id: "d1", status: "agreed", answer: "three" })]);
    expect(spec.waitingDocumentDigest).toBeUndefined();
    // Other decisions of the approval are not this decision's.
    const changed = await w.taskOf(owner, "QUICK");
    const changedDigest = await w.write(changed, "plan", quickPlan(), { stage: "waiting" });
    await w.decide(changed, "APPROVE", changedDigest, { answerOverrides: [{ decisionId: "d9", optionId: "five" }, { decisionId: "d1", optionId: "five" }] });
    expect((await w.spec(owner, changed)).decisions).toEqual([expect.objectContaining({ id: "d1", status: "changed_by_reviewer", answer: "five" })]);
    const other = await w.taskOf(owner, "QUICK");
    const otherDigest = await w.write(other, "plan", quickPlan(), { stage: "waiting" });
    await w.decide(other, "APPROVE", otherDigest, { answerOverrides: [{ decisionId: "d9", optionId: "five" }] });
    expect((await w.spec(owner, other)).decisions).toEqual([expect.objectContaining({ id: "d1", status: "agreed", answer: "three" })]);
  });

  it("a plan sent back (changes requested) or rejected says so, and a plan nobody has decided while the task is elsewhere is just written", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const back = await w.taskOf(owner, "QUICK");
    await w.decide(back, "REQUEST_CHANGES", await w.write(back, "plan", quickPlan(), { stage: "waiting" }));
    expect(layerOf(await w.spec(owner, back), "steps")!["state"]).toBe("changes_requested");
    const rejected = await w.taskOf(owner, "QUICK");
    await w.decide(rejected, "REJECT", await w.write(rejected, "plan", quickPlan(), { stage: "waiting" }));
    expect(layerOf(await w.spec(owner, rejected), "steps")!["state"]).toBe("rejected");
    // A send-back (not a gate decision) naming the plan's digest is not a request for changes to the plan.
    const sent = await w.taskOf(owner, "QUICK");
    await w.decide(sent, "REQUEST_CHANGES", await w.write(sent, "plan", quickPlan()), { source: "SEND_BACK" });
    const written = layerOf(await w.spec(owner, sent), "steps")!;
    expect(written["state"]).toBe("written");
    expect(written["approved"]).toBe(false);
  });

  it("a Full task: three layers in order, each from its own document; requirements approved, design waiting, steps not written; decisions carry their layer", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "FULL");
    const requirements = await w.write(taskId, "requirements", planDocument({ title: "What and why", decisions: [] }));
    await w.decide(taskId, "APPROVE", requirements);
    await w.edit(taskId, (workflow) => ({ ...workflow, reviewPhase: "DESIGN" }));
    const design = await w.write(taskId, "design", planDocument({ title: "Approach" }), { stage: "waiting" });
    const spec = await w.spec(owner, taskId);
    expect(spec.path).toBe("full");
    expect(spec.layers.map((layer) => [layer["layer"], layer["document"], layer["state"]])).toEqual([["what_and_why", "requirements", "approved"], ["approach", "design", "waiting"], ["steps", "plan", "not_written"]]);
    expect(layerOf(spec, "approach")).toMatchObject({ sha256: design, approved: false, current: true });
    expect(layerOf(spec, "what_and_why")!["content"]).toMatchObject({ title: "What and why" });
    expect(spec.waitingDocumentDigest).toBe(design);
    expect(spec.decisions).toEqual([expect.objectContaining({ id: "d1", layer: "approach", status: "proposed" })]);
    expect(spec.biggerThanQuick).toBeUndefined();
  });

  it("a coding plan written before the task went the Full way is history (superseded), and its decisions are not offered", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "FULL");
    await w.write(taskId, "plan", quickPlan());
    const spec = await w.spec(owner, taskId);
    expect(layerOf(spec, "steps")).toMatchObject({ state: "superseded", version: 1 });
    expect(spec.decisions).toEqual([]);
  });

  it("the design review's open questions are decisions that need the person; answered or not waiting, they are not", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "FULL");
    const question = { id: "q1", unclear: "Which table holds it? key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", evidence: [], options: [{ id: "a", label: "Orders", consequence: "One table" }, { id: "b", label: "Payments", consequence: "Two tables" }], recommended: "a", why: "Because" };
    const review = (status: string, answers?: unknown) => ({ decidedBy: "rovara", reasons: [], status, tier: "standard", spentUsd: 0, rounds: [{ round: 1, designDigest: "d".repeat(64), reviewers: [], findings: [], resolutions: [], questions: [question], ...(answers === undefined ? {} : { answers }) }] });
    await w.edit(taskId, (workflow) => ({ ...workflow, designReview: review("waiting_answers") as never }));
    const open = await w.spec(owner, taskId);
    expect(open.decisions).toHaveLength(1);
    const { question: shown, ...rest } = open.decisions[0]!;
    expect(String(shown)).not.toContain("sk-ant-api03");
    expect(String(shown)).toContain("Which table holds it?");
    expect(rest).toEqual({ id: "q1", recommended: "a", layer: "approach", status: "needs_you", options: [{ id: "a", label: "Orders", consequence: "One table" }, { id: "b", label: "Payments", consequence: "Two tables" }] });
    await w.edit(taskId, (workflow) => ({ ...workflow, designReview: review("waiting_answers", { by: { actorId: "x" }, at: "2026-11-25T10:00:00.000Z", answers: [{ questionId: "q1", optionId: "a" }] }) as never }));
    expect((await w.spec(owner, taskId)).decisions).toEqual([]);
    await w.edit(taskId, (workflow) => ({ ...workflow, designReview: review("running") as never }));
    expect((await w.spec(owner, taskId)).decisions).toEqual([]);
  });

  it("a Quick plan that looks bigger than Quick lists why, in fixed sentences; a small plan, an approved one and a Full task list none", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const big = planDocument({
      claims: [
        { id: "1", text: "Add the table.", evidence: [{ kind: "code", path: "infra/db/migrations/0042_orders.sql", startLine: 1, endLine: 4, note: "New migration." }] },
        { id: "2", text: "Check the token.", evidence: [{ kind: "code", path: "src/auth/session.ts", startLine: 1, endLine: 9, note: "Reads the token." }] },
      ],
    });
    const quick = await w.taskOf(owner, "QUICK");
    const digest = await w.write(quick, "plan", big, { stage: "waiting" });
    const reasons = (await w.spec(owner, quick)).biggerThanQuick!.reasons;
    expect(reasons).toEqual(["Changes infrastructure, IAM or data files: infra/db/migrations/0042_orders.sql.", "Touches sensitive paths: src/auth/session.ts."]);
    // The sentence is the plan card's own sentence (one reader), and the layer still reads as written.
    await w.decide(quick, "APPROVE", digest);
    expect((await w.spec(owner, quick)).biggerThanQuick).toBeUndefined();
    const small = await w.taskOf(owner, "QUICK");
    await w.write(small, "plan", planDocument({ claims: [{ id: "1", text: "Retry.", evidence: [{ kind: "code", path: "src/cart.ts", startLine: 1, endLine: 3, note: "Here." }] }] }), { stage: "waiting" });
    expect((await w.spec(owner, small)).biggerThanQuick).toBeUndefined();
    const sensitive = await w.taskOf(owner, "QUICK");
    await w.write(sensitive, "plan", planDocument({ claims: [{ id: "1", text: "Check the token.", evidence: [{ kind: "code", path: "src/auth/session.ts", startLine: 1, endLine: 9, note: "Reads the token." }] }] }), { stage: "waiting" });
    expect((await w.spec(owner, sensitive)).biggerThanQuick!.reasons).toEqual(["Touches sensitive paths: src/auth/session.ts."]);
    const long = await w.taskOf(owner, "QUICK");
    await w.write(long, "plan", planDocument({ claims: Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `Step ${String(index)}: ${"change the cart totals carefully and keep the rounding the same as before. ".repeat(3)}` })) }), { stage: "waiting" });
    expect((await w.spec(owner, long)).biggerThanQuick!.reasons).toEqual(["The plan is longer than fits on one screen."]);
    const many = await w.taskOf(owner, "QUICK");
    await w.write(many, "plan", planDocument({ claims: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), text: `Change file ${String(index)}.`, evidence: [{ kind: "code" as const, path: `src/part${String(index)}.ts`, startLine: 1, endLine: 2, note: "Here." }] })) }), { stage: "waiting" });
    expect((await w.spec(owner, many)).biggerThanQuick!.reasons[0]).toBe("Changes 30 files, more than 25.");
  });

  it("an unreadable structured document is `unreadable` with no content, and the older version is NOT served in its place", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    await w.write(taskId, "plan", quickPlan({ title: "Version one" }));
    const bad = await w.write(taskId, "plan", quickPlan({ title: "Version two" }), { stage: "waiting", tamper: true });
    const tampered = layerOf(await w.spec(owner, taskId), "steps")!;
    expect(tampered).toMatchObject({ state: "unreadable", version: 2, versions: [1, 2], sha256: bad, approved: false });
    expect(tampered["content"]).toBeUndefined();
    expect(JSON.stringify(tampered)).not.toContain("Version one");
    const gone = await w.taskOf(owner, "QUICK");
    await w.write(gone, "plan", quickPlan(), { stage: "waiting", skipBlob: true });
    expect(layerOf(await w.spec(owner, gone), "steps")).toMatchObject({ state: "unreadable" });
    expect((await w.spec(owner, gone)).decisions).toEqual([]);
  });

  it("a document stored as Markdown keeps its state and numbers but serves no content", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    const digest = await w.write(taskId, "plan", { markdown: "# Plan\n\nDo the thing." }, { stage: "waiting" });
    const steps = layerOf(await w.spec(owner, taskId), "steps")!;
    expect(steps).toMatchObject({ state: "waiting", version: 1, sha256: digest });
    expect(steps["content"]).toBeUndefined();
  });

  it("model text is redacted before it is served", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    await w.write(taskId, "plan", quickPlan({ notChanging: ["Never print sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 anywhere."] }), { stage: "waiting" });
    const answer = await w.read(owner, taskId);
    expect(answer!.body).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("every layer state and decision status is one of the fixed words, and unknown members from a newer Code still read", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "FULL");
    await w.write(taskId, "requirements", planDocument(), { stage: "waiting" });
    const spec = await w.spec(owner, taskId);
    for (const layer of spec.layers) expect(STATES).toContain(layer["state"]);
    for (const decision of spec.decisions) expect(STATUSES).toContain(decision["status"]);
    for (const layer of spec.layers.filter((entry) => entry["sha256"] !== undefined)) expect(layer["sha256"]).toMatch(DIGEST_RE);
    const answer = JSON.parse((await w.read(owner, taskId))!.body) as { spec: Record<string, unknown> };
    expect(TaskSpecReadSchema.safeParse({ ...answer, spec: { ...answer.spec, aNewMember: 1 } }).success).toBe(true);
  });

  it("who may read: the owner and a reader the host admits do; a colleague, another company's person and a missing task get the same refusal, and it names nothing", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const reader = w.person(READER_ID, FAKE_COMPANY);
    const colleague = w.person(COLLEAGUE_ID, FAKE_COMPANY);
    const stranger = w.person("person-stranger-000000001", OTHER);
    w.readers.add(READER_ID);
    const taskId = await w.taskOf(owner, "QUICK");
    await w.write(taskId, "plan", quickPlan(), { stage: "waiting" });
    const before = await w.fake.store.get(taskKey(taskId));
    expect((await w.read(owner, taskId))?.statusCode).toBe(200);
    expect((await w.read(reader, taskId))?.statusCode).toBe(200);
    const refusals = [await w.read(colleague, taskId), await w.read(stranger, taskId), await w.read(colleague, randomUUID()), await w.read(owner, randomUUID())];
    for (const refusal of refusals) {
      expect(refusal?.statusCode).toBe(404);
      expect(JSON.parse(refusal!.body)).toEqual(JSON.parse(refusals[3]!.body));
      expect(refusal!.body).not.toContain(taskId);
      expect(refusal!.body).not.toContain("Retry failed payments");
    }
    expect(errorCodeOf(refusals[0])).toBe("TASK_NOT_FOUND");
    expect(await w.fake.store.get(taskKey(taskId))).toEqual(before);
  });

  it("a task with no workflow snapshot has no layers (nothing invented)", async () => {
    const answer = await specOf({ store: { query: async () => ({ items: [] }) }, read: async () => undefined }, { taskId: randomUUID() } as never);
    expect(answer.spec.layers).toEqual([]);
    expect(answer.spec.decisions).toEqual([]);
    expect(Object.keys(answer.spec).sort()).toEqual(["decisions", "layers", "taskId"]);
  });

  it("a stored comment is counted by the members this read uses, so a member a later version adds cannot drop it", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, "QUICK");
    await w.write(taskId, "plan", quickPlan(), { stage: "waiting" });
    await w.comment(taskId, { document: "plan", version: 1, schemaVersion: 7, aFieldFromTheFuture: { nested: true } });
    expect(layerOf(await w.spec(owner, taskId), "steps")!["commentCount"]).toBe(1);
  });
});
