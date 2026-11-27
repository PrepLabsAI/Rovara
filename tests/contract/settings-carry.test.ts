// F1 lanes L1a-0 and L1a-1: the "carried by" column. Each install row says how an upgrade supplies its value (carried.ts) and what happens when nothing supplies it. Since L1a-1 that is one
// rule for every engine (deploy/carry.ts): a parameter an upgrade does not supply keeps its deployed value. The engine tests that hold each engine to it are in templates-engine.test.ts
// (UsePreviousValue), cdk-engine.test.ts (the CDK CLI carries) and upgrade-export.test.ts (the bundle); this file pins the table to the rows and to the code that supplies each value.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARRIED_BY, INSTALL_ROWS, OMITTED_PARAMETER_BY_ENGINE, rowStackParameters, type CarriedByKind, type ReleaseManifest } from "@agentx/contracts";
import { carriedParameterNames, declaredParameterNames } from "../../packages/cli/src/deploy/carry.js";
import { OPERATOR_PARAMETERS, stackParameters, type DeployPart, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";
import { SIGN_IN_PARAMETER_NAMES, GITHUB_SIGN_IN_PARAMETER_NAMES } from "../../packages/cli/src/signin/settings.js";

const rowOf = (part: string, parameter: string) => {
  const row = INSTALL_ROWS.find((each) => each.install.part === part && each.install.parameter === parameter);
  if (row === undefined) throw new Error(`no row for ${part} ${parameter}`);
  return row;
};
const carriedBy = (part: string, parameter: string): readonly CarriedByKind[] => rowOf(part, parameter).install.carriedBy;

describe("the carried-by column (F1 L1a-0, L1a-1)", () => {
  it("names the sign-in settings as the carrier of the developer sign-in parameters and the Slack team id, and keeps every one of them on upgrade", () => {
    expect(CARRIED_BY["ssm-sign-in"].resetCondition).toContain("SSM holds no sign-in settings");
    for (const name of [...SIGN_IN_PARAMETER_NAMES, ...GITHUB_SIGN_IN_PARAMETER_NAMES]) {
      expect(carriedBy("control-plane", name), name).toEqual(["ssm-sign-in", "operator-kept"]);
      expect(OPERATOR_PARAMETERS["control-plane"], name).toContain(name);
    }
  });

  it("names the settings' models block as the carrier of the provider key secret ARNs, the model ids and the classifier", () => {
    for (const [part, name] of [["control-plane", "OpenRouterSecretArn"], ["runtime", "OpenRouterSecretArn"], ["slack", "OpenRouterSecretArn"], ["slack", "GateClassifierModelId"], ["runtime", "ModelId"], ["slack", "ModelId"]] as const) {
      expect(carriedBy(part, name), `${part} ${name}`).toContain("settings-models");
    }
    expect(CARRIED_BY["settings-models"].resetCondition).toContain("deployed value is carried");
    for (const part of ["control-plane", "runtime", "slack"] as const) expect(OPERATOR_PARAMETERS[part], part).toContain("OpenRouterSecretArn");
  });

  it("names the deployed stack as the carrier of GitHubAppId, and control-plane outputs for the Slack queue and table names", () => {
    expect(carriedBy("control-plane", "GitHubAppId")).toContain("deployed-stack");
    expect(CARRIED_BY["deployed-stack"].resetCondition).toContain("refuses");
    for (const name of ["ChannelRequestQueueUrl", "ChannelEventQueueUrl", "SlackAdapterCommandsUrl", "SlackAdapterSecretName"]) {
      expect(carriedBy("slack", name), name).toEqual(["control-plane-outputs", "operator-kept"]);
      expect(OPERATOR_PARAMETERS.slack, name).toContain(name);
    }
    for (const name of ["SlackCompanyStateTableName", "SlackCompanyTeamId"]) expect(carriedBy("slack", name), name).toEqual(["control-plane-outputs"]);
  });

  it("marks every kept parameter as carried by the operator-kept list, and nothing else as that", () => {
    const kept = new Set(Object.entries(OPERATOR_PARAMETERS).flatMap(([part, names]) => names.map((name) => `${part}/${name}`)));
    for (const row of INSTALL_ROWS) {
      const isKept = row.install.kept !== undefined;
      expect(row.install.carriedBy.includes("operator-kept"), row.key).toBe(isKept);
      if (row.install.parameter !== undefined && isKept) expect(kept.has(`${row.install.part}/${row.install.parameter}`), row.key).toBe(true);
    }
  });

  it("carries a parameter nothing supplies on every engine: the L1a-0 engine difference is gone", () => {
    const unsupplied = INSTALL_ROWS.filter((row) => row.install.carriedBy.length === 1 && row.install.carriedBy[0] === "none" && row.install.parameter !== undefined);
    expect(unsupplied.map((row) => row.install.parameter)).toContain("PromptCacheRetention");
    expect(CARRIED_BY.none.resetCondition).toContain("every engine and the upgrade bundle carry the deployed value");
    for (const engine of Object.values(OMITTED_PARAMETER_BY_ENGINE)) expect(engine).toMatch(/^is carried/u);
    expect(OMITTED_PARAMETER_BY_ENGINE.templates).toContain("UsePreviousValue");
    expect(OMITTED_PARAMETER_BY_ENGINE.cdk).toContain("UsePreviousValue");
    expect(OMITTED_PARAMETER_BY_ENGINE.productionRelease).toContain("UsePreviousValue");
  });

  it("never asks the CDK CLI (the cdk engine, the production release) to forget the previous parameter values", () => {
    for (const file of ["packages/cli/src/deploy/cdk-engine.ts", "scripts/release-production.ts", "scripts/release-common.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/no-previous-parameters/u);
    }
  });
});

describe("the one carry rule, as a function (F1 L1a-1)", () => {
  const template = JSON.stringify({ Parameters: { A: {}, B: {}, C: {} }, Resources: {} });

  it("reads a template's declared parameter names, or nothing from text that is not a template", () => {
    expect([...declaredParameterNames(template)!]).toEqual(["A", "B", "C"]);
    expect([...declaredParameterNames("{}")!]).toEqual([]);
    expect(declaredParameterNames("not json")).toBeUndefined();
    expect(declaredParameterNames("[1]")).toEqual(new Set());
  });

  it("carries each deployed parameter the template declares and the upgrade does not supply, in the stack's order", () => {
    expect(carriedParameterNames({ deployed: ["C", "A", "B"], declared: declaredParameterNames(template), supplied: ["A"] })).toEqual(["C", "B"]);
  });

  it("sends nothing for a name the new template no longer declares (CloudFormation refuses an undeclared one), and nothing for a parameter new to the template (it takes its default)", () => {
    expect(carriedParameterNames({ deployed: ["A", "Gone"], declared: declaredParameterNames(template), supplied: [] })).toEqual(["A"]);
    expect(carriedParameterNames({ deployed: ["A"], declared: declaredParameterNames(template), supplied: [] })).not.toContain("B");
  });

  it("carries nothing when the template cannot be read (no way to know which names CloudFormation would refuse)", () => {
    expect(carriedParameterNames({ deployed: ["A"], declared: undefined, supplied: [] })).toEqual([]);
  });
});

// S4 (Opus review of L1a-0): the `answers`, `none`, `stack-outputs` and `control-plane-outputs` values were not tied to the code. Here the rows are held to `stackParameters` itself, with the
// fullest answers and outputs it takes: a row that says `answers` (or an output kind) is named by it on its stack, and a row that says `none` never is. (A mutation of PermissionsBoundaryArn
// from `answers` to `none` fails this.)
describe("the carried-by values are the code's own (S4)", () => {
  const digest = (character: string) => character.repeat(64);
  const release: ReleaseManifest = {
    schemaVersion: 1, version: "1.0.0", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: {
      worker: `public.ecr.aws/agentx/agentx-worker@sha256:${digest("b")}`,
      slack: `public.ecr.aws/agentx/agentx-slack@sha256:${digest("c")}`,
      executor: `public.ecr.aws/agentx/agentx-executor@sha256:${digest("d")}`,
      gateway: `public.ecr.aws/agentx/agentx-gateway@sha256:${digest("e")}`,
    },
  };
  const arn = (service: string, resource: string) => `arn:aws:${service}:us-east-1:123456789012:${resource}`;
  const outputs = {
    access: { ArtifactBucketName: "bucket", CloudFormationRoleArn: arn("iam", "role/cf"), OperatorRoleArn: arn("iam", "role/op"), PullThroughPrefix: "agentx-staging" },
    foundation: {
      VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2", SessionManagerSecurityGroupId: "sg-0123456789abcdef0", DispatcherSecurityGroupId: "sg-0fedcba9876543210",
      WorkspaceKmsKeyArn: arn("kms", "key/k"), Ec2WorkerInstanceRoleArn: arn("iam", "role/worker"), Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c",
      NatEgressAddresses: "203.0.113.195,198.51.100.187",
    },
    identity: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123" },
    "control-plane": {
      ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", SlackOrchestratorTaskRoleArn: arn("iam", "role/slack-task"), SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo",
      SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b", SlackSecretArn: arn("secretsmanager", "secret:s-x"), OperatorAlertsTopicArn: arn("sns", "alerts"),
      ChannelRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/r.fifo", ChannelEventQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/e",
      SlackAdapterCommandsUrl: "https://abc.execute-api.us-east-1.amazonaws.com/v1/slack/channel", SlackAdapterSecretName: "agentx/staging/channel-adapter/slack",
      SlackCompanyStateTableName: "state", SlackCompanyTeamId: "T0INSTALL0",
    },
  };
  const fullest = (): InstallAnswers => ({
    env: "staging", region: "us-east-1", account: "123456789012", release,
    models: {
      orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6",
      providers: { orchestrator: "openrouter", classifier: "amazon-bedrock", worker: "openrouter" },
      openRouter: { secretArn: arn("secretsmanager", "secret:openrouter-AbCdEf"), providers: ["anthropic"] },
      anthropic: { secretArn: arn("secretsmanager", "secret:anthropic-AbCdEf") }, openai: { secretArn: arn("secretsmanager", "secret:openai-AbCdEf") },
    },
    identity: { mode: "cognito" },
    github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: arn("secretsmanager", "secret:agentx/staging/github-app-AbCdEf"), credentialRef: "github-agentx" },
    callbackSigningKey: "k".repeat(40),
    permissionsBoundaryArn: arn("iam", "policy/boundary"),
    operatorPrincipalArn: "arn:aws:iam::210987654321:role/operator", operatorExternalId: "an-external-id-1",
    slackAppPostedMessages: "accept", budget: { monthlyUsd: 150, scope: "account" }, setupPageUrl: "https://setup.example.com",
    coreEngine: { modelGatewayUrl: "https://gateway.example.dev", agentModel: "claude-sonnet-4-6" },
    gateway: { taskKeyIds: "abcdefghijklmnop", certificateArn: arn("acm", "certificate/11111111-2222-3333-4444-555555555555"), host: "gw.example.dev" },
    developerSignIn: {
      slackTeamId: "T0TEAM1",
      settings: {
        schemaVersion: 1, env: "staging", slack: true,
        oidc: { issuer: "https://login.example.com", clientId: "client", requiredClaim: "groups", requiredValues: ["admin"], displayName: "Acme", clientSecretName: "agentx/staging/developer-oidc" },
        github: { clientId: "gh-client", clientSecretName: "agentx/staging/developer-github" }, since: { slack: 1, oidc: 2, github: 3 },
        updatedAt: "2026-11-25T00:00:00.000Z", updatedBy: "someone",
      },
    },
  });
  const namedBy = (part: DeployPart): Set<string> => {
    const names = new Set<string>();
    const variants: InstallAnswers[] = [fullest(), { ...fullest(), identity: { mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx", adminClaim: "custom:roles", adminValues: ["admin"] } }];
    for (const answers of variants) {
      const withoutIdentity = { access: outputs.access, foundation: outputs.foundation, "control-plane": outputs["control-plane"] };
      const given = answers.identity.mode === "oidc" ? withoutIdentity : outputs;
      if (answers.identity.mode === "oidc" && part === "identity") continue;
      for (const name of Object.keys(stackParameters(part, answers, given, { packages: false }))) names.add(name);
    }
    return names;
  };
  const named = new Map((["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"] as DeployPart[]).map((part) => [part, namedBy(part)]));
  const rowsOfKind = (kind: CarriedByKind) => INSTALL_ROWS.flatMap((row) => (row.install.carriedBy.includes(kind) ? rowStackParameters(row).filter((each) => each.part === row.install.part).map((each) => ({ row, ...each })) : []));

  it.each(["answers", "stack-outputs", "control-plane-outputs", "ssm-sign-in", "settings-models"] as CarriedByKind[])("names every %s row on its stack when given everything it can take", (kind) => {
    for (const { row, part, parameter } of rowsOfKind(kind)) {
      if (row.install.declaredIn === "neither") continue;
      expect(named.get(part as DeployPart)!.has(parameter), `${kind}: ${part}/${parameter} (${row.key})`).toBe(true);
    }
  });

  it("never names a `none` row: nothing supplies it, so the deployed value is carried", () => {
    for (const { row, part, parameter } of rowsOfKind("none")) {
      if (parameter === undefined || row.install.declaredIn === "neither") continue;
      expect(named.get(part as DeployPart)!.has(parameter), `none: ${part}/${parameter}`).toBe(false);
    }
  });

  // F1 L1a-1 review (B1, R1, R2): the one carry rule keeps a parameter the CLI LEAVES OUT, so a parameter left out on purpose to fall back to the template's default would be stuck at its
  // old value. This enumerates every parameter `stackParameters` sends only sometimes (named with the fullest answers and outputs, not with the least) and requires each to be either in
  // CARRY_ON_PURPOSE below, with the reason carrying is right, or sent always. A new conditional parameter fails here until someone decides which.
  const minimalAnswers = (): InstallAnswers => ({
    env: "staging", region: "us-east-1", account: "123456789012", release: { ...release, images: { worker: release.images.worker, slack: release.images.slack, gateway: release.images.gateway } },
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
    identity: { mode: "cognito" },
    github: { appId: "123", privateKeySecretArn: arn("secretsmanager", "secret:agentx/staging/github-app-AbCdEf") },
    callbackSigningKey: "k".repeat(40),
    gateway: { taskKeyIds: "abcdefghijklmnop" },
  });
  const minimalOutputs = () => ({
    ...outputs,
    foundation: Object.fromEntries(Object.entries(outputs.foundation).filter(([name]) => name !== "NatEgressAddresses")),
    "control-plane": Object.fromEntries(Object.entries(outputs["control-plane"]).filter(([name]) => !["ChannelRequestQueueUrl", "ChannelEventQueueUrl", "SlackAdapterCommandsUrl", "SlackAdapterSecretName", "SlackCompanyStateTableName", "SlackCompanyTeamId"].includes(name))),
  });
  const CARRY_ON_PURPOSE: Record<string, string> = {
    "control-plane/GitHubAppCredentialRef": "an install-time label the answers carry only when set; a deployed one stays until the operator changes it",
    "control-plane/CoreModelGatewayHost": "the core engine answers are required on install; an upgrade keeps the deployed gateway unless the answers name another (kept list, gateway preflight reads it)",
    "control-plane/CoreAgentModel": "same as the gateway host: an upgrade keeps the deployed agent model unless the answers name another",
    "control-plane/SlackAppPostedMessages": "an operator setting (agentx config set) the upgrade's answers do not carry: it is in the kept list",
    "control-plane/BudgetMonthlyUsd": "the budget answers: an operator setting after install, kept on upgrade (kept list)",
    "control-plane/BudgetScope": "the budget answers: an operator setting after install, kept on upgrade (kept list)",
    "control-plane/NatEgressAddresses": "Rovara's outbound addresses, from the foundation's output when it has one; if the output goes away the stale list stays (deferred check: low impact, a list shown to owners)",
    "control-plane/AdminClaim": "OIDC identity only; the identity mode cannot change after install, so it is never un-sent",
    "control-plane/AdminValues": "OIDC identity only; the identity mode cannot change after install, so it is never un-sent",
    "control-plane/AnthropicSecretArn": "the provider's key ARN from the settings when configured; a key set by hand must survive a settings file without it (deferred check: stale grant if the provider is dropped)",
    "control-plane/OpenAISecretArn": "same as AnthropicSecretArn (deferred check)",
    "control-plane/OpenRouterSecretArn": "the plan's choice: settings without models.openRouter must not clear a key (kept list)",
    "gateway/CertificateArn": "optional operator ACM certificate ARN; omitted on default zero-domain self-hosted installs and kept across upgrades",
    "gateway/GatewayHost": "optional custom gateway hostname; omitted on default zero-domain self-hosted installs and kept across upgrades",
    "gateway/AnthropicSecretArn": "same as the control plane's AnthropicSecretArn (deferred check)",
    "gateway/OpenAISecretArn": "same as the control plane's OpenAISecretArn (deferred check)",
    "gateway/OpenRouterSecretArn": "same as the control plane's OpenRouterSecretArn (kept list)",
    "runtime/AnthropicSecretArn": "same as the control plane's (deferred check)",
    "runtime/OpenAISecretArn": "same as the control plane's (deferred check)",
    "runtime/OpenRouterSecretArn": "the plan's choice (kept list)",
    "runtime/OpenRouterProviders": "the routing list that goes with an OpenRouter key; stale if the key goes away (deferred check)",
    "runtime/ExecutorImageUri": "the release's executor image; a rollback to a release without one keeps the newer image (deferred check)",
    "slack/AnthropicSecretArn": "same as the control plane's (deferred check)",
    "slack/OpenAISecretArn": "same as the control plane's (deferred check)",
    "slack/OpenRouterSecretArn": "the plan's choice (kept list)",
    "slack/OpenRouterProviders": "same as runtime's (deferred check)",
    "slack/ChannelRequestQueueUrl": "from the control plane's outputs, which an older control plane lacks (kept list)",
    "slack/ChannelEventQueueUrl": "from the control plane's outputs, as the request queue above (kept list)",
    "slack/SlackAdapterCommandsUrl": "from the control plane's outputs, as the request queue above (kept list)",
    "slack/SlackAdapterSecretName": "from the control plane's outputs, as the request queue above (kept list)",
  };
  const conditionalNames = (): string[] => (["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"] as DeployPart[]).flatMap((part) => {
    const always = new Set(Object.keys(stackParameters(part, minimalAnswers(), minimalOutputs(), { packages: false })));
    return [...named.get(part)!].filter((name) => !always.has(name)).map((name) => `${part}/${name}`);
  });

  it("sends every parameter always, unless it is on the carry-on-purpose list with a reason (the ones that fall back to a default are always sent)", () => {
    const conditional = conditionalNames();
    // The sign-in family is supplied by the stored sign-in (kept list); every row of it is carried by `ssm-sign-in`.
    const signIn = (entry: string) => rowsOfKind("ssm-sign-in").some(({ part, parameter }) => `${part}/${parameter}` === entry);
    const undecided = conditional.filter((entry) => !signIn(entry) && !Object.hasOwn(CARRY_ON_PURPOSE, entry));
    expect(undecided, "a parameter stackParameters sends only sometimes: send it always (so it can fall back to its default), or list it in CARRY_ON_PURPOSE with the reason").toEqual([]);
    for (const [entry, reason] of Object.entries(CARRY_ON_PURPOSE)) expect(reason.length, entry).toBeGreaterThan(20);
  });

  it("lists nothing in CARRY_ON_PURPOSE that is now always sent or never sent", () => {
    const conditional = new Set(conditionalNames());
    for (const entry of Object.keys(CARRY_ON_PURPOSE)) expect(conditional.has(entry), `${entry} is not conditional any more: remove it from the list`).toBe(true);
  });

  it("sends the three parameters whose empty value means something always (B1 SetupPageUrl, R1 GateClassifierProvider, R2 OperatorExternalId)", () => {
    const sent = (part: DeployPart) => stackParameters(part, minimalAnswers(), minimalOutputs(), { packages: false });
    expect(sent("identity")).toMatchObject({ SetupPageUrl: "" });
    expect(sent("slack")).toMatchObject({ GateClassifierProvider: "amazon-bedrock" });
    expect(sent("access")).toMatchObject({ OperatorExternalId: "" });
  });

  it("names no operator-kept-only row (an operator sets it after install; no answer or output does)", () => {
    for (const row of INSTALL_ROWS) {
      if (row.install.carriedBy.length !== 1 || row.install.carriedBy[0] !== "operator-kept" || row.install.parameter === undefined) continue;
      for (const each of rowStackParameters(row)) expect(named.get(each.part as DeployPart)!.has(each.parameter), `operator-kept only: ${each.part}/${each.parameter}`).toBe(false);
    }
  });
});
