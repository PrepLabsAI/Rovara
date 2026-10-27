import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, requalifyHoldKey as holdKeyOf } from "@agentx/contracts";
import { projectSetupBindingDigest, projectSetupRuntimeKey } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
import { REQUALIFY_DEFERRED_MESSAGE } from "../../packages/broker/src/e2e/requalify-hold.js";
import { createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { snapshotOf } from "../support/e2e-application-plan-fixtures.js";
import { call } from "../support/slack-broker.js";

// AUTOREQUALIFY (AR-3), the setup run's start fence on the real broker. A project registration that creates a setup run commits the run's rows and a ConditionCheck on the renewal's HOLD
// row in one transaction; a hold placed after the earlier looks but before that transaction must refuse the registration with the fixed retryable sentence and write nothing. Until now only a
// structural test (tests/unit/requalify-hold.test.ts) checked that the setup transaction carries the fence.
// A repository whose one package exports a function: the shape the setup run's source-interface smoke inspects (the project-setup onboarding journey uses the same).
const portableSnapshot = snapshotOf({
  "package.json": `${JSON.stringify({ name: "ordinary-orders", type: "module", exports: { ".": "./src/index.mjs" }, scripts: { build: "node --check src/index.mjs", test: "node --test" } }, null, 2)}\n`,
  "package-lock.json": `${JSON.stringify({ name: "ordinary-orders", lockfileVersion: 3, packages: { "": { name: "ordinary-orders" } } }, null, 2)}\n`,
  "src/index.mjs": "export function priceRows(input) { return { rows: input.rows.map((row) => ({ ...row, price: 7 })) }; }\n",
});
const admin = { subject: "admin-subject", admin: true };
const holdKey = holdKeyOf("linux-arm64-web-api-v1");
const holdRow = (until: number) => ({ ...holdKey, entityType: "RUNTIME_REQUALIFY_HOLD", runId: randomUUID(), acquiredAt: new Date().toISOString(), until: new Date(until).toISOString() });

async function registrationHarness() {
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { projectSetupSource: { capture: async () => portableSnapshot }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
  const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
  const binding = projectRow().runtimeBinding as Parameters<typeof projectSetupBindingDigest>[0];
  // The setup runtime the registration admits its setup run on: the operator-managed READY row for this binding.
  const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "darwin 24.0.0", arch: "arm64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: process.execPath, version: "v22.23.2", platform: process.platform, arch: process.arch };
  const digestOf = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  harness.db.set({ ...projectSetupRuntimeKey("setup-catalog", projectSetupBindingDigest(binding)), schemaVersion: 1, entityType: "PROJECT_SETUP_RUNTIME", runtimeCatalogId: "setup-catalog", catalogRevision: 1,
    bindingDigest: projectSetupBindingDigest(binding), binding, manifestDigest: "a".repeat(64), runnerEnvironment, runnerEnvironmentDigest: digestOf(runnerEnvironment), runnerToolchain, runnerToolchainDigest: digestOf(runnerToolchain),
    endpoint: "http://10.0.0.8:8080", generation: 1, transportCorrelationId: randomUUID(), supportedSetupScopes: ["source-interface"], state: "READY",
    qualifiedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const proposal = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
  const proposalRef = String(proposal.body.proposalRef);
  const proposalSha256 = String(proposal.body.proposalSha256);
  const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
  expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  const definition = projectRow().definition as Record<string, unknown> & { revision: number };
  const register = () => call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
    body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposal.body.policy }, runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
  const revisions = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments").length;
  const setupRows = () => harness.db.find((row) => ["PROJECT_SETUP_EXECUTION", "PROJECT_SETUP_SESSION", "PROJECT_SETUP_OPERATION"].includes(String(row.entityType)) || String(row.pk).startsWith("RUNTIME_REQUALIFY_WORK#"));
  return { harness, register, revisions, setupRows, before: revisions() };
}

describe("a project registration's setup run starts only while no renewal hold stands", () => {
  it("(positive control) with no hold, the registration commits the setup run's rows and the drain marker", async () => {
    const { register, revisions, setupRows, before } = await registrationHarness();
    const response = await register();
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(revisions()).toBe(before + 1);
    expect(setupRows().map((row) => String(row.entityType ?? row.pk).split("#")[0]).sort()).toEqual(["PROJECT_SETUP_EXECUTION", "PROJECT_SETUP_OPERATION", "PROJECT_SETUP_SESSION", "RUNTIME_REQUALIFY_SETUP_WORK"]);
  });

  it("refuses with the fixed retryable sentence, and writes nothing, when the hold is placed after the earlier look and before the registration's transaction", async () => {
    const { harness, register, revisions, setupRows, before } = await registrationHarness();
    const send = harness.db.send.bind(harness.db);
    let looks = 0;
    let transactions = 0;
    harness.db.send = async (command) => {
      const key = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
      const isHoldLook = command.constructor.name === "GetCommand" && key?.pk === holdKey.pk && key.sk === holdKey.sk;
      if (command.constructor.name === "TransactWriteCommand") transactions += 1;
      const result = await send(command);
      // The look before the transaction finds no hold; the switch begins right after it.
      if (isHoldLook && (looks += 1) === 1) harness.db.set(holdRow(Date.now() + 600_000));
      return result;
    };
    const response = await register();
    // The look happened, and the transaction was tried: it is the fence inside it that refused (not the look).
    expect(looks).toBeGreaterThanOrEqual(1);
    expect(transactions).toBeGreaterThanOrEqual(1);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toContain(REQUALIFY_DEFERRED_MESSAGE);
    expect(JSON.stringify(response.body)).not.toMatch(/RUNTIME_UNAVAILABLE: RUNTIME_UNAVAILABLE|catalog|conflict/i);
    // Nothing was committed: no new revision, no setup run, no drain marker.
    expect(revisions()).toBe(before);
    expect(setupRows()).toEqual([]);
    // Once the hold ends the same registration commits (it was refused only for the hold).
    harness.db.delete(holdKey.pk, holdKey.sk);
    const retried = await register();
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(setupRows().length).toBeGreaterThan(0);
  });
});
