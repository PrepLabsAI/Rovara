import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EPolicySchema, type E2EApplicationPlanIntent } from "@agentx/contracts";
import { DEFAULT_E2E_AGENT_MODELS } from "../../packages/model-runtime/src/config.js";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import {
  E2E_MODEL_ROUTE_PARTITION, approveE2EAgentRoute, e2eAgentInstallationFromParameters, planE2EAgentRoute, type E2EAgentInstallation,
} from "../../packages/broker/src/e2e/model-route-registry.js";
import { describeFeatureE2EExecutableKinds } from "../../packages/broker/src/e2e/feature-plan-executable-kinds.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call, loadSlackBroker } from "../support/slack-broker.js";
import { contractSnapshot } from "../support/e2e-application-plan-fixtures.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SECRET_ARN } from "../support/e2e-model-fixtures.js";

// Task 4.2: setup approval derives the route from the installation's worker settings and pins it in the project's policy; dispatch re-derives it.
type RequireAgentRoute = (dependencies: never, projectName: string, intent: E2EApplicationPlanIntent, policy: ReturnType<typeof E2EPolicySchema.parse>) => Promise<boolean>;
let requireAgentRouteStillCurrent: RequireAgentRoute;
beforeAll(async () => { requireAgentRouteStillCurrent = (await loadSlackBroker() as unknown as { requireAgentRouteStillCurrent: RequireAgentRoute }).requireAgentRouteStillCurrent; });

const admin = { subject: "admin-subject", admin: true };
const anthropic: E2EAgentInstallation = { provider: "anthropic", secretArn: SECRET_ARN };
const OTHER_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/other-key-ZyXwVu";

async function harnessFor(installation: (() => Promise<E2EAgentInstallation>) | undefined) {
  const state = { current: installation };
  const brokerExtra: Record<string, unknown> = { projectSetupSource: { capture: vi.fn(async () => contractSnapshot) } };
  if (installation !== undefined) brokerExtra.e2eAgentInstallation = () => state.current!();
  const harness = await createDeveloperTaskBroker({ brokerExtra });
  return { harness, state };
}
const propose = (harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) =>
  call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
const approve = (harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, proposal: { body: Record<string, unknown> }, projectName = "payments", decision = "approve") =>
  call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
    body: { projectName, proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision } });
const routeRows = (db: FakeDynamoDb) => db.find((item) => item.pk === E2E_MODEL_ROUTE_PARTITION);

describe("a setup proposal and its approval carry the AI navigation route", () => {
  it("proposes no AI navigation where the installation's settings are not wired (the deployed default until a guarded deploy)", async () => {
    const { harness } = await harnessFor(undefined);
    const proposal = await propose(harness);
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    expect(E2EPolicySchema.parse(proposal.body.policy).modelRouteRevision).toBeNull();
    expect(proposal.body.aiNavigation).toBeNull();
    expect((await approve(harness, proposal)).status).toBe(200);
    expect(routeRows(harness.db)).toEqual([]);
  });

  it("pins the installation's provider route in the proposal's policy and states it in the plain sentence", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    const policy = E2EPolicySchema.parse(proposal.body.policy);
    expect(policy.modelRouteRevision).toMatch(/^r1-[a-f0-9]{12}$/);
    expect(proposal.body.aiNavigation).toBe(`AI navigation: Anthropic \`${DEFAULT_E2E_AGENT_MODELS.anthropic}\`; at most 8 actions per step; checks decide`);
    // A proposal writes nothing: only the approval records the route.
    expect(routeRows(harness.db)).toEqual([]);
    const stored = JSON.parse(harness.s3.objects.get(String(proposal.body.proposalRef))!) as { aiNavigation?: string; policy: { modelRouteRevision: string } };
    expect(stored.aiNavigation).toBe(proposal.body.aiNavigation);
    expect(stored.policy.modelRouteRevision).toBe(policy.modelRouteRevision);
  });

  it("records revision 1 and the latest pointer when the setup is approved, and the approval holds the same policy", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    const approved = await approve(harness, proposal);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const revision = E2EPolicySchema.parse(proposal.body.policy).modelRouteRevision!;
    expect(routeRows(harness.db).map((row) => String(row.sk)).sort()).toEqual(["E2E_MODEL_ROUTE#rovara-e2e-default#REV#1", "E2E_MODEL_ROUTE_LATEST#rovara-e2e-default"]);
    expect(harness.db.get(E2E_MODEL_ROUTE_PARTITION, "E2E_MODEL_ROUTE_LATEST#rovara-e2e-default")).toMatchObject({ revision, revisionNumber: 1 });
    const row = harness.db.find((item) => item.entityType === "PROJECT_SETUP_APPROVAL")[0]!;
    expect((row.policy as { modelRouteRevision: string }).modelRouteRevision).toBe(revision);
  });

  it("stores only the secret's ARN, never any value", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    await approve(harness, await propose(harness));
    const text = JSON.stringify(routeRows(harness.db));
    expect(text).toContain(SECRET_ARN);
    expect(text).not.toMatch(/sk-ant|SecretString|secretValue/);
  });

  it("leaves a keyed provider with no configured secret without AI navigation, and approves the rest of the setup", async () => {
    const { harness } = await harnessFor(async () => ({ provider: "openai" }));
    const proposal = await propose(harness);
    expect(E2EPolicySchema.parse(proposal.body.policy).modelRouteRevision).toBeNull();
    expect(proposal.body.aiNavigation).toBeNull();
    expect((await approve(harness, proposal)).status).toBe(200);
    expect(routeRows(harness.db)).toEqual([]);
  });

  it("leaves the unproven OpenRouter default without AI navigation until its canary is recorded", async () => {
    const { harness } = await harnessFor(async () => ({ provider: "openrouter", secretArn: SECRET_ARN }));
    const proposal = await propose(harness);
    expect(E2EPolicySchema.parse(proposal.body.policy).modelRouteRevision).toBeNull();
    expect(routeRows(harness.db)).toEqual([]);
  });

  it("refuses with model-route-changed-reapprove when the installation's provider changed between the proposal and the approval, and records nothing", async () => {
    const { harness, state } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    state.current = async () => ({ provider: "amazon-bedrock", region: "us-east-1" });
    const refused = await approve(harness, proposal);
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/model-route-changed-reapprove/);
    expect(JSON.stringify(refused.body)).toMatch(/AI navigation settings changed/);
    expect(routeRows(harness.db)).toEqual([]);
    expect(harness.db.find((item) => item.entityType === "PROJECT_SETUP_APPROVAL")).toEqual([]);
  });

  it("refuses the same way when the provider's secret ARN changed", async () => {
    const { harness, state } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    state.current = async () => ({ provider: "anthropic", secretArn: OTHER_ARN });
    const refused = await approve(harness, proposal);
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/model-route-changed-reapprove/);
    expect(routeRows(harness.db)).toEqual([]);
  });

  it("answers an idempotent retry of an approved decision without writing the registry again", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    await approve(harness, proposal);
    const rows = routeRows(harness.db).map((row) => JSON.stringify(row));
    const retry = await approve(harness, proposal);
    expect(retry.body).toMatchObject({ decision: "approve", duplicate: true });
    expect(routeRows(harness.db).map((row) => JSON.stringify(row))).toEqual(rows);
  });

  it("records no route for a declined setup", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const declined = await approve(harness, await propose(harness), "payments", "decline");
    expect(declined.status).toBe(200);
    expect(routeRows(harness.db)).toEqual([]);
  });

  it("keeps one revision when a second project approves the same installation", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const proposal = await propose(harness);
    await approve(harness, proposal, "payments");
    const before = routeRows(harness.db).map((row) => JSON.stringify(row));
    expect((await approve(harness, proposal, "billing")).status).toBe(200);
    expect(routeRows(harness.db).map((row) => JSON.stringify(row))).toEqual(before);
  });

  it("never reads a Scan for approval state, and never touches a membership row", async () => {
    const { harness } = await harnessFor(async () => anthropic);
    const membershipsBefore = harness.db.find((item) => String(item.pk).startsWith("MEMBER#")).map((row) => JSON.stringify(row));
    await approve(harness, await propose(harness));
    expect(harness.db.commandNames()).not.toContain("ScanCommand");
    expect(harness.db.find((item) => String(item.pk).startsWith("MEMBER#")).map((row) => JSON.stringify(row))).toEqual(membershipsBefore);
  });
});

describe("dispatch re-derives the route before an AI navigation round starts", () => {
  const TABLE = "state";
  const agentIntent = { scenarios: [{ steps: [{ kind: "navigate", path: "/" }, { kind: "agent", goal: "export", maxActions: 4 }] }] } as unknown as E2EApplicationPlanIntent;
  const plainIntent = { scenarios: [{ steps: [{ kind: "navigate", path: "/" }] }] } as unknown as E2EApplicationPlanIntent;
  const policyAt = (modelRouteRevision: string | null) => E2EPolicySchema.parse({ schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [],
    defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision, capture: { screenshots: true, traces: false, video: false, downloads: true },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } });
  async function approved(installation: E2EAgentInstallation) {
    const db = new FakeDynamoDb();
    const store = { documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: TABLE };
    const planned = await planE2EAgentRoute(store, installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store, installation, planned.revision);
    const dependencies = (current: (() => Promise<E2EAgentInstallation>) | undefined) => ({ ...store, ...(current === undefined ? {} : { e2eAgentInstallation: current }) });
    return { db, revision: planned.revision, dependencies };
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as Error);

  it("judges nothing for a plan with no agent step", async () => {
    const { dependencies } = await approved(anthropic);
    expect(await requireAgentRouteStillCurrent(dependencies(undefined) as never, "payments", plainIntent, policyAt(null))).toBe(false);
  });

  it("accepts the route the policy pinned while the installation is unchanged, and says the round has agent steps", async () => {
    const { dependencies, revision } = await approved(anthropic);
    expect(await requireAgentRouteStillCurrent(dependencies(async () => anthropic) as never, "payments", agentIntent, policyAt(revision))).toBe(true);
  });

  it.each<[string, E2EAgentInstallation]>([
    ["provider", { provider: "amazon-bedrock", region: "us-east-1" }],
    ["secret ARN", { provider: "anthropic", secretArn: OTHER_ARN }],
  ])("refuses with model-route-changed-reapprove when the %s changed, as a terminal dispatch refusal", async (_name, changed) => {
    const { dependencies, revision } = await approved(anthropic);
    const error = await refusal(requireAgentRouteStillCurrent(dependencies(async () => changed) as never, "payments", agentIntent, policyAt(revision)));
    expect(error).toBeInstanceOf(ApplicationDispatchRefusal);
    expect(error?.message).toMatch(/^model-route-changed-reapprove: The AI navigation settings changed; approve the checks again/);
  });

  it("refuses with model-route-changed-reapprove when the project's pinned revision is no longer the latest", async () => {
    const { dependencies, db, revision } = await approved(anthropic);
    const store = { documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: TABLE };
    const bedrock = { provider: "amazon-bedrock", region: "us-east-1" } satisfies E2EAgentInstallation;
    const second = await planE2EAgentRoute(store, bedrock);
    if (second.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store, bedrock, second.revision);
    const error = await refusal(requireAgentRouteStillCurrent(dependencies(async () => bedrock) as never, "payments", agentIntent, policyAt(revision)));
    expect(error?.message).toMatch(/^model-route-changed-reapprove:/);
  });

  it("refuses with agent-route-not-approved when the policy has no route, the settings cannot be read, or the installation lost its secret", async () => {
    const { dependencies, revision } = await approved(anthropic);
    expect((await refusal(requireAgentRouteStillCurrent(dependencies(async () => anthropic) as never, "payments", agentIntent, policyAt(null))))?.message).toMatch(/^agent-route-not-approved:/);
    expect((await refusal(requireAgentRouteStillCurrent(dependencies(undefined) as never, "payments", agentIntent, policyAt(revision))))?.message).toMatch(/^agent-route-not-approved:/);
    expect((await refusal(requireAgentRouteStillCurrent(dependencies(async () => { throw new Error("ssm down"); }) as never, "payments", agentIntent, policyAt(revision))))?.message).toMatch(/^agent-route-not-approved:/);
    expect((await refusal(requireAgentRouteStillCurrent(dependencies(async () => ({ provider: "anthropic" })) as never, "payments", agentIntent, policyAt(revision))))?.message).toMatch(/^agent-route-not-approved:/);
  });

  it("refuses with model-route-budget-exhausted before the run starts when the project's day has no room for the round", async () => {
    const { dependencies, db, revision } = await approved(anthropic);
    const day = new Date().toISOString().slice(0, 10);
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${day}`, inputTokens: 1_990_000, calls: 10 });
    const error = await refusal(requireAgentRouteStillCurrent(dependencies(async () => anthropic) as never, "payments", agentIntent, policyAt(revision)));
    expect(error).toBeInstanceOf(ApplicationDispatchRefusal);
    expect(error?.message).toMatch(/^model-route-budget-exhausted:/);
    // Another project's day is its own.
    expect(await requireAgentRouteStillCurrent(dependencies(async () => anthropic) as never, "billing", agentIntent, policyAt(revision))).toBe(true);
    expect(db.commandNames()).not.toContain("ScanCommand");
  });
});

describe("the installation's settings as SSM holds them", () => {
  const PREFIX = "/agentx/test/";
  const read = (values: Record<string, string>) => async (names: readonly string[]) => new Map(Object.entries(values).filter(([name]) => names.includes(name)));

  it("reads the provider, the matching provider's secret ARN and the OpenRouter allowlist, and the region it is given", async () => {
    const installation = await e2eAgentInstallationFromParameters(PREFIX, read({
      [`${PREFIX}worker-model-provider`]: "openrouter", [`${PREFIX}worker-openrouter-secret-arn`]: SECRET_ARN, [`${PREFIX}worker-anthropic-secret-arn`]: OTHER_ARN,
      [`${PREFIX}worker-openrouter-providers`]: "anthropic",
    }), "us-east-1");
    expect(installation).toEqual({ provider: "openrouter", secretArn: SECRET_ARN, openRouterProviders: "anthropic", region: "us-east-1" });
  });

  it("takes only the installation provider's own ARN, and treats none or empty as not configured", async () => {
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({ [`${PREFIX}worker-model-provider`]: "anthropic", [`${PREFIX}worker-openai-secret-arn`]: OTHER_ARN, [`${PREFIX}worker-anthropic-secret-arn`]: "none" }), undefined))
      .toEqual({ provider: "anthropic" });
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({ [`${PREFIX}worker-model-provider`]: "amazon-bedrock" }), "us-east-1")).toEqual({ provider: "amazon-bedrock", region: "us-east-1" });
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({}), "us-east-1")).toEqual({ region: "us-east-1" });
  });
});

describe("what the planner is told about agent steps", () => {
  const web = { kind: "web" as const, steps: ["navigate", "fill", "click", "choose-file", "agent"], assertions: ["text", "visible", "csv"] };
  const context = (steps: string[]) => ({ targets: [{ targetId: "web-1", applicationId: "orders", kind: "web" as const, accountProfileId: "synthetic" }], unavailableTargetRefs: [],
    executableKinds: [{ ...web, steps }] });

  it("lists agent as a step kind and explains how to use it only when the context offers it", () => {
    const text = describeFeatureE2EExecutableKinds(context([...web.steps]));
    expect(text).toContain("steps navigate, fill, click, choose-file, agent;");
    expect(text).toMatch(/Use deterministic steps where test IDs are known and stable/);
    expect(text).toMatch(/name the outcome/);
    expect(text).not.toMatch(/Do not use `agent` steps/);
  });

  it("keeps saying agent steps are unavailable when the context does not offer them", () => {
    const text = describeFeatureE2EExecutableKinds(context(["navigate", "fill", "click", "choose-file"]));
    expect(text).toContain("Do not use `agent` steps; they stay unavailable.");
    expect(text).not.toContain(", agent;");
  });
});
