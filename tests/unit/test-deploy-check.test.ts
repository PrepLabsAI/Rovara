import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/protocol.js";
import {
  evaluateTestDeployCheck,
  findingLabel,
  formatFindings,
  lambdaRoleIds,
  parseRunnerStatus,
  type CatalogRowFact,
  type CheckInput,
  type Finding,
  type RunnerFacts,
} from "../../scripts/test-deploy-check.js";
import { assertCheckAllowsApply, gatherCheckFacts, main, parseTestDeployArgs, type CfnTemplate } from "../../scripts/test-deploy.js";

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
const READY_FEATURES = [...WORKER_INVOCATION_FEATURES];
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
    try {
      assertCheckAllowsApply(result.findings, ["control-plane-code"], template());
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Tier 3");
      expect(message).toContain(SESSIONS_POLICY);
      expect(message).toContain("ssm:GetParameters");
      expect(message).toContain("worker-executor-image");
    }
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
  function fakeAws(overrides: { instances?: string[]; statusBody?: string | null; catalogItems?: unknown[] } = {}) {
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
        if (args[0] === "cloudformation" && args[1] === "get-template") return ok(brokerTemplate());
        if (args[0] === "cloudformation" && args[1] === "list-stack-resources") return ok([["BrokerE1355FD6", "fn-broker"], [NOTIFIER, "fn-notifier"], ["SessionsSteps3B98DD2B", "fn-sessions"], ["Unrelated", "fn-other"]]);
        if (args[0] === "lambda" && args[1] === "get-function") return ok(`"sha-of-${args[args.indexOf("--function-name") + 1]}"`);
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
  const gather = (fake: ReturnType<typeof fakeAws>) => gatherCheckFacts({
    runner: fake.runner, region: "us-east-1", env: ENV,
    headTemplate: () => template(),
    builtZipShas: async () => ({ BrokerE1355FD6: "b" }),
  });

  it("reads the deployed template, code hashes, catalog rows and the runner's status, and only reads", async () => {
    const fake = fakeAws();
    const { facts } = await gather(fake);
    expect(facts.lambdaCodeShas).toEqual({ BrokerE1355FD6: "sha-of-fn-broker", [NOTIFIER]: "sha-of-fn-notifier", SessionsSteps3B98DD2B: "sha-of-fn-sessions" });
    expect(facts.builtZipShas).toEqual({ BrokerE1355FD6: "b" });
    expect(facts.catalogRows.map((row) => row.sk).sort()).toEqual(["PROFILE#linux-arm64-web-api-v1#api", "PROFILE#linux-arm64-web-api-v1#web"]);
    expect(facts.runnerFacts).toEqual({ deployedExecutorImage: ACCOUNT_IMAGE, executorImage: ACCOUNT_IMAGE, invocationFeatures: ["task.readiness"] });
    const readOnly = ["cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources", "lambda get-function", "dynamodb query", "ec2 describe-instances", "iam get-role", "s3api get-object"];
    for (const call of fake.calls) expect(readOnly, call.join(" ")).toContain(`${call[0]} ${call[1]}`);
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

  it("refuses a deployed Broker with no catalog ID rather than checking nothing", async () => {
    const fake = fakeAws();
    const original = fake.runner.aws.bind(fake.runner);
    fake.runner.aws = (args: readonly string[]) => (args[1] === "get-template" ? ok(template()) : original(args));
    await expect(gather(fake)).rejects.toThrow(/AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID/);
  });
});
