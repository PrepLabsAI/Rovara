import { App, Stack } from "aws-cdk-lib";
import { withoutGithubSignIn } from "../support/github-signin-template.js";
import { withoutSavedEnvImages } from "../support/saved-env-images-template.js";
import { withoutSavedEnvSwitch } from "../support/saved-env-switch-template.js";
import { withoutBrokerSlackPoster } from "../support/broker-slack-poster-template.js";
import { withoutChatGptKeyDeny } from "../support/chatgpt-key-deny-template.js";
import { withoutCompanyImportReads } from "../support/company-import-reads-template.js";
import { withoutDispatcherHookSigner } from "../support/dispatcher-hook-signer-template.js";
import { withoutWorkerSandboxEgress } from "../support/worker-sandbox-egress-template.js";
import { Template } from "aws-cdk-lib/assertions";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { withoutCoreModelAccessRoute } from "../support/core-model-access-template.js";
import { withoutCoreEngine } from "../support/core-engine-template.js";
import { withoutSwitchoverControlPlaneParity } from "../support/switchover-parity-template.js";
import { withoutNatEgressControlPlane } from "../support/egress-addresses-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { removePackedPieces, unpackedBrokerVariables, withoutBrokerNamesParameter } from "../support/broker-environment-template.js";
import { withoutSlackCompanyMode } from "../support/slack-company-template.js";

skipLambdaBundling();

type TemplateJson = {
  Parameters?: Record<string, Record<string, unknown>>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown> }>;
};

function namedTemplate(env: string, account = "944937319445", region = "us-east-1"): TemplateJson {
  const rendered: unknown = Template.fromStack(new ControlPlaneStack(new App(), `Proof-${env}-${account}-${region}`, {
    env: { account, region }, naming: environmentNaming(env),
  })).toJSON();
  return withoutSlackCompanyMode(rendered, { proof: env === "agentxlivetest123" }) as TemplateJson;
}

function proofEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([logicalId]) => logicalId.includes("TaskPersonProof"));
}

function workflowDependencyEnvironmentEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
}

function runtimeCatalogEnvironmentEntries(template: TemplateJson) {
  const brokers = workflowDependencyEnvironmentEntries(template);
  const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(brokers, "one Broker owns both runtime catalog IDs").toHaveLength(1);
  expect(dispatchers, "one Dispatcher owns the project setup catalog ID").toHaveLength(1);
  const brokerVariables = brokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  const dispatcherVariables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  // ENV-ROOM: a named broker derives both catalog ids from AGENTX_ENV (tests/support/broker-environment-template.ts gives the derived literal).
  return { broker: unpackedBrokerVariables(brokerVariables.Variables, template as never), dispatcher: dispatcherVariables.Variables };
}

function expectRuntimeCatalogEnvironment(template: TemplateJson, prefix: string) {
  const { broker, dispatcher } = runtimeCatalogEnvironmentEntries(template);
  const setupId = `${prefix}-project-setup-runtime-v1`;
  const featureId = `${prefix}-e2e-mock-runtime-v1`;
  expect(broker.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
  expect(broker.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe(featureId);
  expect(dispatcher.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
  expect(dispatcher).not.toHaveProperty("AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID");
}

function appControlPlane(env: string): TemplateJson {
  const stacks = buildAgentXApp({ agentxEnv: env }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const stack = stacks.find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return withoutSlackCompanyMode(Template.fromStack(stack).toJSON(), { proof: env === "agentxlivetest123" }) as TemplateJson;
}

function parentRemainderDigest(template: TemplateJson, named = true): string {
  const remainder = structuredClone(template);
  withoutCoreModelAccessRoute(remainder);
  // The core engine's named-environment addition (E2) is checked in full by core-engine-infrastructure.test.ts. A named environment must carry it (its shape is asserted as it is removed);
  // #1148: the legacy template carries it too now (off by default), and its digest pins it whole, so only a named template has it taken out.
  if (named && remainder.Parameters?.CoreTaskCapUsd !== undefined) {
    withoutCoreEngine(remainder);
    // The switch-over parity additions of a named control plane (switchover-parity-infrastructure.test.ts); shape asserted, then taken out.
    withoutSwitchoverControlPlaneParity(remainder);
    // L4-EGR: the NatEgressAddresses parameter and the broker variable that reads it (egress-addresses-infrastructure.test.ts).
    withoutNatEgressControlPlane(remainder);
  } else if (named) expect(JSON.stringify(remainder), "only a template without the core engine may skip its removal").not.toContain("CoreEngine");
  delete remainder.Parameters?.TaskPersonProofEnabled;
  // Spec 059's default-OFF runtime graph addition is asserted exactly below; exclude only that
  // named parameter and its corresponding Broker environment reference from the proof-only hash.
  delete remainder.Parameters?.WorkflowDependenciesEnabled;
  const conditions = remainder.Conditions ?? {};
  for (const id of Object.keys(conditions)) if (id.includes("InstallTaskPersonProof")) delete conditions[id];
  const resources = remainder.Resources ?? {};
  for (const id of Object.keys(resources)) if (id.startsWith("TaskPersonProof")) delete resources[id];
  const dispatchers = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(dispatchers, "the actual Dispatcher remains in the parent template remainder").toHaveLength(1);
  const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  delete variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN;
  delete variables.Variables.SLACK_TEAM_ID;
  delete variables.Variables.DEVELOPER_SIGNIN_TABLE_NAME;
  for (const [id] of workflowDependencyEnvironmentEntries(remainder)) {
    const brokerVariables = resources[id]!.Properties!.Environment as { Variables: Record<string, unknown> };
    delete brokerVariables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED;
    // ENV-ROOM: in a named Broker the flag is the `wd` piece of AGENTX_SETTINGS.
    if (brokerVariables.Variables.AGENTX_SETTINGS !== undefined) removePackedPieces(brokerVariables.Variables, "AGENTX_SETTINGS", ["wd"]);
    delete brokerVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
    delete brokerVariables.Variables.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID;
  }
  for (const [, resource] of Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function")) {
    const dispatcherVariables = resource.Properties!.Environment as { Variables: Record<string, unknown> };
    delete dispatcherVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
  }
  // This separately tested, least-privilege creator fence is the only additional sign-in-table
  // statement. Remove only its exact action/resource pair so historical parent hashes stay scoped.
  for (const entry of developerSignInConditionCheckEntries(remainder)) {
    const policy = resources[entry.policyId]!;
    const document = policy.Properties!.PolicyDocument as { Statement: unknown };
    if (Array.isArray(document.Statement)) document.Statement.splice(entry.index, 1);
    else delete (document as { Statement?: unknown }).Statement;
  }
  const establishedAssetHashNormalization = JSON.stringify(remainder).replace(/[a-f0-9]{64}/g, "<asset-hash>");
  return createHash("sha256").update(establishedAssetHashNormalization).digest("hex");
}

/**
 * Owner DEC 254zzz73 (rule D, a removal): the step-up's removal took exactly these out of a named or foreign control plane: the StepUpEmailSender parameter (after
 * McpConfirmElicitation), the sign-in function's STEP_UP_EMAIL_FROM and DEVELOPER_PASSKEYS variables (after POLICY_HOOK_KEY_ARN), and its ses:SendEmail and PASSKEYS# Query/DeleteItem
 * statements (the 7th and 8th of its default policy). Putting exactly those back, where they stood, must give the pre-removal pins: the proof that nothing else moved.
 */
function withStepUpRestored(template: TemplateJson): TemplateJson {
  const restored = structuredClone(template);
  const insertAfter = <T>(record: Record<string, T>, after: string, entries: Array<[string, T]>): Record<string, T> => {
    const list = Object.entries(record);
    const at = list.findIndex(([key]) => key === after);
    expect(at, `${after} is where the removed entries stood`).toBeGreaterThanOrEqual(0);
    list.splice(at + 1, 0, ...entries);
    return Object.fromEntries(list);
  };
  restored.Parameters = insertAfter(restored.Parameters ?? {}, "McpConfirmElicitation", [["StepUpEmailSender", {
    Type: "String", Default: "", AllowedPattern: "^$|^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\\.[A-Za-z]{2,63}$",
    Description: "The verified Amazon SES email identity (one address) that sends step-up codes; empty: no emailed codes (passkeys only)", MaxLength: 254,
  }]]);
  const resources = restored.Resources ?? {};
  const fn = Object.entries(resources).filter(([id, resource]) => id.startsWith("DeveloperSignInFunction") && resource.Type === "AWS::Lambda::Function");
  expect(fn).toHaveLength(1);
  const environment = fn[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  environment.Variables = insertAfter(environment.Variables, "POLICY_HOOK_KEY_ARN", [["STEP_UP_EMAIL_FROM", { Ref: "StepUpEmailSender" }], ["DEVELOPER_PASSKEYS", "enabled"]]);
  const policies = Object.entries(resources).filter(([id]) => id.startsWith("DeveloperSignInFunctionServiceRoleDefaultPolicy"));
  expect(policies).toHaveLength(1);
  const statements = (policies[0]![1].Properties!.PolicyDocument as { Statement: unknown[] }).Statement;
  const table = Object.keys(resources).find((id) => id.startsWith("DeveloperSignInTable") && resources[id]!.Type === "AWS::DynamoDB::Table")!;
  statements.splice(6, 0,
    { Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": { Ref: "StepUpEmailSender" } } }, Effect: "Allow",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ses:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":identity/", { Ref: "StepUpEmailSender" }]] } },
    { Action: ["dynamodb:Query", "dynamodb:DeleteItem"], Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PASSKEYS#*"] }, Null: { "dynamodb:LeadingKeys": "false" } }, Effect: "Allow",
      Resource: { "Fn::GetAtt": [table, "Arn"] } },
  );
  return restored;
}

function realAppControlPlane(env?: string): TemplateJson {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const stackName = env === undefined ? "AgentXControlPlane" : `agentx-${env}-control-plane`;
  const stack = stacks.find((candidate) => candidate.stackName === stackName);
  if (stack === undefined) throw new Error(`expected actual app control-plane stack ${stackName}`);
  const template = Template.fromStack(stack).toJSON();
  return env === undefined ? template : withoutSlackCompanyMode(template, { proof: env === "agentxlivetest123" }) as TemplateJson;
}

function normalizeSingleton(value: unknown): unknown {
  // CDK may emit one IAM Action/Resource as a scalar or a singleton array; normalize only that shape.
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function developerSignInConditionCheckEntries(template: TemplateJson): Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> {
  const resources = template.Resources ?? {};
  const signInTable = Object.entries(resources).find(([id, resource]) => id.startsWith("DeveloperSignInTable") && resource.Type === "AWS::DynamoDB::Table");
  const brokerRole = Object.entries(resources).find(([id, resource]) => id.startsWith("BrokerServiceRole") && resource.Type === "AWS::IAM::Role");
  if (signInTable === undefined || brokerRole === undefined) return [];
  const [tableId] = signInTable;
  const roleId = brokerRole[0];
  const expectedResource = { "Fn::GetAtt": [tableId, "Arn"] };
  const entries: Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> = [];
  for (const [policyId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const properties = resource.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: unknown } } | undefined;
    const roles = Array.isArray(properties?.Roles) ? properties.Roles as Array<Record<string, unknown>> : [];
    if (!roles.some((role) => role.Ref === roleId)) continue;
    const rawStatements = properties?.PolicyDocument?.Statement;
    const statements = Array.isArray(rawStatements) ? rawStatements : rawStatements === undefined ? [] : [rawStatements];
    statements.forEach((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const statement = value as Record<string, unknown>;
      if (normalizeSingleton(statement.Action) === "dynamodb:ConditionCheckItem"
        && JSON.stringify(statement.Resource) === JSON.stringify(expectedResource)) {
        entries.push({ policyId, index, statement, tableId });
      }
    });
  }
  return entries;
}

describe("the named TEST proof-only installation gate", () => {
  it("declares a distinct default-OFF gate only for the approved named environment", () => {
    const approved = namedTemplate("agentxlivetest123");
    const foreign = namedTemplate("staging", "123456789012");
    const wrongAccount = namedTemplate("agentxlivetest123", "123456789012");
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "Legacy")).toJSON() as TemplateJson;

    expect(approved.Parameters?.TaskPersonProofEnabled).toMatchObject({
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(proofEntries(approved).length).toBeGreaterThan(0);
    expect(approved.Parameters?.TaskPeopleChangesEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(foreign.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(foreign)).toHaveLength(0);
    expect(wrongAccount.Parameters?.TaskPersonProofEnabled).toMatchObject({ Default: "false" });
    expect(proofEntries(wrongAccount).length).toBeGreaterThan(0);
    expect(legacy.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(legacy)).toHaveLength(0);
  });

  it("preserves exact parent app templates outside the named proof addition", () => {
    const named = realAppControlPlane("agentxlivetest123");
    const foreign = realAppControlPlane("staging");
    const legacy = realAppControlPlane();
    expectRuntimeCatalogEnvironment(named, "agentx-agentxlivetest123");
    expectRuntimeCatalogEnvironment(foreign, "agentx-staging");
    expectRuntimeCatalogEnvironment(legacy, "agentx-production");

    for (const [label, template] of [["staging", foreign], ["legacy", legacy]] as const) {
      expect(template.Parameters?.TaskPersonProofEnabled, `${label} has no proof-only parameter`).toBeUndefined();
      expect(proofEntries(template), `${label} has no proof-only resources`).toHaveLength(0);
      const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
      expect(dispatchers, `${label} has its ordinary Dispatcher`).toHaveLength(1);
      const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
        expect(variables.Variables, `${label} has no proof-only ${key}`).not.toHaveProperty(key);
      }
    }

    for (const [label, template] of [["named", named], ["foreign", foreign]] as const) {
      expect(template.Parameters?.WorkflowDependenciesEnabled, `${label} preserves the default-OFF workflow gate`).toMatchObject({
        Type: "String", Default: "false", AllowedValues: ["true", "false"],
      });
      const broker = workflowDependencyEnvironmentEntries(template);
      expect(broker, `${label} has exactly one Broker with the workflow flag`).toHaveLength(1);
      const variables = broker[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      // ENV-ROOM: in a named Broker the flag is the parameter's piece of AGENTX_SETTINGS.
      expect(unpackedBrokerVariables(variables.Variables, template as never).AGENTX_WORKFLOW_DEPENDENCIES_ENABLED, `${label} wires only the parameter reference`).toEqual({ Ref: "WorkflowDependenciesEnabled" });
    }
    expect(legacy.Parameters?.WorkflowDependenciesEnabled, "legacy (production) has the workflow gate parameter, off").toMatchObject({ Default: "false" });
    const legacyBrokers = workflowDependencyEnvironmentEntries(legacy);
    expect(legacyBrokers, "legacy has its Broker Lambda").toHaveLength(1);
    const legacyVariables = legacyBrokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
    // #1149: the legacy Broker packs it as well.
    expect(unpackedBrokerVariables(legacyVariables.Variables, legacy as never).AGENTX_WORKFLOW_DEPENDENCIES_ENABLED, "legacy wires only the parameter reference").toEqual({ Ref: "WorkflowDependenciesEnabled" });

    // Named/foreign pins include the reviewed destination identity grant and dependency; legacy pins are unchanged. Named/foreign re-pinned for lane E2 (the core engine construct, #663,
    // and R2 step 4: the dispatcher's core queue mapping, its reads, the conditional deleter policy, its variables and the outbox pending index); legacy unchanged.
    // #722: named/foreign re-pinned for the combined stacked baseline (#689 + R2 step 4; no template change of #722's own), the same values as L1a (#731) measured before its edits.
    // ENV-ROOM (pr/broker-env-diet): named/foreign re-pinned for the packed broker environment (AGENTX_NAMES, AGENTX_SETTINGS, AGENTX_ACCOUNT_ID; the snapshot diff is the broker's Variables only); legacy unchanged.
    // Switch-over incident 2026-11-16: named and foreign re-pinned for the CoreAppRoute -> AppRoute construct rename (logical ID DeveloperSignInAppRouteBAD38FAA); only ordering moves.
    // Core gateway settings (2026-11-17): named and foreign re-pinned because the broker derives CHANNEL_ADAPTER_SECRET_PREFIX (that one variable leaves the broker; checked in
    // core-gateway-settings.test.ts and verified: with the variable passed as before, the old pins hold); legacy unchanged.
    // Guided onboarding PR 4 (#836, DEC 254r item 2): named and foreign re-pinned for the sign-in Lambda's one Slack workspace token statement (secretsmanager CreateSecret,
    // PutSecretValue, GetSecretValue on agentx/<env>/slack-workspaces/*; developer-signin-infrastructure.test.ts pins it exactly). Verified: with only that statement removed, the old pins hold; legacy unchanged.
    // DEC 254za: all six re-pinned for the callback signing key's secret (legacy included): the secret, its resource policy, the CALLBACK_SIGNING_KEY_SECRET_ID variables and the dispatcher's conditional read.
    // Batch 12 (second-merge re-pin of #872 over #865, plus #871's Linear webhook route; DEC 254za, DEC 254y, rule D): named and foreign re-pinned. Verified on this tree: with only
    // LinearWebhookRoute and #865's one slack-workspaces statement removed, #872's approved pins hold exactly (named fd809c0e/98b1dae8, foreign ca40bea2/694d8393); legacy unchanged.
    // DEC 254zg (a), owner-approved re-pin (#891): #865's slack-workspaces statement now lives only in a policy under CompanySignIn's condition (tests/support/company-signin-template.ts
    // asserts and removes it with the rest of the switch). Batch 13 measured code/next + #891 alone: named 92a9b3f3/594a31af, foreign ceee7bbe/11c5f75a; with LinearWebhookRoute also
    // removed those are exactly #872's approved pins (named fd809c0e/98b1dae8, foreign ca40bea2/694d8393). Batch 13 (rule D; #886/#906, DEC 254z-amend3 / 254zm): and re-pinned for
    // test services' additions only (TestServices and TestServiceImages parameters, td/ti in the broker's and the dispatcher's AGENTX_SETTINGS, the session steps' two variables).
    // Verified on this tree: with exactly those taken out, the code/next + #891 values above hold. Legacy unchanged.
    // Machine size stack (#877 infra + #887 + DEC 254zr, 2026-11-17): named, foreign AND legacy re-pinned. The session provisioner's RunInstances grant carries the ec2:InstanceType allow-list
    // (infra/lib/session-lifecycle.ts, session-lifecycle-infrastructure.test.ts pins it exactly): six types in #877/#887, ten with DEC 254zr. Verified: removing only the four types m6g.4xlarge,
    // m6g.8xlarge, m6i.4xlarge and m6i.8xlarge from every ec2:InstanceType list gives the #887 head's digests (named 69aa57be..., foreign 3c33651d..., legacy f9e67a89...; the same without the route),
    // so DEC 254zr moves these pins by exactly those four strings. The older pins below this note did not hold at the #887 head either (its six types moved them first).
    // Batch 14 (DEC 254zr/zv/zz machine sizes, DEC 254u dispatcher read, DEC 254zx email): all six re-pinned on the combined tree. A full synth of every stack (legacy, named staging,
    // foreign) against batch 13's head 84be8d7b7 differs ONLY in: the provisioner's ec2:InstanceType allow-list (10 types), the x86_64 AL2023 AMI parameter in ResolveWorkerAmi, the provisioner
    // state machine definition (#877/#887/#901); the attention email's 3 parameters, condition, rule and 5 conditional resources plus `ae` in AGENTX_SETTINGS (#907, off by default); and, in the
    // proof install, the dispatcher's one GetItem COMPANY_MEMBER#* statement (#875, DEC 254u) and the proof function's CurrentVersion id (its code changed). Nothing else moved.
    // Batch 14 combined (DEC 254zzl-amend3, DEC 254zzn(2)): named and foreign re-pinned again; legacy unchanged. Against the first batch-14 synth the templates differ ONLY in the
    // CoreSystemRuns parameter (default off) and its condition, the hourly upkeep-night schedule (existing invoke role, DISABLED unless that condition holds), the CoreAnswersModel
    // parameter (default empty), `aa`/`sy` in the broker's and `sy` in the dispatcher's AGENTX_SETTINGS, and the proof function's CurrentVersion id (its code changed).
    // SIGNIN-AUDIT: pre-removal hashes also include the sign-in Lambda's required State binding and AUDIT-family writer policy.
    // Owner DEC 254zzz73 (rule D, a removal): named and foreign re-pinned for the step-up's removal ONLY. A dump of the hashed remainder before and after differs in exactly the
    // StepUpEmailSender parameter, the sign-in function's STEP_UP_EMAIL_FROM and DEVELOPER_PASSKEYS variables and its two statements; `beforeStepUpRemoval` proves it (withStepUpRestored
    // puts exactly those back and gives the old pins). Legacy unchanged.
    const digestCases = [
      {
        label: "named",
        template: named,
        withRoute: "ff39867ccbebe339f5521b328242810296cf9f22de7164fc0c753a22d8ad994a", withoutRoute: "d2e9d7f43372743cffea7a4c6550137b924b4e751adcee11c4e27420b94ac1f8",
        beforeStepUpRemoval: { withRoute: "d58b14cb4439b703997e2d5384f7965da0149c0fe6267f70f1b7e0eed9208bd9", withoutRoute: "4d23c397d6fcd7b7d9b117358b7684afb36f811ce460095553b334a01791d139" },
      },
      {
        label: "foreign",
        template: foreign,
        withRoute: "89f0bd99f26d69338ba56b954d8233b0f2cf24202aa20f3765130a1c53176a13", withoutRoute: "64558d40113fef82c6c9a2e9ce36e20306b73a7c64d472c73f56798c33904487",
        beforeStepUpRemoval: { withRoute: "773ebd697b866d1844dc835ed3eb504a4fb61cfddc004f2e25ef15ea0fe8bc6e", withoutRoute: "1d6fd5d890d61ab815c6fbb4e6640e69d9997eb7cfc58d09687434fe23e1124e" },
      },
      {
        label: "legacy",
        template: legacy,
        // #1129, #1131: the company layer, GitHub sign-in, the company-secrets role and the reliability parts in the legacy (production) template too (no step-up: DEC 254zzz73).
        // #1149: re-pinned for the legacy broker's packed environment (names parameter, AGENTX_SETTINGS, the names parameter's read).
        // #1148: re-pinned for the core engine in the legacy template (CoreEngine off by default, the /v1/app route, saved environment images, the core's keys).
        // SIGNIN-STATE-TABLE: re-pinned for ONE change: the sign-in function's STATE_TABLE_NAME is the plain Ref to State instead of an Fn::If on SlackCompanyModeOn to "" (rule D: with the old
        // Fn::If put back, the old pins 5e7b09b2... and 40317b61... held). Named and foreign are unchanged (withoutSlackCompanyMode takes the variable out in both forms).
        // #1275: re-pinned for removing the core engine switch (the legacy-templates snapshot diff is exactly that).
        withRoute: "e07dd4159c119f01af79e029eca73c35fff9cc4098ad8341f946a5070517cded",
        withoutRoute: "7f704d79dc046c8f3fb1c6141eeb0cfcc8f21fe9cc1ab1380fdbee2f55db74ff",
        beforeStepUpRemoval: undefined,
      },
    ] as const;
    expect(named.Parameters?.CoreTaskCapUsd, "named has the core engine").toBeDefined();
    expect(foreign.Parameters?.CoreTaskCapUsd, "foreign has the core engine").toBeDefined();
    // #1148: the legacy (production) template has the core engine too.
    expect(legacy.Parameters?.CoreTaskCapUsd, "legacy has the core engine").toBeDefined();
    for (const { label, template, withRoute, withoutRoute, beforeStepUpRemoval } of digestCases) {
      const creatorChecks = developerSignInConditionCheckEntries(template);
      {
        expect(creatorChecks, `${label} has exactly one broker creator identity fence`).toHaveLength(1);
        expect(creatorChecks[0]!.statement, `${label} checks only the exact sign-in table key namespace`).toEqual({
          Action: "dynamodb:ConditionCheckItem",
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
          Effect: "Allow",
          Resource: { "Fn::GetAtt": [creatorChecks[0]!.tableId, "Arn"] },
        });
      }
      expect(template.Resources?.ProjectSetupExecutionReadRoute, `${label} has the approved setup read route`).toMatchObject({
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          AuthorizationType: "NONE",
          RouteKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
        },
      });
      // DEC 254h: GitHub sign-in's named-environment additions are asserted and taken out (tests/support/github-signin-template.ts); legacy has none.
      // ENV-ROOM 2's additions (the broker names parameter and the IAM room made for it) are asserted and taken out first (tests/support/broker-environment-template.ts).
      // L4-HW8b: the broker's Slack poster variables and the Slack adapter secret's policy (tests/support/broker-slack-poster-template.ts) are asserted and taken out too; the legacy template has none.
      // CORE-DISPATCH-HOOK-SIGNER-20261117: the dispatcher's question signer is asserted and taken out (tests/support/dispatcher-hook-signer-template.ts); legacy has none.
      const environment = label === "named" ? "agentxlivetest123" : "staging";
      const pinned = label === "legacy" ? template : withoutWorkerSandboxEgress(withoutDispatcherHookSigner(withoutGithubSignIn(withoutBrokerNamesParameter(withoutCompanyImportReads(withoutChatGptKeyDeny(withoutSavedEnvSwitch(withoutSavedEnvImages(withoutBrokerSlackPoster(structuredClone(template), environment), environment))))), environment)));
      // L4-HARD (c): the ChatGPT key's Deny is asserted and taken out too (tests/support/chatgpt-key-deny-template.ts); legacy has none.
      expect(parentRemainderDigest(pinned, label !== "legacy"), `${label} parent remainder with the route`).toBe(withRoute);
      const priorRemainder = structuredClone(pinned);
      delete priorRemainder.Resources?.ProjectSetupExecutionReadRoute;
      expect(parentRemainderDigest(priorRemainder, label !== "legacy"), `${label} parent remainder with only the approved route removed`).toBe(withoutRoute);
      if (beforeStepUpRemoval !== undefined) {
        // Rule D proof (owner DEC 254zzz73): with exactly the step-up's removed parameter, variables and statements put back, the pre-removal pins hold.
        const restored = withStepUpRestored(pinned);
        expect(parentRemainderDigest(restored), `${label} with the step-up's removed parts put back`).toBe(beforeStepUpRemoval.withRoute);
        delete restored.Resources?.ProjectSetupExecutionReadRoute;
        expect(parentRemainderDigest(restored), `${label} with the step-up's parts put back and the route removed`).toBe(beforeStepUpRemoval.withoutRoute);
      } else expect(JSON.stringify(pinned), "legacy never had the step-up's parts").not.toContain("StepUpEmailSender");
    }
  });

  it("conditions the isolated proof resources on the switch, exact account and region", () => {
    const approved = namedTemplate("agentxlivetest123");
    const proofResources = proofEntries(approved);
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const condition = approved.Conditions?.[conditionId!];
    expect(JSON.stringify(condition)).toContain("TaskPersonProofEnabled");
    expect(JSON.stringify(condition)).toContain("944937319445");
    expect(JSON.stringify(condition)).toContain("us-east-1");
    expect(proofResources.map(([id]) => id)).toEqual(expect.arrayContaining([
      expect.stringContaining("Role"), expect.stringContaining("Function"), expect.stringContaining("Version"),
      expect.stringContaining("SecretReadPolicy"), expect.stringContaining("DispatcherPolicy"),
    ]));
    for (const [id, resource] of proofResources.filter(([, resource]) => resource.Type !== "AWS::CloudFormation::Condition")) {
      if (id.includes("Role") || id.includes("Function") || id.includes("Version") || id.includes("Policy")) {
        expect(resource.Condition).toBe(conditionId);
      }
    }
  });

  it("keeps the proof function and role free of unrelated runtime permissions", () => {
    const approved = namedTemplate("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const [functionId, proofFunction] = Object.entries(resources).find(([id, resource]) =>
      id.includes("TaskPersonProofFunction") && resource.Type === "AWS::Lambda::Function",
    )!;
    const properties = proofFunction.Properties!;
    expect(properties).toMatchObject({ MemorySize: 512, Timeout: 7 });
    expect(properties).not.toHaveProperty("TracingConfig");
    expect(properties).not.toHaveProperty("VpcConfig");
    const variables = (properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({ AGENTX_ENV: "agentxlivetest123" });
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ENV", "SLACK_SECRET_ARN", "SLACK_TEAM_ID"]);
    const roleId = ((properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(roleId).toContain("TaskPersonProofRole");
    const role = resources[roleId]!.Properties!;
    expect(role).not.toHaveProperty("ManagedPolicyArns");
    expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
    const rolePolicies = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy"
      && JSON.stringify(resource.Properties?.Roles).includes(roleId));
    expect(rolePolicies).toHaveLength(1);
    const statements = (rolePolicies[0]![1].Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"] });
    expect(JSON.stringify(statements[0]?.Resource)).toContain("SlackSecret");
    expect(JSON.stringify(proofFunction)).not.toMatch(/xray:|logs:|kms:|dynamodb:/);
    expect(functionId).toContain("TaskPersonProofFunction");
  });

  it("limits the dispatcher addition to projected Developer GetItem and the published proof version", () => {
    const approved = appControlPlane("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const policy = Object.entries(resources).find(([id, resource]) => id.includes("TaskPersonProofDispatcherPolicy") && resource.Type === "AWS::IAM::Policy")?.[1];
    expect(policy).toBeDefined();
    const statements = (policy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(4);
    const getItem = statements.find((statement) => JSON.stringify(statement.Action).includes("dynamodb:GetItem") && JSON.stringify(statement.Condition).includes("DEVELOPER#*"));
    const companyMemberGetItem = statements.find((statement) => JSON.stringify(statement.Condition ?? {}).includes("COMPANY_MEMBER#*"));
    const denyUnprojectedGetItem = statements.find((statement) => statement.Sid === "DenyGetItemUnlessSpecificAttributes");
    const invoke = statements.find((statement) => JSON.stringify(statement.Action).includes("lambda:InvokeFunction"));
    const dispatcherEntries = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
    expect(dispatcherEntries).toHaveLength(1);
    const dispatcher = dispatcherEntries[0];
    const dispatcherRole = ((dispatcher![1].Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(policy!.Properties!.Roles).toEqual([{ Ref: dispatcherRole }]);
    const tableId = Object.keys(resources).find((id) => id.includes("DeveloperSignInTable"));
    expect(tableId).toBeDefined();
    expect(getItem).toEqual({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [{ "Fn::GetAtt": [tableId, "Arn"] }],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName"] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
    expect(companyMemberGetItem).toEqual({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [{ "Fn::GetAtt": [tableId, "Arn"] }],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_MEMBER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "entityType", "personId", "companyId", "role", "joinedAt", "joinedVia", "revokedAt", "revokedBy"] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
    const expectedProjectionDeny = {
      Sid: "DenyGetItemUnlessSpecificAttributes",
      Effect: "Deny",
      Action: "dynamodb:GetItem",
      Resource: { "Fn::GetAtt": [tableId, "Arn"] },
      Condition: { StringNotEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } },
    };
    const assertExactProjectionDeny = (statement: Record<string, unknown>) => expect({
      ...statement,
      Action: normalizeSingleton(statement.Action),
      Resource: normalizeSingleton(statement.Resource),
    }).toEqual(expectedProjectionDeny);
    assertExactProjectionDeny(denyUnprojectedGetItem!);
    const extraNullCounterfactual = structuredClone(denyUnprojectedGetItem!);
    extraNullCounterfactual.Condition = {
      ...(extraNullCounterfactual.Condition as Record<string, unknown>),
      Null: { "dynamodb:Select": "false" },
    };
    expect(() => assertExactProjectionDeny(extraNullCounterfactual)).toThrow();
    const versionId = Object.keys(resources).find((id) => JSON.stringify(invoke?.Resource).includes(id));
    expect(invoke).toEqual({ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [{ Ref: versionId }] });
    expect(versionId).toContain("TaskPersonProofFunctionCurrentVersion");
    expect(resources[versionId!]?.Type).toBe("AWS::Lambda::Version");
    expect(JSON.stringify(invoke?.Resource)).not.toContain("$LATEST");
    const variables = dispatcher![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(Object.keys(variables.Variables).filter((key) => ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"].includes(key)).sort()).toEqual([
      "TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME",
    ].sort());
    expect(JSON.stringify(variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN)).toContain("TaskPersonProofFunctionCurrentVersion");
    for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
      expect(JSON.stringify(variables.Variables[key])).toContain(conditionId);
    }

    const functions = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
    const roleFor = (resource: { Properties?: Record<string, unknown> }): string =>
      ((resource.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    const purpose = (prefix: string) => {
      const matches = functions.filter(([id]) => id.startsWith(prefix));
      expect(matches, `expected exactly one ${prefix} Lambda`).toHaveLength(1);
      return matches[0]!;
    };
    const [brokerId, broker] = purpose("Broker");
    const [notifierId, notifier] = purpose("DeveloperTaskNotifier");
    const [signInId, signIn] = purpose("DeveloperSignIn");
    for (const [id, resource] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      const envVars = (resource.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(envVars, `${id} must not receive proof-only runtime configuration`).not.toHaveProperty("TASK_PERSON_PROOF_FUNCTION_ARN");
    }
    const brokerVars = unpackedBrokerVariables((broker.Properties!.Environment as { Variables: Record<string, unknown> }).Variables, { Resources: resources });
    expect(brokerVars.SLACK_TEAM_ID).toEqual({ Ref: "SlackTeamId" });
    expect(brokerVars.DEVELOPER_SIGNIN_TABLE_NAME).toEqual({ Ref: tableId });
    const notifierVars = (notifier.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(notifierVars.SLACK_TEAM_ID).toBeUndefined();
    expect(notifierVars.DEVELOPER_SIGNIN_TABLE_NAME).toBeUndefined();
    const signInVars = (signIn.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(signInVars.SLACK_TEAM_ID).toEqual({ Ref: "SlackTeamId" });
    expect(signInVars.DEVELOPER_SIGNIN_TABLE_NAME).toEqual({ Ref: tableId });

    const proofPolicyRoles = policy!.Properties!.Roles as Array<{ Ref?: string }>;
    expect(proofPolicyRoles).toEqual([{ Ref: dispatcherRole }]);
    for (const [, otherFunction] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      expect(proofPolicyRoles).not.toContainEqual({ Ref: roleFor(otherFunction) });
    }
  });
});
