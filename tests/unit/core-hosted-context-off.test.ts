// HOTFIX 0.5.33 (DEC 254zzz207), stopgap: on the HOSTED core no stage asks the worker for the context-source list (`GET /v1/internal/context-tools`) and the design review is not wired
// (its reviewers read `GET /v1/internal/design-review/packet`). Neither route exists on API Gateway and both want a gateway-stamped `x-rovara-workspace` header a hosted worker never sends,
// so the first hosted task failed CALLBACK_FORBIDDEN. The real hosted root (Team record ON), a real task, and the step each stage would be dispatched as are read back, so what a worker would be sent is
// what is checked. The LAPTOP path is unchanged and is proved by the existing laptop tests (tests/unit/local-up-flow.test.ts "plan job is told contextSources and GET context-tools answers 200",
// tests/unit/design-review-flow.test.ts and design-review-local-sources.test.ts, whose reviewers read their packet); `core-team-context.test.ts` keeps the hosted handler itself (unwired) correct.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace, type StepInput } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
const personA = "a".repeat(64);
const PROJECT = "payments";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
/** Every stage the context-source list would have been asked for, plus the design review's own stage and the coding stage. */
const SOURCE_STAGES = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"] as const;

async function hostedRoot() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) return { Item: { ...key, entityType: "COMPANY_MEMBERSHIP", personId: personA, companyId: A, role: "owner", joinedAt: new Date(w.clock.now).toISOString() } };
    if (/^ORG#org_[0-9a-z]{20}#MEMBER#/u.test(key.pk)) return { Item: { ...key, projectName: PROJECT, role: "developer" } };
    return { Item: await w.store.get(key) };
  } };
  const key = makeKey("t".repeat(16));
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}`, ROVARA_CORE_ALLOWED_COMPANIES: A, ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6", ROVARA_CORE_LESSONS: "on" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(key)), issuer: "https://api.example/v1/auth" }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
  });
  await w.store.put({ item: plain({ ...projectRevisionKey(A, PROJECT, 1), definition: project }) });
  await w.store.put({ item: { ...orgProjectCatalogKey(A, PROJECT), latestRevision: 1 } });
  return { w, root };
}

/** The dispatch the stage's step is accepted with on the hosted flow: what the worker is sent (the payload, its capability actions and the features it must list). */
async function dispatchOf(mode: StepInput["workflowMode"], wireSources = false) {
  const { w, root } = await hostedRoot();
  const reply = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: PROJECT, instructions: "Add a health endpoint", workflow: true }) }, { developerId: personA, sessionId: "session", name: "Member" });
  expect(reply?.statusCode, reply?.body).toBe(200);
  const deps = (await root.app.runtimeFor(A)).flow.deps;
  // Positive control only: proves this file sees a source list when one IS wired (the mutant the hotfix removed).
  if (wireSources) deps.contextSources = { stageHasSources: async () => true };
  const taskId = (JSON.parse(reply!.body) as { task: { taskId: string } }).task.taskId;
  const task = (await readTask(deps, taskId))!;
  // The workspace is free for a step (the machine handshake is not what this file is about).
  const held = (await readWorkspace(deps, task.workspaceId))!;
  await w.store.put({ item: plain({ ...held, status: "READY", activeOperationId: null }) });
  const workspace = (await readWorkspace(deps, task.workspaceId))!;
  const accepted = await acceptStep(deps, { task, workspace, requestId: randomUUID(), prompt: "read", workflowMode: mode });
  return { deps, dispatch: accepted.operation?.dispatch, result: accepted.result };
}

describe("hosted core: no context-source list and no design review packet (hotfix 0.5.33)", () => {
  it("with the Team record on, flow.deps carries no context sources and no design review runtime", async () => {
    const { root } = await hostedRoot();
    expect(root.lessons).toBeDefined();
    const deps = (await root.app.runtimeFor(A)).flow.deps;
    expect(deps.learned).toBeDefined();
    expect(deps.contextSources).toBeUndefined();
    expect(deps.designReview).toBeUndefined();
  });

  it.each(SOURCE_STAGES)("a hosted %s step is dispatched with no source-list flag, no context-tools capability and no feature to list", async (mode) => {
    const { dispatch, result } = await dispatchOf(mode);
    expect(result).toBe("STARTED");
    expect(dispatch?.payload).not.toHaveProperty("contextSources");
    expect(dispatch?.extraActions ?? []).not.toContain("context-tools");
    expect(dispatch?.extraActions ?? []).not.toContain("design-review-packet");
    expect(dispatch?.requires ?? []).not.toContain("task.contextSources.v1");
  });

  it("the harness would see a source list if one were wired (positive control), and nothing else of the hosted flow changed", async () => {
    const wired = await dispatchOf("UNDERSTAND", true);
    expect(wired.dispatch?.payload).toMatchObject({ contextSources: true });
    expect(wired.dispatch?.extraActions).toContain("context-tools");
    // The company's second review and the Team record are still built on the hosted flow.
    const { root } = await hostedRoot();
    const deps = (await root.app.runtimeFor(A)).flow.deps;
    expect(deps.secondReview).toBeDefined();
    expect(deps.learned).toBeDefined();
  });

  it("a hosted flow with no design review runtime answers the flow's entry points as 'no design review' (no reviewer round, no packet)", async () => {
    const { root } = await hostedRoot();
    const deps = (await root.app.runtimeFor(A)).flow.deps;
    expect(deps.designReview).toBeUndefined();
    expect(await deps.designReview?.designFirst("Add a health endpoint")).toBeUndefined();
  });
});
