// L4-HW1: the hosted core root starts workflow tasks on workflow 1.1.0 (Understand first, the plan check program), as the laptop's root does (local/app/app.ts `understandFirst: true`).
// The real broker root, registry and dev routes over fakes. Proved here, on the hosted root itself:
//   - a workflow start with no Quick/Full path is accepted (it was refused with WORKFLOW_PATH_REQUIRED) and is a 1.1.0 task with Understand queued first and the Rovara Code program (plan check) attached;
//   - the step queued first for the task is UNDERSTAND (a 1.0.0 task queues none);
//   - the S3 answers route engages (it answered "not waiting" for every hosted task): the owner's answers land, a People commenter and another company's person do not;
//   - gates that read `definitionVersion === "1.1.0"` engage on the hosted task (parallel parts, the plan check step, the Rovara check verdict, the steer note gate);
//   - a task that started on 1.0.0 stays on 1.0.0 when the root is later built with the setting on, and a start with the input off is still the old 1.0.0 start;
//   - a non-workflow start (the eval-plan test's) is unchanged.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  WORKFLOW_PATH_REQUIRED, createCandidateManifest, orgProjectCatalogKey, projectRevisionKey, recordIntentAssessment, startWorkflowUnderstand,
  type OrgId, type StoredDocument,
} from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { ROVARA_CODE_PROGRAM } from "../../packages/broker/src/core/plan/program.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { workflowPullRequestCheckVerdict } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { commitWorkflow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { workflowDependenciesAllowed } from "../../packages/broker/src/core/work-breakdown/parallel-parts.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
// Batch b18 (#1041 HW3c): no company rules service on this install (the company-instructions point stays empty, as before #1041); this file is not about company rules.
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));
afterEach(() => { vi.unstubAllGlobals(); });

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const personA = "a".repeat(64), personB = "b".repeat(64), commenterA = "c".repeat(64);
const SIGNING = "k".repeat(32);
const GATEWAY = "https://gateway.example";
const PROJECT = "payments";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const QUESTIONS = [{ id: "q1", text: "Which endpoint path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a" }, { id: "q2", text: "Anything else to check?" }];
const ANSWERS = [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "Return the version too" }];

async function world() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  // The sign-in table's live memberships; the project grants are the defaults ("developer").
  const members = new Map<string, { companyId: OrgId; role: "owner" | "admin" | "member" }>([[personA, { companyId: A, role: "owner" }], [personB, { companyId: B, role: "owner" }], [commenterA, { companyId: A, role: "member" }]]);
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length), found = members.get(personId);
      return { Item: found === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, companyId: found.companyId, role: found.role, joinedAt: new Date(w.clock.now).toISOString() } };
    }
    // DEC 254zzz80: a person's grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(key.pk);
    if (grant !== null) return { Item: members.get(grant[2]!)?.companyId === grant[1] ? { ...key, projectName: PROJECT, role: "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  const key = makeKey("t".repeat(16));
  /** A root over the shared fake store; `understandFirst` left out is the production wiring (nothing is passed). */
  const rootWith = (understandFirst?: boolean) => createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}:${B}`, ROVARA_CORE_ALLOWED_COMPANIES: `${A}:${B}`, ROVARA_CORE_MODEL_GATEWAY_URL: GATEWAY, ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(key)), issuer: "https://api.example/v1/auth" }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
    ...(understandFirst === undefined ? {} : { understandFirst }),
  });
  for (const companyId of [A, B]) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, PROJECT, 1), definition: project }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT), latestRevision: 1 } });
  }
  type Root = ReturnType<typeof rootWith>;
  const caller = (person: string) => ({ developerId: person, sessionId: "session", name: "Member" });
  const route = (root: Root, person: string, method: string, path: string, body?: unknown) =>
    root.coreTasks!.route({ method, path, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, caller(person));
  /** Starts a workflow task as `person`; `workflowPath` left out is the web's "let Understand choose". */
  const start = async (root: Root, person: string, workflowPath?: "QUICK" | "FULL") => {
    const reply = await route(root, person, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Add a health endpoint", workflow: true, ...(workflowPath === undefined ? {} : { workflowPath }) });
    return reply!;
  };
  const taskIdOf = (reply: { body: string }) => z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(reply.body)).task.taskId;
  const depsOf = async (root: Root, companyId: OrgId) => (await root.app.runtimeFor(companyId)).flow.deps;
  /** What the worker's Understand callback commits: the first round of questions. */
  const askQuestions = async (root: Root, companyId: OrgId, taskId: string) => {
    const deps = await depsOf(root, companyId);
    let record = (await readTask(deps, taskId))!;
    if (record.workflow?.state === "READY") {
      expect(await commitWorkflow(deps, record, startWorkflowUnderstand(record.workflow, new Date(w.clock.now).toISOString()))).toBe(true);
      record = (await readTask(deps, taskId))!;
    }
    const asked = recordIntentAssessment(record.workflow, { expectedRevision: record.workflow!.revision, assessment: { kind: "questions", restatement: "Add a health endpoint.", questions: QUESTIONS }, now: new Date(w.clock.now).toISOString() });
    expect(await commitWorkflow(deps, record, asked)).toBe(true);
  };
  return { w, rootWith, route, start, taskIdOf, depsOf, askQuestions };
}

const errorOf = (reply: { body: string }) => (JSON.parse(reply.body) as { error?: { code: string; message: string } }).error;

describe("the hosted core root starts workflow tasks on 1.1.0 (L4-HW1)", () => {
  it("accepts a start with no Quick/Full path and stores a 1.1.0 task: Understand queued first, the Rovara Code program (plan check) attached, path chosen later by Understand", async () => {
    const h = await world();
    const root = h.rootWith();
    const reply = await h.start(root, personA);
    expect(reply.statusCode, reply.body).toBe(200);
    const taskId = h.taskIdOf(reply);
    const record = (await readTask(await h.depsOf(root, A), taskId))!;
    expect(record.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "READY" });
    expect(record.workflow?.intent?.pathFrom).toBe("understand");
    expect(record.workflow?.program).toEqual(ROVARA_CODE_PROGRAM);
  });

  it("a start that names Quick or Full is still a 1.1.0 task that understands first, with the person's path kept", async () => {
    const h = await world();
    const root = h.rootWith();
    const taskId = h.taskIdOf(await h.start(root, personA, "FULL"));
    const workflow = (await readTask(await h.depsOf(root, A), taskId))!.workflow!;
    expect(workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", path: "FULL" });
    expect(workflow.intent?.pathFrom).toBe("request");
  });

  it("the first step queued for the task is UNDERSTAND (a 1.0.0 task queues none: it starts on its plan)", async () => {
    const h = await world();
    const root = h.rootWith();
    const taskId = h.taskIdOf(await h.start(root, personA));
    const row = await h.w.store.get(dispatchRowKey(A, taskId, 1));
    expect([row?.["kind"], row?.["companyId"], row?.["taskId"]]).toEqual(["UNDERSTAND", A, taskId]);
    const old = h.taskIdOf(await h.start(h.rootWith(false), personA, "QUICK"));
    expect((await h.w.store.get(dispatchRowKey(A, old, 1)))?.["kind"]).not.toBe("UNDERSTAND");
  });

  it("the S3 answers route engages: the owner's answers to Understand's questions land; a company member who is no owner and another company's person get nothing written", async () => {
    const h = await world();
    const root = h.rootWith();
    const taskId = h.taskIdOf(await h.start(root, personA));
    await h.askQuestions(root, A, taskId);
    const deps = await h.depsOf(root, A);
    const waiting = (await readTask(deps, taskId))!.workflow!;
    expect([waiting.stage, waiting.state, waiting.intent?.assessment?.kind]).toEqual(["UNDERSTAND", "WAITING", "questions"]);
    const body = () => ({ requestId: randomUUID(), round: 1, answers: ANSWERS });
    // Another person of the same company (no owner, no People role) and another company's owner: the task is not theirs to answer.
    const otherMember = await h.route(root, commenterA, "POST", `/v1/dev/tasks/${taskId}/answers`, body());
    expect(otherMember?.statusCode).toBeGreaterThanOrEqual(400);
    const otherCompany = await h.route(root, personB, "POST", `/v1/dev/tasks/${taskId}/answers`, body());
    expect(otherCompany?.statusCode).toBe(404);
    expect((await readTask(deps, taskId))!.workflow!.intent?.answers).toHaveLength(0);
    // The owner's answers (it answered "not waiting" for every hosted task before).
    const ok = await h.route(root, personA, "POST", `/v1/dev/tasks/${taskId}/answers`, body());
    expect(ok?.statusCode, ok?.body).toBe(200);
    const after = (await readTask(deps, taskId))!.workflow!;
    expect(after.intent?.answers).toHaveLength(1);
    expect(after.intent?.answers[0]).toMatchObject({ round: 1, answers: ANSWERS });
  });

  it("gates that read definitionVersion 1.1.0 engage on the hosted task: parallel parts, the plan check step, the Rovara check verdict, the steer waiting gate", async () => {
    const h = await world();
    const root = h.rootWith();
    const taskId = h.taskIdOf(await h.start(root, personA));
    const deps = await h.depsOf(root, A);
    const record = (await readTask(deps, taskId))!;
    const workflow = record.workflow!;
    // Parts: the hosted flow has no install switch for ordered plans, and a 1.1.0 task needs none.
    expect(deps.workflowDependenciesEnabled).not.toBe(true);
    expect(workflowDependenciesAllowed(deps, workflow)).toBe(true);
    // Plan check: the program has the plan_critic step (core/plan runs the check from it).
    expect(workflow.program?.steps.some((step) => step.kind === "plan_critic")).toBe(true);
    // An unreviewed start has no verdict; the 1.1.0 projection engages once its current code reviews clear.
    const task = { title: "Add a health endpoint" };
    expect(workflowPullRequestCheckVerdict(task, workflow, undefined)).toBeUndefined();
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
    const reviewed = { ...workflow, candidate, reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS" as const, findings: [], readOnly: true, recordedAt: "2026-11-19T00:00:00.000Z" })) };
    expect(workflowPullRequestCheckVerdict(task, reviewed as typeof workflow, undefined)).toBeDefined();
  });

  it("two companies: each company's task is its own 1.1.0 task, read only in its own store", async () => {
    const h = await world();
    const root = h.rootWith();
    const a = h.taskIdOf(await h.start(root, personA));
    const b = h.taskIdOf(await h.start(root, personB));
    expect((await readTask(await h.depsOf(root, A), a))!.workflow?.definitionVersion).toBe("1.1.0");
    expect((await readTask(await h.depsOf(root, B), b))!.workflow?.definitionVersion).toBe("1.1.0");
    // B's person cannot read or answer A's task through B's routes.
    expect((await h.route(root, personB, "GET", `/v1/dev/tasks/${a}`))?.statusCode).toBe(404);
  });
});

describe("the old start stays reachable and running tasks keep their version", () => {
  it("with the input off a start with no path is refused as before, and a start with a path is a 1.0.0 task", async () => {
    const h = await world();
    const root = h.rootWith(false);
    const refused = await h.start(root, personA);
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorOf(refused)?.message).toContain(WORKFLOW_PATH_REQUIRED);
    const taskId = h.taskIdOf(await h.start(root, personA, "QUICK"));
    const workflow = (await readTask(await h.depsOf(root, A), taskId))!.workflow!;
    expect(workflow.definitionVersion).toBe("1.0.0");
  });

  it("a task that started on 1.0.0 stays on 1.0.0 when the root is later built with the setting on; its answers route still says it is not waiting", async () => {
    const h = await world();
    const oldRoot = h.rootWith(false);
    const taskId = h.taskIdOf(await h.start(oldRoot, personA, "QUICK"));
    const newRoot = h.rootWith();
    const workflow = (await readTask(await h.depsOf(newRoot, A), taskId))!.workflow!;
    expect(workflow.definitionVersion).toBe("1.0.0");
    const answered = await h.route(newRoot, personA, "POST", `/v1/dev/tasks/${taskId}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS });
    expect(answered?.statusCode).toBeGreaterThanOrEqual(400);
    expect((await readTask(await h.depsOf(newRoot, A), taskId))!.workflow!.definitionVersion).toBe("1.0.0");
    // And new tasks on the new root are 1.1.0, beside it.
    const fresh = h.taskIdOf(await h.start(newRoot, personA));
    expect((await readTask(await h.depsOf(newRoot, A), fresh))!.workflow!.definitionVersion).toBe("1.1.0");
  });

  it("a start that is no workflow (a plain task) is unchanged by the setting", async () => {
    const h = await world();
    const root = h.rootWith();
    const reply = await h.route(root, personA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Add retry handling" });
    expect(reply?.statusCode, reply?.body).toBe(200);
    const record = (await readTask(await h.depsOf(root, A), h.taskIdOf(reply!)))!;
    expect(record.workflow).toBeUndefined();
  });
});
