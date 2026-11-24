// Hosted wiring on the synthesized templates (named environment "staging"; the legacy template is proven byte-identical by legacy-templates.test.ts):
//   (a) SES SendEmail for the sign-in function, on the one identity the StepUpEmailSender parameter names, with the From address pinned;
//   (b) passkeys on, and the function's Query/DeleteItem reach PASSKEYS# partitions only;
//   (c) the policy hook's question key: its own KMS key, Sign only by the broker (key policy), public key only to the broker and the sign-in function;
//   (d) COMPANY_READS for the broker, which already reads COMPANY_MEMBER# and queries the State table;
//   (g) the outbox publisher can do mainline's transactional PutItem + UpdateItem on the State table;
//   (h) the company-secrets role (T6): trust, name fence, tagged create, no TagResource allow and no TagResource deny;
//   (i) the core dispatch queues: RedriveAllowPolicy on the dead letters, aws:SecureTransport denied on both.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { COMPANY_SECRET_USE_ACTIONS, COMPANY_TAG_VALUE_GLOB } from "../../infra/lib/company-secrets.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource> };

let named: TemplateJson;
let legacy: TemplateJson;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const actionsOf = (statement: Statement) => [statement.Action].flat();
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");
const roleOf = (template: TemplateJson, prefix: string) => ofType(template, "AWS::IAM::Role").find(([id]) => withoutHash(id) === prefix)![0];
/** Every identity statement attached to a role (AWS::IAM::Policy documents that name it). */
function statementsOfRole(template: TemplateJson, rolePrefix: string): Statement[] {
  const role = roleOf(template, rolePrefix);
  return ofType(template, "AWS::IAM::Policy")
    .filter(([, policy]) => (policy.Properties.Roles as Array<{ Ref?: string }>).some((ref) => ref.Ref === role))
    .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}
const envOf = (template: TemplateJson, functionPrefix: string) => {
  const [, fn] = ofType(template, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === functionPrefix)!;
  return unpackedBrokerVariables((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables, template);
};
const keyPolicy = (template: TemplateJson, prefix: string) => {
  const keys = ofType(template, "AWS::KMS::Key").filter(([id]) => id.startsWith(prefix));
  expect(keys).toHaveLength(1);
  return { id: keys[0]![0], statements: (keys[0]![1].Properties.KeyPolicy as { Statement: Statement[] }).Statement };
};

beforeAll(() => {
  named = controlPlane(buildAgentXApp({ agentxEnv: "staging" }), "agentx-staging-control-plane");
  legacy = controlPlane(buildAgentXApp(), "AgentXControlPlane");
}, 300_000);

describe("(a) no step-up email (DEC 254zzz73)", () => {
  it("declares no StepUpEmailSender parameter and gives the sign-in function no STEP_UP_EMAIL_FROM, in either template", () => {
    expect(named.Parameters.StepUpEmailSender).toBeUndefined();
    expect(legacy.Parameters.StepUpEmailSender).toBeUndefined();
    expect(envOf(named, "DeveloperSignInFunction").STEP_UP_EMAIL_FROM).toBeUndefined();
    expect(JSON.stringify(named)).not.toContain("StepUpEmailSender");
    expect(JSON.stringify(named)).not.toContain("STEP_UP_EMAIL_FROM");
    expect(JSON.stringify(legacy)).not.toContain("STEP_UP_EMAIL_FROM");
  });

  it("lets the sign-in function send no email: the only SES right in the stack is the attention email sender's own", () => {
    expect(statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => actionsOf(statement).some((action) => action.startsWith("ses:")))).toEqual([]);
    // No other role in the stack may send email, except the attention email's own sender (DEC 254zx, #907): one ses:SendEmail on its own CoreAttentionEmailSender identity, From
    // pinned, in its own policy that exists only while CoreAttentionEmail is on (core-engine-infrastructure.test.ts pins the rest of it).
    const sesByPolicy = ofType(named, "AWS::IAM::Policy").flatMap(([id, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith("ses:"))).map((statement) => ({ id, statement })));
    expect(sesByPolicy).toHaveLength(1);
    expect(sesByPolicy[0]!.id.startsWith("CoreEngineJobsAttentionEmailSenderServiceRoleDefaultPolicy")).toBe(true);
    expect(sesByPolicy.map(({ statement }) => statement)).toEqual([{
      Action: "ses:SendEmail", Effect: "Allow",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ses:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":identity/", { Ref: "CoreAttentionEmailSender" }]] },
      Condition: { StringEquals: { "ses:FromAddress": { Ref: "CoreAttentionEmailSender" } } },
      Sid: "AttentionEmailSend",
    }]);
    // #1148: the legacy template has the attention email's sender too (off by default): the same one statement, under its own condition.
    const legacySes = ofType(legacy, "AWS::IAM::Policy").flatMap(([id, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith("ses:"))).map(() => id));
    expect(legacySes).toHaveLength(1);
    expect(legacySes[0]!.startsWith("CoreEngineJobsAttentionEmailSenderServiceRoleDefaultPolicy")).toBe(true);
  });
});

describe("(a) the default boundary's SES statement", () => {
  // Kept for the attention email sender; the Sid keeps its old name so the deployed boundary does not change (DEC 254zzz73).
  it("allows only ses:SendEmail, only on this account's email identities in this region", () => {
    const scope = { env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "agentx-staging-cloudformation" };
    const statements = defaultBoundaryStatements(scope);
    expect(statements.filter((statement) => JSON.stringify(statement.Action).includes("ses:"))).toEqual([
      { Sid: "StepUpEmail", Effect: "Allow", Action: ["ses:SendEmail"], Resource: "arn:aws:ses:us-west-2:111122223333:identity/*" },
    ]);
  });
});

describe("(b) no passkeys (DEC 254zzz73)", () => {
  it("turns no passkeys on, and the function's Query and DeleteItem reach only the sign-in clients' partition and the company grants, never PASSKEYS#", () => {
    expect(envOf(named, "DeveloperSignInFunction").DEVELOPER_PASSKEYS).toBeUndefined();
    expect(JSON.stringify(named)).not.toContain("DEVELOPER_PASSKEYS");
    expect(JSON.stringify(legacy)).not.toContain("DEVELOPER_PASSKEYS");
    expect(JSON.stringify(named)).not.toContain("PASSKEYS#");
    const all = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => actionsOf(statement).some((action) => action === "dynamodb:Query" || action === "dynamodb:DeleteItem"));
    // Batch 16+17 (#1014, owner DEC 254zzz33): the sign-in role's company grants add three key-limited Query/DeleteItem statements of their own (pinned exactly here).
    const companyGrant = (statement: (typeof all)[number]) => /SIGNIN_LINKS#|#MEMBERS"|COMPANY_INVITE_CODES|#PREAPPROVAL"|#COMPANY"|COMPANY_MEMBER#/u.test(JSON.stringify(statement.Condition));
    expect(all.filter(companyGrant).map((statement) => [actionsOf(statement), statement.Condition])).toEqual([
      [["dynamodb:Query"], { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#MEMBERS", "ORG#org_????????????????????#PREAPPROVAL", "COMPANY_INVITE_CODES", "SIGNIN_LINKS#*"] }, Null: { "dynamodb:LeadingKeys": "false" } }],
      [["dynamodb:DeleteItem"], { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SIGNIN_LINKS#*"] }, Null: { "dynamodb:LeadingKeys": "false" } }],
      [["dynamodb:DeleteItem"], { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#COMPANY", "ORG#org_????????????????????#MEMBERS", "COMPANY_MEMBER#*"] }, Null: { "dynamodb:LeadingKeys": "false" } }],
    ]);
    const scoped = all.filter((statement) => !companyGrant(statement));
    expect(scoped.map((statement) => statement.Condition)).toEqual([
      { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["SIGNIN_CLIENTS"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    ]);
    for (const statement of scoped) expect(actionsOf(statement).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:Query"]);
    expect(JSON.stringify(statementsOfRole(named, "DeveloperSignInFunctionServiceRole"))).not.toContain("dynamodb:Scan");
  });
});

describe("(c) the policy hook's question key", () => {
  it("is its own RSA signing key with its own alias (the legacy install's too since #1148)", () => {
    const { id } = keyPolicy(named, "DeveloperSignInPolicyHookKey");
    const [, key] = ofType(named, "AWS::KMS::Key").find(([keyId]) => keyId === id)!;
    expect(key.Properties).toMatchObject({ KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PendingWindowInDays: 7 });
    expect(ofType(named, "AWS::KMS::Alias").filter(([, alias]) => alias.Properties.AliasName === "alias/agentx/staging/policy-questions").map(([, alias]) => alias.Properties.TargetKeyId)).toEqual([{ "Fn::GetAtt": [id, "Arn"] }]);
    expect(id).not.toBe(keyPolicy(named, "DeveloperSignInTaskTokenKey").id);
    expect(ofType(legacy, "AWS::KMS::Alias").map(([, alias]) => alias.Properties.AliasName)).toContain("alias/agentx/production/policy-questions");
  });

  it("only the broker and the dispatcher may sign; only they and the sign-in function read the public key", () => {
    const { id, statements } = keyPolicy(named, "DeveloperSignInPolicyHookKey");
    const broker = { "Fn::GetAtt": [roleOf(named, "BrokerServiceRole"), "Arn"] };
    const signIn = { "Fn::GetAtt": [roleOf(named, "DeveloperSignInFunctionServiceRole"), "Arn"] };
    const dispatcher = { "Fn::GetAtt": [roleOf(named, "DispatcherServiceRole"), "Arn"] };
    expect(statements.find((statement) => statement.Sid === "BrokerSignsPolicyQuestions")).toEqual({ Sid: "BrokerSignsPolicyQuestions", Effect: "Allow", Principal: { AWS: broker }, Action: ["kms:Sign", "kms:GetPublicKey"], Resource: "*" });
    // CORE-DISPATCH-HOOK-SIGNER-20261117: the dispatcher signs only as the question signer does (RS256 over the raw input) and reads the public key (the question's kid).
    expect(statements.find((statement) => statement.Sid === "DispatcherSignsPolicyQuestions")).toEqual({
      Sid: "DispatcherSignsPolicyQuestions", Effect: "Allow", Principal: { AWS: dispatcher }, Action: "kms:Sign", Resource: "*",
      Condition: { StringEquals: { "kms:SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256", "kms:MessageType": "RAW" } },
    });
    expect(statements.find((statement) => statement.Sid === "DispatcherReadsPolicyQuestionKey")).toEqual({ Sid: "DispatcherReadsPolicyQuestionKey", Effect: "Allow", Principal: { AWS: dispatcher }, Action: "kms:GetPublicKey", Resource: "*" });
    expect(statements.find((statement) => statement.Sid === "SignOnlyAsBroker")).toEqual({ Sid: "SignOnlyAsBroker", Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:Sign", Resource: "*", Condition: { ArnNotEquals: { "aws:PrincipalArn": [broker, dispatcher] } } });
    expect(statements.find((statement) => statement.Sid === "GetPublicKeyOnlyAsBrokerAndDeveloperIdentity")).toEqual({ Sid: "GetPublicKeyOnlyAsBrokerAndDeveloperIdentity", Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:GetPublicKey", Resource: "*", Condition: { ArnNotEquals: { "aws:PrincipalArn": [broker, signIn, dispatcher] } } });
    // No other Allow names a principal other than the account root (CDK's default admin statement).
    const allows = statements.filter((statement) => statement.Effect === "Allow" && !["BrokerSignsPolicyQuestions", "DispatcherSignsPolicyQuestions", "DispatcherReadsPolicyQuestionKey"].includes(String(statement.Sid)));
    for (const allow of allows) expect(JSON.stringify(allow.Principal)).toContain(":root");
    // The sign-in function reads the public key; it is never given Sign.
    const fnKms = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => JSON.stringify(statement.Resource).includes(id));
    expect(fnKms.map((statement) => statement.Action)).toEqual(["kms:GetPublicKey"]);
    // Neither the broker's nor the dispatcher's own role policy grows for this key: key-policy grants only.
    expect(JSON.stringify(statementsOfRole(named, "BrokerServiceRole"))).not.toContain(id);
    expect(JSON.stringify(statementsOfRole(named, "DispatcherServiceRole"))).not.toContain(id);
    expect(envOf(named, "DeveloperSignInFunction").POLICY_HOOK_KEY_ARN).toEqual({ "Fn::GetAtt": [id, "Arn"] });
    // ENV-ROOM: the broker is given the key's id packed (AGENTX_NAMES) and builds the same ARN (tests/contract/broker-environment.test.ts).
    expect(envOf(named, "Broker").POLICY_HOOK_KEY_ARN).toEqual({ Ref: id });
    // The dispatcher's question signer: the key's ARN and the install's issuer, the sign-in function's own value (hosted-wiring.ts policyHookInstallFromEnvironment).
    expect(envOf(named, "Dispatcher").POLICY_HOOK_KEY_ARN).toEqual({ "Fn::GetAtt": [id, "Arn"] });
    expect(envOf(named, "Dispatcher").DEVELOPER_TOKEN_ISSUER).toEqual(envOf(named, "DeveloperSignInFunction").DEVELOPER_TOKEN_ISSUER);
    // #1148: the legacy deployment has the question key too, and its dispatcher both.
    expect(envOf(legacy, "Dispatcher")).toHaveProperty("POLICY_HOOK_KEY_ARN");
    expect(envOf(legacy, "Dispatcher")).toHaveProperty("DEVELOPER_TOKEN_ISSUER");
  });
});

describe("(d) company reads and (g) the outbox", () => {
  it("turns the company reads on for the broker in named environments, which can already read membership and query the State table", () => {
    expect(envOf(named, "Broker").COMPANY_READS).toBe("enabled");
    expect(JSON.stringify(legacy)).not.toContain("COMPANY_READS");
    const broker = statementsOfRole(named, "BrokerServiceRole");
    const signInTable = ofType(named, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("DeveloperSignInTable"))![0];
    const membership = broker.find((statement) => JSON.stringify(statement.Resource).includes(signInTable) && JSON.stringify(statement.Condition).includes("COMPANY_MEMBER#*"));
    expect(membership?.Action).toBe("dynamodb:GetItem");
    const stateTable = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
    expect(broker.some((statement) => actionsOf(statement).includes("dynamodb:Query") && JSON.stringify(statement.Resource).includes(stateTable) && statement.Condition === undefined)).toBe(true);
  });

  it("lets the outbox publisher write mainline's transaction (PutItem + UpdateItem) on the State table", () => {
    const stateTable = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
    const outbox = statementsOfRole(named, "OutboxPublisherServiceRole").filter((statement) => statement.Effect === "Allow" && JSON.stringify(statement.Resource).includes(stateTable) && statement.Condition === undefined);
    const actions = new Set(outbox.flatMap(actionsOf));
    for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem"]) expect(actions.has(action), action).toBe(true);
  });
});

describe("(h) the company-secrets role (T6)", () => {
  const role = () => ofType(named, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "CompanySecretsRole")!;

  it("exists (the legacy deployment too since #1129, under agentx/production/), and the broker gets its ARN", () => {
    expect(role()).toBeDefined();
    const legacyRole = ofType(legacy, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "CompanySecretsRole")!;
    expect(legacyRole).toBeDefined();
    expect(envOf(legacy, "Broker").COMPANY_SECRETS_ROLE_ARN).toEqual({ "Fn::GetAtt": [legacyRole[0], "Arn"] });
    const legacyPaths = JSON.stringify(ofType(legacy, "AWS::IAM::Policy").filter(([id]) => id.startsWith("CompanySecretsRoleDefaultPolicy")));
    expect(legacyPaths).toContain(":secret:agentx/production/org-connectors/${aws:PrincipalTag/rovara:org}/*");
    expect(legacyPaths).toContain(":secret:agentx/production/org-hooks/${aws:PrincipalTag/rovara:org}/*");
    // ENV-ROOM: the role's name packed; the broker builds its ARN in the environment's role path (tests/contract/broker-environment.test.ts).
    expect(envOf(named, "Broker").COMPANY_SECRETS_ROLE_ARN).toEqual({ Ref: role()[0] });
  });

  it("has a fixed name (the boundary and the deploy role name it exactly; contracts access-policies.ts), in the legacy deployment too", () => {
    expect(role()[1].Properties.RoleName).toBe("agentx-staging-company-secrets");
    const legacyRole = ofType(legacy, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "CompanySecretsRole")!;
    expect(legacyRole[1].Properties.RoleName).toBe("agentx-production-company-secrets");
  });

  it("trusts only the broker's role, to assume and tag together, with exactly one company tag", () => {
    const trust = (role()[1].Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement;
    expect(trust).toEqual([{
      Effect: "Allow",
      Principal: { AWS: { "Fn::GetAtt": [roleOf(named, "BrokerServiceRole"), "Arn"] } },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: {
        Null: { "aws:RequestTag/rovara:org": "false", "aws:TagKeys": "false" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara:org"] },
        StringLike: { "aws:RequestTag/rovara:org": COMPANY_TAG_VALUE_GLOB },
      },
    }]);
    expect(COMPANY_TAG_VALUE_GLOB).toBe("org_????????????????????");
    // The broker's inline policy needs no sts statement (same account, the trust names its role).
    expect(JSON.stringify(statementsOfRole(named, "BrokerServiceRole"))).not.toContain("sts:AssumeRole");
  });

  it("fences use by the secret's name only, creates only with the session's own company tag, and neither allows nor denies tagging", () => {
    const statements = statementsOfRole(named, "CompanySecretsRole");
    const env = "staging";
    const arn = (family: string, leaf = "*") => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:secret:agentx/${env}/${family}/\${aws:PrincipalTag/rovara:org}/${leaf}`]] });
    const companyArns = [arn("org-connectors"), arn("org-hooks")];
    const nested = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:secret:agentx/${env}/org-connectors/*/pkgreg_*/*`]] };
    expect(statements).toEqual([
      { Sid: "UseOwnCompanySecrets", Effect: "Allow", Action: [...COMPANY_SECRET_USE_ACTIONS], Resource: companyArns, Condition: { Null: { "aws:PrincipalTag/rovara:org": "false" } } },
      { Sid: "DeleteOwnCompanySecretsRecoverably", Effect: "Allow", Action: "secretsmanager:DeleteSecret", Resource: companyArns, Condition: { Null: { "aws:PrincipalTag/rovara:org": "false" }, Bool: { "secretsmanager:ForceDeleteWithoutRecovery": "false" } } },
      // PRIVATE-PACKAGES P1b: the company's package token, created UNTAGGED on exactly `pkgreg_*` under the company's own connector path (so no TagResource is needed); `aws:TagKeys` must be absent.
      {
        Sid: "CreateOwnCompanyRegistrySecrets", Effect: "Allow", Action: "secretsmanager:CreateSecret", Resource: arn("org-connectors", "pkgreg_*"),
        Condition: { Null: { "aws:PrincipalTag/rovara:org": "false", "aws:TagKeys": "true" } },
      },
      // The token's secret is ADOPTED and RESTORED, never force-deleted or recreated: RestoreSecret on the company's own `pkgreg_*` only.
      { Sid: "RestoreOwnCompanyRegistrySecrets", Effect: "Allow", Action: "secretsmanager:RestoreSecret", Resource: arn("org-connectors", "pkgreg_*"), Condition: { Null: { "aws:PrincipalTag/rovara:org": "false" } } },
      {
        Sid: "CreateOwnCompanySecrets", Effect: "Allow", Action: "secretsmanager:CreateSecret", Resource: companyArns,
        Condition: { Null: { "aws:PrincipalTag/rovara:org": "false" }, StringEquals: { "aws:RequestTag/rovara:org": "${aws:PrincipalTag/rovara:org}" }, "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara:org"] } },
      },
      // Hardening (Opus review of P1b, F2): IAM's `*` matches `/`; a nested `pkgreg_x/y` create is denied outright (the only Deny of the role, and no condition).
      { Sid: "DenyNestedCompanyRegistrySecrets", Effect: "Deny", Action: "secretsmanager:CreateSecret", Resource: nested },
    ]);
    const text = JSON.stringify(statements);
    // Pitfall 2 of the T6 review: no resource-tag condition on use, so an own missing secret is not-found, not AccessDenied.
    expect(text).not.toContain("ResourceTag");
    // Pitfall 1: no Deny on TagResource (it would also cover a tagged create); tagging is simply not allowed until a create-only discriminator is verified.
    expect(text).not.toContain("TagResource");
    expect(statements.filter((statement) => statement.Effect !== "Allow").map((statement) => statement.Sid)).toEqual(["DenyNestedCompanyRegistrySecrets"]);
    expect(text).not.toMatch(/"Resource":"\*"/u);
  });
});

describe("(i) the core dispatch queues", () => {
  it("lets only the core dispatch queue redrive to its dead letters, and denies every request that is not over TLS", () => {
    const queues = ofType(named, "AWS::SQS::Queue").filter(([id]) => id.startsWith("CoreEngineJobs"));
    const [, dlq] = queues.find(([id]) => id.startsWith("CoreEngineJobsDeadLetterQueue"))!;
    expect(dlq.Properties.RedriveAllowPolicy).toEqual({
      redrivePermission: "byQueue",
      sourceQueueArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":sqs:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":agentx-staging-core-dispatch"]] }],
    });
    const [queueId, queue] = queues.find(([id]) => withoutHash(id) === "CoreEngineJobsQueue")!;
    expect(queue.Properties.QueueName).toBe("agentx-staging-core-dispatch");
    // L4-SQS: the lessons reflection queue and its dead letters are CoreEngineJobs queues too (pinned in tests/contract/core-lessons-reflect-queue.test.ts); this test is the core dispatch pair's.
    const reflectPolicies = ofType(named, "AWS::SQS::QueuePolicy").filter(([, policy]) => JSON.stringify(policy.Properties.Queues).includes("CoreEngineJobsLessonsReflect"));
    expect(reflectPolicies).toHaveLength(2);
    for (const [, policy] of reflectPolicies) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      expect(statements.filter((statement) => statement.Effect === "Deny")).toHaveLength(1);
      expect(statements.filter((statement) => statement.Sid === "BrokerUsesCoreDispatchQueue")).toHaveLength(0);
    }
    const policies = ofType(named, "AWS::SQS::QueuePolicy").filter(([, policy]) => JSON.stringify(policy.Properties.Queues).includes("CoreEngineJobs") && !JSON.stringify(policy.Properties.Queues).includes("LessonsReflect"));
    expect(policies).toHaveLength(2);
    for (const [, policy] of policies) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      const deny = statements.filter((statement) => statement.Effect === "Deny");
      expect(deny).toHaveLength(1);
      expect(deny[0]).toMatchObject({ Action: "sqs:*", Principal: { AWS: "*" }, Condition: { Bool: { "aws:SecureTransport": "false" } } });
      expect(statements.filter((statement) => statement.Sid === "BrokerUsesCoreDispatchQueue")).toHaveLength(1);
    }
    expect(queueId).toBeDefined();
  });
});
