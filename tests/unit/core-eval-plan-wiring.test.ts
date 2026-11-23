import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
// EVAL-PLAN-CORE-WIRING (DEC 253c, 253j(1), 253k): the deployed (AWS) core callback layer answers a CHECKS run's `eval-plan` callback from the trusted eval plan source, with the
// approver's CURRENT role from the hosted members reader (live `COMPANY_MEMBER#` membership in this company, the broker's project grant). The gateway's word for the approver's roles is
// never the role, and a stored approval of a person who is no longer a member gives no grant. Real broker root, registry and callbacks over fakes; the gateway is a fake fetch.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  EVAL_PLAN_DELIVERY_ACTION, EvalPlanDeliverySchema, TestEnvironmentBodySchema, change, evalCommandFingerprint, evalQuestionHash, orgProjectCatalogKey, projectRevisionKey, testEnvDigest,
  type EvalPlanBody, type EvalSpendPlan, type OrgId, type StoredDocument, type WorkerInvocation, type WorkerMachines,
} from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createCoreDispatchHost } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { EVAL_AUTHORITY_PATH } from "../../packages/broker/src/core-host/eval-authority-http.js";
import { evalSpendKey, proposeEvalSpendApproval } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import { documentOf } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";
import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
// Batch b18 (#1041 HW3c): no company rules service on this install (the company-instructions point stays empty, as before #1041); this file is not about company rules.
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));
afterEach(() => { vi.unstubAllGlobals(); });

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const personA = "a".repeat(64), personB = "b".repeat(64);
const SIGNING = "k".repeat(32);
const GATEWAY = "https://gateway.example";
const PROJECT = "payments";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "app" }] };
const settings = { imageDigest: "sha256:" + "e".repeat(64), route: "gateway" };
const judgePin = "b".repeat(64);
const inputs = { evalSetHash: "a".repeat(64), judgePin, modelVersion: "version-1", model: "model", catalogRowId: "model", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: evalSettingsFingerprint(settings, judgePin) };
const spendPlan = (): Omit<EvalSpendPlan, "evalPlanDigest"> => ({ selection: "evals/demo", inputs: { ...inputs }, estimate: { calls: 6, costMicros: 60 }, budget: { usual: { calls: 6, costMicros: 60 }, maximum: { calls: 400, costMicros: 4_000_000 } } });
const evalPlan = (): EvalPlanBody => ({
  selection: "evals/demo", inputs: { ...inputs }, key: { commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1" }, settings,
  evalSetHash: inputs.evalSetHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, subsetSupported: true,
  questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt", hash: evalQuestionHash(Buffer.from("question one\n")) }],
  maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10,
});
const EVAL_REQUEST = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } as const;
const BASE = "c".repeat(40);

async function world() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  // The sign-in table's live memberships (person -> company and role), changed by the tests.
  const members = new Map<string, { companyId: OrgId; role: "owner" | "admin" | "member" }>([[personA, { companyId: A, role: "owner" }], [personB, { companyId: B, role: "owner" }]]);
  // The broker's project grants (person -> role on PROJECT); "developer" when unset.
  const grants = new Map<string, "developer" | "administrator">();
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length), found = members.get(personId);
      return { Item: found === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, companyId: found.companyId, role: found.role, joinedAt: new Date(w.clock.now).toISOString() } };
    }
    // DEC 254zzz80: a person's grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(key.pk);
    if (grant !== null) return { Item: members.get(grant[2]!)?.companyId === grant[1] ? { ...key, projectName: PROJECT, role: grants.get(grant[2]!) ?? "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  // The gateway's authority answer: it confirms the approver and the connected customer key, and names roles the broker must NOT use.
  const gatewayRoles: { roles: string[] } = { roles: ["member"] };
  const authorityAsks: Array<{ company: string; project: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const price = signedRunPriceResponse(String(url), [A, B], ["claude-sonnet-4-6"], w.clock.now);
    if (price !== undefined) return price;
    if (String(url) !== `${GATEWAY}${EVAL_AUTHORITY_PATH}`) throw new Error("unexpected fetch");
    const asked = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { company: string; project: string; approver: { personId: string; provider: string } };
    authorityAsks.push({ company: asked.company, project: asked.project });
    return new Response(JSON.stringify({ company: asked.company, project: asked.project, provider: "customer", connected: true,
      principal: { companyId: asked.company, personId: asked.approver.personId, displayName: "Approver", roles: gatewayRoles.roles, provider: asked.approver.provider } }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const key = makeKey("t".repeat(16));
  const root = createBrokerCoreRoot({
    // This fixture isolates the existing root behavior; core-task-people-hosted/identity tests exercise creation's real identity proof.
    taskRules: () => ({ taskPeopleStart: async () => [] }) as unknown as DeveloperTaskRouteDependencies,
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: GATEWAY, ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(key)), issuer: "https://api.example/v1/auth" }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  for (const companyId of [A, B]) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, PROJECT, 1), definition: project }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT), latestRevision: 1 } });
  }
  const dispatch = createCoreDispatchHost({
    companyOfWorkspace: workspaceCompanyReader(client, "state"),
    depsFor: async (companyId, queues) => {
      const flow = (await root.app.runtimeFor(companyId)).flow;
      const source = flow.deps.machines;
      const machines: WorkerMachines & { companyId: OrgId } = { companyId, capabilities: source.capabilities, start: (spec) => source.start(spec), stop: (id) => source.stop(id), terminate: (id) => source.terminate(id), health: (id) => source.health(id), deliver: (id, job) => source.deliver(id, job) };
      return { ...flow.deps, machines, queues };
    }, changeVisibility: async () => undefined,
  });
  /** Starts a task for `person`, dispatches its first job and adds a running CHECKS operation the broker asked for an eval, with a capability that names `eval-plan`. */
  const checksRun = async (companyId: OrgId, person: string) => {
    const answer = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: PROJECT, instructions: "Add retry handling" }) }, { developerId: person, sessionId: "session", name: "Member" });
    expect(answer?.statusCode, answer?.body).toBe(200);
    const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answer!.body));
    const workspaceId = z.string().parse((await w.store.get(taskKey(taskId)))!["workspaceId"]);
    const queue = await w.queues.queue("task-dispatch");
    const messages = await queue.receive({ maxMessages: 10 });
    const records = messages.map((message) => ({ messageId: message.messageId, receiptHandle: message.receiptHandle, body: JSON.stringify(message.body) }));
    expect((await dispatch.handle(records, dispatch.take(records))).failures).toEqual([]);
    const workspace = (await w.store.get(workspaceKey(companyId, workspaceId)))!;
    const delivered: WorkerInvocation = w.machines.delivered((workspace["machine"] as { machineId: string }).machineId).at(-1)!;
    const operationId = randomUUID();
    await w.store.put({ item: { ...operationKey(companyId, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: delivered.fence, companyId,
      dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: EVAL_REQUEST, workflowBase: [{ repositoryId: "demo", baseCommitSha: BASE }] } } } });
    const capability = new CallbackCapabilities(Buffer.from(SIGNING)).issue({ workspaceId, operationId, fence: delivered.fence, actions: [EVAL_PLAN_DELIVERY_ACTION] as CallbackAction[], expiresInSeconds: 600 });
    const ask = async () => {
      const reply = await root.callback({ method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${EVAL_PLAN_DELIVERY_ACTION}`, headers: { "x-agentx-callback-capability": capability }, body: "{}" });
      expect(reply?.statusCode, reply?.body).toBe(200);
      const body = JSON.parse(reply!.body) as Record<string, unknown>;
      delete body["requestId"];
      return { answer: EvalPlanDeliverySchema.parse(body), text: reply!.body };
    };
    return { taskId, workspaceId, operationId, ask };
  };
  /** Setup's approved eval spend item and its plan for `companyId`, approved by `person` (the approval record names them as the hosted sign-in's person). */
  const approved = async (companyId: OrgId, person: string) => {
    const deps = { store: w.store, companyId, monthlyCapMicros: 50_000_000, log: () => undefined };
    await proposeEvalSpendApproval(deps, PROJECT, spendPlan(), evalPlan());
    await w.store.update({ key: evalSpendKey(companyId, PROJECT), ops: [change.set("state", "approved"), change.set("approvedBy", { personId: person, provider: HOSTED_IDENTITY_PROVIDER, role: "owner", at: new Date(w.clock.now).toISOString() })] });
  };
  return { w, root, members, grants, gatewayRoles, authorityAsks, checksRun, approved };
}

it("the deployed callback layer answers a CHECKS run's eval-plan from the company's approved plan, with the approver's role from LIVE membership (not the gateway's roles, not the stored role)", async () => {
  const h = await world();
  const run = await h.checksRun(A, personA);
  // No plan yet: not available, and nothing is asked of the gateway.
  expect((await run.ask()).answer).toEqual({ status: "not_available" });
  await h.approved(A, personA);
  const ready = (await run.ask()).answer;
  expect(ready.status).toBe("ready");
  if (ready.status !== "ready") return;
  expect(ready.plan).toMatchObject({ company: A, project: PROJECT, selection: "evals/demo", key: { company: A, project: PROJECT, baseCommit: BASE } });
  // The gateway says "member"; the live membership says owner: the grant's role is the live one (mutant: the hosted members reader replaced by the laptop's owner-only reader).
  expect(ready.approval).toMatchObject({ company: A, project: PROJECT, role: "owner", provider: "customer", connected: true, maxCalls: 6, maxCostMicros: 60 });
  expect(h.authorityAsks).toEqual([{ company: A, project: PROJECT }]);
  // The live membership changes the answer, not the stored approval: an admin is an admin...
  h.members.set(personA, { companyId: A, role: "admin" });
  expect((await run.ask()).answer).toMatchObject({ status: "ready", approval: { role: "admin" } });
  // ...a plain member with no maintainer grant is no approver, even when the gateway names "owner"...
  h.gatewayRoles.roles = ["owner"];
  h.members.set(personA, { companyId: A, role: "member" });
  expect((await run.ask()).answer).toMatchObject({ status: "ready", approval: null });
  // ...a member who administers the project is its maintainer (review L4)...
  h.grants.set(personA, "administrator");
  expect((await run.ask()).answer).toMatchObject({ status: "ready", approval: { role: "maintainer" } });
  h.grants.delete(personA);
  // ...and a person who left, or who is now another company's, gives no grant (the plan is still delivered, so the eval reads "spend not approved").
  h.members.delete(personA);
  expect((await run.ask()).answer).toMatchObject({ status: "ready", approval: null });
  h.members.set(personA, { companyId: B, role: "owner" });
  expect((await run.ask()).answer).toMatchObject({ status: "ready", approval: null });
});

/** An approved test environment (the revision row and the pointer, as an approval writes them) of `companyId`'s project whose one repository `demo` has these install steps. */
async function approveInstallSteps(h: Awaited<ReturnType<typeof world>>, companyId: OrgId, steps: Array<{ executable: string; args: string[] }>) {
  const command = (executable: string, args: string[]) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
  const environment = TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: steps.map((step) => command(step.executable, step.args)), checks: [{ id: "unit", label: "Unit", command: command("pytest", []), kind: "test" }] }],
    roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: ["requirements.txt"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
    data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  });
  const digest = testEnvDigest(environment);
  await h.w.store.put({ item: documentOf({ ...testEnvRevisionKey(companyId, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: companyId, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r".repeat(12), lessSafe: [], environment }) });
  await h.w.store.put({ item: { ...testEnvLatestKey(companyId, PROJECT), entityType: "TEST_ENV_LATEST", orgId: companyId, project: PROJECT, revision: 1, digest } });
}

it("L4-EVS2: the answer carries the project's own approved install steps as the environment, per company (a company with none gets none)", async () => {
  const h = await world();
  const a = await h.checksRun(A, personA);
  const b = await h.checksRun(B, personB);
  await h.approved(A, personA);
  await h.approved(B, personB);
  // Neither has an approved environment: the plan alone, as before.
  expect((await a.ask()).answer).not.toHaveProperty("environment");
  await approveInstallSteps(h, A, [{ executable: "pip", args: ["install", "-r", "requirements.txt"] }]);
  const withSteps = (await a.ask()).answer;
  expect(withSteps).toMatchObject({ status: "ready", environment: { kind: "install", commands: [{ executable: "pip", args: ["install", "-r", "requirements.txt"], cwd: "." }] } });
  // B has none of its own: it never gets A's steps, and its plan is still delivered.
  const fromB = await b.ask();
  expect(fromB.answer).toMatchObject({ status: "ready", plan: { company: B } });
  expect(fromB.answer).not.toHaveProperty("environment");
  expect(fromB.text).not.toContain("requirements.txt");
  // B's own approval gives B its own steps, and A's stay A's.
  await approveInstallSteps(h, B, [{ executable: "npm", args: ["ci"] }]);
  expect((await b.ask()).answer).toMatchObject({ environment: { kind: "install", commands: [{ executable: "npm", args: ["ci"], cwd: "." }] } });
  expect((await a.ask()).answer).toMatchObject({ environment: { commands: [{ executable: "pip" }] } });
});
