import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/protocol.js";
import {
  E2E_MODEL_ROUTE,
  evaluateTestDeployCheck,
  findingLabel,
  formatFindings,
  lambdaRoleIds,
  parseDeployedCodeKey,
  parseRunnerStatus,
  sourcePathsFor,
  tier3Request,
  type CatalogRowFact,
  type CheckInput,
  type E2EModelRoute,
  type Finding,
  type ModelRouteCheck,
  type RunnerFacts,
} from "../../scripts/test-deploy-check.js";
import { DeployCheckFindingsError, assertCheckAllowsApply, checkExitCode, checkReport, gatherCheckFacts, main, parseTestDeployArgs, type CfnTemplate } from "../../scripts/test-deploy.js";

const NOW = new Date("2026-10-20T18:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const ARN = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:parameter/agentx/agentxlivetest123/${name}`]] });

const SESSIONS_POLICY = "SessionsStepsServiceRoleDefaultPolicy9F4B87C9";
const BROKER_POLICY = "BrokerServiceRoleDefaultPolicyDDFD9E7E";
const NOTIFIER = "DeveloperTaskNotifierFunction551419CC";

const settings = ["worker-image", "model-id", "model-provider"].map(ARN);
const executorImage = ARN("worker-executor-image");

interface Statement {
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}
const lambda = (roleId: string) => ({ Type: "AWS::Lambda::Function", Properties: { Role: { "Fn::GetAtt": [roleId, "Arn"] }, Code: { S3Bucket: { Ref: "AssetParametersAAAS3Bucket" }, S3Key: "x" } } });
const role = { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: {} } };
const policy = (roleId: string, statements: Statement[]) => ({
  Type: "AWS::IAM::Policy",
  Properties: { PolicyName: `${roleId}Policy`, Roles: [{ Ref: roleId }], PolicyDocument: { Version: "2012-10-17", Statement: statements } },
});

interface Variant {
  sessionsSsm?: unknown[];
  brokerOrder?: "head" | "deployed";
  assetHash?: string;
}
/** A control-plane template reduced to what the check reads: three Lambdas, their roles and their default policies. */
function template(variant: Variant = {}): CfnTemplate {
  const brokerStatements: Statement[] = [
    { Effect: "Allow", Action: ["dynamodb:ConditionCheckItem", "dynamodb:GetItem"], Resource: { "Fn::GetAtt": ["DeveloperSignInTable", "Arn"] } },
    { Effect: "Allow", Action: "ssm:GetParameters", Resource: settings },
    { Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["Artifacts", "Arn"] }, "/*"]] } },
  ];
  const ordered = variant.brokerOrder === "deployed" ? [...brokerStatements].reverse() : brokerStatements;
  return {
    Resources: {
      SessionsSteps3B98DD2B: lambda("SessionsStepsServiceRole5DDD9E37"),
      [NOTIFIER]: lambda("DeveloperTaskNotifierServiceRoleAB12CD34"),
      BrokerE1355FD6: lambda("BrokerServiceRole1938BCC9"),
      SessionsStepsServiceRole5DDD9E37: role,
      DeveloperTaskNotifierServiceRoleAB12CD34: role,
      BrokerServiceRole1938BCC9: role,
      [SESSIONS_POLICY]: policy("SessionsStepsServiceRole5DDD9E37", [
        { Effect: "Allow", Action: "ec2:RunInstances", Resource: "*" },
        { Effect: "Allow", Action: "ssm:GetParameters", Resource: variant.sessionsSsm ?? settings },
      ]),
      DeveloperTaskNotifierServiceRoleDefaultPolicyAB12CD35: policy("DeveloperTaskNotifierServiceRoleAB12CD34", [
        { Effect: "Allow", Action: "dynamodb:Query", Resource: { "Fn::GetAtt": ["DeveloperSignInTable", "Arn"] } },
      ]),
      [BROKER_POLICY]: policy("BrokerServiceRole1938BCC9", ordered),
      ...(variant.assetHash === undefined ? {} : { AssetBound: { Type: "AWS::Lambda::Function", Properties: { Role: { "Fn::GetAtt": ["BrokerServiceRole1938BCC9", "Arn"] }, Code: { S3Bucket: { Ref: `AssetParameters${variant.assetHash}S3Bucket` } } } } }),
    },
  };
}

const SHAS = { SessionsSteps3B98DD2B: "c2Vzc2lvbnM=", [NOTIFIER]: "bm90aWZpZXI=", BrokerE1355FD6: "YnJva2Vy" };
const hexOf = (base64: string) => Buffer.from(base64, "base64").toString("hex");
const keyFor = (logicalId: string, revision: string, base64: string) => `test-deploy/${revision}/${logicalId}-${hexOf(base64)}.zip`;
/** A copy of `source` whose Lambda `logicalId` reads its code from `S3Key`. */
function withKey(source: CfnTemplate, logicalId: string, S3Key: string): CfnTemplate {
  const copy = JSON.parse(JSON.stringify(source)) as CfnTemplate;
  (copy.Resources?.[logicalId]?.Properties?.Code as { S3Key: string }).S3Key = S3Key;
  return copy;
}
/** A copy of `source` whose Lambda `logicalId` has exactly these environment variables. */
function withEnvironment(source: CfnTemplate, logicalId: string, names: readonly string[]): CfnTemplate {
  const copy = JSON.parse(JSON.stringify(source)) as CfnTemplate;
  const properties = copy.Resources?.[logicalId]?.Properties;
  if (properties) properties.Environment = { Variables: Object.fromEntries(names.map((name) => [name, `value-of-${name}`])) };
  return copy;
}
const AGENT_FEATURE = "task.workflowE2EAgentSteps.v1";
const READY_FEATURES = [...WORKER_INVOCATION_FEATURES, AGENT_FEATURE];
const GOOD_RUNNER: RunnerFacts = {
  deployedExecutorImage: `123.dkr.ecr.us-east-1.amazonaws.com/x/executor@sha256:${"a".repeat(64)}`,
  executorImage: `123.dkr.ecr.us-east-1.amazonaws.com/x/executor@sha256:${"a".repeat(64)}`,
  invocationFeatures: READY_FEATURES,
};
const rows = (overrides: Partial<CatalogRowFact>[] = [{}, {}]): CatalogRowFact[] =>
  (["web", "api"] as const).map((kind, index) => ({ sk: `PROFILE#linux-arm64-web-api-v1#${kind}`, state: "READY", expiresAt: hoursFromNow(24 * 30), ...overrides[index] }));

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    headTemplate: template(),
    deployedTemplate: template(),
    lambdaCodeShas: SHAS,
    builtZipShas: SHAS,
    catalogRows: rows(),
    runnerFacts: GOOD_RUNNER,
    now: NOW,
    ...overrides,
  };
}
const kinds = (findings: readonly Finding[]) => findings.map((finding) => finding.kind);

describe("evaluateTestDeployCheck", () => {
  it("passes when head, deployed code, catalog and runner all agree", () => {
    expect(evaluateTestDeployCheck(input())).toEqual({ ok: true, findings: [] });
  });

  it("finds the live M1.2 SessionsSteps drift: exactly one iam-missing-grant naming its policy", () => {
    const result = evaluateTestDeployCheck(input({ headTemplate: template({ sessionsSsm: [...settings, executorImage] }), deployedTemplate: template() }));
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({
      kind: "iam-missing-grant",
      severity: "error",
      policyLogicalId: SESSIONS_POLICY,
      roleLogicalId: "SessionsStepsServiceRole5DDD9E37",
      label: "SessionsSteps",
    });
    // The statement a Tier 3 request needs: only what the deployed policy lacks.
    expect(finding?.statements).toEqual([{ Effect: "Allow", Action: "ssm:GetParameters", Resource: [executorImage] }]);
  });

  it("finds a stale notifier: the 2026-10-14 code against a newer head build gives stale-lambda for DeveloperTaskNotifier only", () => {
    const result = evaluateTestDeployCheck(input({ lambdaCodeShas: { ...SHAS, [NOTIFIER]: "MjAyNi0xMC0xNA==" } }));
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "stale-lambda", severity: "error", subject: NOTIFIER, label: "DeveloperTaskNotifier" });
  });

  it("checks every built Lambda, and a Lambda with no deployed code hash is stale too", () => {
    const { BrokerE1355FD6: _gone, ...withoutBroker } = SHAS;
    void _gone;
    const result = evaluateTestDeployCheck(input({ lambdaCodeShas: withoutBroker }));
    expect(result.findings.map((finding) => [finding.kind, finding.subject])).toEqual([["stale-lambda", "BrokerE1355FD6"]]);
  });

  it("ignores statement and action order: the Broker ConditionCheckItem move gives no finding", () => {
    const reordered = template({ brokerOrder: "deployed" });
    const swapped = template();
    (swapped.Resources?.[BROKER_POLICY]?.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement[0] = { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"], Resource: { "Fn::GetAtt": ["DeveloperSignInTable", "Arn"] } };
    expect(evaluateTestDeployCheck(input({ headTemplate: swapped, deployedTemplate: reordered }))).toEqual({ ok: true, findings: [] });
  });

  it("ignores the asset parameter names and the version hashes the audit normalized", () => {
    const result = evaluateTestDeployCheck(input({ headTemplate: template({ assetHash: "a".repeat(64) }), deployedTemplate: template({ assetHash: "b".repeat(64) }) }));
    expect(result).toEqual({ ok: true, findings: [] });
    const versioned = (hash: string) => {
      const copy = template();
      const policyBody = copy.Resources?.[BROKER_POLICY]?.Properties as { PolicyDocument: { Statement: Statement[] } };
      policyBody.PolicyDocument.Statement.push({ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { Ref: `TaskPersonProofFunctionCurrentVersion${hash}` } });
      return copy;
    };
    expect(evaluateTestDeployCheck(input({ headTemplate: versioned("A".repeat(40)), deployedTemplate: versioned("B".repeat(40)) }))).toEqual({ ok: true, findings: [] });
    // As live TEST spells it: 40 hex characters, upper case then lower case.
    expect(evaluateTestDeployCheck(input({ headTemplate: versioned("5D5638F1f9693dcd2f6b905cf5c9ff00caecf6fd"), deployedTemplate: versioned("5D5638F12cf3052718f41061830d4c3263592027") }))).toEqual({ ok: true, findings: [] });
  });

  it("matches a grant by its condition: the same action under a narrower condition is not the deployed grant", () => {
    const head = template();
    const deployed = template();
    const grant = (condition: unknown): Statement => ({ Effect: "Allow", Action: "iam:PassRole", Resource: "*", Condition: condition });
    (head.Resources?.[SESSIONS_POLICY]?.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement.push(grant({ StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } }));
    (deployed.Resources?.[SESSIONS_POLICY]?.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement.push(grant({ StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } }));
    const result = evaluateTestDeployCheck(input({ headTemplate: head, deployedTemplate: deployed }));
    expect(kinds(result.findings).sort()).toEqual(["iam-extra-grant", "iam-missing-grant"]);
  });

  it("reports a head policy the deployed role lacks entirely, whole", () => {
    const deployed = template();
    delete deployed.Resources?.DeveloperTaskNotifierServiceRoleDefaultPolicyAB12CD35;
    const result = evaluateTestDeployCheck(input({ deployedTemplate: deployed }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "iam-missing-grant", label: "DeveloperTaskNotifier", policyLogicalId: "DeveloperTaskNotifierServiceRoleDefaultPolicyAB12CD35" });
  });

  it("treats a grant that exists only in the deployed policy as a warning, never a failure", () => {
    const result = evaluateTestDeployCheck(input({ headTemplate: template(), deployedTemplate: template({ sessionsSsm: [...settings, executorImage] }) }));
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "iam-extra-grant", severity: "warning", policyLogicalId: SESSIONS_POLICY });
  });

  it("flags a catalog row that expires within 24 hours, and not one that expires after", () => {
    const soon = evaluateTestDeployCheck(input({ catalogRows: rows([{ expiresAt: hoursFromNow(23) }, {}]) }));
    expect(soon.ok).toBe(false);
    expect(soon.findings.map((finding) => [finding.kind, finding.subject])).toEqual([["catalog-expiring", "PROFILE#linux-arm64-web-api-v1#web"]]);
    expect(evaluateTestDeployCheck(input({ catalogRows: rows([{ expiresAt: hoursFromNow(25) }, {}]) })).ok).toBe(true);
    // Already expired is expiring too.
    expect(kinds(evaluateTestDeployCheck(input({ catalogRows: rows([{}, { expiresAt: hoursFromNow(-2) }]) })).findings)).toEqual(["catalog-expiring"]);
  });

  it("flags a catalog row that is not READY, and a kind with no row at all", () => {
    const parked = evaluateTestDeployCheck(input({ catalogRows: rows([{}, { state: "PARKED" }]) }));
    expect(parked.findings.map((finding) => [finding.kind, finding.subject])).toEqual([["catalog-not-ready", "PROFILE#linux-arm64-web-api-v1#api"]]);
    const missing = evaluateTestDeployCheck(input({ catalogRows: rows().slice(0, 1) }));
    expect(missing.findings.map((finding) => [finding.kind, finding.subject])).toEqual([["catalog-not-ready", "#api"]]);
    // Only the web and api rows of the profile are looked at.
    expect(evaluateTestDeployCheck(input({ catalogRows: [...rows(), { sk: "PROFILE#linux-arm64-web-api-v1", state: "UNAVAILABLE", expiresAt: hoursFromNow(-1) }] })).ok).toBe(true);
  });

  it("flags a runner whose executor image digest is not the deployed ExecutorImageUri", () => {
    const other = `123.dkr.ecr.us-east-1.amazonaws.com/x/executor@sha256:${"b".repeat(64)}`;
    const result = evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, executorImage: other } }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "runner-image-mismatch", severity: "error" });
    // The same digest from another registry spelling is the same image.
    expect(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, executorImage: `other.example/exec@sha256:${"a".repeat(64)}` } })).ok).toBe(true);
  });

  it("flags a runner that reports no executor image or no deployed ExecutorImageUri to compare", () => {
    expect(kinds(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, executorImage: undefined } })).findings)).toEqual(["runner-image-mismatch"]);
    expect(kinds(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, deployedExecutorImage: undefined } })).findings)).toEqual(["runner-image-mismatch"]);
    expect(kinds(evaluateTestDeployCheck(input({ runnerFacts: undefined })).findings)).toEqual(["runner-image-mismatch", "worker-feature-missing"]);
  });

  it("flags the feature strings this head needs and the running worker's /ping lacks", () => {
    const lacking = READY_FEATURES.filter((feature) => feature !== "task.workflowE2EApplicationChecks");
    const result = evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: lacking } }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "worker-feature-missing", severity: "error", missing: ["task.workflowE2EApplicationChecks"] });
    // Extra features the worker has beyond this head are fine, and the needed set can be given.
    expect(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: [...READY_FEATURES, "task.future"] } })).ok).toBe(true);
    expect(kinds(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: READY_FEATURES, requiredFeatures: [...READY_FEATURES, "task.m13"] } })).findings)).toEqual(["worker-feature-missing"]);
  });

  it("flags a runner that never reported its features", () => {
    const { invocationFeatures: _features, ...unreported } = GOOD_RUNNER;
    void _features;
    expect(kinds(evaluateTestDeployCheck(input({ runnerFacts: unreported })).findings)).toEqual(["worker-feature-missing"]);
  });
});

describe("the agent feature", () => {
  it("is needed by head: a running worker whose /ping lacks task.workflowE2EAgentSteps.v1 gives worker-feature-missing", () => {
    const withoutAgent = READY_FEATURES.filter((feature) => feature !== AGENT_FEATURE);
    const result = evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: withoutAgent } }));
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "worker-feature-missing", severity: "error", subject: "runner", missing: [AGENT_FEATURE] });
    expect(result.findings[0]?.message).toContain(AGENT_FEATURE);
  });

  it("is a plain feature string: a worker that lists it passes, and it is never listed twice as missing", () => {
    expect(evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: READY_FEATURES } })).ok).toBe(true);
    const lacking = evaluateTestDeployCheck(input({ runnerFacts: { ...GOOD_RUNNER, invocationFeatures: [] } })).findings[0];
    expect(lacking?.missing?.filter((feature) => feature === AGENT_FEATURE)).toHaveLength(1);
  });
});

describe("the e2e model route", () => {
  const MODEL = "us.anthropic.claude-haiku-5-5";
  const ACCOUNT = "123456789012";
  const PROFILE_ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/${MODEL}`;
  const MODEL_ARNS = ["us-east-1", "us-east-2", "us-west-2"].map((region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-5-5`);
  const WORKER_ROLE = "Ec2WorkersInstanceRole5F1A2B3C";
  const WORKER_POLICY = "Ec2WorkersInstanceRoleDefaultPolicy7D8E9F0A";
  /** The grant infra/lib/ec2-workers.ts declares, as CDK emits it. */
  const BEDROCK_SID = {
    Sid: "BedrockModelInvocation",
    Effect: "Allow",
    Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    Resource: [
      { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":bedrock:*::foundation-model/*"]] },
      { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":bedrock:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":*"]] },
    ],
  };
  const foundation = (statements: unknown[] = [BEDROCK_SID]): CfnTemplate => ({
    Resources: {
      [WORKER_ROLE]: role,
      [WORKER_POLICY]: { Type: "AWS::IAM::Policy", Properties: { PolicyName: "p", Roles: [{ Ref: WORKER_ROLE }], PolicyDocument: { Version: "2012-10-17", Statement: statements } } },
    },
    Outputs: { Ec2WorkerInstanceRoleArn: { Value: { "Fn::GetAtt": [WORKER_ROLE, "Arn"] } } },
  });
  const route = (overrides: Partial<ModelRouteCheck> = {}): ModelRouteCheck => ({
    route: E2E_MODEL_ROUTE,
    approval: { approved: true },
    access: { state: "checked", profileStatus: "ACTIVE", models: [{ modelId: "anthropic.claude-haiku-5-5", authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE", agreementStatus: "AVAILABLE" }] },
    iam: { foundationTemplate: foundation(), roleLogicalId: WORKER_ROLE, resources: [PROFILE_ARN, ...MODEL_ARNS], scope: { partition: "aws", region: "us-east-1", accountId: ACCOUNT } },
    ...overrides,
  });
  const check = (overrides: Partial<ModelRouteCheck> = {}) => evaluateTestDeployCheck(input({ modelRoute: route(overrides) }));

  it("names the pinned Bedrock model of decision D1", () => {
    expect(E2E_MODEL_ROUTE.modelId).toBe(MODEL);
    expect(E2E_MODEL_ROUTE.inferenceProfileArn).toBeNull();
    expect(E2E_MODEL_ROUTE.routeId).not.toBe("");
  });

  it("passes when the model is available and the worker role already grants the route's ARNs (nothing to add)", () => {
    expect(check()).toEqual({ ok: true, findings: [] });
  });

  it("gives model-access-unverified when the route's model is absent from the account's Bedrock listing", () => {
    const result = check({ access: { state: "not-found", detail: "ResourceNotFoundException: the inference profile could not be found" } });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "model-access-unverified", severity: "error", subject: E2E_MODEL_ROUTE.routeId });
    expect(result.findings[0]?.message).toContain(MODEL);
    expect(result.findings[0]?.message).toMatch(/not listed|not available/);
  });

  it("gives model-access-unverified, as unverifiable and never as a pass, when the profile cannot read the listing", () => {
    const result = check({ access: { state: "unverifiable", reason: "AccessDeniedException: not authorized to perform bedrock:GetInferenceProfile" } });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatchObject({ kind: "model-access-unverified", severity: "error" });
    expect(result.findings[0]?.message).toMatch(/unverifiable/);
    expect(result.findings[0]?.message).toContain("bedrock:GetInferenceProfile");
  });

  it("gives model-access-unverified for a listed model the account is not authorized for, or whose profile is not ACTIVE", () => {
    const base = route().access;
    if (base.state !== "checked") throw new Error("fixture");
    const model = base.models[0]!;
    const notAuthorized = check({ access: { ...base, models: [{ ...model, authorizationStatus: "NOT_AUTHORIZED" }] } });
    expect(notAuthorized.findings[0]).toMatchObject({ kind: "model-access-unverified", severity: "error" });
    expect(notAuthorized.findings[0]?.message).toContain("NOT_AUTHORIZED");
    expect(check({ access: { ...base, profileStatus: "INACTIVE" } }).findings[0]?.kind).toBe("model-access-unverified");
    expect(check({ access: { ...base, models: [] } }).findings[0]?.kind).toBe("model-access-unverified");
    expect(check({ access: { ...base, models: [{ ...model, entitlementAvailability: "NOT_AVAILABLE" }] } }).findings[0]?.kind).toBe("model-access-unverified");
    expect(check({ access: { ...base, models: [{ ...model, regionAvailability: "NOT_AVAILABLE" }] } }).findings[0]?.kind).toBe("model-access-unverified");
    expect(check({ access: { ...base, models: [{ ...model, agreementStatus: "PENDING" }] } }).findings[0]?.kind).toBe("model-access-unverified");
  });

  it("warns, without failing the check, that the route is not approved (until Task 4.9 makes it an error)", () => {
    const result = check({ approval: { approved: false } });
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "model-route-not-approved", severity: "warning", subject: E2E_MODEL_ROUTE.routeId });
    const unreadable = check({ approval: { unreadable: "AccessDeniedException: dynamodb:Scan" } });
    expect(unreadable.ok).toBe(true);
    expect(unreadable.findings[0]).toMatchObject({ kind: "model-route-not-approved", severity: "warning" });
    expect(unreadable.findings[0]?.message).toContain("dynamodb:Scan");
  });

  it("gives iam-missing-grant naming the worker instance role for an inference-profile ARN outside the granted patterns", () => {
    const outside = "arn:aws:bedrock:us-west-2:210987654321:application-inference-profile/abc123def456";
    const result = check({ iam: { ...route().iam, resources: [outside, ...MODEL_ARNS] } });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "iam-missing-grant", severity: "error", roleLogicalId: WORKER_ROLE, policyLogicalId: WORKER_POLICY, label: "Ec2WorkersInstanceRole",
    });
    expect(result.findings[0]?.message).toContain(outside);
    expect(result.findings[0]?.statements).toEqual([{ Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: [outside] }]);
    expect(tier3Request(result.findings)).toContain(WORKER_ROLE);
  });

  it("needs bedrock:InvokeModel, which also authorizes Converse, and reports only the action a statement lacks", () => {
    const onlyStream = [{ ...BEDROCK_SID, Action: "bedrock:InvokeModelWithResponseStream" }];
    const result = check({ iam: { ...route().iam, foundationTemplate: foundation(onlyStream) } });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.statements).toEqual([{ Effect: "Allow", Action: "bedrock:InvokeModel", Resource: [PROFILE_ARN, ...MODEL_ARNS] }]);
  });

  it("does not count a conditional Allow, a Deny or an unresolvable resource as a grant", () => {
    const conditional = { ...BEDROCK_SID, Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } };
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: foundation([conditional]) } }).findings)).toEqual(["iam-missing-grant"]);
    const denied = foundation([BEDROCK_SID, { Effect: "Deny", Action: "bedrock:InvokeModel", Resource: "*" }]);
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: denied } }).findings)).toEqual(["iam-missing-grant"]);
    const attribute = foundation([{ Effect: "Allow", Action: "bedrock:InvokeModel*", Resource: { "Fn::GetAtt": ["Somewhere", "Arn"] } }]);
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: attribute } }).findings)).toEqual(["iam-missing-grant"]);
  });

  it("never passes on a Deny it cannot judge: a conditional Deny, or one with a resource it cannot resolve, is model-access-unverified", () => {
    const conditionalDeny = foundation([BEDROCK_SID, { Effect: "Deny", Action: "bedrock:InvokeModel", Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": "us-east-1" } } }]);
    const conditional = check({ iam: { ...route().iam, foundationTemplate: conditionalDeny } });
    expect(conditional.ok).toBe(false);
    expect(kinds(conditional.findings)).toEqual(["model-access-unverified"]);
    expect(conditional.findings[0]?.message).toMatch(/unverifiable, which is not a pass/);
    expect(conditional.findings[0]?.message).toContain(PROFILE_ARN);
    const unresolved = foundation([BEDROCK_SID, { Effect: "Deny", Action: "bedrock:*", Resource: { "Fn::GetAtt": ["Somewhere", "Arn"] } }]);
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: unresolved } }).findings)).toEqual(["model-access-unverified"]);
    // A conditional Deny of another service's action cannot block the route.
    const other = foundation([BEDROCK_SID, { Effect: "Deny", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }]);
    expect(check({ iam: { ...route().iam, foundationTemplate: other } })).toEqual({ ok: true, findings: [] });
    // Not granted at all stays a plain iam-missing-grant even when a conditional Deny is also present.
    const none = foundation([{ Effect: "Deny", Action: "bedrock:InvokeModel", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }]);
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: none } }).findings)).toEqual(["iam-missing-grant"]);
  });

  it("evaluates NotAction and NotResource: an Allow covers everything but what it excludes", () => {
    // NotAction excludes only InvokeModel, so it grants the streaming action and leaves InvokeModel missing.
    const notAction = foundation([{ Effect: "Allow", NotAction: "bedrock:InvokeModel", Resource: "*" }]);
    const lacking = check({ iam: { ...route().iam, foundationTemplate: notAction } });
    expect(lacking.findings).toHaveLength(1);
    expect(lacking.findings[0]?.statements).toEqual([{ Effect: "Allow", Action: "bedrock:InvokeModel", Resource: [PROFILE_ARN, ...MODEL_ARNS] }]);
    // NotAction of an unrelated service grants the route's actions.
    expect(check({ iam: { ...route().iam, foundationTemplate: foundation([{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }]) } })).toEqual({ ok: true, findings: [] });
    // NotResource excludes the profile: only the profile lacks the grant.
    const notResource = foundation([{ Effect: "Allow", Action: "bedrock:Invoke*", NotResource: `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/*` }]);
    const excluded = check({ iam: { ...route().iam, foundationTemplate: notResource } });
    expect(excluded.findings).toHaveLength(1);
    expect(excluded.findings[0]?.statements).toEqual([{ Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: [PROFILE_ARN] }]);
    // A Deny with a NotResource that names only the profile blocks the model ARNs definitively.
    const denyOutside = foundation([BEDROCK_SID, { Effect: "Deny", Action: "bedrock:InvokeModel", NotResource: PROFILE_ARN }]);
    expect(check({ iam: { ...route().iam, foundationTemplate: denyOutside } }).findings[0]?.statements).toEqual([{ Effect: "Allow", Action: "bedrock:InvokeModel", Resource: MODEL_ARNS }]);
    // A Deny whose NotResource pattern this cannot resolve cannot be judged.
    const unknownDeny = foundation([BEDROCK_SID, { Effect: "Deny", Action: "bedrock:InvokeModel", NotResource: { "Fn::GetAtt": ["Somewhere", "Arn"] } }]);
    expect(kinds(check({ iam: { ...route().iam, foundationTemplate: unknownDeny } }).findings)).toEqual(["model-access-unverified"]);
  });

  it("matches IAM wildcards in actions and resources, and Fn::Sub spellings", () => {
    const wildcard = foundation([{ Effect: "Allow", Action: "bedrock:Invoke*", Resource: { "Fn::Sub": "arn:${AWS::Partition}:bedrock:*:*:*" } }]);
    expect(check({ iam: { ...route().iam, foundationTemplate: wildcard } })).toEqual({ ok: true, findings: [] });
  });

  it("runs after the other checks and does not disturb them", () => {
    const result = evaluateTestDeployCheck(input({ lambdaCodeShas: { ...SHAS, [NOTIFIER]: "x" }, modelRoute: route({ approval: { approved: false } }) }));
    expect(kinds(result.findings)).toEqual(["stale-lambda", "model-route-not-approved"]);
    expect(formatFindings(result.findings)).toContain("warning model-route-not-approved");
  });
});

describe("stale-lambda: provenance, then currency", () => {
  const REVISION = "0b35a884aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const HEAD = "f00dfeedbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const DEPLOYED_SHA = Buffer.from("2026-10-14".padEnd(32, "x")).toString("base64");
  const OTHER_SHA = Buffer.from("other".padEnd(32, "y")).toString("base64");
  /** The notifier runs code test-deploy uploaded at REVISION; head builds something else. */
  const deployedWithKey = (key = keyFor(NOTIFIER, REVISION, DEPLOYED_SHA)) => withKey(template(), NOTIFIER, key);
  const stale = (overrides: Partial<CheckInput>) => evaluateTestDeployCheck(input({
    deployedTemplate: deployedWithKey(), lambdaCodeShas: { ...SHAS, [NOTIFIER]: DEPLOYED_SHA }, headRevision: HEAD, ...overrides,
  }));

  it("is current when none of the Lambda's inputs changed between the deployed revision and head, though the zips differ", () => {
    expect(stale({ inputsChanged: { [NOTIFIER]: false } })).toEqual({ ok: true, findings: [] });
  });

  it("is stale, naming the revision, when its inputs changed since the deployed revision", () => {
    const result = stale({ inputsChanged: { [NOTIFIER]: true } });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "stale-lambda", severity: "error", subject: NOTIFIER });
    expect(result.findings[0]?.message).toContain(REVISION.slice(0, 12));
    expect(result.findings[0]?.message).toMatch(/changed since/);
  });

  it("is stale when it cannot be told whether its inputs changed (unknown revision, git failure)", () => {
    for (const inputsChanged of [{ [NOTIFIER]: undefined }, {}, undefined]) {
      const result = stale({ inputsChanged });
      expect(result.findings.map((finding) => finding.kind), JSON.stringify(inputsChanged)).toEqual(["stale-lambda"]);
      expect(result.findings[0]?.message).toMatch(/cannot tell/);
    }
  });

  it("is current when the deployed revision is head, even though the zips differ (a build that is not reproducible)", () => {
    const deployed = deployedWithKey(keyFor(NOTIFIER, HEAD, DEPLOYED_SHA));
    expect(stale({ deployedTemplate: deployed })).toEqual({ ok: true, findings: [] });
    // A short revision is the same commit.
    expect(stale({ deployedTemplate: deployedWithKey(keyFor(NOTIFIER, HEAD.slice(0, 9), DEPLOYED_SHA)) })).toEqual({ ok: true, findings: [] });
  });

  it("is current when the head build is the deployed zip, whatever the key says", () => {
    expect(evaluateTestDeployCheck(input({ deployedTemplate: withKey(template(), NOTIFIER, "x"), headRevision: HEAD, inputsChanged: { [NOTIFIER]: true } }))).toEqual({ ok: true, findings: [] });
  });

  it("is stale with unknown provenance when the key's hash is not the running CodeSha256, even if the inputs did not change", () => {
    const result = stale({ deployedTemplate: deployedWithKey(keyFor(NOTIFIER, REVISION, OTHER_SHA)), inputsChanged: { [NOTIFIER]: false } });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "stale-lambda", subject: NOTIFIER });
    expect(result.findings[0]?.message).toMatch(/unknown provenance/);
    // The same when the deployed revision is head: provenance comes first.
    expect(stale({ deployedTemplate: deployedWithKey(keyFor(NOTIFIER, HEAD, OTHER_SHA)) }).findings[0]?.message).toMatch(/unknown provenance/);
  });

  it("is stale with unknown provenance for a key that is not a test-deploy artifact of this Lambda", () => {
    for (const key of ["x", "cdk-hnb659fds/abc.zip", `test-deploy/${REVISION}/OtherFunction123-${hexOf(DEPLOYED_SHA)}.zip`, `test-deploy/${REVISION}/${NOTIFIER}-${hexOf(DEPLOYED_SHA)}.zip.bak`]) {
      const result = stale({ deployedTemplate: deployedWithKey(key), inputsChanged: { [NOTIFIER]: false } });
      expect(result.findings[0]?.message, key).toMatch(/unknown provenance/);
    }
    expect(stale({ deployedTemplate: withKey(template(), NOTIFIER, "x"), inputsChanged: { [NOTIFIER]: false } }).findings[0]?.message).toMatch(/unknown provenance/);
  });
});

describe("parseDeployedCodeKey", () => {
  it("reads the revision of a test-deploy key whose hash is the running code's", () => {
    const hex = "ab".repeat(32);
    expect(parseDeployedCodeKey(`test-deploy/0b35a884/${NOTIFIER}-${hex}.zip`, NOTIFIER, Buffer.from(hex, "hex").toString("base64"))).toEqual({ revision: "0b35a884" });
    expect(parseDeployedCodeKey(`test-deploy/0b35a884/${NOTIFIER}-${hex}.zip`, NOTIFIER, "other")).toEqual({ problem: expect.stringMatching(/CodeSha256/) as unknown });
    expect(parseDeployedCodeKey(undefined, NOTIFIER, "x")).toEqual({ problem: expect.stringMatching(/no literal S3Key/) as unknown });
  });
});

describe("sourcePathsFor", () => {
  it("maps built workspace output to its source, drops node_modules for the lockfile, and keeps extra files", () => {
    expect(sourcePathsFor(
      ["packages/broker/src/aws/dispatcher.ts", "packages/contracts/dist/session.js", "packages/contracts/dist/sub/x.js", "node_modules/zod/index.js", "node_modules/@aws-sdk/a/b.js"],
      ["packages/worker/ec2/boot.sh"],
    )).toEqual([
      "package-lock.json",
      "packages/broker/src/aws/dispatcher.ts",
      "packages/contracts/package.json",
      "packages/contracts/src/session.ts",
      "packages/contracts/src/sub/x.ts",
      "packages/worker/ec2/boot.sh",
    ]);
  });
});

describe("lambda-env-missing", () => {
  const DISPATCHER = "DispatcherD4A12972";
  const base = () => {
    const head = template();
    head.Resources = { ...head.Resources, [DISPATCHER]: { Type: "AWS::Lambda::Function", Properties: { Role: { "Fn::GetAtt": ["DispatcherServiceRole904BCD09", "Arn"] }, Code: { S3Key: "x" } } }, DispatcherServiceRole904BCD09: role };
    return head;
  };
  const evaluate = (head: CfnTemplate, deployed: CfnTemplate) => evaluateTestDeployCheck(input({ headTemplate: head, deployedTemplate: deployed }));

  it("finds an environment variable head's function has and the deployed function lacks, naming the stack update it needs", () => {
    const head = withEnvironment(base(), DISPATCHER, ["TABLE_NAME", "ARTIFACT_BUCKET_NAME"]);
    const deployed = withEnvironment(base(), DISPATCHER, ["TABLE_NAME"]);
    const result = evaluate(head, deployed);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "lambda-env-missing", severity: "error", subject: DISPATCHER, label: "Dispatcher", missing: ["ARTIFACT_BUCKET_NAME"] });
    expect(result.findings[0]?.message).toContain("ARTIFACT_BUCKET_NAME");
    expect(result.findings[0]?.message).toMatch(/stack update/);
    expect(result.findings[0]?.message).toMatch(/code-only change set cannot add Environment/);
  });

  it("finds a function whose deployed copy has no Environment at all, and ignores variable order, values and extras", () => {
    expect(evaluate(withEnvironment(base(), DISPATCHER, ["A"]), base()).findings.map((finding) => finding.missing)).toEqual([["A"]]);
    expect(evaluate(withEnvironment(base(), DISPATCHER, ["A", "B"]), withEnvironment(base(), DISPATCHER, ["B", "A", "C"]))).toEqual({ ok: true, findings: [] });
    expect(evaluate(base(), withEnvironment(base(), DISPATCHER, ["OLD"]))).toEqual({ ok: true, findings: [] });
  });

  it("does not report a function the deployed stack does not have: that is not a code-only gap", () => {
    const deployed = base();
    delete deployed.Resources?.[DISPATCHER];
    expect(evaluate(withEnvironment(base(), DISPATCHER, ["A"]), deployed).findings.filter((finding) => finding.kind === "lambda-env-missing")).toEqual([]);
  });

  it("refuses --apply of a code-only deploy of that function, and only of a unit that deploys it", () => {
    const head = withEnvironment(base(), DISPATCHER, ["ARTIFACT_BUCKET_NAME"]);
    const { findings } = evaluate(head, base());
    expect(() => assertCheckAllowsApply(findings, ["dispatcher"], head)).toThrow("deploy check failed: lambda-env-missing Dispatcher (needs a control-plane stack update");
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head)).toThrow(/ARTIFACT_BUCKET_NAME/);
    expect(() => assertCheckAllowsApply(findings, ["broker"], head)).not.toThrow();
    expect(() => assertCheckAllowsApply(findings, ["worker-image"], head)).not.toThrow();
  });

  it("reports an IAM gap and an environment gap in one refusal", () => {
    const head = withEnvironment(base(), DISPATCHER, ["ARTIFACT_BUCKET_NAME"]);
    (head.Resources?.[SESSIONS_POLICY]?.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:GetObject", Resource: "*" });
    const { findings } = evaluate(head, base());
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head)).toThrow(/iam-missing-grant SessionsSteps \(needs Tier 3 approval\); lambda-env-missing Dispatcher/);
  });
});

describe("check report and exit codes", () => {
  it("reports ok, the counts, the findings and the notes as one JSON-ready object", () => {
    const result = evaluateTestDeployCheck(input({ lambdaCodeShas: { ...SHAS, [NOTIFIER]: "x" } }));
    const report = checkReport(result, ["a note"], { env: "agentxlivetest123", revision: "abc" });
    expect(report).toMatchObject({ ok: false, env: "agentxlivetest123", revision: "abc", errors: 1, warnings: 0, notes: ["a note"] });
    expect(report.findings).toEqual(result.findings);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("exits 1 for findings, 2 when the check could not run, and 1 for any other mode's failure", () => {
    expect(checkExitCode(["--env", "e", "--check"], new DeployCheckFindingsError(3))).toBe(1);
    expect(checkExitCode(["--env", "e", "--check"], new Error("cannot read the feature-verifier catalog"))).toBe(2);
    expect(checkExitCode(["--check", "--json"], new Error("x"))).toBe(2);
    expect(checkExitCode(["--env", "e", "--apply"], new Error("x"))).toBe(1);
    expect(new DeployCheckFindingsError(3).message).toBe("TEST deploy check failed: 3 problem(s) above");
  });

  it("takes --json only with --check", () => {
    expect(parseTestDeployArgs(["--env", "e", "--profile", "p", "--check", "--json"])).toMatchObject({ check: true, json: true });
    expect(parseTestDeployArgs(["--env", "e", "--profile", "p", "--check"])).toMatchObject({ json: false });
    expect(() => parseTestDeployArgs(["--env", "e", "--profile", "p", "--json"])).toThrow(/--json only goes with --check/);
  });
});

describe("lambdaRoleIds", () => {
  it("maps each Lambda to the role it runs as", () => {
    expect(lambdaRoleIds(template())).toEqual({
      SessionsSteps3B98DD2B: "SessionsStepsServiceRole5DDD9E37",
      [NOTIFIER]: "DeveloperTaskNotifierServiceRoleAB12CD34",
      BrokerE1355FD6: "BrokerServiceRole1938BCC9",
    });
  });
});

describe("findingLabel", () => {
  it("names a Lambda or its role without CDK's hash and function suffix", () => {
    expect(findingLabel("SessionsSteps3B98DD2B")).toBe("SessionsSteps");
    expect(findingLabel(NOTIFIER)).toBe("DeveloperTaskNotifier");
    expect(findingLabel("DeveloperSignInFunction10B62B05")).toBe("DeveloperSignIn");
    expect(findingLabel("SessionsStepsServiceRole5DDD9E37")).toBe("SessionsSteps");
    expect(findingLabel(SESSIONS_POLICY)).toBe("SessionsSteps");
  });
});

describe("formatFindings", () => {
  it("prints one line per finding, errors before warnings, and says when there are none", () => {
    expect(formatFindings([])).toBe("TEST deploy check: no findings.");
    const text = formatFindings(evaluateTestDeployCheck(input({ headTemplate: template({ sessionsSsm: [...settings, executorImage] }), lambdaCodeShas: { ...SHAS, [NOTIFIER]: "x" } })).findings);
    expect(text).toContain("error stale-lambda DeveloperTaskNotifier");
    expect(text).toContain("error iam-missing-grant SessionsSteps");
  });
});

describe("assertCheckAllowsApply", () => {
  const drift = () => evaluateTestDeployCheck(input({ headTemplate: template({ sessionsSsm: [...settings, executorImage] }) }));

  it("refuses --apply of control-plane-code while SessionsSteps lacks a grant, with the statement for a Tier 3 request", () => {
    const result = drift();
    expect(() => assertCheckAllowsApply(result.findings, ["control-plane-code"], template({ sessionsSsm: [...settings, executorImage] }))).toThrow(
      "deploy check failed: iam-missing-grant SessionsSteps (needs Tier 3 approval)",
    );
    expect(() => assertCheckAllowsApply(result.findings, ["control-plane-code"], template())).toThrow(
      new RegExp(`Tier 3[\\s\\S]*${SESSIONS_POLICY}[\\s\\S]*ssm:GetParameters[\\s\\S]*worker-executor-image`),
    );
  });

  it("refuses when a unit that runs as the drifted role is chosen alone", () => {
    expect(() => assertCheckAllowsApply(drift().findings, ["control-plane-code"], template())).toThrow(/iam-missing-grant SessionsSteps/);
    expect(() => assertCheckAllowsApply(drift().findings, ["broker"], template())).not.toThrow();
  });

  it("lets a deploy of other units through, and never refuses for anything but a missing grant", () => {
    const stale = evaluateTestDeployCheck(input({ lambdaCodeShas: { ...SHAS, [NOTIFIER]: "x" }, catalogRows: [], runnerFacts: undefined })).findings;
    expect(() => assertCheckAllowsApply(stale, ["control-plane-code"], template())).not.toThrow();
    expect(() => assertCheckAllowsApply(drift().findings, ["worker-image", "executor-image"], template())).not.toThrow();
  });
});

describe("test-deploy --check", () => {
  it("still refuses a non-allowlisted environment with the M1.0 error, before any AWS call", async () => {
    await expect(main(["--env", "not-in-the-allowlist", "--profile", "agentx-test", "--check"])).rejects.toThrow("test-deploy only targets allowlisted TEST installations");
  });

  it("takes neither --apply nor --only, so a check can never change anything", async () => {
    await expect(main(["--env", "agentxlivetest123", "--profile", "agentx-test", "--check", "--apply"])).rejects.toThrow(/--check is read-only/);
    await expect(main(["--env", "agentxlivetest123", "--profile", "agentx-test", "--check", "--only", "broker"])).rejects.toThrow(/--check checks every unit/);
  });
});

describe("parseRunnerStatus", () => {
  it("reads the hook's status object and what it reports of the runner", () => {
    expect(parseRunnerStatus(JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "2026-10-20T10:00:00Z", executorImage: "r/e@sha256:1", invocationFeatures: ["a.b"] })))
      .toEqual({ state: "SUCCEEDED", reason: "qualified", executorImage: "r/e@sha256:1", invocationFeatures: ["a.b"] });
    // A status from before the hook reported them has neither.
    expect(parseRunnerStatus('{"state":"SUCCEEDED","reason":"qualified","finishedAt":"2026-10-14T10:00:00Z"}')).toEqual({ state: "SUCCEEDED", reason: "qualified" });
  });

  it("reads anything else as no status", () => {
    for (const text of ["", "not json", "[]", "null", '{"state":"SUCCEEDED"}', '{"state":1,"reason":"x"}']) expect(parseRunnerStatus(text)).toBeUndefined();
    expect(parseRunnerStatus('{"state":"READY","reason":"r","invocationFeatures":[1]}')).toEqual({ state: "READY", reason: "r" });
  });
});

describe("parseTestDeployArgs --check", () => {
  it("is a flag that excludes --apply and --only", () => {
    expect(parseTestDeployArgs(["--env", "e", "--profile", "p", "--check"])).toMatchObject({ check: true, apply: false });
    expect(parseTestDeployArgs(["--env", "e", "--profile", "p"])).toMatchObject({ check: false });
    expect(() => parseTestDeployArgs(["--env", "e", "--profile", "p", "--check", "--apply"])).toThrow(/read-only/);
    expect(() => parseTestDeployArgs(["--env", "e", "--profile", "p", "--check", "--only", "broker"])).toThrow(/every unit/);
  });
});

describe("gatherCheckFacts", () => {
  type CommandResult = ReturnType<Parameters<typeof gatherCheckFacts>[0]["runner"]["aws"]>;
  const ENV = "agentxlivetest123";
  const ACCOUNT_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor@sha256:${"a".repeat(64)}`;
  const brokerTemplate = (): CfnTemplate => {
    const deployed = template();
    const broker = deployed.Resources?.BrokerE1355FD6;
    if (broker?.Properties) broker.Properties.Environment = { Variables: { AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: "agentx-agentxlivetest123-e2e-mock-runtime-v1" } };
    return deployed;
  };
  const ok = (stdout: unknown): CommandResult => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
  const status = JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "2026-10-20T10:00:00Z", executorImage: ACCOUNT_IMAGE, invocationFeatures: ["task.readiness"] });

  /** A fake `aws` that answers each read, records every call, and fails the test on anything it was not told about. */
  const WORKER_ROLE = "Ec2WorkersInstanceRole5F1A2B3C";
  const PROFILE_ID = "us.anthropic.claude-haiku-5-5";
  const FOUNDATION_MODEL = "anthropic.claude-haiku-5-5";
  const foundationTemplate = (): CfnTemplate => ({
    Resources: {
      [WORKER_ROLE]: { Type: "AWS::IAM::Role", Properties: {} },
      WorkerPolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          Roles: [{ Ref: WORKER_ROLE }],
          PolicyDocument: { Statement: [{
            Sid: "BedrockModelInvocation", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            Resource: [
              { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":bedrock:*::foundation-model/*"]] },
              { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":bedrock:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":*"]] },
            ],
          }] },
        },
      },
    },
    Outputs: { Ec2WorkerInstanceRoleArn: { Value: { "Fn::GetAtt": [WORKER_ROLE, "Arn"] } } },
  });
  const failed = (stderr: string): CommandResult => ({ status: 254, stdout: "", stderr });
  type BedrockMode = "ok" | "not-found" | "denied" | "unauthorized-model";
  function fakeAws(overrides: { instances?: string[]; statusBody?: string | null; catalogItems?: unknown[]; brokerSha?: string; brokerKey?: string; bedrock?: BedrockMode; routeRows?: number; scan?: "denied" } = {}) {
    const calls: string[][] = [];
    const runner = {
      aws(args: readonly string[]): CommandResult {
        calls.push([...args]);
        const line = args.join(" ");
        if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
          const stack = args[args.indexOf("--stack-name") + 1];
          if (stack === `agentx-${ENV}-control-plane`) return ok({ Outputs: [{ OutputKey: "StateTableName", OutputValue: "state-table" }, { OutputKey: "ArtifactBucketName", OutputValue: "artifacts" }] });
          if (stack === `agentx-${ENV}-runtime`) return ok({ Parameters: [{ ParameterKey: "ExecutorImageUri", ParameterValue: ACCOUNT_IMAGE }] });
          if (stack === `agentx-${ENV}-foundation`) return ok({ Outputs: [{ OutputKey: "Ec2WorkerInstanceRoleArn", OutputValue: "arn:aws:iam::123456789012:role/worker-role" }] });
        }
        if (args[0] === "cloudformation" && args[1] === "get-template" && args[args.indexOf("--stack-name") + 1] === `agentx-${ENV}-foundation`) return ok(foundationTemplate());
        if (args[0] === "bedrock") {
          const mode = overrides.bedrock ?? "ok";
          if (mode === "denied") return failed("An error occurred (AccessDeniedException) when calling the GetInferenceProfile operation: User is not authorized to perform: bedrock:GetInferenceProfile");
          if (args[1] === "get-inference-profile") {
            if (mode === "not-found") return failed("An error occurred (ResourceNotFoundException) when calling the GetInferenceProfile operation: Inference profile not found");
            return ok({
              inferenceProfileArn: `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${args[args.indexOf("--inference-profile-identifier") + 1]}`, status: "ACTIVE", type: "SYSTEM_DEFINED",
              models: ["us-east-1", "us-east-2", "us-west-2"].map((region) => ({ modelArn: `arn:aws:bedrock:${region}::foundation-model/${FOUNDATION_MODEL}` })),
            });
          }
          if (args[1] === "get-foundation-model-availability") {
            return ok({ modelId: args[args.indexOf("--model-id") + 1], agreementAvailability: { status: "AVAILABLE" }, authorizationStatus: mode === "unauthorized-model" ? "NOT_AUTHORIZED" : "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" });
          }
        }
        if (args[0] === "dynamodb" && args[1] === "scan") return overrides.scan === "denied" ? failed("AccessDeniedException: not authorized to perform: dynamodb:Scan") : ok({ Count: overrides.routeRows ?? 0 });
        if (args[0] === "cloudformation" && args[1] === "get-template") return ok(overrides.brokerKey === undefined ? brokerTemplate() : withKey(brokerTemplate(), "BrokerE1355FD6", overrides.brokerKey));
        if (args[0] === "cloudformation" && args[1] === "list-stack-resources") return ok([["BrokerE1355FD6", "fn-broker"], [NOTIFIER, "fn-notifier"], ["SessionsSteps3B98DD2B", "fn-sessions"], ["Unrelated", "fn-other"]]);
        if (args[0] === "lambda" && args[1] === "get-function") {
          const name = args[args.indexOf("--function-name") + 1];
          return ok(`"${name === "fn-broker" && overrides.brokerSha !== undefined ? overrides.brokerSha : `sha-of-${name}`}"`);
        }
        if (args[0] === "dynamodb" && args[1] === "query") {
          return ok({ Items: overrides.catalogItems ?? [
            { sk: { S: "PROFILE#linux-arm64-web-api-v1#api" }, state: { S: "READY" }, expiresAt: { S: "2027-01-01T00:00:00.000Z" }, endpoint: { S: "http://10.0.1.5:8080" } },
            { sk: { S: "PROFILE#linux-arm64-web-api-v1#web" }, state: { S: "READY" }, expiresAt: { S: "2027-01-01T00:00:00.000Z" }, endpoint: { S: "http://10.0.1.5:8080" } },
          ] });
        }
        if (args[0] === "ec2" && args[1] === "describe-instances") return ok(overrides.instances ?? ["i-0123456789abcdef0"]);
        if (args[0] === "iam" && args[1] === "get-role") return ok('"AROAEXAMPLEROLEID1234"');
        if (args[0] === "s3api" && args[1] === "get-object") {
          if (overrides.statusBody === null) return { status: 254, stdout: "", stderr: "NoSuchKey" };
          writeFileSync(args[args.length - 1] ?? "", overrides.statusBody ?? status);
          return ok("{}");
        }
        throw new Error(`unexpected aws call: ${line}`);
      },
    };
    return { runner, calls };
  }
  const HEAD_REVISION = "f00dfeedbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const changes: Array<{ revision: string; paths: string[] }> = [];
  let changed: boolean | undefined = false;
  const gather = (fake: ReturnType<typeof fakeAws>, route?: E2EModelRoute) => gatherCheckFacts({
    runner: fake.runner, region: "us-east-1", env: ENV, ...(route === undefined ? {} : { route }),
    headTemplate: () => template(),
    builtZips: async () => ({ shas: { BrokerE1355FD6: "b" }, sources: { BrokerE1355FD6: ["packages/broker/src/aws/broker.ts"] } }),
    headRevision: HEAD_REVISION,
    changedSince: (revision, paths) => { changes.push({ revision, paths: [...paths] }); return changed; },
  });

  it("reads the deployed template, code hashes, catalog rows and the runner's status, and only reads", async () => {
    const fake = fakeAws();
    const { facts } = await gather(fake);
    expect(facts.lambdaCodeShas).toEqual({ BrokerE1355FD6: "sha-of-fn-broker", [NOTIFIER]: "sha-of-fn-notifier", SessionsSteps3B98DD2B: "sha-of-fn-sessions" });
    expect(facts.builtZipShas).toEqual({ BrokerE1355FD6: "b" });
    expect(facts.catalogRows.map((row) => row.sk).sort()).toEqual(["PROFILE#linux-arm64-web-api-v1#api", "PROFILE#linux-arm64-web-api-v1#web"]);
    expect(facts.runnerFacts).toEqual({ deployedExecutorImage: ACCOUNT_IMAGE, executorImage: ACCOUNT_IMAGE, invocationFeatures: ["task.readiness"] });
    const readOnly = ["cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources", "lambda get-function", "dynamodb query", "ec2 describe-instances", "iam get-role", "s3api get-object", "bedrock get-inference-profile", "bedrock get-foundation-model-availability", "dynamodb scan"];
    for (const call of fake.calls) expect(readOnly, call.join(" ")).toContain(`${call[0]} ${call[1]}`);
  });

  describe("the model route", () => {
    it("reads Bedrock's control plane only: no model is ever invoked, and no bedrock-runtime call is made", async () => {
      const fake = fakeAws();
      await gather(fake);
      const bedrock = fake.calls.filter((call) => call[0]?.startsWith("bedrock"));
      expect(bedrock.map((call) => `${call[0]} ${call[1]}`).sort()).toEqual(["bedrock get-foundation-model-availability", "bedrock get-inference-profile"]);
      for (const call of fake.calls) {
        expect(call[0], call.join(" ")).not.toBe("bedrock-runtime");
        expect(call[1] ?? "", call.join(" ")).not.toMatch(/^(invoke|converse)/);
      }
      expect(bedrock.find((call) => call[1] === "get-inference-profile")?.join(" ")).toContain(`--inference-profile-identifier ${PROFILE_ID}`);
      // The availability of the foundation model behind the profile, asked once for the three regions' ARNs.
      expect(bedrock.filter((call) => call[1] === "get-foundation-model-availability").map((call) => call[call.indexOf("--model-id") + 1])).toEqual([FOUNDATION_MODEL]);
    });

    it("checks the pinned route's model, its approval row, and the worker role's grants for the profile and its models", async () => {
      const fake = fakeAws();
      const { facts } = await gather(fake);
      expect(facts.modelRoute?.route).toEqual(E2E_MODEL_ROUTE);
      expect(facts.modelRoute?.access).toEqual({
        state: "checked", profileStatus: "ACTIVE",
        models: [{ modelId: FOUNDATION_MODEL, authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE", agreementStatus: "AVAILABLE" }],
      });
      expect(facts.modelRoute?.approval).toEqual({ approved: false });
      expect(facts.modelRoute?.iam.roleLogicalId).toBe(WORKER_ROLE);
      expect(facts.modelRoute?.iam.scope).toEqual({ partition: "aws", region: "us-east-1", accountId: "123456789012" });
      expect(facts.modelRoute?.iam.resources).toEqual([
        `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${PROFILE_ID}`,
        ...["us-east-1", "us-east-2", "us-west-2"].map((region) => `arn:aws:bedrock:${region}::foundation-model/${FOUNDATION_MODEL}`),
      ]);
      const scan = fake.calls.find((call) => call[1] === "scan")?.join(" ") ?? "";
      expect(scan).toContain("--table-name state-table");
      expect(scan).toContain(`E2E_MODEL_ROUTE_LATEST#${E2E_MODEL_ROUTE.routeId}`);
      const result = evaluateTestDeployCheck({ ...facts, runnerFacts: { ...GOOD_RUNNER, deployedExecutorImage: ACCOUNT_IMAGE, executorImage: ACCOUNT_IMAGE }, now: NOW });
      expect(result.findings.filter((finding) => finding.kind === "model-route-not-approved")).toHaveLength(1);
      expect(result.findings.filter((finding) => finding.kind === "iam-missing-grant" && finding.roleLogicalId === WORKER_ROLE)).toEqual([]);
    });

    it("reads a route that names an application inference profile by its ARN", async () => {
      const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123def456";
      const fake = fakeAws();
      const { facts } = await gather(fake, { routeId: "app-profile-route", modelId: "ignored-for-an-arn", inferenceProfileArn: arn });
      const profileCall = fake.calls.find((call) => call[1] === "get-inference-profile") ?? [];
      expect(profileCall[profileCall.indexOf("--inference-profile-identifier") + 1]).toBe(arn);
      expect(facts.modelRoute?.iam.resources[0]).toBe(arn);
      expect(facts.modelRoute?.iam.resources).toHaveLength(4);
      expect(facts.modelRoute?.access.state).toBe("checked");
    });

    it("reads a plain foundation-model id with the availability call alone, and checks the model ARN in the region", async () => {
      const fake = fakeAws();
      const { facts } = await gather(fake, { routeId: "direct", modelId: FOUNDATION_MODEL, inferenceProfileArn: null });
      expect(fake.calls.some((call) => call[1] === "get-inference-profile")).toBe(false);
      expect(fake.calls.filter((call) => call[1] === "get-foundation-model-availability")).toHaveLength(1);
      expect(facts.modelRoute?.iam.resources).toEqual([`arn:aws:bedrock:us-east-1::foundation-model/${FOUNDATION_MODEL}`]);
      expect(facts.modelRoute?.access.state).toBe("checked");
    });

    it("reads the route as approved when the registry holds its latest row", async () => {
      expect((await gather(fakeAws({ routeRows: 1 }))).facts.modelRoute?.approval).toEqual({ approved: true });
      expect(JSON.stringify((await gather(fakeAws({ scan: "denied" }))).facts.modelRoute?.approval)).toContain("dynamodb:Scan");
    });

    it("reports a model Bedrock does not know as not-found, a denied listing as unverifiable, and an unauthorized model", async () => {
      const missing = await gather(fakeAws({ bedrock: "not-found" }));
      expect(missing.facts.modelRoute?.access.state).toBe("not-found");
      expect(JSON.stringify(missing.facts.modelRoute?.access)).toContain("ResourceNotFoundException");
      expect(evaluateTestDeployCheck({ ...missing.facts, now: NOW }).findings.map((finding) => finding.kind)).toContain("model-access-unverified");
      const denied = await gather(fakeAws({ bedrock: "denied" }));
      expect(denied.facts.modelRoute?.access.state).toBe("unverifiable");
      expect(JSON.stringify(denied.facts.modelRoute?.access)).toContain("bedrock:GetInferenceProfile");
      const unauthorized = await gather(fakeAws({ bedrock: "unauthorized-model" }));
      expect(evaluateTestDeployCheck({ ...unauthorized.facts, now: NOW }).findings.find((finding) => finding.kind === "model-access-unverified")?.message).toContain("NOT_AUTHORIZED");
    });
  });

  it("looks the runner up by the web row's private IP in the qualification tag, and its status by the worker role's unique ID", async () => {
    const fake = fakeAws();
    await gather(fake);
    const describe = fake.calls.find((call) => call[1] === "describe-instances")?.join(" ") ?? "";
    expect(describe).toContain("Name=private-ip-address,Values=10.0.1.5");
    expect(describe).toContain("Name=tag:DeploymentMode,Values=e2e-qualification");
    const get = fake.calls.find((call) => call[1] === "get-object") ?? [];
    expect(get.slice(get.indexOf("--bucket"), get.indexOf("--bucket") + 4)).toEqual(["--bucket", "artifacts", "--key", "e2e-runtime/AROAEXAMPLEROLEID1234:i-0123456789abcdef0/status.json"]);
    // The catalog is the Broker's own, read from the table by its key.
    const query = fake.calls.find((call) => call[1] === "query")?.join(" ") ?? "";
    expect(query).toContain("--table-name state-table");
    expect(query).toContain("E2E_FEATURE_VERIFIER#agentx-agentxlivetest123-e2e-mock-runtime-v1");
  });

  it("reports no runner facts, with the reason, when the runner is not found, has no status or did not qualify", async () => {
    const none = await gather(fakeAws({ instances: [] }));
    expect(none.facts.runnerFacts).toBeUndefined();
    expect(none.notes.join(" ")).toMatch(/0 running qualification instances/);
    const absent = await gather(fakeAws({ statusBody: null }));
    expect(absent.facts.runnerFacts).toBeUndefined();
    expect(absent.notes.join(" ")).toMatch(/NoSuchKey/);
    const failed = await gather(fakeAws({ statusBody: JSON.stringify({ state: "FAILED", reason: "worker-not-healthy", finishedAt: "x" }) }));
    expect(failed.facts.runnerFacts).toBeUndefined();
    expect(failed.notes.join(" ")).toMatch(/FAILED \(worker-not-healthy\)/);
  });

  it("feeds the evaluation: a runner qualified with another image is runner-image-mismatch", async () => {
    const other = JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "x", executorImage: `r/e@sha256:${"c".repeat(64)}`, invocationFeatures: READY_FEATURES });
    const { facts } = await gather(fakeAws({ statusBody: other }));
    const result = evaluateTestDeployCheck({ ...facts, now: NOW });
    expect(result.findings.filter((finding) => finding.kind === "runner-image-mismatch")).toHaveLength(1);
    expect(result.findings.filter((finding) => finding.kind === "worker-feature-missing")).toHaveLength(0);
  });

  it("asks git what changed only for a Lambda whose zip differs and whose S3Key proves its revision", async () => {
    changes.length = 0;
    changed = true;
    const hex = "ab".repeat(32);
    const deployedSha = Buffer.from(hex, "hex").toString("base64");
    const fake = fakeAws({ brokerSha: deployedSha, brokerKey: `test-deploy/0b35a884/BrokerE1355FD6-${hex}.zip` });
    const { facts } = await gather(fake);
    expect(changes).toEqual([{ revision: "0b35a884", paths: ["packages/broker/src/aws/broker.ts"] }]);
    expect(facts.inputsChanged).toEqual({ BrokerE1355FD6: true });
    expect(facts.headRevision).toBe(HEAD_REVISION);
    // Unknown provenance (the fixture's literal key) is never looked up.
    changes.length = 0;
    expect((await gather(fakeAws())).facts.inputsChanged).toEqual({});
    expect(changes).toEqual([]);
  });

  it("refuses a deployed Broker with no catalog ID rather than checking nothing", async () => {
    const fake = fakeAws();
    const original = fake.runner.aws.bind(fake.runner);
    fake.runner.aws = (args: readonly string[]) => (args[1] === "get-template" ? ok(template()) : original(args));
    await expect(gather(fake)).rejects.toThrow(/AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID/);
  });
});
