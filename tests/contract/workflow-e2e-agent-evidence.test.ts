import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DEFAULT_MODEL_ROUTE_ID, e2eModelRouteRevision } from "@agentx/contracts";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { approveE2EAgentRoute, planE2EAgentRoute } from "../../packages/broker/src/e2e/model-route-registry.js";
import { modelRouteForAdmission as modelRouteForAdmissionWith } from "../../packages/broker/src/e2e/application-evidence.js";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { createOrdersM14AgentPlan } from "../support/orders-m14-agent.js";
import { deriveE2EAgentRoute } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { agentRunnable, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../../packages/broker/src/e2e/application-evidence.js";
import { SCRIPTED_REGISTRY_ROUTE, asLinuxRun, assembleAgentRun, brokerRoundFor } from "../support/agent-collection.js";
import { renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks } from "../../packages/broker/src/e2e-presentation.js";
import { scrubScenarioResults } from "../../packages/broker/src/e2e/application-display.js";

// The gate itself is tested in e2e-driving-test-gate.test.ts; here every digest counts as driven (Task 4.10C).
assumeDrivingTestsPassed();

// Task 4.4a at the broker: the same real agent runs as the group evidence a worker uploads, re-collected and requalified by `verifyApplicationE2EEvidence` against the admission and the
// model route registry's own definition of the admitted revision. The verdicts of the three journeys (agent-renamed-export, agent-wrong-action, agent-model-outage) at verdict level.
type Scenario = "ok" | "decoy" | "outage" | "no-download";
const SCRIPTS = {
  ok: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }],
  decoy: [{ kind: "tap", name: /Download invoices/ }, { kind: "done" }],
  outage: [{ kind: "fail", message: "provider down" }],
  "no-download": [{ kind: "done" }],
} as const;

const artifactPath = (sha256: string) => `/review/t/task/api/e2e/artifacts/${sha256}`;
/** The task page's section for these rows as text (entities undone, so a sentence can be matched as the owner reads it). */
const pageText = (scenarios: readonly never[] | readonly object[], undo = true) => {
  const page = renderE2EScenarioRowsHtml({ scenarios: scenarios as never }, { artifactPath });
  return undo ? page.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") : page;
};
const slackText = (scenarios: readonly object[]) => renderE2EScenarioSlackBlocks({ scenarios: scenarios as never }, { taskPageUrl: "https://agentx.test/review/t/task" }).map((block) => block.text.text).join("\n");

describe.runIf(agentRunnable)("the broker's verdict on real agent runs", () => {
  const runs: AgentRun[] = [];
  const byName = {} as Record<Scenario, AgentRun>;
  beforeAll(async () => {
    for (const name of Object.keys(SCRIPTS) as Scenario[]) { const run = await runAgentCase({ script: SCRIPTS[name] }); runs.push(run); byName[name] = run; }
  }, 600_000);
  afterAll(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });
  const readBack = async (name: Scenario) => asLinuxRun(await assembleAgentRun(byName[name]));

  it("32. agent-renamed-export: PASS, the case passed with both receipts named, and the broker's own display has the case", async () => {
    const a = await readBack("ok");
    const round = brokerRoundFor(a);
    const verdict = round.verify();
    expect(verdict.reason).toBe("every admitted application group was independently re-collected as passing");
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.groups).toMatchObject([{ verdict: "PASS" }]);
    expect(verdict.results[0]!.status).toBe("passed");
    expect(verdict.results[0]!.modelReceiptIds).toEqual(a.run.receipts.map((receipt) => receipt.receiptId).sort());
    expect(verdict.results[0]!.modelReceiptIds).toHaveLength(2);
    expect(verdict.display?.scenarios).toHaveLength(1);
    expect(verdict.display!.scenarios[0]).toMatchObject({ scenarioId: "agent-export", status: "PASSED" });
    // Task 4.4b: the row says how the AI navigated, from the ledger the broker verified: what it clicked, how the step ended, the calls and the route, and which check decided.
    expect(verdict.display!.scenarios[0]!.agentNavigation).toEqual({ steps: [{ goal: "Export the orders as a CSV file", actedOn: [{ role: "button", name: "Download orders", did: "tap" }], stop: "concluded" }],
      modelCalls: 2, routeId: SCRIPTED_REGISTRY_ROUTE.routeId, decidedBy: ["csv"] });
    expect(pageText(verdict.display!.scenarios)).toContain("AI-navigated: the model clicked 'Download orders'; the CSV check decided");
    expect(slackText(verdict.display!.scenarios)).toContain("AI navigation: 1 step, 2 model calls (checks decide)");
  });

  it("AGENTSCOPE: the broker verifies a round under the scope it is given, and a customer round (the default) does not accept the scripted double's receipts even when the registry row claims qualification", async () => {
    const a = await readBack("ok");
    expect(SCRIPTED_REGISTRY_ROUTE.scope).toBe("qualification");
    expect(brokerRoundFor(a, { roundScope: "qualification" }).verify().verdict).toBe("PASS");
    const customer = brokerRoundFor(a, { roundScope: "standard" });
    expect(customer.input.roundScope).toBe("standard");
    const verdict = customer.verify();
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.results[0]!.cases[0]).toMatchObject({ status: "unavailable", reason: "model-receipts-mismatch" });
    // What the production caller passes (nothing) is the customer round.
    const { roundScope: _unused, ...withoutScope } = brokerRoundFor(a).input;
    void _unused;
    expect(verifyApplicationE2EEvidence(withoutScope).verdict).toBe("UNKNOWN");
  });

  it("33. agent-wrong-action: FAILED on the deterministic CSV mismatch alone (decision D3), with the case failed and no UNKNOWN code", async () => {
    const verdict = brokerRoundFor(await readBack("decoy")).verify();
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.results[0]!.cases[0]).toMatchObject({ status: "failed", reason: "observed-application-assertion-failure" });
    // The row is the broker's own, and names the assertion that failed: the CSV of the wrong file.
    expect(verdict.display!.scenarios[0]).toMatchObject({ status: "FAILED", failedAssertion: { kind: "csv", expected: "orders.csv", actual: "invoices.csv" } });
    // The row names what the model clicked, so the owner can see the model took the wrong button: the decoy, and the CSV check that decided.
    expect(verdict.display!.scenarios[0]!.agentNavigation?.steps[0]?.actedOn).toEqual([{ role: "button", name: "Download invoices", did: "tap" }]);
    expect(pageText(verdict.display!.scenarios)).toContain("AI-navigated: the model clicked 'Download invoices'; the CSV check decided");
  });

  it("34. agent-model-outage: UNKNOWN, with the case saying model-unavailable, and no pass", async () => {
    const verdict = brokerRoundFor(await readBack("outage")).verify();
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.results[0]!.cases[0]).toMatchObject({ status: "unavailable", reason: "model-unavailable" });
    expect(verdict.display!.scenarios[0]!.status).not.toBe("PASSED");
    expect(verdict.display!.scenarios[0]!.status).not.toBe("FAILED");
    // Task 4.4b: an outage says so in the owner's words, and no navigation is claimed for a row the broker could not decide.
    expect(verdict.display!.scenarios[0]).toMatchObject({ status: "UNKNOWN", reason: "The AI model couldn't be reached, so this AI-navigated check could not run; retry the checks" });
    expect(verdict.display!.scenarios[0]).not.toHaveProperty("agentNavigation");
    expect(slackText(verdict.display!.scenarios)).not.toContain("AI navigation:");
  });

  it("a model that finished without acting leaves a case the broker calls UNKNOWN agent-no-download", async () => {
    const verdict = brokerRoundFor(await readBack("no-download")).verify();
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.results[0]!.cases[0]).toMatchObject({ status: "unavailable", reason: "agent-no-download" });
    expect(verdict.display!.scenarios[0]).toMatchObject({ status: "UNKNOWN", reason: "The AI navigator didn't find a way to download the CSV; retry, or check the button exists" });
  });

  it("29. nothing a run typed, no key, no credential and no digest reaches a row, the page, Slack or the artifact list, for any of the four runs", async () => {
    for (const name of Object.keys(SCRIPTS) as Scenario[]) {
      const a = await readBack(name);
      const verdict = brokerRoundFor(a).verify();
      const display = verdict.display!;
      const ledgerText = JSON.stringify(a.run.readLedger() ?? {});
      const digests = [...ledgerText.matchAll(/"(?:valueDigest|snapshotSha256|goalDigest|valueKeyId)":"([a-f0-9]{64})"/gu)].map((match) => match[1]!);
      const secrets = [a.run.valueKey, ...a.run.fixture.plan.accounts.flatMap((account) => [account.password, account.email, account.email.split("@")[0]!]), ...digests, ...a.run.receipts.flatMap((receipt) => [receipt.receiptId, receipt.promptSha256])];
      const stored = scrubScenarioResults({ scenarios: [...display.scenarios] });
      const everything = [JSON.stringify(display.scenarios), pageText(display.scenarios, false), slackText(display.scenarios), JSON.stringify(display.artifacts.map((artifact) => ({ sha256: artifact.sha256, contentType: artifact.contentType }))), JSON.stringify(stored)].join("\n");
      for (const secret of secrets) expect(everything, `${name}: ${secret.slice(0, 8)}`).not.toContain(secret);
      // Positive control: the scan ran over a real display, and over a ledger that has the digests it looks for.
      expect(everything.length).toBeGreaterThan(200);
      if (name === "ok") expect(digests.length).toBeGreaterThan(0);
    }
  });

  it("21. model evidence for a group with no admitted route, or none for a group with an agent step, is UNKNOWN model-receipts-mismatch", async () => {
    const a = await readBack("ok");
    const without = Object.fromEntries(Object.entries(a.inputs).filter(([key]) => key !== "agentModel")) as typeof a.inputs;
    const missing = brokerRoundFor(a, { inputs: without });
    // The worker's collector refuses too, so what is uploaded is its unavailable group; the broker's own re-collection of the same bytes must say the same.
    const verdict = missing.verify();
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.reason).toMatch(/model-receipts-mismatch/);
    // The worker claims a PASS it has no model evidence for: the broker does not read the claim.
    const claimed = brokerRoundFor(a, { editGroupRun: () => undefined });
    const forged = { ...claimed.input, groupEvidence: new Map([...claimed.input.groupEvidence].map(([key, envelope]) => {
      const copy = JSON.parse(JSON.stringify(envelope)) as { groupRun: { actual: { collectionInputs: Record<string, unknown> } } };
      delete copy.groupRun.actual.collectionInputs["agentModel"];
      return [key, copy] as const;
    })), aggregate: undefined };
    const forgedVerdict = (await import("../../packages/broker/src/e2e/application-evidence.js")).verifyApplicationE2EEvidence(forged);
    expect(forgedVerdict.verdict).toBe("UNKNOWN");
    expect(forgedVerdict.groups[0]!.reason).toMatch(/^model-receipts-mismatch:/);
  });

  it("22. a worker's route that is not the admitted revision, or no definition in the registry, is UNKNOWN; the registry's definition is the one used", async () => {
    const a = await readBack("ok");
    // The registry has no such revision.
    const gone = brokerRoundFor(a, { modelRouteDefinition: null }).verify();
    expect(gone.verdict).toBe("UNKNOWN");
    expect(gone.groups[0]!.reason).toMatch(/^agent-route-not-approved:/);
    // The caller did not read the registry at all.
    const unread = brokerRoundFor(a, { modelRouteDefinition: undefined }).verify();
    expect(unread.verdict).toBe("UNKNOWN");
    expect(unread.groups[0]!.reason).toMatch(/^agent-route-not-approved:/);
    // A registry row that is not the admitted revision (another route, other budgets).
    const other = deriveE2EAgentRoute({ provider: "amazon-bedrock", region: "us-east-1" }, 1);
    if (other.status !== "available") throw new Error("the fixture route must be available");
    const wrong = brokerRoundFor(a, { modelRouteDefinition: other.definition }).verify();
    expect(wrong.verdict).toBe("UNKNOWN");
    expect(wrong.groups[0]!.reason).toMatch(/^agent-route-not-approved:/);
    // The worker's own account of the route being another revision is a mismatch, whatever the registry holds.
    const edited = brokerRoundFor(a, { editGroupRun: (groupRun) => { (groupRun["actual"] as { collectionInputs: { agentModel: Record<string, unknown> } }).collectionInputs.agentModel["route"] = JSON.parse(JSON.stringify(other.definition)); } }).verify();
    expect(edited.verdict).toBe("UNKNOWN");
    expect(edited.groups[0]!.reason).toMatch(/^model-receipts-mismatch:/);
    expect(e2eModelRouteRevision(other.definition)).not.toBe(e2eModelRouteRevision(SCRIPTED_REGISTRY_ROUTE));
  });

  it("a group with an agent step is held to the model ceiling its config pins (32000 per call), not the runner's default: the real runner reports 32000, and a report of 64000 is refused", async () => {
    const a = await readBack("ok");
    expect(a.inputs.limits["maxModelTokensPerCall"]).toBe(32_000);
    expect(brokerRoundFor(a).verify().verdict).toBe("PASS");
    const limits = (groupRun: Record<string, unknown>) => (groupRun["actual"] as { collectionInputs: { limits: Record<string, number> } }).collectionInputs.limits;
    const raised = brokerRoundFor(a, { editGroupRun: (groupRun) => { limits(groupRun)["maxModelTokensPerCall"] = 64_000; } }).verify();
    expect(raised.verdict).toBe("UNKNOWN");
    expect(raised.groups[0]!.reason).toMatch(/limits are not the configured limits/);
  });

  it("23. receipts edited after the worker uploaded them do not requalify: the worker's own PASS is ignored", async () => {
    const a = await readBack("ok");
    // The worker's collection (taken before the edit) says PASS; the uploaded receipts then lose their second call, or one outcome is flipped.
    const honest = brokerRoundFor(a);
    expect(honest.verify().verdict).toBe("PASS");
    const edits: Array<[string, (agentModel: Record<string, unknown>) => void]> = [
      ["a receipt dropped", (agentModel) => { (agentModel["receipts"] as unknown[]).pop(); }],
      ["an outcome flipped", (agentModel) => { (agentModel["receipts"] as Array<Record<string, unknown>>)[1]!["outcome"] = "provider-error"; (agentModel["receipts"] as Array<Record<string, unknown>>)[1]!["responseSha256"] = null; }],
      ["a receipt id forged", (agentModel) => { (agentModel["receipts"] as Array<Record<string, unknown>>)[0]!["receiptId"] = "rcpt-forged"; }],
      ["the key swapped", (agentModel) => { agentModel["valueKey"] = "cd".repeat(32); }],
      ["a dirty channel hidden as clean is not possible, but a clean one made dirty is read", (agentModel) => { (agentModel["channel"] as Record<string, unknown>)["droppedRequests"] = 1; }],
    ];
    for (const [name, edit] of edits) {
      const round = brokerRoundFor(a, { editGroupRun: (groupRun) => edit((groupRun["actual"] as { collectionInputs: { agentModel: Record<string, unknown> } }).collectionInputs.agentModel) });
      const verdict = round.verify();
      expect(verdict.verdict, name).toBe("UNKNOWN");
    }
  });
});

// Checklist 3: what was stored before Task 4.4a still verifies, and a round with no AI navigation step is unaffected by it.
describe("evidence written before Task 4.4a", () => {
  type Stored = { admissionText: string; subject: ApplicationEvidenceInput["subject"]; aggregate: unknown; groupEvidence: Record<string, unknown>; receivedAt: Record<string, string> };
  const load = (name: "passing" | "failing"): ApplicationEvidenceInput => {
    const stored = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures", `application-evidence-before-task-4-4a-${name}.json`), "utf8")) as Stored;
    return { admissionBytes: Buffer.from(stored.admissionText, "utf8"), subject: stored.subject, aggregate: stored.aggregate, groupEvidence: new Map(Object.entries(stored.groupEvidence)),
      receivedAt: new Map(Object.entries(stored.receivedAt)), terminalStatus: "SUCCEEDED" };
  };
  const inputsOf = (input: ApplicationEvidenceInput) => [...input.groupEvidence.values()].map((envelope) => (envelope as { groupRun: { actual: { collectionInputs: Record<string, unknown> } } }).groupRun.actual.collectionInputs);

  it("a stored round that passed still passes, and one that failed still fails, with the bytes exactly as the code before wrote them (no agentModel, governedModelReceipts empty)", () => {
    for (const [name, verdict] of [["passing", "PASS"], ["failing", "FAILED"]] as const) {
      const input = load(name);
      for (const inputs of inputsOf(input)) { expect(inputs).not.toHaveProperty("agentModel"); expect(inputs["governedModelReceipts"]).toEqual([]); }
      expect(verifyApplicationE2EEvidence(input).verdict, name).toBe(verdict);
      // A registry definition the caller read changes nothing for a round that has no AI navigation step.
      expect(verifyApplicationE2EEvidence({ ...input, modelRouteDefinition: SCRIPTED_REGISTRY_ROUTE }).verdict, name).toBe(verdict);
    }
  });

  it("21. model evidence on a group with no AI navigation step is refused, whatever it holds: a worker cannot attach receipts to a round that never used the model", () => {
    const input = load("passing");
    for (const envelope of input.groupEvidence.values()) {
      const inputs = (envelope as { groupRun: { actual: { collectionInputs: Record<string, unknown> } } }).groupRun.actual.collectionInputs;
      inputs["agentModel"] = { schemaVersion: "rovara-agent-model-evidence/v1", route: null, valueKey: "ab".repeat(32), receipts: [], channel: { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 },
        ledgers: [], transcriptDigests: [] };
    }
    const verdict = verifyApplicationE2EEvidence({ ...input, aggregate: undefined });
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.groups[0]!.reason).toMatch(/model-receipts-mismatch: model evidence came with a group that has no AI navigation step/);
  });
});

// What the broker's async caller does: one GetItem on its state table, by the registry's key.
const modelRouteForAdmission = (dependencies: { documentClient: DynamoDBDocumentClient; tableName: string }, admission: Parameters<typeof modelRouteForAdmissionWith>[1]) =>
  modelRouteForAdmissionWith(async (key) => ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item, admission);

describe("the async caller reads the registry for a round that has an AI navigation step, and only for one", () => {
  const registry = async (installation: { provider: "amazon-bedrock"; region: string }) => {
    const db = new FakeDynamoDb();
    const store = { documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: "state" };
    const planned = await planE2EAgentRoute(store, installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store, installation, planned.revision);
    return { db, dependencies: { documentClient: store.documentClient, tableName: "state" } as never, planned };
  };
  const agentAdmission = (routeRevision: string) => {
    const admission = createOrdersM14AgentPlan().plan.admission;
    return { ...admission, modelRoute: { routeId: E2E_DEFAULT_MODEL_ROUTE_ID, routeRevision } } as typeof admission;
  };

  it("asks for the admitted revision with one GetItem, and hands the definition on", async () => {
    const { db, dependencies, planned } = await registry({ provider: "amazon-bedrock", region: "us-east-1" });
    const before = db.commandNames().length;
    const route = await modelRouteForAdmission(dependencies, agentAdmission(planned.revision));
    expect(route).toEqual({ definition: planned.definition });
    expect(db.commandNames().slice(before)).toEqual(["GetCommand"]);
    // A revision the registry does not hold is "not there", which is not the same as "could not be asked".
    expect(await modelRouteForAdmission(dependencies, agentAdmission("r9-aaaaaaaaaaaa"))).toEqual({ definition: null });
  });

  it("does not ask for a round with no route, or no case with an agent step", async () => {
    const { db, dependencies, planned } = await registry({ provider: "amazon-bedrock", region: "us-east-1" });
    const before = db.commandNames().length;
    expect(await modelRouteForAdmission(dependencies, { ...agentAdmission(planned.revision), modelRoute: null })).toEqual({ definition: undefined });
    const plain = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" }).plan.admission;
    expect(await modelRouteForAdmission(dependencies, { ...plain, modelRoute: { routeId: E2E_DEFAULT_MODEL_ROUTE_ID, routeRevision: planned.revision } })).toEqual({ definition: undefined });
    expect(db.commandNames().length).toBe(before);
  });

  it("says the registry could not be asked when the read keeps failing, rather than judging the round without it", async () => {
    const { dependencies, planned } = await registry({ provider: "amazon-bedrock", region: "us-east-1" });
    void dependencies;
    const failing = { tableName: "state", documentClient: { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } } };
    expect(await modelRouteForAdmission(failing as never, agentAdmission(planned.revision))).toEqual({ unavailable: "model-route-registry-unavailable" });
  });
});
