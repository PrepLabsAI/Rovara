// B5, B6, B8, #57 and #58 in the gateway stack: made only with -c rovaraModelGatewayProductAi=on. Off, the template is byte for byte
// the one before this change, plus DEC 328's exact install-setting read. On: the product key table with its own KMS key (only Cloud's settings role seals, only the gateway's
// serving role opens, bound to this install and the six context keys), an HMAC key for fingerprints, the product and learning
// meters' tables, the shared eval stage table, the Vertex federation role, and the serving role's exact grants. The deploy role's
// actions for the new resources are simulated against the agentx deploy role and its default permission boundary.
import { createHash } from "node:crypto";
import { withoutRoleBoundary } from "../support/without-role-boundary.js";
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GATEWAY_ANSWERS_ENV, GATEWAY_ENV, GATEWAY_EVAL_STAGE_INDEXES, GATEWAY_LEARNING_ENV, GATEWAY_PRODUCT_ENV, GATEWAY_PRODUCT_TTL_ATTRIBUTE, PRODUCT_KEY_PURPOSE as GATEWAY_PURPOSE, PRODUCT_KEYS_TTL_ATTRIBUTE, productKeyContext } from "../../packages/model-gateway/src/index.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { AI_SOURCE_KINDS_CONTEXT_KEY, productAiOn } from "../../infra/lib/model-gateway-app.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_EVAL_STAGE_INDEXES, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, PRODUCT_KEY_CONTEXT_KEYS, PRODUCT_KEY_PURPOSE } from "../../infra/lib/model-gateway.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>>; Principal?: unknown };

const synth = (context: Record<string, string>) => Template.fromStack(buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2", ...context }).node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource>; Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
/** The gateway template (staging) in Rovara Cloud at d7d1edbb8, before this change (rule description reworded for EC2, 2026-11-16): SHA-256 of its JSON, less the role boundary (2026-11-17). Re-pinned 2026-11-17 for the alarm topic allow, fixed alarm names and the PricesStale math alarm. Re-pinned for the common customer-source overage alarm filter and description (controller round B, DEC 254zzz253). */
const BEFORE_SHA256 = "19c9c5ae6200f2ad0f9bc8c30c8241b4918300bbc3095714d8c8165bde7fc06f";
// The pin is the fixed-name template (the one deployed before generated provider secret names became the default).
const off = synth({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" });
const on = synth({ [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" });
const openRouterOn = synth({ [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on", [AI_SOURCE_KINDS_CONTEXT_KEY]: "openrouter" });
const ofType = (t: { Resources: Record<string, Resource> }, type: string) => Object.entries(t.Resources).filter(([, r]) => r.Type === type);
const idStarting = (type: string, prefix: string) => ofType(on, type).find(([id]) => id.startsWith(prefix))![0];
const arnOf = (id: string) => ({ "Fn::GetAtt": [id, "Arn"] });
const serveRole = idStarting("AWS::IAM::Role", "ServeTaskRole");
const serveStatements = (t = on): Statement[] => ofType(t, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(`"${serveRole}"`)).flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const bySid = () => Object.fromEntries(serveStatements().map((s) => [s.Sid ?? "", s]));
const table = (prefix: string) => idStarting("AWS::DynamoDB::GlobalTable", prefix);
const companyKeysOnly = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } };
const issuer = { "Fn::Join": ["", [{ Ref: "CodeUrl" }, "/v1/auth"]] };
const installRead = {
  Sid: "ReadInstallRovaraAi", Effect: "Allow", Action: "dynamodb:GetItem",
  Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-west-2:", { Ref: "AWS::AccountId" }, ":table/", { Ref: "CompanyTableName" }]] },
  Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["INSTALL#ROVARA_AI"] }, Null: { "dynamodb:LeadingKeys": "false" } },
};

describe("off unless configured", () => {
  it("adds only the exact install read to the pinned gateway template, and refuses any switch value but on", () => {
    const beforeInstallRead = withoutRoleBoundary(off);
    expect(serveStatements(beforeInstallRead).filter(s => s.Sid === "ReadInstallRovaraAi")).toEqual([installRead]);
    for (const [, policy] of ofType(beforeInstallRead, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(`"${serveRole}"`))) {
      const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
      document.Statement = document.Statement.filter(s => s.Sid !== "ReadInstallRovaraAi");
    }
    // Keep the historical hash: every other resource, statement and action must be unchanged.
    expect(createHash("sha256").update(JSON.stringify(beforeInstallRead)).digest("hex")).toBe(BEFORE_SHA256);
    expect(productAiOn(undefined, "x")).toBe(false);
    expect(productAiOn("on", "x")).toBe(true);
    for (const bad of ["true", "1", "off", "", true]) expect(() => productAiOn(bad, "x")).toThrow(/must be "on" or absent/u);
    expect(() => synth({ [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "yes" })).toThrow(/must be "on" or absent/u);
    // Rovara-cloud#247: production's gateway carries product AI too (its engine's models come through Rovara's AI, which needs it).
    const production = Template.fromStack(buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "production", agentxRegion: "us-east-1", [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on", rovaraAiSourceKinds: "openai" }).node.findChild("RovaraModelGateway") as Stack).toJSON() as { Parameters: Record<string, unknown> };
    expect(production.Parameters).toHaveProperty("CloudSettingsRoleArn");
  });
  it("adds the OpenRouter over-reservation alarm and metric filter when OpenRouter is configured", () => {
    const resources = openRouterOn.Resources;
    const alarm = Object.values(resources).find((resource) => resource.Type === "AWS::CloudWatch::Alarm" && JSON.stringify(resource.Properties).includes("OpenRouterOverReservation"));
    const filter = Object.values(resources).find((resource) => resource.Type === "AWS::Logs::MetricFilter" && JSON.stringify(resource.Properties).includes("openrouter_over_reservation"));

    expect(alarm?.Type).toBe("AWS::CloudWatch::Alarm");
    expect(filter?.Type).toBe("AWS::Logs::MetricFilter");
  });
  it("repeats the process's literals (deploy.ts, product-seal.ts)", () => {
    expect(MODEL_GATEWAY_EVAL_STAGE_INDEXES).toEqual(GATEWAY_EVAL_STAGE_INDEXES);
    expect(PRODUCT_KEY_PURPOSE).toBe(GATEWAY_PURPOSE);
    expect(PRODUCT_KEYS_TTL_ATTRIBUTE).toBe(GATEWAY_PRODUCT_TTL_ATTRIBUTE);
    expect([...PRODUCT_KEY_CONTEXT_KEYS].sort()).toEqual(Object.keys(productKeyContext({ iss: "i", cid: "c", owner: "o", sourceId: "s", versionId: "v" })).sort());
  });
});

describe("on: tables", () => {
  it("adds eleven tables, all retained, deletion-protected and recoverable, with company keys; TTL only where rows expire", () => {
    const added = ofType(on, "AWS::DynamoDB::GlobalTable").map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).filter((id) => !["Ledger", "Markers", "Meter", "Prices"].includes(id)).sort();
    expect(added).toEqual(["AnswersLedger", "AnswersMarkers", "AnswersMeter", "EvalStages", "LearningLedger", "LearningMarkers", "LearningMeter", "ProductKeys", "ProductLedger", "ProductMarkers", "ProductMeter"]);
    for (const name of added) {
      const r = on.Resources[table(name)]!;
      expect(r.DeletionPolicy).toBe("Retain");
      expect(r.Properties.Replicas).toEqual([expect.objectContaining({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })]);
      const ttl = ["AnswersMarkers", "EvalStages", "LearningMarkers", "ProductKeys", "ProductMarkers"].includes(name);
      expect(r.Properties.TimeToLiveSpecification).toEqual(ttl ? { AttributeName: GATEWAY_PRODUCT_TTL_ATTRIBUTE, Enabled: true } : undefined);
    }
    const indexes = (name: string) => ((on.Resources[table(name)]!.Properties.GlobalSecondaryIndexes ?? []) as Array<{ IndexName: string }>).map((i) => i.IndexName).sort();
    expect(indexes("EvalStages")).toEqual(["due-stages"]);
    expect(indexes("ProductLedger")).toEqual(["pending-by-age", "pending-by-key"]);
    expect(indexes("ProductMeter")).toEqual(["open-holds"]);
    expect(indexes("ProductKeys")).toEqual([]);
  });
});

describe("on: keys", () => {
  const keyPolicy = (prefix: string) => ((on.Resources[idStarting("AWS::KMS::Key", prefix)]!.Properties.KeyPolicy as { Statement: Statement[] }).Statement);
  const sealedRow = {
    StringEquals: { "kms:EncryptionContext:purpose": "rovara-product-ai-key", "kms:EncryptionContext:install": issuer },
    "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["purpose", "install", "company", "owner", "source", "version"] },
    Null: { "kms:EncryptionContext:company": "false", "kms:EncryptionContext:owner": "false", "kms:EncryptionContext:source": "false", "kms:EncryptionContext:version": "false" },
  };
  it("the product key key: only the serving role opens, only Cloud's settings role seals, never Encrypt or a grant", () => {
    const statements = keyPolicy("ProductKeysKey");
    expect(statements.map((s) => s.Sid)).toEqual(["AccountManagesNotUses", "OnlyGatewayOpens", "OnlySettingsSeals"]);
    expect(statements[1]).toEqual({ Sid: "OnlyGatewayOpens", Effect: "Allow", Principal: { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }, Action: "kms:Decrypt", Resource: "*", Condition: { ...sealedRow, ArnEquals: { "aws:PrincipalArn": arnOf(serveRole) } } });
    expect(statements[2]).toEqual({ Sid: "OnlySettingsSeals", Effect: "Allow", Principal: statements[1]!.Principal, Action: "kms:GenerateDataKey", Resource: "*", Condition: { ...sealedRow, ArnEquals: { "aws:PrincipalArn": { Ref: "CloudSettingsRoleArn" } } } });
    const managed = [statements[0]!.Action].flat();
    for (const use of ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:ReEncrypt*", "kms:CreateGrant", "kms:*"]) expect(managed).not.toContain(use);
    expect(on.Resources[idStarting("AWS::KMS::Key", "ProductKeysKey")]!.Properties.EnableKeyRotation).toBe(true);
    expect(on.Parameters.CloudSettingsRoleArn).toMatchObject({ Type: "String", AllowedPattern: "^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$" });
  });
  it("the fingerprint key: HMAC, only Cloud's settings role makes MACs, only the serving role verifies them (Cloud's signed calls)", () => {
    const r = on.Resources[idStarting("AWS::KMS::Key", "ProductKeysMacKey")]!;
    expect(r.Properties).toMatchObject({ KeySpec: "HMAC_256", KeyUsage: "GENERATE_VERIFY_MAC" });
    const statements = keyPolicy("ProductKeysMacKey");
    expect(statements.map((s) => s.Sid)).toEqual(["AccountManagesNotUses", "OnlySettingsFingerprints", "OnlyGatewayVerifiesCalls"]);
    expect(statements[1]).toMatchObject({ Action: "kms:GenerateMac", Resource: "*", Condition: { ArnEquals: { "aws:PrincipalArn": { Ref: "CloudSettingsRoleArn" } } } });
    // PRODUCT-VERTEX-CLOUD-CONNECT: VerifyMac only, only the serving role (never GenerateMac: the gateway can't sign a call).
    expect(statements[2]).toEqual({ Sid: "OnlyGatewayVerifiesCalls", Effect: "Allow", Principal: statements[1]!.Principal, Action: "kms:VerifyMac", Resource: "*", Condition: { ArnEquals: { "aws:PrincipalArn": arnOf(serveRole) } } });
  });
});

describe("on: the serving role's grants (exact)", () => {
  it("pins every new statement: tables, indexes, key and federation role, company keys on every item grant", () => {
    const s = bySid();
    expect(s.ReadInstallRovaraAi).toEqual(installRead);
    // Product AI must preserve every base grant, including its exact actions and conditions.
    for (const statement of serveStatements(off)) expect(s[statement.Sid!]).toEqual(statement);
    expect(s.ProductKeysCompanyKeys).toEqual({ Sid: "ProductKeysCompanyKeys", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: arnOf(table("ProductKeys")), Condition: companyKeysOnly });
    expect(s.ProductAndLearningMeterCompanyKeys).toEqual({ Sid: "ProductAndLearningMeterCompanyKeys", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource: ["ProductMeter", "ProductLedger", "LearningMeter", "LearningLedger", "AnswersMeter", "AnswersLedger"].map((n) => arnOf(table(n))), Condition: companyKeysOnly });
    expect(s.ProductAndLearningMarkersCompanyKeys).toEqual({ Sid: "ProductAndLearningMarkersCompanyKeys", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:DeleteItem"], Resource: ["ProductMarkers", "LearningMarkers", "AnswersMarkers"].map((n) => arnOf(table(n))), Condition: companyKeysOnly });
    expect(s.EvalStagesCompanyKeys).toEqual({ Sid: "EvalStagesCompanyKeys", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: arnOf(table("EvalStages")), Condition: companyKeysOnly });
    const index = (name: string, idx: string) => ({ "Fn::Join": ["", [arnOf(table(name)), `/index/${idx}`]] });
    expect(s.QueryProductIndexes).toEqual({ Sid: "QueryProductIndexes", Effect: "Allow", Action: "dynamodb:Query", Resource: [
      index("ProductLedger", "pending-by-key"), index("ProductLedger", "pending-by-age"), index("LearningLedger", "pending-by-key"), index("LearningLedger", "pending-by-age"), index("AnswersLedger", "pending-by-key"), index("AnswersLedger", "pending-by-age"),
      index("ProductMeter", "open-holds"), index("LearningMeter", "open-holds"), index("AnswersMeter", "open-holds"), index("EvalStages", "due-stages"),
    ] });
    expect(s.OpenProductKeys).toEqual({ Sid: "OpenProductKeys", Effect: "Allow", Action: "kms:Decrypt", Resource: arnOf(idStarting("AWS::KMS::Key", "ProductKeysKey")), Condition: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-product-ai-key", "kms:EncryptionContext:install": issuer } } });
    expect(s.VerifyCloudCalls).toEqual({ Sid: "VerifyCloudCalls", Effect: "Allow", Action: "kms:VerifyMac", Resource: arnOf(idStarting("AWS::KMS::Key", "ProductKeysMacKey")) });
    expect(s.AssumeVertexFederation).toEqual({ Sid: "AssumeVertexFederation", Effect: "Allow", Action: "sts:AssumeRole", Resource: arnOf(idStarting("AWS::IAM::Role", "VertexFederationRole")), Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } });
    // Bring-your-own Bedrock (DEC 254zzz520, always with product AI): exactly two more statements, pinned in model-gateway-bedrock-byo-infra.test.ts.
    expect(s.AssumeBedrockBroker).toMatchObject({ Action: "sts:AssumeRole", Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } });
    expect(s.MakeBedrockExternalIds).toMatchObject({ Action: "kms:GenerateMac", Resource: arnOf(idStarting("AWS::KMS::Key", "BedrockExternalIdKey")) });
    // Nothing else was added, and the agent grants are unchanged.
    expect(serveStatements().map(statement => statement.Sid).sort()).toEqual(["AssumeBedrockBroker", "AssumeVertexFederation", "DecryptProviderKeys", "EvalStagesCompanyKeys", "MakeBedrockExternalIds", "MarkersCompanyKeys", "MeterAndLedgerCompanyKeys", "OpenProductKeys", "ProductAndLearningMarkersCompanyKeys", "ProductAndLearningMeterCompanyKeys", "ProductKeysCompanyKeys", "QueryOpenHolds", "QueryPendingCorrections", "QueryProductIndexes", "ReadCompanyBudgets", "ReadInstallRovaraAi", "ReadPrices", "ReadProviderKeys", "VerifyCloudCalls"]);
    // No DeleteItem on any money table, the key table or the stage table; no GenerateDataKey or Encrypt for the gateway.
    const all = serveStatements();
    for (const st of all.filter((x) => [x.Action].flat().includes("dynamodb:DeleteItem"))) expect(JSON.stringify(st.Resource)).not.toMatch(/ProductKeys|EvalStages|Meter|Ledger/u);
    // GenerateMac is the Bedrock external-id key's alone (the gateway never makes MACs with any other key).
    expect(JSON.stringify(all.filter((x) => x.Sid !== "MakeBedrockExternalIds"))).not.toMatch(/"kms:GenerateDataKey|"kms:Encrypt"|"kms:GenerateMac"|"sts:\*"|"\*:\*"/u);
  });
  it("the Vertex federation role: no permissions at all; its trust names only the serving role, with a company session name", () => {
    const role = idStarting("AWS::IAM::Role", "VertexFederationRole");
    const r = on.Resources[role]!;
    expect(r.Properties.AssumeRolePolicyDocument).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: arnOf(serveRole) }, Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } }] });
    expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    expect(r.Properties.Policies).toBeUndefined();
    expect(r.Properties.MaxSessionDuration).toBe(3600);
    expect(ofType(on, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(`"${role}"`))).toEqual([]);
  });
  it("gives the serving task every product and learning setting, and the price job none", () => {
    const env = (task: string) => Object.fromEntries(((on.Resources[idStarting("AWS::ECS::TaskDefinition", task)]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!.Environment).map((e) => [e.Name, e.Value]));
    const serve = env("ServeTask");
    for (const name of [...GATEWAY_PRODUCT_ENV, ...GATEWAY_LEARNING_ENV, ...GATEWAY_ANSWERS_ENV, GATEWAY_ENV.vertexFederationRole]) expect(serve[name]).toBeDefined();
    expect(serve[GATEWAY_ENV.productKeysKey]).toEqual(arnOf(idStarting("AWS::KMS::Key", "ProductKeysKey")));
    expect(serve[GATEWAY_ENV.vertexFederationRole]).toEqual(arnOf(idStarting("AWS::IAM::Role", "VertexFederationRole")));
    expect(serve[GATEWAY_ENV.productMacKey]).toEqual(arnOf(idStarting("AWS::KMS::Key", "ProductKeysMacKey")));
    // DEC 236: with the company key store deployed, the agent route sends only each company's own key.
    expect(serve[GATEWAY_ENV.agentKeys]).toBe("company");
    expect(Object.keys(env("PriceFetchTask")).sort()).toEqual([GATEWAY_ENV.mode, GATEWAY_ENV.pricesTable, "NODE_OPTIONS"].sort());
    expect(Object.keys(on.Outputs)).toEqual(expect.arrayContaining(["ProductKeysTableName", "ProductKeysKeyArn", "ProductKeysMacKeyArn", "VertexFederationRoleArn"]));
  });
});

// ---- the deploy role and its permission boundary -------------------------------------------------------------------------
/** A small IAM evaluator: explicit Deny wins; an Allow needs a matching action and resource. Conditions on an Allow are taken as met
 * (a ceiling check); a Deny's condition is evaluated for the one key the deploy role's Deny statements use (iam:PermissionsBoundary). */
// The offline simulation of Cloud's agentx deploy role and boundary (Cloud's contracts access-policies.ts) stays in Rovara Cloud with
// those contracts; Code's access-policies describe Code's own roles (#1478).
