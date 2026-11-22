// Regression for the original hosted stopgap: the real root now advertises the repaired routes.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace, type StepInput } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";
import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";

afterEach(() => { vi.unstubAllGlobals(); });

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
  vi.stubGlobal("fetch", async (input: string | URL | Request) => signedRunPriceResponse(input, [A], ["claude-sonnet-4-6"], w.clock.now) ?? Response.json({}, { status: 404 }));
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
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6", ROVARA_CORE_LESSONS: "on" },
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
async function dispatchOf(mode: StepInput["workflowMode"], reviewer = false) {
  const { w, root } = await hostedRoot();
  const reply = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: PROJECT, instructions: "Add a health endpoint", workflow: true }) }, { developerId: personA, sessionId: "session", name: "Member" });
  expect(reply?.statusCode, reply?.body).toBe(200);
  const deps = (await root.app.runtimeFor(A)).flow.deps;

  const taskId = (JSON.parse(reply!.body) as { task: { taskId: string } }).task.taskId;
  const task = (await readTask(deps, taskId))!;
  // The workspace is free for a step (the machine handshake is not what this file is about).
  const held = (await readWorkspace(deps, task.workspaceId))!;
  await w.store.put({ item: plain({ ...held, status: "READY", activeOperationId: null }) });
  const workspace = (await readWorkspace(deps, task.workspaceId))!;
  const accepted = await acceptStep(deps, { task, workspace, requestId: randomUUID(), prompt: "read", workflowMode: mode, ...(reviewer ? { designReview: { version: 1 as const, round: 1 as const, reviewers: [{ role: "critic" as const, keySlot: "r1-critic", packetDigest: "d".repeat(64), model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } }] } } : {}) });
  return { deps, dispatch: accepted.operation?.dispatch, result: accepted.result };
}

describe("hosted core context and design review restored", () => {
  it("with the Team record on, flow.deps carries context sources and a design review runtime", async () => {
    const { root } = await hostedRoot();
    expect(root.lessons).toBeDefined();
    const deps = (await root.app.runtimeFor(A)).flow.deps;
    expect(deps.learned).toBeDefined();
    expect(deps.contextSources).toBeDefined();
    expect(deps.designReview).toBeDefined();
  });

  it.each(SOURCE_STAGES)("a hosted %s step advertises its source list, capability and feature", async (mode) => {
    const { dispatch, result } = await dispatchOf(mode);
    expect(result).toBe("STARTED");
    expect(dispatch?.payload).toMatchObject({ contextSources: true });
    expect(dispatch?.extraActions).toContain("context-tools");
    expect(dispatch?.extraActions ?? []).not.toContain("design-review-packet");
    expect(dispatch?.requires).toContain("task.contextSources.v1");
  });

  it.each(["IMPLEMENT", "CHECKS"] as const)("%s does not advertise context tools", async mode => {
    const { dispatch, result } = await dispatchOf(mode);
    expect(result).toBe("STARTED");
    expect(dispatch).toBeDefined();
    expect(dispatch?.payload).not.toHaveProperty("contextSources");
    expect(dispatch?.extraActions ?? []).not.toContain("context-tools");
    expect(dispatch?.requires ?? []).not.toContain("task.contextSources.v1");
  });

  it("packet reviewer operations do not advertise context tools", async () => {
    const { dispatch, result } = await dispatchOf("PLAN_CRITIQUE", true);
    expect(result).toBe("STARTED");
    expect(dispatch).toBeDefined();
    expect(dispatch?.payload).not.toHaveProperty("contextSources");
    expect(dispatch?.extraActions ?? []).not.toContain("context-tools");
    expect(dispatch?.requires ?? []).not.toContain("task.contextSources.v1");
  });
});
