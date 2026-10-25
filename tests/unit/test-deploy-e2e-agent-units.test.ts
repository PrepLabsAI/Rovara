import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOY_UNITS, DEPLOY_UNITS, E2E_AGENT_SETTINGS_UNIT, assertOnlyExpectedChanges, formatPlan, liftDeclaredSettings, observedChanges, parseTestDeployArgs, planTestDeploy,
  type BuiltArtifacts, type CfnTemplate, type DeployStep, type StackParameters,
} from "../../scripts/test-deploy.js";
import type { Change } from "@aws-sdk/client-cloudformation";
import { readFileSync } from "node:fs";

// M1.4 Task 4.10A, test 12: the test-deploy units that put the AI navigation model setting on TEST.

const ENV = "agentxlivetest123";
const CONTROL_PLANE = "agentx-agentxlivetest123-control-plane";
const RUNTIME = "agentx-agentxlivetest123-runtime";
const OLD_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"a".repeat(64)}`;
const HAIKU_45_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const artifacts: BuiltArtifacts = { revision: "0123456789ab", outputDir: "/tmp/test-deploy-0123456789ab" };
const previous: StackParameters = {
  "control-plane": { OidcIssuer: "https://issuer.example", CallbackSigningKey: "****", AdminValues: "admin" },
  runtime: { ModelId: "model", ModelProvider: "amazon-bedrock", WorkerImageUri: OLD_IMAGE },
};
const withSetting: StackParameters = { ...previous, runtime: { ...previous.runtime, E2eAgentModelId: "default" } };
const plan = (only: Parameters<typeof planTestDeploy>[0]["only"], extra: Partial<Parameters<typeof planTestDeploy>[0]> = {}) =>
  planTestDeploy({ env: ENV, only, artifacts, previous, ...extra });
const kinds = (steps: DeployStep[]) => steps.map((step) => step.kind);
type ChangeSetStep = Extract<DeployStep, { kind: "create-change-set" }>;
const changeSetOf = (steps: DeployStep[]) => steps.find((step): step is ChangeSetStep => step.kind === "create-change-set")!;

describe("the e2e-agent-model unit", () => {
  it("is a unit of its own, never a default one", () => {
    expect(DEPLOY_UNITS).toContain("e2e-agent-model");
    expect(DEFAULT_DEPLOY_UNITS).not.toContain("e2e-agent-model");
  });

  it("adds the parameter and its SSM setting the first time: exactly two additions, lifted from a synth of the runtime stack, with the chosen model as the parameter's value", () => {
    const steps = plan(["e2e-agent-model"], { e2eModel: HAIKU_45_US });
    expect(kinds(steps)).toEqual(["create-change-set", "execute-change-set", "verify-stack-parameter"]);
    const changeSet = changeSetOf(steps);
    expect(changeSet.stack).toBe(RUNTIME);
    expect(changeSet.template).toEqual({
      source: "lift-resources", logicalIdPrefix: "WorkerE2eAgentModelParameter", parameterNames: ["E2eAgentModelId"], construct: "AgentXProductionRuntime", cdkContext: {}, identityMode: "cognito",
    });
    expect(changeSet.expect).toEqual({ action: "Add", logicalIdPrefixes: ["WorkerE2eAgentModelParameter"] });
    // The additions: one CloudFormation parameter and one SSM parameter resource.
    const template = changeSet.template as Extract<ChangeSetStep["template"], { source: "lift-resources" }>;
    expect((template.parameterNames ?? []).length + (changeSet.expect.logicalIdPrefixes ?? []).length).toBe(2);
    expect(changeSet.parameters).toEqual([
      { key: "E2eAgentModelId", literal: HAIKU_45_US },
      { key: "ModelId", usePreviousValue: true }, { key: "ModelProvider", usePreviousValue: true }, { key: "WorkerImageUri", usePreviousValue: true },
    ]);
    expect(steps[2]).toMatchObject({ stack: RUNTIME, key: "E2eAgentModelId", expected: { literal: HAIKU_45_US } });
  });

  it("changes only the setting's value afterwards, on the previous template", () => {
    const steps = plan(["e2e-agent-model"], { e2eModel: "global.anthropic.claude-haiku-4-5-20251001-v1:0", previous: withSetting });
    const changeSet = changeSetOf(steps);
    expect(changeSet.template).toEqual({ source: "previous" });
    expect(changeSet.expect).toEqual({ action: "Modify", logicalIdPrefixes: ["WorkerE2eAgentModelParameter"], allowedAttributes: ["Properties.Value"] });
    expect(changeSet.parameters.filter((parameter) => "literal" in parameter)).toEqual([{ key: "E2eAgentModelId", literal: "global.anthropic.claude-haiku-4-5-20251001-v1:0" }]);
    expect(changeSet.parameters.filter((parameter) => "usePreviousValue" in parameter).map((parameter) => parameter.key)).toEqual(["ModelId", "ModelProvider", "WorkerImageUri"]);
  });

  it("puts the recommendation back with default", () => {
    const steps = plan(["e2e-agent-model"], { e2eModel: "default", previous: withSetting });
    expect(changeSetOf(steps).parameters).toContainEqual({ key: "E2eAgentModelId", literal: "default" });
  });

  it("needs a model, and refuses one the table does not list for the stack's provider and region", () => {
    expect(() => plan(["e2e-agent-model"])).toThrow("e2e-agent-model needs --e2e-model <model id or default>");
    for (const bad of ["anthropic.claude-haiku-4-5-20251001-v1:0", "eu.anthropic.claude-haiku-5-5", "claude-haiku-5-5", "bad id", ""]) {
      expect(() => plan(["e2e-agent-model"], { e2eModel: bad }), bad).toThrow(/is not a model Rovara can use with amazon-bedrock in us-east-1/);
    }
    // The same id is eligible on another region's geography.
    expect(() => plan(["e2e-agent-model"], { e2eModel: "eu.anthropic.claude-haiku-5-5", region: "eu-west-1" })).not.toThrow();
    // A keyed provider is judged against its own models.
    const anthropic: StackParameters = { ...previous, runtime: { ...previous.runtime, ModelProvider: "anthropic" } };
    expect(() => plan(["e2e-agent-model"], { e2eModel: "claude-haiku-4-5", previous: anthropic })).not.toThrow();
    expect(() => plan(["e2e-agent-model"], { e2eModel: HAIKU_45_US, previous: anthropic })).toThrow(/with anthropic/);
  });

  it("refuses --e2e-model for any other unit, and refuses to combine the unit with another", () => {
    expect(() => plan(["broker"], { e2eModel: "default" })).toThrow("--e2e-model goes only with the e2e-agent-model unit");
    for (const other of ["broker", "dispatcher", "control-plane-code", "worker-image", "executor-image", "qualification-transport", "e2e-agent-settings", "model-fallback-settings"] as const) {
      expect(() => plan(["e2e-agent-model", other], { e2eModel: "default" }), other).toThrow(/changes a stack template or setting; run it on its own/);
    }
  });

  it("prints what it will do: the model, that it is a stack parameter and a setting, and that no image is built", () => {
    const text = formatPlan(plan(["e2e-agent-model"], { e2eModel: HAIKU_45_US }));
    expect(text).toContain(`E2eAgentModelId=${HAIKU_45_US}`);
    expect(text).toContain("WorkerE2eAgentModelParameter*");
    expect(text).not.toContain("image");
  });

  it("parses --e2e-model, and takes it only with --only e2e-agent-model", () => {
    const parsed = parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "e2e-agent-model", "--e2e-model", HAIKU_45_US]);
    expect(parsed).toMatchObject({ only: ["e2e-agent-model"], e2eModel: HAIKU_45_US });
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "e2e-agent-model"])).toThrow("e2e-agent-model needs --e2e-model <model id or default>");
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--e2e-model", "default"])).toThrow("--e2e-model goes only with --only e2e-agent-model");
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--check", "--e2e-model", "default"])).toThrow(/--check/);
  });
});

describe("the e2e-agent-settings unit", () => {
  it("is a unit of its own, never a default one", () => {
    expect(DEPLOY_UNITS).toContain("e2e-agent-settings");
    expect(DEFAULT_DEPLOY_UNITS).not.toContain("e2e-agent-settings");
    expect(() => plan(["e2e-agent-settings", "broker"])).toThrow(/e2e-agent-settings.*on its own/);
  });

  it("plans one change set on the control-plane stack that only modifies the broker's environment and the two role policies (two setting ARNs each), then reads the variable back", () => {
    const steps = plan(["e2e-agent-settings"]);
    expect(kinds(steps)).toEqual(["create-change-set", "execute-change-set", "verify-lambda-environment"]);
    const changeSet = changeSetOf(steps);
    expect(changeSet.stack).toBe(CONTROL_PLANE);
    expect(changeSet.template).toEqual({
      source: "lift-declared", construct: "AgentXControlPlane", cdkContext: { "agentx:e2eQualificationTransport": "enabled" }, identityMode: "cognito",
      environment: [{ logicalId: "BrokerE1355FD6", variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX" }],
      // Both settings' ARNs in both policies: 4.10A's worker-e2e-agent-model and 4.10D's worker-model-fallback.
      grants: E2E_AGENT_SETTINGS_UNIT.policies.flatMap((logicalId) => [`/agentx/${ENV}/worker-e2e-agent-model`, `/agentx/${ENV}/worker-model-fallback`].map((parameterName) => ({ logicalId, parameterName }))),
    });
    expect(E2E_AGENT_SETTINGS_UNIT.policies).toEqual(["BrokerServiceRoleDefaultPolicyDDFD9E7E", "SessionsStepsServiceRoleDefaultPolicy9F4B87C9"]);
    expect(changeSet.expect).toEqual({
      action: "Modify", logicalIds: ["BrokerE1355FD6", ...E2E_AGENT_SETTINGS_UNIT.policies],
      allowedAttributes: [], allowedAttributesByLogicalId: { BrokerE1355FD6: ["Properties.Environment"], ...Object.fromEntries(E2E_AGENT_SETTINGS_UNIT.policies.map((id) => [id, ["Properties.PolicyDocument"]])) },
      allowArnReevaluations: true, arnSources: ["BrokerE1355FD6"],
    });
    // Every parameter keeps its value.
    expect(changeSet.parameters.every((parameter) => "usePreviousValue" in parameter)).toBe(true);
    expect(steps[2]).toMatchObject({ stack: CONTROL_PLANE, logicalId: "BrokerE1355FD6", key: "AGENTX_E2E_AGENT_SETTINGS_PREFIX", expected: { literal: `/agentx/${ENV}/` } });
    expect(formatPlan(steps)).toContain("BrokerE1355FD6");
    expect(formatPlan(steps)).toContain("AGENTX_E2E_AGENT_SETTINGS_PREFIX");
  });

  it("accepts the change set only when the broker changes its Environment and each policy its PolicyDocument, and nothing else", () => {
    const expected = changeSetOf(plan(["e2e-agent-settings"])).expect;
    const own = [{ evaluation: "Static", changeSource: "DirectModification" }];
    const broker = { action: "Modify", logicalId: "BrokerE1355FD6", type: "AWS::Lambda::Function", replacement: "False", attributes: ["Properties.Environment"], details: own };
    const policies = E2E_AGENT_SETTINGS_UNIT.policies.map((logicalId) => ({ action: "Modify", logicalId, type: "AWS::IAM::Policy", replacement: "False", attributes: ["Properties.PolicyDocument"], details: own }));
    expect(() => assertOnlyExpectedChanges([broker, ...policies], expected)).not.toThrow();
    // A policy may change its document and not its roles, and the broker its environment and not its code or role.
    expect(() => assertOnlyExpectedChanges([{ ...broker, attributes: ["Properties.Environment", "Properties.Code"] }, ...policies], expected)).toThrow(/Properties\.Code/);
    expect(() => assertOnlyExpectedChanges([{ ...broker, attributes: ["Properties.PolicyDocument"] }, ...policies], expected)).toThrow(/Properties\.PolicyDocument/);
    expect(() => assertOnlyExpectedChanges([broker, { ...policies[0]!, attributes: ["Properties.PolicyDocument", "Properties.Roles"] }, ...policies.slice(1)], expected)).toThrow(/Properties\.Roles/);
    expect(() => assertOnlyExpectedChanges([broker, { ...policies[0]!, attributes: ["Properties.Environment"] }, ...policies.slice(1)], expected)).toThrow(/Properties\.Environment/);
    expect(() => assertOnlyExpectedChanges([{ ...broker, replacement: "True" }, ...policies], expected)).toThrow(/replac/);
    expect(() => assertOnlyExpectedChanges([broker, ...policies, { action: "Modify", logicalId: "SessionsSteps3B98DD2B", type: "AWS::Lambda::Function", attributes: ["Properties.Code"], details: own }], expected)).toThrow(/SessionsSteps3B98DD2B/);
    expect(() => assertOnlyExpectedChanges([broker, ...policies, { action: "Add", logicalId: "E2eModelDiscovery", type: "AWS::IAM::Policy" }], expected)).toThrow(/Add E2eModelDiscovery/);
    expect(() => assertOnlyExpectedChanges([broker, ...policies.slice(1)], expected)).toThrow(/missing the expected Modify/);
  });

  // DEPLOYFIX round 2: the change set CloudFormation made for this unit on TEST at b6cfedb4 (saved from the refused live run): the three declared Modifies and eight Modifies that only
  // re-evaluate the Broker's Arn (an API integration, an invoke permission whose Replacement is Conditional, three schedules, four role policies).
  describe("against the change set CloudFormation made for it on TEST", () => {
    const live = JSON.parse(readFileSync(new URL("../fixtures/test-deploy/control-plane-e2e-settings-change-set.json", import.meta.url), "utf8")) as { Changes: Change[] };
    const fresh = (): Change[] => JSON.parse(JSON.stringify(live.Changes)) as Change[];
    const expected = changeSetOf(plan(["e2e-agent-settings"])).expect;
    const check = (changes: Change[]) => assertOnlyExpectedChanges(observedChanges(changes), expected);
    const named = (changes: Change[], id: string) => changes.find((change) => change.ResourceChange?.LogicalResourceId === id)!.ResourceChange!;

    it("has the three declared Modifies and eight Arn re-evaluations, and passes", () => {
      const changes = fresh();
      expect(changes).toHaveLength(11);
      const result = check(changes);
      expect(result.noOpReevaluations.sort()).toEqual([
        "BrokerApiInvokeC6C766F0", "BrokerIntegration", "GithubWebhookRecoveryRoleDefaultPolicyDC13C89E", "GithubWebhookRecoverySchedule", "SlackIngressServiceRoleDefaultPolicy6F2F26FC",
        "WorkflowDispatchRecoveryRoleDefaultPolicy083213B6", "WorkflowDispatchRecoverySchedule", "WorkflowMergeRecoverySchedule",
      ]);
    });

    it("still refuses a Static detail on one of the extra resources", () => {
      const changes = fresh();
      Object.assign(named(changes, "BrokerIntegration").Details![0]!, { Evaluation: "Static", ChangeSource: "DirectModification", CausingEntity: undefined });
      expect(() => check(changes)).toThrow(/Modify BrokerIntegration/);
    });

    it("still refuses a re-evaluation caused by anything but a modified resource's Arn", () => {
      for (const causingEntity of ["SessionsSteps3B98DD2B.Arn", "BrokerE1355FD6", "BrokerE1355FD6.Role", "BrokerServiceRoleDefaultPolicyDDFD9E7E.Arn", "WorkerImageUri"]) {
        const changes = fresh();
        named(changes, "GithubWebhookRecoverySchedule").Details![0]!.CausingEntity = causingEntity;
        expect(() => check(changes), causingEntity).toThrow(/Modify GithubWebhookRecoverySchedule/);
      }
    });

    it("still refuses a Dynamic detail that is not a ResourceAttribute re-evaluation", () => {
      for (const changeSource of ["ParameterReference", "DirectModification", "Automatic"]) {
        const changes = fresh();
        named(changes, "WorkflowMergeRecoverySchedule").Details![0]!.ChangeSource = changeSource as never;
        expect(() => check(changes), changeSource).toThrow(/Modify WorkflowMergeRecoverySchedule/);
      }
    });

    it("still refuses a replacement of an extra resource, an Add and a Remove", () => {
      const replaced = fresh();
      named(replaced, "BrokerIntegration").Replacement = "True";
      expect(() => check(replaced)).toThrow(/Modify BrokerIntegration/);
      const added = fresh();
      added.push({ Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "NewQueue", ResourceType: "AWS::SQS::Queue" } });
      expect(() => check(added)).toThrow(/Add NewQueue/);
      const removed = fresh();
      removed.push({ Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: "OldQueue", ResourceType: "AWS::SQS::Queue" } });
      expect(() => check(removed)).toThrow(/Remove OldQueue/);
    });

    it("still refuses when the Broker itself changes more than its Environment, which would make its Arn re-evaluations real", () => {
      const changes = fresh();
      named(changes, "BrokerE1355FD6").Details!.push({ Target: { Attribute: "Properties", Name: "Code", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" });
      expect(() => check(changes)).toThrow(/Properties\.Code/);
    });
  });
});

describe("the model-fallback-settings unit", () => {
  const RUNTIME_WITH_FALLBACK: StackParameters = { ...previous, runtime: { ...previous.runtime, ModelFallback: "none" } };

  it("is a unit of its own, never a default one", () => {
    expect(DEPLOY_UNITS).toContain("model-fallback-settings");
    expect(DEFAULT_DEPLOY_UNITS).not.toContain("model-fallback-settings");
    for (const other of ["broker", "dispatcher", "control-plane-code", "worker-image", "executor-image", "qualification-transport", "e2e-agent-settings", "e2e-agent-model"] as const) {
      expect(() => plan(["model-fallback-settings", other]), other).toThrow(/changes a stack template or setting; run it on its own/);
    }
  });

  it("adds the parameter and its SSM setting, defaulting to none: exactly two additions lifted from a synth of the runtime stack, then reads the parameter back", () => {
    const steps = plan(["model-fallback-settings"]);
    expect(kinds(steps)).toEqual(["create-change-set", "execute-change-set", "verify-stack-parameter"]);
    const changeSet = changeSetOf(steps);
    expect(changeSet.stack).toBe(RUNTIME);
    expect(changeSet.template).toEqual({
      source: "lift-resources", logicalIdPrefix: "WorkerModelFallbackParameter", parameterNames: ["ModelFallback"], construct: "AgentXProductionRuntime", cdkContext: {}, identityMode: "cognito",
    });
    expect(changeSet.expect).toEqual({ action: "Add", logicalIdPrefixes: ["WorkerModelFallbackParameter"] });
    const template = changeSet.template as Extract<ChangeSetStep["template"], { source: "lift-resources" }>;
    expect((template.parameterNames ?? []).length + (changeSet.expect.logicalIdPrefixes ?? []).length).toBe(2);
    expect(changeSet.parameters).toEqual([
      { key: "ModelFallback", literal: "none" },
      { key: "ModelId", usePreviousValue: true }, { key: "ModelProvider", usePreviousValue: true }, { key: "WorkerImageUri", usePreviousValue: true },
    ]);
    expect(steps[2]).toMatchObject({ stack: RUNTIME, key: "ModelFallback", expected: { literal: "none" } });
  });

  it("refuses to plan once the runtime stack has the parameter, and points at the command that changes it", () => {
    expect(() => plan(["model-fallback-settings"], { previous: RUNTIME_WITH_FALLBACK })).toThrow(/already has ModelFallback.*models\.fallback/);
  });

  it("accepts the change set only when it adds the parameter's SSM setting and nothing else", () => {
    const expected = changeSetOf(plan(["model-fallback-settings"])).expect;
    const added = { action: "Add", logicalId: "WorkerModelFallbackParameter0A1B2C3D", type: "AWS::SSM::Parameter" };
    expect(() => assertOnlyExpectedChanges([added], expected)).not.toThrow();
    expect(() => assertOnlyExpectedChanges([added, { action: "Add", logicalId: "WorkerOtherParameter", type: "AWS::SSM::Parameter" }], expected)).toThrow(/Add WorkerOtherParameter/);
    expect(() => assertOnlyExpectedChanges([added, { action: "Modify", logicalId: "WorkerImageParameter", type: "AWS::SSM::Parameter", attributes: ["Properties.Value"] }], expected)).toThrow(/Modify WorkerImageParameter/);
    expect(() => assertOnlyExpectedChanges([{ ...added, action: "Modify" }], expected)).toThrow(/Modify WorkerModelFallbackParameter0A1B2C3D/);
  });

  it("prints what it will do, and takes no --e2e-model", () => {
    const text = formatPlan(plan(["model-fallback-settings"]));
    expect(text).toContain("ModelFallback=none");
    expect(text).toContain("WorkerModelFallbackParameter*");
    expect(text).not.toContain("image");
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "model-fallback-settings"])).toMatchObject({ only: ["model-fallback-settings"] });
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "model-fallback-settings", "--e2e-model", "default"])).toThrow("--e2e-model goes only with --only e2e-agent-model");
  });
});

describe("liftDeclaredSettings", () => {
  const PARAMETER = `/agentx/${ENV}/worker-e2e-agent-model`;
  const FALLBACK = `/agentx/${ENV}/worker-model-fallback`;
  const arn = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:parameter/agentx/${ENV}/${name}`]] });
  const policy = (resources: unknown[], extra: unknown[] = []) => ({
    Type: "AWS::IAM::Policy", Properties: { PolicyName: "P", Roles: [{ Ref: "R" }], PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "ssm:GetParameters", Resource: resources }, ...extra] } },
  });
  const OTHER = { Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::bucket/*" };
  // `added` names the settings whose ARN the policies carry: both in head, none in the deployed template of TEST, or one of them in a half-applied one.
  const template = (withNew: boolean, added: readonly string[] = withNew ? ["worker-e2e-agent-model", "worker-model-fallback"] : []): CfnTemplate => ({
    Resources: {
      BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "k" }, Environment: { Variables: { STATE_TABLE_NAME: "t", ...(withNew ? { AGENTX_E2E_AGENT_SETTINGS_PREFIX: `/agentx/${ENV}/` } : {}) } } } },
      P1: policy([arn("worker-image"), ...added.map(arn)], [OTHER]),
      P2: policy([arn("worker-image"), ...added.map(arn)]),
      Unrelated: { Type: "AWS::SQS::Queue", Properties: {} },
    },
  });
  const declared = { environment: [{ logicalId: "BrokerE1355FD6", variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX" }], grants: ["P1", "P2"].flatMap((logicalId) => [PARAMETER, FALLBACK].map((parameterName) => ({ logicalId, parameterName }))) };

  it("takes exactly the declared additions from head and leaves every other byte of the deployed template", () => {
    const deployed = template(false);
    const lifted = liftDeclaredSettings(deployed, template(true), declared);
    expect(lifted.Resources).toEqual(template(true).Resources);
    expect(deployed).toEqual(template(false));
  });

  it("keeps the deployed function's code, which the code units move and head's synth names differently", () => {
    const head = template(true);
    (head.Resources!["BrokerE1355FD6"]!.Properties as { Code: { S3Key: string } }).Code.S3Key = "head-asset-key";
    const lifted = liftDeclaredSettings(template(false), head, declared);
    expect((lifted.Resources!["BrokerE1355FD6"]!.Properties as { Code: { S3Key: string } }).Code.S3Key).toBe("k");
  });

  it("is a no-op when the deployed template already has them (a re-run)", () => {
    expect(liftDeclaredSettings(template(true), template(true), declared)).toEqual(template(true));
  });

  it("refuses when head differs from the deployed template by anything more than the declared additions", () => {
    const head = (mutate: (value: CfnTemplate) => void) => { const copy = template(true); mutate(copy); return copy; };
    const refusals: Array<[string, CfnTemplate]> = [
      ["another statement in a policy", head((t) => { (t.Resources!["P1"]!.Properties as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement.push({ Effect: "Allow", Action: "kms:Decrypt", Resource: "*" }); })],
      ["another resource in the ssm statement", head((t) => { ((t.Resources!["P2"]!.Properties as { PolicyDocument: { Statement: Array<{ Resource: unknown[] }> } }).PolicyDocument.Statement[0]!.Resource).push(arn("worker-other")); })],
      ["another environment variable", head((t) => { ((t.Resources!["BrokerE1355FD6"]!.Properties as { Environment: { Variables: Record<string, string> } }).Environment.Variables["OTHER"]) = "x"; })],
      ["a changed environment variable", head((t) => { ((t.Resources!["BrokerE1355FD6"]!.Properties as { Environment: { Variables: Record<string, string> } }).Environment.Variables["STATE_TABLE_NAME"]) = "other"; })],
      ["a changed property of the function", head((t) => { (t.Resources!["BrokerE1355FD6"]!.Properties as Record<string, unknown>)["Timeout"] = 900; })],
      ["changed roles of a policy", head((t) => { (t.Resources!["P1"]!.Properties as { Roles: unknown[] }).Roles = [{ Ref: "Other" }]; })],
    ];
    for (const [what, headTemplate] of refusals) expect(() => liftDeclaredSettings(template(false), headTemplate, declared), what).toThrow(/more than the declared|differs from head/);
  });

  it("takes both settings' ARNs into one policy: the second grant is judged against what the deployed policy lacks, not against the first one's result", () => {
    const lifted = liftDeclaredSettings(template(false), template(true), declared);
    for (const id of ["P1", "P2"]) {
      const resources = (lifted.Resources![id]!.Properties as { PolicyDocument: { Statement: Array<{ Resource: unknown[] }> } }).PolicyDocument.Statement[0]!.Resource;
      expect(resources, id).toEqual([arn("worker-image"), arn("worker-e2e-agent-model"), arn("worker-model-fallback")]);
    }
  });

  it("finishes a half-applied policy (one of the two ARNs already there)", () => {
    for (const present of [["worker-e2e-agent-model"], ["worker-model-fallback"]]) {
      expect(liftDeclaredSettings(template(false, present), template(true), declared).Resources, present.join()).toEqual(template(true).Resources);
    }
  });

  it("ignores the order of statements and of the lists inside them: IAM reads both as sets", () => {
    const deployed = template(false);
    for (const id of ["P1", "P2"]) {
      const document = (deployed.Resources![id]!.Properties as { PolicyDocument: { Statement: Array<{ Resource: unknown }> } }).PolicyDocument;
      document.Statement.reverse();
      for (const statement of document.Statement) if (Array.isArray(statement.Resource)) statement.Resource.reverse();
    }
    expect(liftDeclaredSettings(deployed, template(true), declared).Resources).toEqual(template(true).Resources);
  });

  it("refuses a second difference even when both declared ARNs are missing: an undeclared ARN, an extra statement in head, or a statement the deployed policy lacks", () => {
    const extraArn = template(true);
    ((extraArn.Resources!["P1"]!.Properties as { PolicyDocument: { Statement: Array<{ Resource: unknown[] }> } }).PolicyDocument.Statement[0]!.Resource).push(arn("worker-undeclared"));
    const extraStatement = template(true);
    (extraStatement.Resources!["P2"]!.Properties as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement.push({ Effect: "Allow", Action: "kms:Decrypt", Resource: "*" });
    const deployedLacksStatement = template(false);
    (deployedLacksStatement.Resources!["P1"]!.Properties as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement.pop();
    expect(() => liftDeclaredSettings(template(false), extraArn, declared), "an undeclared ARN").toThrow(/more than the declared grant/);
    expect(() => liftDeclaredSettings(template(false), extraStatement, declared), "an extra statement").toThrow(/more than the declared grant/);
    expect(() => liftDeclaredSettings(deployedLacksStatement, template(true), declared), "a statement the deployed policy lacks").toThrow(/more than the declared grant/);
  });

  it("refuses an ARN that is not declared: head carries the fallback's ARN and only the other setting is declared (what the unit did at df5a5a1e)", () => {
    const onlyFirst = { environment: declared.environment, grants: ["P1", "P2"].map((logicalId) => ({ logicalId, parameterName: PARAMETER })) };
    expect(() => liftDeclaredSettings(template(false), template(true), onlyFirst)).toThrow(/more than the declared grant for \/agentx\/agentxlivetest123\/worker-e2e-agent-model/);
  });

  describe("matches a declared ARN only as the exact entry CDK synthesizes (DEPLOYFIX review I-1, M-1)", () => {
    type Statement = { Sid?: string; Effect: string; Action: unknown; Resource: unknown[] };
    const statementsOf = (t: CfnTemplate, id: string) => (t.Resources![id]!.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement;
    const refused = (deployed: CfnTemplate, head: CfnTemplate) => expect(() => liftDeclaredSettings(deployed, head, declared)).toThrow(/more than the declared grant/);

    it("refuses a wildcard ARN that contains a declared name", () => {
      const head = template(true);
      statementsOf(head, "P1")[0]!.Resource.push(arn("worker-model-fallback*"));
      refused(template(false), head);
    });

    it("refuses another parameter whose name starts with a declared one", () => {
      const head = template(true);
      statementsOf(head, "P1")[0]!.Resource.push(arn("worker-e2e-agent-model-secret-arn"));
      refused(template(false), head);
    });

    it("refuses an ARN of any region and any account for a declared name", () => {
      const head = template(true);
      statementsOf(head, "P1")[0]!.Resource.push(`arn:aws:ssm:*:*:parameter${FALLBACK}`);
      refused(template(false), head);
      const otherAccount = template(true);
      statementsOf(otherAccount, "P2")[0]!.Resource.push({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":123456789012", `:parameter${PARAMETER}`]] });
      refused(template(false), otherAccount);
    });

    it("refuses a declared ARN listed twice in the holder statement", () => {
      const head = template(true);
      statementsOf(head, "P1")[0]!.Resource.push(arn("worker-model-fallback"));
      expect(() => liftDeclaredSettings(template(false), head, declared)).toThrow(/in exactly one statement/);
    });

    it("does not take the declared ARN out of a statement of another Action: a deployed ssm:PutParameter grant that head empties is a removal, not the declared change", () => {
      const deployed = template(false);
      statementsOf(deployed, "P1").push({ Effect: "Allow", Action: "ssm:PutParameter", Resource: [arn("worker-model-fallback")] });
      const head = template(true);
      statementsOf(head, "P1").push({ Effect: "Allow", Action: "ssm:PutParameter", Resource: [] });
      refused(deployed, head);
    });
  });

  it("refuses a policy that does not carry the parameter in head, a resource of another type, and a resource missing from either template", () => {
    expect(() => liftDeclaredSettings(template(false), template(false), { environment: [], grants: declared.grants })).toThrow(/head's P1 has no grant/);
    expect(() => liftDeclaredSettings(template(false), template(false), declared)).toThrow(/head's BrokerE1355FD6 does not set AGENTX_E2E_AGENT_SETTINGS_PREFIX/);
    const notPolicy = template(true);
    notPolicy.Resources!["P1"] = { Type: "AWS::SQS::Queue", Properties: {} };
    expect(() => liftDeclaredSettings(template(false), notPolicy, declared)).toThrow(/P1 is not an AWS::IAM::Policy/);
    const missing = template(true);
    delete missing.Resources!["P2"];
    expect(() => liftDeclaredSettings(template(false), missing, declared)).toThrow(/P2/);
    const noBroker = template(false);
    delete noBroker.Resources!["BrokerE1355FD6"];
    expect(() => liftDeclaredSettings(noBroker, template(true), declared)).toThrow(/BrokerE1355FD6/);
  });
});
