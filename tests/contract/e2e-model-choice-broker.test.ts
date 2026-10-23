import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2E_DEFAULT_MODEL_ROUTE_ID, e2eModelRouteRevision, type E2EWorkflowAdmissionRef } from "@agentx/contracts";
import {
  E2E_MODEL_ROUTE_PARTITION, agentRouteSummary, approveE2EAgentRoute, checkE2EAgentRouteCurrent, deriveE2EAgentRoute, e2eAgentInstallationFromParameters, e2eAgentRouteDefinitionDigest,
  e2eModelRouteRevisionKey, e2eModelRouteShapeKey, planE2EAgentRoute, readE2EModelRouteShape, type E2EAgentInstallation,
} from "../../packages/broker/src/e2e/model-route-registry.js";
import { createWorkflowE2EAdmissionModelChoiceReader } from "../../packages/broker/src/aws/workflow-e2e-admission-schema.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SECRET_ARN } from "../support/e2e-model-fixtures.js";

// M1.4 Task 4.10A, tests 8 and 14: what the broker reads of the installation's choice, what it shows the administrator, and the reader the dispatcher uses.

const TABLE = "state";
const PREFIX = "/agentx/agentxlivetest123/";
const HAIKU_45_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_GLOBAL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const store = (db: FakeDynamoDb) => ({ documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: TABLE });
const read = (values: Record<string, string>) => async (names: readonly string[]) => new Map(Object.entries(values).filter(([name]) => names.includes(name)));
const available = (installation: E2EAgentInstallation, revision = 1) => {
  const derived = deriveE2EAgentRoute(installation, revision);
  if (derived.status !== "available") throw new Error(`not available: ${derived.detail}`);
  return derived.definition;
};

describe("the installation's chosen AI navigation model, as SSM and the shape row hold it (test 8)", () => {
  it("reads worker-e2e-agent-model, and treats default, none, empty and absent as no choice", async () => {
    const base = { [`${PREFIX}worker-model-provider`]: "amazon-bedrock" };
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({ ...base, [`${PREFIX}worker-e2e-agent-model`]: HAIKU_45_US }), "us-east-1"))
      .toEqual({ provider: "amazon-bedrock", region: "us-east-1", e2eModel: HAIKU_45_US });
    for (const value of ["default", "none", "", "  "]) {
      expect(await e2eAgentInstallationFromParameters(PREFIX, read({ ...base, [`${PREFIX}worker-e2e-agent-model`]: value }), "us-east-1"), JSON.stringify(value)).toEqual({ provider: "amazon-bedrock", region: "us-east-1" });
    }
    expect(await e2eAgentInstallationFromParameters(PREFIX, read(base), "us-east-1")).toEqual({ provider: "amazon-bedrock", region: "us-east-1" });
  });

  it("asks for the shape of the chosen model, or of the recommended one when there is no choice, and carries minimal only", async () => {
    const asked: string[] = [];
    const readShape = async (modelId: string) => { asked.push(modelId); return modelId === HAIKU_45_US ? "minimal" as const : undefined; };
    const base = { [`${PREFIX}worker-model-provider`]: "amazon-bedrock" };
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({ ...base, [`${PREFIX}worker-e2e-agent-model`]: HAIKU_45_US }), "us-east-1", { readShape }))
      .toEqual({ provider: "amazon-bedrock", region: "us-east-1", e2eModel: HAIKU_45_US, payloadShape: "minimal" });
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({ ...base, [`${PREFIX}worker-e2e-agent-model`]: HAIKU_45_GLOBAL }), "us-east-1", { readShape }))
      .toEqual({ provider: "amazon-bedrock", region: "us-east-1", e2eModel: HAIKU_45_GLOBAL });
    expect(await e2eAgentInstallationFromParameters(PREFIX, read(base), "us-east-1", { readShape })).toEqual({ provider: "amazon-bedrock", region: "us-east-1" });
    expect(asked).toEqual([HAIKU_45_US, HAIKU_45_GLOBAL, "us.anthropic.claude-haiku-5-5"]);
    // No provider: nothing to ask about.
    asked.length = 0;
    expect(await e2eAgentInstallationFromParameters(PREFIX, read({}), "us-east-1", { readShape })).toEqual({ region: "us-east-1" });
    expect(asked).toEqual([]);
  });

  it("reads the shape row by key: minimal, standard and absent, and refuses a row it cannot read", async () => {
    const db = new FakeDynamoDb();
    expect(await readE2EModelRouteShape(store(db), E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_US)).toBeUndefined();
    db.set({ ...e2eModelRouteShapeKey(E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_US), payloadShape: "minimal", testedAt: "2026-10-23T01:00:00.000Z" });
    db.set({ ...e2eModelRouteShapeKey(E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_GLOBAL), payloadShape: "standard", testedAt: "2026-10-23T01:00:00.000Z" });
    db.set({ ...e2eModelRouteShapeKey(E2E_DEFAULT_MODEL_ROUTE_ID, "us.anthropic.claude-haiku-5-5"), payloadShape: "weird" });
    expect(e2eModelRouteShapeKey(E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_US)).toEqual({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE_SHAPE#rovara-e2e-default#${HAIKU_45_US}` });
    expect(await readE2EModelRouteShape(store(db), E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_US)).toBe("minimal");
    expect(await readE2EModelRouteShape(store(db), E2E_DEFAULT_MODEL_ROUTE_ID, HAIKU_45_GLOBAL)).toBeUndefined();
    await expect(readE2EModelRouteShape(store(db), E2E_DEFAULT_MODEL_ROUTE_ID, "us.anthropic.claude-haiku-5-5")).rejects.toThrow(/agent-route-not-approved/);
  });

  it("approves exactly the definition the setting and the shape row give, and asks for a new approval when the setting changes", async () => {
    const db = new FakeDynamoDb();
    const installation = await e2eAgentInstallationFromParameters(PREFIX, read({ [`${PREFIX}worker-model-provider`]: "amazon-bedrock", [`${PREFIX}worker-e2e-agent-model`]: HAIKU_45_US }), "us-east-1",
      { readShape: async () => "minimal" });
    const planned = await planE2EAgentRoute(store(db), installation);
    if (planned.status !== "available") throw new Error(planned.detail);
    expect(planned.definition).toMatchObject({ modelId: HAIKU_45_US, effort: null, payloadShape: "minimal" });
    expect(planned.definitionDigest).toBe(e2eAgentRouteDefinitionDigest(available({ provider: "amazon-bedrock", region: "us-east-1", e2eModel: HAIKU_45_US, payloadShape: "minimal" })));
    await approveE2EAgentRoute(store(db), installation, planned.revision);
    expect(db.get(E2E_MODEL_ROUTE_PARTITION, e2eModelRouteRevisionKey(E2E_DEFAULT_MODEL_ROUTE_ID, 1).sk)).toMatchObject({ definition: planned.definition });
    expect(await checkE2EAgentRouteCurrent(store(db), installation, planned.revision)).toMatchObject({ ok: true });
    // The administrator changes the model after approval: the project's pinned revision no longer matches.
    const changed = { ...installation, e2eModel: HAIKU_45_GLOBAL };
    expect(await checkE2EAgentRouteCurrent(store(db), changed, planned.revision)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("makes an ineligible setting an unavailable route, not an error", async () => {
    const installation = await e2eAgentInstallationFromParameters(PREFIX, read({ [`${PREFIX}worker-model-provider`]: "amazon-bedrock", [`${PREFIX}worker-e2e-agent-model`]: "anthropic.claude-haiku-4-5-20251001-v1:0" }), "us-east-1");
    expect(await planE2EAgentRoute(store(new FakeDynamoDb()), installation)).toMatchObject({ status: "unavailable", reason: "agent-route-not-approved" });
  });
});

describe("the setup approval sentence (test 14)", () => {
  const US_SENTENCE = "Your app's pages are processed by the AI in US data centers.";
  const GLOBAL_SENTENCE = "Slightly cheaper and less likely to hit limits; your app's pages may be processed by the AI outside the US.";
  const bedrock = { provider: "amazon-bedrock", region: "us-east-1" } as const;

  it("says exactly the owner's US sentence for a us. profile and exactly the Global sentence for a global. profile", () => {
    const us = agentRouteSummary(available({ ...bedrock, e2eModel: HAIKU_45_US }));
    expect(us).toContain(US_SENTENCE);
    expect(us).not.toContain("outside the US");
    expect(us).toBe(`AI navigation: Amazon Bedrock \`${HAIKU_45_US}\` (your choice). ${US_SENTENCE} At most 8 actions per step; checks decide`);
    const global = agentRouteSummary(available({ ...bedrock, e2eModel: HAIKU_45_GLOBAL }));
    expect(global).toContain(GLOBAL_SENTENCE);
    expect(global).not.toContain("US data centers");
    expect(global).toBe(`AI navigation: Amazon Bedrock \`${HAIKU_45_GLOBAL}\` (your choice). ${GLOBAL_SENTENCE} At most 8 actions per step; checks decide`);
  });

  it("names Rovara's recommendation as such, with its US sentence on Bedrock", () => {
    expect(agentRouteSummary(available(bedrock))).toBe(`AI navigation: Amazon Bedrock \`us.anthropic.claude-haiku-5-5\` (Rovara's recommendation). ${US_SENTENCE} At most 8 actions per step; checks decide`);
  });

  it("shows no scope sentence for a keyed provider, with the choice named", () => {
    const keyed = (provider: "anthropic" | "openai" | "openrouter", e2eModel?: string) => agentRouteSummary(available({ provider, secretArn: SECRET_ARN, region: "us-east-1", ...(e2eModel === undefined ? {} : { e2eModel }) }));
    expect(keyed("anthropic")).toBe("AI navigation: Anthropic `claude-haiku-5-5` (Rovara's recommendation); at most 8 actions per step; checks decide");
    expect(keyed("anthropic", "claude-haiku-4-5")).toBe("AI navigation: Anthropic `claude-haiku-4-5` (your choice); at most 8 actions per step; checks decide");
    for (const text of [keyed("openai"), keyed("openrouter"), keyed("openai", "gpt-5.4")]) {
      expect(text).not.toContain("data centers");
      expect(text).not.toContain("outside the US");
    }
  });

  it("does not mention the request shape", () => {
    expect(agentRouteSummary(available({ ...bedrock, e2eModel: HAIKU_45_US, payloadShape: "minimal" }))).not.toMatch(/minimal|shape/i);
  });
});

describe("the admission reader behind the dispatch check (test 15)", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const referenceFor = (bytes: Buffer): E2EWorkflowAdmissionRef => ({ schemaVersion: 1, taskId: "11111111-1111-4111-8111-111111111111", workflowRevision: 3, candidateDigest: "a".repeat(64),
    roundId: "22222222-2222-4222-8222-222222222222", groupRunIds: ["33333333-3333-4333-8333-333333333333"], kind: "application", agentSteps: true,
    admissionRef: { key: `workflow-e2e-admissions/sha256/${sha(bytes)}.json`, sha256: sha(bytes), byteLength: bytes.byteLength } } as unknown as E2EWorkflowAdmissionRef);
  const s3Returning = (text: string) => ({ send: vi.fn(async () => ({ Body: { transformToString: async () => text } })) });

  const registered = (definition: ReturnType<typeof available>) => {
    const db = new FakeDynamoDb();
    const revision = e2eModelRouteRevision(definition);
    db.set({ ...e2eModelRouteRevisionKey(definition.routeId, definition.revision), entityType: "E2E_MODEL_ROUTE", routeId: definition.routeId, revisionNumber: definition.revision, revision,
      definitionDigest: e2eAgentRouteDefinitionDigest(definition), definition, approvedAt: "2026-10-23T00:00:00.000Z" });
    return { db, route: { routeId: definition.routeId, routeRevision: revision } };
  };
  const answer = async (admission: Record<string, unknown>, db: FakeDynamoDb) => {
    const bytes = Buffer.from(JSON.stringify(admission));
    const reader = createWorkflowE2EAdmissionModelChoiceReader({ s3: s3Returning(bytes.toString("utf8")), bucket: "b", readRow: async (key) => ((await db.send(new GetCommand({ TableName: TABLE, Key: key }))) as { Item?: Record<string, unknown> }).Item });
    return reader(referenceFor(bytes));
  };

  it("says a chosen model or the minimal shape needs the feature, and the recommended default does not", async () => {
    const bedrock = { provider: "amazon-bedrock", region: "us-east-1" } as const;
    const recommended = registered(available(bedrock));
    expect(await answer({ modelRoute: recommended.route }, recommended.db)).toBe(false);
    const chosen = registered(available({ ...bedrock, e2eModel: HAIKU_45_US }));
    expect(await answer({ modelRoute: chosen.route }, chosen.db)).toBe(true);
    const minimal = registered(available({ ...bedrock, payloadShape: "minimal" }));
    expect(await answer({ modelRoute: minimal.route }, minimal.db)).toBe(true);
  });

  it("answers false for an admission that pins no route, and undefined for anything it cannot establish", async () => {
    const empty = new FakeDynamoDb();
    expect(await answer({ modelRoute: null }, empty)).toBe(false);
    // A route the registry does not hold, a malformed route, and bytes that do not match the reference.
    expect(await answer({ modelRoute: { routeId: "rovara-e2e-default", routeRevision: "r1-aaaaaaaaaaaa" } }, empty)).toBeUndefined();
    expect(await answer({ modelRoute: { routeId: 4 } }, empty)).toBeUndefined();
    expect(await answer({}, empty)).toBeUndefined();
    const bytes = Buffer.from(JSON.stringify({ modelRoute: null }));
    const mismatched = createWorkflowE2EAdmissionModelChoiceReader({ s3: s3Returning(JSON.stringify({ modelRoute: null, extra: 1 })), bucket: "b", readRow: async () => undefined });
    expect(await mismatched(referenceFor(bytes))).toBeUndefined();
  });
});
