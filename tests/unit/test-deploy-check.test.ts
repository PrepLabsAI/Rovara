import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_PROVIDERS } from "../../packages/contracts/src/model-providers.js";
import { WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/protocol.js";
import { DEFAULT_E2E_AGENT_MODELS } from "../../packages/model-runtime/src/config.js";
import { deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { E2E_MODEL_ROUTE, E2E_MODEL_ROUTE_ID, deriveE2EModelRoute, evaluateTestDeployCheck, iamEvaluationNotes, findingLabel, formatFindings, lambdaRoleIds, parseDeployedCodeKey, parseRunnerStatus, sourcePathsFor, tier3Request, type CatalogRowFact, type CheckInput, type E2EModelRoute, type Finding, type BedrockRouteFacts, type KeyedRouteFacts, type ModelAccessFacts, type ModelAvailabilityFact, type ModelRouteCheck, type RunnerFacts } from "../../scripts/test-deploy-check.js";
import { CHECK_READ_VERBS, DeployCheckFindingsError, checkExitCode, deployedFeatureCatalogId, gatherCheckFacts, main, parseTestDeployArgs, readOnlyAws, type CfnTemplate } from "../../scripts/test-deploy.js";

const NOW = new Date("2026-10-20T18:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const ARN = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:parameter/agentx/agentxlivetest123/${name}`]] });

const SESSIONS_POLICY = "SessionsStepsServiceRoleDefaultPolicy9F4B87C9";
const BROKER_POLICY = "BrokerServiceRoleDefaultPolicyDDFD9E7E";
const NOTIFIER = "DeveloperTaskNotifierFunction551419CC";

const settings = ["worker-image", "model-id", "model-provider"].map(ARN);

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
/** A copy of `source` whose Lambda `logicalId` reads its code from `S3Key`. */
function withKey(source: CfnTemplate, logicalId: string, S3Key: string): CfnTemplate {
  const copy = JSON.parse(JSON.stringify(source)) as CfnTemplate;
  (copy.Resources?.[logicalId]?.Properties?.Code as { S3Key: string }).S3Key = S3Key;
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

  it("flags a catalog row that expires within 24 hours, and not one that expires after", () => {
    const soon = evaluateTestDeployCheck(input({ catalogRows: rows([{ expiresAt: hoursFromNow(23) }, {}]) }));
    expect(soon.ok).toBe(false);
    expect(soon.findings.map((finding) => [finding.kind, finding.subject])).toEqual([["catalog-expiring", "PROFILE#linux-arm64-web-api-v1#web"]]);
    expect(evaluateTestDeployCheck(input({ catalogRows: rows([{ expiresAt: hoursFromNow(25) }, {}]) })).ok).toBe(true);
    // Already expired is expiring too.
    expect(kinds(evaluateTestDeployCheck(input({ catalogRows: rows([{}, { expiresAt: hoursFromNow(-2) }]) })).findings)).toEqual(["catalog-expiring"]);
  });

});

describe("the e2e model route", () => {
  const MODEL = "us.anthropic.claude-haiku-5-5";
  const ACCOUNT = "123456789012";
  const PROFILE_ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/${MODEL}`;
  const MODEL_ARNS = ["us-east-1", "us-east-2", "us-west-2"].map((region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-5-5`);
  const WORKER_ROLE = "Ec2WorkersInstanceRole5F1A2B3C";
  const WORKER_POLICY = "Ec2WorkersInstanceRoleDefaultPolicy7D8E9F0A";
  const WORKER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/agentx/agentxlivetest123/worker-role`;
  const SCOPE = { partition: "aws", region: "us-east-1", accountId: ACCOUNT };
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
  const AVAILABLE_MODEL: ModelAvailabilityFact = { modelId: "anthropic.claude-haiku-5-5", authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE", agreementStatus: "AVAILABLE" };
  const ACCESS: ModelAccessFacts = { state: "checked", profileStatus: "ACTIVE", models: [AVAILABLE_MODEL] };
  const bedrockIam = (overrides: Partial<BedrockRouteFacts["iam"]> = {}): BedrockRouteFacts["iam"] =>
    ({ foundationTemplate: foundation(), roleLogicalId: WORKER_ROLE, resources: [PROFILE_ARN, ...MODEL_ARNS], scope: SCOPE, ...overrides });
  const route = (overrides: Partial<ModelRouteCheck> = {}): ModelRouteCheck => ({
    provider: { state: "known", route: E2E_MODEL_ROUTE },
    approval: { approved: true },
    bedrock: { access: ACCESS, iam: bedrockIam() },
    ...overrides,
  });
  const check = (overrides: Partial<ModelRouteCheck> = {}) => evaluateTestDeployCheck(input({ modelRoute: route(overrides) }));


  // ---- keyed providers: a Secrets Manager ARN, the worker role's grant on it, and what cannot be checked without a call ----
  type KeyedProvider = "anthropic" | "openai" | "openrouter";
  const PREFIX: Record<KeyedProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
  const secretArnFor = (provider: KeyedProvider) => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/agentxlivetest123/${provider}-AbCdEf`;
  const WORKER_ROLE_EXPRESSION = { "Fn::Select": [3, { "Fn::Split": ["/", { Ref: "Ec2WorkerInstanceRoleArn" }] }] };
  /** The control-plane stack as model-keys.ts emits it: <Prefix>Enabled, and <Prefix>SecretRead on the orchestrator role and the worker role. */
  const controlPlaneTemplate = (provider: KeyedProvider, options: { roles?: unknown[] } = {}): CfnTemplate => ({
    Conditions: { [`${PREFIX[provider]}Enabled`]: { "Fn::Not": [{ "Fn::Equals": [{ Ref: `${PREFIX[provider]}SecretArn` }, ""] }] } },
    Resources: {
      [`${PREFIX[provider]}SecretRead`]: {
        Type: "AWS::IAM::Policy",
        Condition: `${PREFIX[provider]}Enabled`,
        Properties: {
          PolicyName: `${PREFIX[provider]}SecretRead`,
          Roles: options.roles ?? [{ Ref: "SlackOrchestratorTaskRole2372FE40" }, WORKER_ROLE_EXPRESSION],
          PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: `${PREFIX[provider]}SecretArn` } }] },
        },
      },
    },
  });
  interface KeyedOverrides {
    secretArn?: KeyedRouteFacts["secretArn"];
    openRouterProviders?: KeyedRouteFacts["openRouterProviders"];
    template?: CfnTemplate;
    stackArn?: string;
    foundationTemplate?: CfnTemplate;
  }
  function keyedFacts(provider: KeyedProvider, overrides: KeyedOverrides = {}): KeyedRouteFacts {
    const arn = secretArnFor(provider);
    return {
      secretArn: overrides.secretArn ?? { state: "read", value: arn },
      ...(provider === "openrouter" ? { openRouterProviders: overrides.openRouterProviders ?? { state: "read" as const, value: undefined } } : {}),
      iam: {
        foundationTemplate: overrides.foundationTemplate ?? foundation(), roleLogicalId: WORKER_ROLE, roleName: "worker-role",
        controlPlaneTemplate: overrides.template ?? controlPlaneTemplate(provider),
        scope: { ...SCOPE, parameters: { [`${PREFIX[provider]}SecretArn`]: overrides.stackArn ?? arn, Ec2WorkerInstanceRoleArn: WORKER_ROLE_ARN } },
      },
    };
  }
  const keyed = (provider: KeyedProvider, facts: KeyedRouteFacts = keyedFacts(provider), derived: E2EModelRoute = deriveE2EModelRoute(provider)) =>
    evaluateTestDeployCheck(input({ modelRoute: { provider: { state: "known", route: derived }, approval: { approved: true }, keyed: facts } }));
  const infos = (findings: readonly Finding[]) => findings.filter((finding) => finding.severity === "info");
  const errorsOf = (findings: readonly Finding[]) => findings.filter((finding) => finding.severity === "error");

  describe("the provider setting", () => {

    it("gives model-not-in-catalog when the pinned pi catalog does not know the default model, for every provider", () => {
      for (const provider of MODEL_PROVIDERS) {
        const unknown: E2EModelRoute = { routeId: E2E_MODEL_ROUTE_ID, provider, modelId: "claude-haiku-9-9-not-a-model" };
        const result = provider === "amazon-bedrock"
          ? check({ provider: { state: "known", route: unknown } })
          : keyed(provider, keyedFacts(provider), unknown);
        expect(result.findings.filter((finding) => finding.kind === "model-not-in-catalog"), provider).toHaveLength(1);
        expect(result.findings.find((finding) => finding.kind === "model-not-in-catalog")).toMatchObject({ severity: "error", subject: E2E_MODEL_ROUTE_ID });
        expect(result.ok).toBe(false);
      }
    });

  });

  describe.each(["anthropic", "openai", "openrouter"] as const)("keyed provider %s", (provider) => {
    it("passes with a well-formed secret ARN the worker role may read; the check cannot say the key works (info) and cannot see the KMS key (unverifiable)", () => {
      const result = keyed(provider);
      expect(result.ok).toBe(true);
      expect(errorsOf(result.findings)).toEqual([]);
      const unverified = infos(result.findings);
      expect(unverified.length).toBeGreaterThanOrEqual(1);
      for (const finding of unverified) expect(finding).toMatchObject({ kind: "model-access-unverified", severity: "info", subject: E2E_MODEL_ROUTE_ID });
      const text = unverified.map((finding) => finding.message).join(" ");
      expect(text).toMatch(/key|credit/i);
      expect(text).toMatch(/kms:Decrypt/);
      expect(text).toMatch(/unverifiable/);
      // F3: the granted verdict ignores all of these, so the info says so.
      expect(text).toMatch(/managed polic/i);
      expect(text).toMatch(/permissions? boundar/i);
      expect(text).toMatch(/SCP/);
      expect(text).toMatch(/resource polic/i);
    });

    it("gives model-route-secret-missing when the ARN setting is absent, unset (none, empty) or not a Secrets Manager ARN", () => {
      for (const value of [undefined, "none", ""]) {
        const result = keyed(provider, keyedFacts(provider, { secretArn: { state: "read", value } }));
        expect(result.ok, String(value)).toBe(false);
        expect(result.findings.find((finding) => finding.kind === "model-route-secret-missing"), String(value)).toMatchObject({ severity: "error", subject: E2E_MODEL_ROUTE_ID });
        expect(kinds(result.findings), String(value)).not.toContain("iam-missing-grant");
      }
      const malformed = "sk-pasted-by-mistake-0123456789abcdef";
      const bad = keyed(provider, keyedFacts(provider, { secretArn: { state: "read", value: malformed } }));
      expect(kinds(bad.findings)).toContain("model-route-secret-missing");
      // A malformed value might be a pasted key: it is never echoed.
      expect(JSON.stringify(bad)).not.toContain(malformed);
      expect(kinds(keyed(provider, keyedFacts(provider, { secretArn: { state: "read", value: `${secretArnFor(provider)} ` } })).findings)).toContain("model-route-secret-missing");
    });

    it("is unverifiable, not a pass, when the ARN setting cannot be read", () => {
      const result = keyed(provider, keyedFacts(provider, { secretArn: { state: "unverifiable", reason: "AccessDeniedException: ssm:GetParameter" } }));
      expect(result.ok).toBe(false);
      const [error] = errorsOf(result.findings);
      expect(error).toMatchObject({ kind: "model-access-unverified" });
      expect(error?.message).toMatch(/unverifiable, which is not a pass/);
      expect(kinds(result.findings)).not.toContain("model-route-secret-missing");
    });

    it("gives iam-missing-grant naming the worker instance role when its policy does not allow secretsmanager:GetSecretValue on the ARN", () => {
      const arn = secretArnFor(provider);
      // The read policy is on another role only.
      const otherRole = keyed(provider, keyedFacts(provider, { template: controlPlaneTemplate(provider, { roles: [{ Ref: "SlackOrchestratorTaskRole2372FE40" }] }) }));
      expect(otherRole.ok).toBe(false);
      const finding = otherRole.findings.find((item) => item.kind === "iam-missing-grant");
      expect(finding).toMatchObject({ severity: "error", roleLogicalId: WORKER_ROLE, policyLogicalId: `${PREFIX[provider]}SecretRead`, label: "Ec2WorkersInstanceRole" });
      expect(finding?.statements).toEqual([{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [arn] }]);
      expect(finding?.message).toContain("worker instance role");
      expect(finding?.message).toContain(arn);
      expect(tier3Request(otherRole.findings)).toContain(WORKER_ROLE);
      // The policy grants a different secret.
      const wrong = keyed(provider, keyedFacts(provider, { stackArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:somebody-else-ZZZZZZ` }));
      expect(kinds(wrong.findings)).toContain("iam-missing-grant");
      // The policy is disabled (its condition is false because the stack's ARN parameter is empty), so it grants nothing.
      const disabled = keyed(provider, keyedFacts(provider, { stackArn: "" }));
      expect(kinds(disabled.findings)).toContain("iam-missing-grant");
      // No policy at all.
      expect(kinds(keyed(provider, keyedFacts(provider, { template: { Resources: {} } })).findings)).toContain("iam-missing-grant");
    });

    it("also counts a grant the foundation stack gives the worker role", () => {
      const foundationGrant = foundation([BEDROCK_SID, { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArnFor(provider) }]);
      const result = keyed(provider, keyedFacts(provider, { template: { Resources: {} }, foundationTemplate: foundationGrant }));
      expect(kinds(result.findings)).not.toContain("iam-missing-grant");
      expect(result.ok).toBe(true);
    });

    it("treats every Deny shape it cannot parse as a maybe-Deny: Fn::If statement, intrinsic Action, a Deny policy under an unresolvable condition", () => {
      const wrapped = foundation([{ "Fn::If": ["DenyIt", { Effect: "Deny", Action: "secretsmanager:*", Resource: "*" }, { Ref: "AWS::NoValue" }] }]);
      const intrinsicAction = foundation([{ Effect: "Deny", Action: { "Fn::If": ["DenyIt", "secretsmanager:*", "s3:*"] }, Resource: "*" }]);
      for (const foundationTemplate of [wrapped, intrinsicAction]) {
        const result = keyed(provider, keyedFacts(provider, { foundationTemplate }));
        expect(result.ok).toBe(false);
        expect(errorsOf(result.findings).map((finding) => finding.kind)).toEqual(["model-access-unverified"]);
      }
      // A Deny policy of the control-plane stack on the worker role, under a condition that cannot be resolved here.
      const withDeny = controlPlaneTemplate(provider);
      withDeny.Conditions = { ...(withDeny.Conditions as Record<string, unknown>), Mystery: { "Fn::Equals": [{ "Fn::GetAtt": ["Somewhere", "Arn"] }, "x"] } };
      withDeny.Resources = {
        ...withDeny.Resources,
        DenyPolicy: {
          Type: "AWS::IAM::Policy", Condition: "Mystery",
          Properties: { Roles: [WORKER_ROLE_EXPRESSION], PolicyDocument: { Statement: [{ Effect: "Deny", Action: "secretsmanager:GetSecretValue", Resource: "*" }] } },
        },
      };
      const conditional = keyed(provider, keyedFacts(provider, { template: withDeny }));
      expect(conditional.ok).toBe(false);
      expect(errorsOf(conditional.findings).map((finding) => finding.kind)).toEqual(["model-access-unverified"]);
      // An Allow policy under the same unresolvable condition grants nothing, as before.
      const allowOnly = controlPlaneTemplate(provider);
      allowOnly.Conditions = { Mystery: { "Fn::Equals": [{ "Fn::GetAtt": ["Somewhere", "Arn"] }, "x"] } };
      (allowOnly.Resources?.[`${PREFIX[provider]}SecretRead`] as { Condition: string }).Condition = "Mystery";
      expect(kinds(keyed(provider, keyedFacts(provider, { template: allowOnly })).findings)).toContain("iam-missing-grant");
      // A Deny policy under a condition that is definitely off is skipped.
      const off = controlPlaneTemplate(provider);
      off.Resources = { ...off.Resources, DenyPolicy: { Type: "AWS::IAM::Policy", Condition: `${PREFIX[provider]}Enabled`, Properties: { Roles: [WORKER_ROLE_EXPRESSION], PolicyDocument: { Statement: [{ Effect: "Deny", Action: "secretsmanager:GetSecretValue", Resource: "*" }] } } } };
      expect(errorsOf(keyed(provider, keyedFacts(provider, { template: off, stackArn: "" })).findings).map((finding) => finding.kind)).toEqual(["iam-missing-grant"]);
    });

    it("does not read an Allow whose NotAction entries are all non-strings as matching every action", () => {
      const allow = foundation([{ Effect: "Allow", NotAction: [{ Ref: "SomeAction" }], Resource: "*" }]);
      const result = keyed(provider, keyedFacts(provider, { template: { Resources: {} }, foundationTemplate: allow }));
      expect(kinds(result.findings)).toContain("iam-missing-grant");
    });

    it("reports a definite Deny of the secret as iam-explicit-deny: no statements, no Tier 3 request", () => {
      const result = keyed(provider, keyedFacts(provider, { foundationTemplate: foundation([{ Effect: "Deny", Action: "secretsmanager:*", Resource: "*" }]) }));
      expect(result.ok).toBe(false);
      expect(kinds(result.findings)).toContain("iam-explicit-deny");
      expect(kinds(result.findings)).not.toContain("iam-missing-grant");
      const deny = result.findings.find((finding) => finding.kind === "iam-explicit-deny");
      expect(deny).toMatchObject({ severity: "error", roleLogicalId: WORKER_ROLE });
      expect(deny?.statements).toBeUndefined();
      expect(deny?.message).toContain(secretArnFor(provider));
      expect(tier3Request(result.findings)).toBe("");
    });

    it("never passes on a Deny it cannot judge", () => {
      const conditionalDeny = foundation([{ Effect: "Deny", Action: "secretsmanager:GetSecretValue", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }]);
      const maybe = keyed(provider, keyedFacts(provider, { foundationTemplate: conditionalDeny }));
      expect(maybe.ok).toBe(false);
      expect(errorsOf(maybe.findings)[0]).toMatchObject({ kind: "model-access-unverified" });
    });

    it("never reads or prints a secret value, and says in its info that the key is not checked without a call", () => {
      const result = keyed(provider);
      expect(JSON.stringify(result)).not.toMatch(/SecretString|get-secret-value|describe-secret/);
      expect(formatFindings(result.findings)).toContain("info model-access-unverified");
    });
  });

});

describe("IAM drift: ARN spellings and the evaluation note (Task 3.0 clean-ups)", () => {
  const PARTITION = { Ref: "AWS::Partition" };

  describe("iamEvaluationNotes", () => {
    it("always says what the IAM comparison does not evaluate", () => {
      const notes = iamEvaluationNotes(template(), template());
      const text = notes.join("\n");
      expect(text).toMatch(/ManagedPolicyArns/);
      expect(text).toMatch(/PermissionsBoundary/);
      expect(text).toMatch(/resource polic/i);
      expect(text).toMatch(/out-of-band/);
    });

    it("names the roles whose managed policies or boundary head or the deployed stack attaches, because those are not evaluated", () => {
      const head = JSON.parse(JSON.stringify(template())) as CfnTemplate;
      (head.Resources?.SessionsStepsServiceRole5DDD9E37?.Properties as Record<string, unknown>).ManagedPolicyArns = [{ "Fn::Join": ["", ["arn:", PARTITION, ":iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"]] }];
      const deployed = JSON.parse(JSON.stringify(template())) as CfnTemplate;
      (deployed.Resources?.BrokerServiceRole1938BCC9?.Properties as Record<string, unknown>).PermissionsBoundary = "arn:aws:iam::123456789012:policy/boundary";
      const notes = iamEvaluationNotes(head, deployed).join("\n");
      expect(notes).toContain("SessionsStepsServiceRole5DDD9E37");
      expect(notes).toContain("BrokerServiceRole1938BCC9");
      expect(iamEvaluationNotes(template(), template()).join("\n")).not.toContain("SessionsStepsServiceRole5DDD9E37");
    });

    it("bounds the list of roles, because nearly every Lambda role attaches the basic execution policy", () => {
      const many = { Resources: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`Role${index}`, { Type: "AWS::IAM::Role", Properties: { ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] } }])) } as CfnTemplate;
      const note = iamEvaluationNotes(many, many)[1] ?? "";
      expect(note).toContain("9 role(s)");
      expect(note).toContain("and 4 more");
      expect(note).not.toContain("Role8");
    });
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

describe("check report and exit codes", () => {

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

describe("the read-only reader (F6)", () => {
  const runnerThatAnswers = () => {
    const calls: Array<{ args: string[]; allowFailure: boolean | undefined }> = [];
    return { calls, runner: { aws: (args: readonly string[], allowFailure?: boolean) => { calls.push({ args: [...args], allowFailure }); return { status: 0, stdout: "{}", stderr: "" }; } } };
  };

  it("lists exactly the read verbs the check uses", () => {
    expect([...CHECK_READ_VERBS].sort()).toEqual([
      "bedrock get-foundation-model-availability", "bedrock get-inference-profile",
      "cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources",
      "dynamodb query", "dynamodb scan", "ec2 describe-instances", "ec2 describe-volumes", "iam get-role", "lambda get-function", "s3api get-object", "service-quotas list-service-quotas", "ssm get-parameter",
    ]);
  });

  it("passes an allowed read through with its arguments and allowFailure", () => {
    const { calls, runner } = runnerThatAnswers();
    readOnlyAws(runner).aws(["ssm", "get-parameter", "--name", "/x"], true);
    expect(calls).toEqual([{ args: ["ssm", "get-parameter", "--name", "/x"], allowFailure: true }]);
  });

  it("refuses anything else before it reaches the CLI: secrets, KMS, writes, invocations", () => {
    const { calls, runner } = runnerThatAnswers();
    const reader = readOnlyAws(runner);
    for (const args of [
      ["secretsmanager", "describe-secret"], ["secretsmanager", "get-secret-value"], ["kms", "decrypt"], ["ssm", "put-parameter"], ["ssm", "get-parameters"],
      ["ssm", "get-parameter-history"], ["cloudformation", "delete-stack"], ["lambda", "invoke"], ["bedrock-runtime", "converse"], ["dynamodb", "put-item"], ["iam", "create-role"], ["s3api", "put-object"], [],
    ]) {
      expect(() => reader.aws(args), args.join(" ")).toThrow(/read-only|not a read/);
    }
    expect(calls).toEqual([]);
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
  const KEYED_ARN = {
    anthropic: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/agentxlivetest123/anthropic-AbCdEf",
    openai: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/agentxlivetest123/openai-AbCdEf",
    openrouter: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/agentxlivetest123/openrouter-AbCdEf",
  };
  /** The SSM worker settings of an installation on each provider. "DENIED" makes the read fail with AccessDenied. */
  const PROVIDERS: Record<"bedrock" | "anthropic" | "openai" | "openrouter", Record<string, string>> = {
    bedrock: { "worker-model-provider": "amazon-bedrock" },
    anthropic: { "worker-model-provider": "anthropic", "worker-anthropic-secret-arn": KEYED_ARN.anthropic },
    openai: { "worker-model-provider": "openai", "worker-openai-secret-arn": KEYED_ARN.openai },
    openrouter: { "worker-model-provider": "openrouter", "worker-openrouter-secret-arn": KEYED_ARN.openrouter, "worker-openrouter-providers": "none" },
  };
  const SECRET_PREFIX = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" } as const;
  /** The deployed control-plane template's <Prefix>SecretRead policy, as infra/lib/model-keys.ts emits it, on the orchestrator role and the worker role. */
  const withSecretPolicy = (deployed: CfnTemplate, provider: keyof typeof SECRET_PREFIX): CfnTemplate => {
    const prefix = SECRET_PREFIX[provider];
    return {
      ...deployed,
      Conditions: { [`${prefix}Enabled`]: { "Fn::Not": [{ "Fn::Equals": [{ Ref: `${prefix}SecretArn` }, ""] }] } },
      Resources: {
        ...deployed.Resources,
        [`${prefix}SecretRead`]: {
          Type: "AWS::IAM::Policy",
          Condition: `${prefix}Enabled`,
          Properties: {
            PolicyName: `${prefix}SecretRead`,
            Roles: [{ Ref: "SlackOrchestratorTaskRole2372FE40" }, { "Fn::Select": [3, { "Fn::Split": ["/", { Ref: "Ec2WorkerInstanceRoleArn" }] }] }],
            PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: `${prefix}SecretArn` } }] },
          },
        },
      },
    };
  };
  function fakeAws(overrides: { instances?: string[]; launchTimes?: string[]; statusBody?: string | null; catalogItems?: unknown[]; brokerSha?: string; brokerKey?: string; bedrock?: BedrockMode; routeRows?: number; scan?: "denied"; agreement?: string; ssm?: Record<string, string>; secretPolicy?: keyof typeof SECRET_PREFIX;
    quotas?: "denied" | "garbage" | Array<[string, string, number]>; shapeRow?: "minimal" | "standard" | "unreadable"; testRow?: "driving/v1" | "single-call" | "unreadable" } = {}) {
    const calls: string[][] = [];
    const runner = {
      aws(args: readonly string[]): CommandResult {
        calls.push([...args]);
        const line = args.join(" ");
        if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
          const stack = args[args.indexOf("--stack-name") + 1];
          if (stack === `agentx-${ENV}-control-plane`) {
            const secretParameter = overrides.secretPolicy === undefined ? [] : [{ ParameterKey: `${SECRET_PREFIX[overrides.secretPolicy]}SecretArn`, ParameterValue: KEYED_ARN[overrides.secretPolicy] }];
            return ok({
              Outputs: [{ OutputKey: "StateTableName", OutputValue: "state-table" }, { OutputKey: "ArtifactBucketName", OutputValue: "artifacts" }],
              Parameters: [...secretParameter, { ParameterKey: "Ec2WorkerInstanceRoleArn", ParameterValue: "arn:aws:iam::123456789012:role/agentx/agentxlivetest123/worker-role" }],
            });
          }
          if (stack === `agentx-${ENV}-runtime`) return ok({ Parameters: [{ ParameterKey: "ExecutorImageUri", ParameterValue: ACCOUNT_IMAGE }] });
          if (stack === `agentx-${ENV}-foundation`) return ok({ Outputs: [{ OutputKey: "Ec2WorkerInstanceRoleArn", OutputValue: "arn:aws:iam::123456789012:role/worker-role" }] });
        }
        if (args[0] === "cloudformation" && args[1] === "get-template" && args[args.indexOf("--stack-name") + 1] === `agentx-${ENV}-foundation`) return ok(foundationTemplate());
        if (args[0] === "ssm" && args[1] === "get-parameter") {
          const name = args[args.indexOf("--name") + 1] ?? "";
          const setting = name.startsWith(`/agentx/${ENV}/`) ? name.slice(`/agentx/${ENV}/`.length) : name;
          const values = overrides.ssm ?? PROVIDERS.bedrock;
          const value = values[setting];
          if (value === "DENIED") return failed(`An error occurred (AccessDeniedException) when calling the GetParameter operation: User is not authorized to perform: ssm:GetParameter on resource: ${name}`);
          if (value === undefined) return failed(`An error occurred (ParameterNotFound) when calling the GetParameter operation:`);
          return ok({ Parameter: { Name: name, Type: "String", Value: value, Version: 1 } });
        }
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
            return ok({ modelId: args[args.indexOf("--model-id") + 1], agreementAvailability: { status: overrides.agreement ?? "AVAILABLE" }, authorizationStatus: mode === "unauthorized-model" ? "NOT_AUTHORIZED" : "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" });
          }
        }
        if (args[0] === "dynamodb" && args[1] === "scan") return overrides.scan === "denied" ? failed("AccessDeniedException: not authorized to perform: dynamodb:Scan") : ok({ Count: overrides.routeRows ?? 0 });
        if (args[0] === "cloudformation" && args[1] === "get-template") {
          const deployed = overrides.brokerKey === undefined ? brokerTemplate() : withKey(brokerTemplate(), "BrokerE1355FD6", overrides.brokerKey);
          return ok(overrides.secretPolicy === undefined ? deployed : withSecretPolicy(deployed, overrides.secretPolicy));
        }
        if (args[0] === "cloudformation" && args[1] === "list-stack-resources") return ok([["BrokerE1355FD6", "fn-broker"], [NOTIFIER, "fn-notifier"], ["SessionsSteps3B98DD2B", "fn-sessions"], ["Unrelated", "fn-other"]]);
        if (args[0] === "lambda" && args[1] === "get-function") {
          const name = args[args.indexOf("--function-name") + 1];
          return ok(`"${name === "fn-broker" && overrides.brokerSha !== undefined ? overrides.brokerSha : `sha-of-${name}`}"`);
        }
        if (args[0] === "service-quotas" && args[1] === "list-service-quotas") {
          if (overrides.quotas === "denied") return failed("An error occurred (AccessDeniedException) when calling the ListServiceQuotas operation: User is not authorized to perform: servicequotas:ListServiceQuotas");
          if (overrides.quotas === "garbage") return ok("not a list");
          return ok(overrides.quotas ?? []);
        }
        // The registry's own rows, read by key: the recorded request shape and the driving test's row.
        const registryKey = args[1] === "query" ? JSON.parse(args[args.indexOf("--expression-attribute-values") + 1] ?? "{}") as { ":pk"?: { S?: string }; ":sk"?: { S?: string } } : {};
        if (args[0] === "dynamodb" && args[1] === "query" && registryKey[":pk"]?.S === "E2E_MODEL_ROUTES") {
          const sk = registryKey[":sk"]?.S ?? "";
          if (sk.startsWith("E2E_MODEL_ROUTE_SHAPE#")) {
            if (overrides.shapeRow === "unreadable") return failed("AccessDeniedException: not authorized to perform: dynamodb:Query");
            return ok({ Items: overrides.shapeRow === undefined ? [] : [{ payloadShape: { S: overrides.shapeRow } }] });
          }
          if (sk.startsWith("E2E_MODEL_ROUTE_CANARY#")) {
            if (overrides.testRow === "unreadable") return failed("AccessDeniedException: not authorized to perform: dynamodb:Query");
            return ok({ Items: overrides.testRow === undefined ? [] : overrides.testRow === "driving/v1" ? [{ test: { S: "driving/v1" } }] : [{}] });
          }
          throw new Error(`unexpected registry query: ${sk}`);
        }
        if (args[0] === "dynamodb" && args[1] === "query") {
          return ok({ Items: overrides.catalogItems ?? [
            { sk: { S: "PROFILE#linux-arm64-web-api-v1#api" }, state: { S: "READY" }, expiresAt: { S: "2027-01-01T00:00:00.000Z" }, endpoint: { S: "http://10.0.1.5:8080" } },
            { sk: { S: "PROFILE#linux-arm64-web-api-v1#web" }, state: { S: "READY" }, expiresAt: { S: "2027-01-01T00:00:00.000Z" }, endpoint: { S: "http://10.0.1.5:8080" } },
          ] });
        }
        if (args[0] === "ec2" && args[1] === "describe-instances" && args.includes("--instance-ids")) return ok(overrides.launchTimes ?? ["2026-10-01T00:00:00+00:00"]);
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
  const changed: boolean | undefined = false;
  const gather = (fake: ReturnType<typeof fakeAws>) => gatherCheckFacts({
    runner: fake.runner, region: "us-east-1", env: ENV,
    headTemplate: () => template(),
    builtZips: async () => ({ shas: { BrokerE1355FD6: "b" }, sources: { BrokerE1355FD6: ["packages/broker/src/aws/broker.ts"] } }),
    headRevision: HEAD_REVISION,
    changedSince: (revision, paths) => { changes.push({ revision, paths: [...paths] }); return changed; },
  });

  describe("the model route", () => {

    describe("the AI navigation model the installation chose (Task 4.10A, test 13)", () => {
      const HAIKU_45_GLOBAL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
      const chosen = (modelId: string) => ({ "worker-model-provider": "amazon-bedrock", "worker-e2e-agent-model": modelId });

      it("derives the route from the setting: the chosen model is the one Bedrock is asked about, and the digest and the registry rows follow it", async () => {
        const fake = fakeAws({ ssm: chosen(HAIKU_45_GLOBAL), shapeRow: "minimal", testRow: "driving/v1" });
        const { facts } = await gather(fake);
        expect(facts.modelRoute?.choice).toEqual({ state: "chosen", modelId: HAIKU_45_GLOBAL });
        expect(facts.modelRoute?.provider).toEqual({ state: "known", route: { routeId: "rovara-e2e-default", provider: "amazon-bedrock", modelId: HAIKU_45_GLOBAL } });
        expect(fake.calls.find((call) => call[1] === "get-inference-profile")?.join(" ")).toContain(`--inference-profile-identifier ${HAIKU_45_GLOBAL}`);
        const derived = deriveE2EAgentRoute({ provider: "amazon-bedrock", region: "us-east-1", e2eModel: HAIKU_45_GLOBAL, payloadShape: "minimal" });
        if (derived.status !== "available") throw new Error("not available");
        const registryReads = fake.calls.filter((call) => call[1] === "query" && call.join(" ").includes("E2E_MODEL_ROUTES")).map((call) => (JSON.parse(call[call.indexOf("--expression-attribute-values") + 1]!) as { ":sk": { S: string } })[":sk"].S);
        expect(registryReads).toEqual([`E2E_MODEL_ROUTE_SHAPE#rovara-e2e-default#${HAIKU_45_GLOBAL}`, `E2E_MODEL_ROUTE_CANARY#rovara-e2e-default#${e2eAgentRouteDefinitionDigest(derived.definition)}`]);
        expect(facts.modelRoute?.tested).toEqual({ tested: true });
      });

      it("is an error, model-route-choice-unsupported, when the setting names a model the table does not list for the provider and region, and reads no Bedrock for it", async () => {
        for (const value of ["anthropic.claude-haiku-4-5-20251001-v1:0", "eu.anthropic.claude-haiku-5-5", "claude-haiku-5-5", "us.made-up-v1"]) {
          const fake = fakeAws({ ssm: chosen(value) });
          const { facts } = await gather(fake);
          expect(facts.modelRoute?.choice, value).toEqual({ state: "unsupported", setting: value });
          expect(fake.calls.filter((call) => call[0]?.startsWith("bedrock")), value).toEqual([]);
          const result = evaluateTestDeployCheck({ ...facts, now: NOW });
          expect(result.ok, value).toBe(false);
          const found = result.findings.find((finding) => finding.kind === "model-route-choice-unsupported");
          expect(found, value).toMatchObject({ severity: "error" });
          expect(found?.message).toContain("Amazon Bedrock");
        }
        // The same ids are judged against the keyed provider's own models.
        const keyed = evaluateTestDeployCheck({ ...(await gather(fakeAws({ ssm: { ...PROVIDERS.anthropic, "worker-e2e-agent-model": "us.anthropic.claude-haiku-5-5" } }))).facts, now: NOW });
        expect(keyed.findings.find((finding) => finding.kind === "model-route-choice-unsupported")?.message).toContain("Anthropic");
        const ok = await gather(fakeAws({ ssm: { ...PROVIDERS.anthropic, "worker-e2e-agent-model": "claude-haiku-4-5" } }));
        expect(ok.facts.modelRoute?.choice).toEqual({ state: "chosen", modelId: "claude-haiku-4-5" });
        expect(evaluateTestDeployCheck({ ...ok.facts, now: NOW }).findings.map((finding) => finding.kind)).not.toContain("model-route-choice-unsupported");
      });

    });

    describe.each(["anthropic", "openai", "openrouter"] as const)("keyed provider %s", (provider) => {
      const ssm = PROVIDERS[provider];
      const modelFindings = (result: ReturnType<typeof evaluateTestDeployCheck>) =>
        result.findings.filter((finding) => finding.subject === E2E_MODEL_ROUTE.routeId || finding.roleLogicalId === WORKER_ROLE);

      it("derives that provider's route, reads the secret ARN setting, and makes no Bedrock call", async () => {
        const fake = fakeAws({ ssm });
        const { facts } = await gather(fake);
        expect(facts.modelRoute?.provider).toEqual({ state: "known", route: { routeId: "rovara-e2e-default", provider, modelId: DEFAULT_E2E_AGENT_MODELS[provider] } });
        expect(facts.modelRoute?.bedrock).toBeUndefined();
        expect(fake.calls.filter((call) => call[0]?.startsWith("bedrock"))).toEqual([]);
        const read = fake.calls.filter((call) => call[0] === "ssm").map((call) => call[call.indexOf("--name") + 1]);
        expect(read).toContain(`/agentx/${ENV}/worker-${provider === "openrouter" ? "openrouter" : provider}-secret-arn`);
        expect(read).toContain(`/agentx/${ENV}/worker-model-provider`);
        expect(read.includes(`/agentx/${ENV}/worker-openrouter-providers`)).toBe(provider === "openrouter");
        expect(facts.modelRoute?.keyed?.secretArn).toEqual({ state: "read", value: KEYED_ARN[provider] });
        expect(facts.modelRoute?.keyed?.iam.roleLogicalId).toBe(WORKER_ROLE);
        expect(facts.modelRoute?.keyed?.iam.roleName).toBe("worker-role");
      });

      it("passes the worker role's read policy of the deployed control-plane template, with the stack's parameters, to the evaluation", async () => {
        const { facts } = await gather(fakeAws({ ssm, secretPolicy: provider }));
        const result = evaluateTestDeployCheck({ ...facts, now: NOW });
        expect(result.findings.filter((finding) => finding.kind === "iam-missing-grant" && finding.roleLogicalId === WORKER_ROLE)).toEqual([]);
        expect(modelFindings(result).filter((finding) => finding.severity === "error")).toEqual([]);
        expect(modelFindings(result).filter((finding) => finding.severity === "info").length).toBeGreaterThan(0);
        // Without the policy in the deployed template, the worker role lacks the grant.
        const lacking = evaluateTestDeployCheck({ ...(await gather(fakeAws({ ssm }))).facts, now: NOW });
        expect(lacking.findings.find((finding) => finding.kind === "iam-missing-grant" && finding.roleLogicalId === WORKER_ROLE)?.statements).toEqual([{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [KEYED_ARN[provider]] }]);
      });

      it("reports an unset ARN setting (none, or no parameter) as model-route-secret-missing and a denied read as unverifiable", async () => {
        const without = { ...ssm, [`worker-${provider}-secret-arn`]: "none" };
        const none = evaluateTestDeployCheck({ ...(await gather(fakeAws({ ssm: without }))).facts, now: NOW });
        expect(none.findings.map((finding) => finding.kind)).toContain("model-route-secret-missing");
        const { [`worker-${provider}-secret-arn`]: _gone, ...absent } = ssm;
        void _gone;
        expect(evaluateTestDeployCheck({ ...(await gather(fakeAws({ ssm: absent }))).facts, now: NOW }).findings.map((finding) => finding.kind)).toContain("model-route-secret-missing");
        const denied = await gather(fakeAws({ ssm: { ...ssm, [`worker-${provider}-secret-arn`]: "DENIED" } }));
        expect(denied.facts.modelRoute?.keyed?.secretArn.state).toBe("unverifiable");
        expect(evaluateTestDeployCheck({ ...denied.facts, now: NOW }).findings.find((finding) => finding.severity === "error" && finding.subject === E2E_MODEL_ROUTE.routeId)?.kind).toBe("model-access-unverified");
      });
    });

    it("reads the OpenRouter allowlist setting and reports one without anthropic", async () => {
      const { facts } = await gather(fakeAws({ ssm: { ...PROVIDERS.openrouter, "worker-openrouter-providers": "google-vertex" }, secretPolicy: "openrouter" }));
      expect(facts.modelRoute?.keyed?.openRouterProviders).toEqual({ state: "read", value: "google-vertex" });
      expect(evaluateTestDeployCheck({ ...facts, now: NOW }).findings.map((finding) => finding.kind)).toContain("model-route-openrouter-allowlist");
    });
  });

  describe("the automatic renewal (AUTOREQUALIFY, AR-5)", () => {
    const RENEWAL = "RuntimeRequalifyStepsAC5E645B";
    const dynamoText = (value: unknown): unknown => typeof value === "string" ? { S: value } : typeof value === "number" ? { N: String(value) } : value === null ? { NULL: true }
      : { M: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, dynamoText(inner)])) };
    const row = (fields: Record<string, unknown>) => (dynamoText(fields) as { M: unknown }).M;
    /** The fake with the renewal's Lambda in the deployed stack (and its renewal rows), or without it. */
    function withRenewal(installed: boolean, rows: Record<string, unknown> = {}, scheduleState?: string) {
      const fake = fakeAws();
      const original = fake.runner.aws.bind(fake.runner);
      fake.runner.aws = (args: readonly string[]): CommandResult => {
        if (installed && args[0] === "cloudformation" && args[1] === "get-template" && args[args.indexOf("--stack-name") + 1] === `agentx-${ENV}-control-plane`) {
          const deployed = brokerTemplate();
          return ok({ ...deployed, Resources: {
            ...deployed.Resources, [RENEWAL]: lambda("BrokerServiceRole1938BCC9"),
            ...(scheduleState === undefined ? {} : { RuntimeRequalifyDailyCheckFBF4C861: { Type: "AWS::Scheduler::Schedule", Properties: { State: scheduleState } } }),
          } });
        }
        if (installed && args[0] === "cloudformation" && args[1] === "list-stack-resources") return ok([["BrokerE1355FD6", "fn-broker"], [NOTIFIER, "fn-notifier"], ["SessionsSteps3B98DD2B", "fn-sessions"], [RENEWAL, "fn-renewal"]]);
        if (args[0] === "dynamodb" && args[1] === "query") {
          const values = JSON.parse(args[args.indexOf("--expression-attribute-values") + 1] ?? "{}") as { ":pk"?: { S?: string }; ":sk"?: { S?: string } };
          const key = `${values[":pk"]?.S}|${values[":sk"]?.S}`;
          if (key in rows) { fake.calls.push([...args]); return rows[key] === "DENIED" ? failed("AccessDeniedException: not authorized to perform: dynamodb:Query") : ok({ Items: rows[key] === undefined ? [] : [rows[key]] }); }
          if (key.startsWith("RUNTIME_REQUALIFY")) throw new Error(`unexpected renewal read: ${key}`);
        }
        return original(args);
      };
      return fake;
    }

    describe("the daily schedule (ARGUARD)", () => {
      const KEYS = { lock: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1|LOCK", hold: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1|HOLD", marker: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1|SCHEDULE_ENABLED", pointer: "E2E_MODEL_ROUTES|E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1" };
      const enabledRow = row({ pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "SCHEDULE_ENABLED", entityType: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED", at: "2026-10-20T06:00:00.000Z" });
      const gatherWith = async (fake: ReturnType<typeof fakeAws>) => {
        const heads: unknown[] = [];
        const result = await gatherCheckFacts({
          runner: fake.runner, region: "us-east-1", env: ENV,
          headTemplate: (options) => { heads.push(options); return template(); },
          builtZips: async (options) => ({ shas: { BrokerE1355FD6: "b", ...(options?.requalify === true ? { [RENEWAL]: "r" } : {}) }, sources: {} }),
          headRevision: HEAD_REVISION, changedSince: () => false,
        });
        const check = evaluateTestDeployCheck({ ...result.facts, runnerFacts: { ...GOOD_RUNNER, deployedExecutorImage: ACCOUNT_IMAGE, executorImage: ACCOUNT_IMAGE }, now: NOW });
        return { ...result, heads, errors: check.findings.filter((finding) => finding.severity === "error" && finding.kind.startsWith("requalify")) };
      };

      it("is an error when the deployed schedule is DISABLED after it was enabled, and the head synth then keeps the schedule enabled", async () => {
        const { facts, heads, errors } = await gatherWith(withRenewal(true, { [KEYS.lock]: undefined, [KEYS.hold]: undefined, [KEYS.pointer]: undefined, [KEYS.marker]: enabledRow }, "DISABLED"));
        expect(facts.requalify).toMatchObject({ state: "installed", schedule: { deployed: "DISABLED", enabledOnce: { state: "yes", at: "2026-10-20T06:00:00.000Z" } } });
        expect(errors).toEqual([expect.objectContaining({ kind: "requalify-schedule-off" })]);
        expect(heads).toEqual([{ requalify: true, scheduleEnabled: true }]);
      });

    });

    it("adds the automatic-renewal note to an expiry finding only where the renewal is installed (M3)", () => {
      const base = { headTemplate: {}, deployedTemplate: {}, lambdaCodeShas: {}, builtZipShas: {}, runnerFacts: undefined, now: NOW, catalogRows: [{ sk: "PROFILE#linux-arm64-web-api-v1#web", state: "READY", expiresAt: hoursFromNow(30) }] };
      const expiring = (requalify?: Parameters<typeof evaluateTestDeployCheck>[0]["requalify"]) =>
        evaluateTestDeployCheck({ ...base, ...(requalify === undefined ? {} : { requalify }) }).findings.find((finding) => finding.kind === "catalog-expiring")!.message;
      expect(expiring()).not.toContain("RuntimeRequalify");
      expect(expiring({ state: "not-installed" })).not.toContain("RuntimeRequalify");
      expect(expiring({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: { state: "none" } })).toContain("RuntimeRequalify");
    });

  });
});

describe("deployedFeatureCatalogId (ENV-ROOM)", () => {
  const withBroker = (variables: Record<string, unknown>): CfnTemplate => ({ Resources: { BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: variables } } } } });
  it("reads the literal a Broker is given whole", () => {
    expect(deployedFeatureCatalogId(withBroker({ AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: "catalog-1" }), "test")).toBe("catalog-1");
  });
  it("derives it from the environment's name for a packed Broker (AGENTX_NAMES, no literal), and only then", () => {
    expect(deployedFeatureCatalogId(withBroker({ AGENTX_NAMES: { "Fn::Join": ["", []] } }), "test")).toBe("agentx-test-e2e-mock-runtime-v1");
    expect(() => deployedFeatureCatalogId(withBroker({}), "test")).toThrow(/no literal AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID/u);
    expect(() => deployedFeatureCatalogId(withBroker({ AGENTX_NAMES: "x", AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: { Ref: "P" } }), "test")).toThrow(/no literal/u);
    expect(() => deployedFeatureCatalogId({ Resources: {} }, "test")).toThrow(/no literal/u);
  });
});
