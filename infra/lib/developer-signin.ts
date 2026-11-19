// Spec 025 phase 25a: the control plane as the developers' sign-in server. Spec 064: the legacy deployment has it too,
// for account linking only (scope "linking"): no developer tasks, task people or AI-tool confirmations there.
import { ArnFormat, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import { SIGN_IN_CLIENTS_PK } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { addBrokerName, addBrokerSetting, addDerivedBrokerVariable } from "./broker-names.js";
import { packagedFunction } from "./control-plane.js";
import { COMPANY_SELF_SERVE_VARIABLE, companySignInParameters, type CompanySignInParameters, type CompanySignInSwitch } from "./company-signin.js";

const SIGN_IN_ROUTE_KEY = "ANY /v1/auth/{proxy+}";
const DEV_ROUTE_KEY = "ANY /v1/dev/{proxy+}";
const FEEDBACK_REVIEW_ROUTE_KEY = "ANY /review/{proxy+}";
/** Lane L12: the core engine's own /v1/app/* routes, named environments with developer tasks only. The broker answers them only while the core switch serves. */
const CORE_APP_ROUTE_KEY = "ANY /v1/app/{proxy+}";

export interface DeveloperSignInParameters {
  slackTeamId: CfnParameter; slack: CfnParameter; oidcIssuer: CfnParameter; oidcClientId: CfnParameter;
  oidcRequiredClaim: CfnParameter; oidcRequiredValues: CfnParameter; oidcDisplayName: CfnParameter;
  slackSince: CfnParameter; oidcSince: CfnParameter;
  /** Named environments only: the developer task settings, which the legacy deployment does not have. */
  tasks?: DeveloperTaskParameters;
  /** DEC 254h (the legacy deployment too since #1129): GitHub sign-in (offered only with Code's company layer), its OAuth app's client id, and when it was last turned on. */
  github?: { enabled: CfnParameter; clientId: CfnParameter; since: CfnParameter };
  /** DEC 254zg (a): Code's company layer (CompanySignIn) and self-serve create (CompanySelfServe), both off by default (company-signin.ts); the legacy deployment too since #1129. */
  company?: CompanySignInParameters;
}

export interface DeveloperTaskParameters {
  taskPeopleChangesEnabled: CfnParameter; taskPeoplePublicInvitationsEnabled: CfnParameter; taskPeoplePrivateInvitationsEnabled: CfnParameter;
  workflowDependenciesEnabled: CfnParameter;
  /** Spec 025 E16: whether an admin may confirm a change in the AI tool's own pop-up. */
  mcpConfirmElicitation: CfnParameter;
}

/**
 * Declared on the stack itself, so the parameter names are exactly these. Spec 064: the legacy deployment
 * (`tasks: false`) gets the sign-in ones only, declared in the same order so named templates are unchanged.
 */
export function developerSignInParameters(stack: Stack, options: { tasks: boolean } = { tasks: true }): DeveloperSignInParameters {
  const signIn = {
    slackTeamId: new CfnParameter(stack, "SlackTeamId", { type: "String", default: "", allowedPattern: "^$|^[TE][A-Z0-9]{2,31}$", description: "The Slack workspace (team) ID this environment serves; Slack sign-in is refused while it is empty" }),
    slack: new CfnParameter(stack, "DeveloperSignInSlack", { type: "String", default: "disabled", allowedValues: ["enabled", "disabled"], description: "enabled: developers may sign in with Slack; disabled: they may not" }),
    oidcIssuer: new CfnParameter(stack, "DeveloperOidcIssuer", { type: "String", default: "", allowedPattern: "^$|^https://\\S+$", description: "Company OIDC issuer URL for developer sign-in; empty turns company sign-in off" }),
    oidcClientId: new CfnParameter(stack, "DeveloperOidcClientId", { type: "String", default: "", maxLength: 256, description: "Client ID of the company OIDC app for developer sign-in" }),
    oidcRequiredClaim: new CfnParameter(stack, "DeveloperOidcRequiredClaim", { type: "String", default: "", maxLength: 128, description: "Claim a company sign-in must carry, for example groups; empty for none" }),
    oidcRequiredValues: new CfnParameter(stack, "DeveloperOidcRequiredValues", { type: "String", default: "[]", allowedPattern: "^\\[.*\\]$", description: "JSON string array; the required claim must contain one of these values" }),
    oidcDisplayName: new CfnParameter(stack, "DeveloperOidcDisplayName", { type: "String", default: "Company sign-in", minLength: 1, maxLength: 40, description: "Name on the company sign-in button, for example Okta" }),
    // FR-045: a session started before its method was last turned on was ended by that disable, so
    // it stays ended. agentx signin enable sets these; 0 means the method was never turned back on.
    slackSince: new CfnParameter(stack, "DeveloperSignInSlackSince", { type: "String", default: "0", allowedPattern: "^[0-9]{1,12}$", description: "When Slack sign-in was last turned on, in epoch seconds; Slack sessions started before it are refused" }),
    oidcSince: new CfnParameter(stack, "DeveloperOidcSince", { type: "String", default: "0", allowedPattern: "^[0-9]{1,12}$", description: "When company sign-in was last turned on, in epoch seconds; company sessions started before it are refused" }),
  };
  if (!options.tasks) return signIn;
  const tasks: DeveloperTaskParameters = {
    taskPeopleChangesEnabled: new CfnParameter(stack, "TaskPeopleChangesEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people role changes are enabled in this environment" }),
    taskPeoplePublicInvitationsEnabled: new CfnParameter(stack, "TaskPeoplePublicInvitationsEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people may invite members to public channels in this environment" }),
    taskPeoplePrivateInvitationsEnabled: new CfnParameter(stack, "TaskPeoplePrivateInvitationsEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether task people may invite members to private channels in this environment" }),
    workflowDependenciesEnabled: new CfnParameter(stack, "WorkflowDependenciesEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Whether bounded serial task work breakdowns are enabled in this environment" }),
    mcpConfirmElicitation: new CfnParameter(stack, "McpConfirmElicitation", { type: "String", default: "enabled", allowedValues: ["enabled", "disabled"], description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button (or the CLI)" }),
  };
  // #1129: the legacy deployment (production) declares the ones below too, after all of its own, so its existing parameters keep their order and values: GitHub sign-in
  // (disabled) and Code's company layer (both switches disabled). DEC 254zzz73 removed the StepUpEmailSender parameter that stood first here.
  // DEC 254h: the client secret is never a parameter: it lives in the secret agentx/<env>/developer-github, which only the sign-in function may read.
  const github = {
    enabled: new CfnParameter(stack, "DeveloperSignInGithub", { type: "String", default: "disabled", allowedValues: ["enabled", "disabled"], description: "enabled: developers may sign in with GitHub (only with company sign-in on); disabled: they may not" }),
    clientId: new CfnParameter(stack, "DeveloperGithubClientId", { type: "String", default: "", allowedPattern: "^[A-Za-z0-9._-]{0,64}$", description: "Client ID of the GitHub OAuth app for developer sign-in" }),
    since: new CfnParameter(stack, "DeveloperGithubSince", { type: "String", default: "0", allowedPattern: "^[0-9]{1,12}$", description: "When GitHub sign-in was last turned on, in epoch seconds; GitHub sessions started before it are refused" }),
  };
  // DEC 254zg (a): declared last, so every parameter before them keeps its order.
  const company = companySignInParameters(stack);
  return { ...signIn, tasks, github, company };
}

/**
 * Spec 025 E3: admin change audit records, only under CHANGE#. Written once, then stepped forward by the broker alone;
 * no delete, and no route edits them (FR-051).
 */
function adminChangeAudit(turnRecords: dynamodb.Table): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
    resources: [turnRecords.tableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } },
  });
}

export interface DeveloperSignInProps {
  naming: AgentXNaming;
  env: string;
  api: apigwv2.CfnApi;
  brokerIntegration: apigwv2.CfnIntegration;
  broker: lambdaNodejs.NodejsFunction;
  /**
   * CORE-DISPATCH-HOOK-SIGNER-20261117 (named environments only, with the policy hook's key): the dispatcher, which asks the company rules service the engine's per-task limit before
   * each model run, as the broker does. Absent: the key's policy is the broker's alone, as before.
   */
  dispatcher?: lambdaNodejs.NodejsFunction;
  /** The concrete Secret (F5): control-plane.ts passes a secretsmanager.Secret. */
  slackSecret: secretsmanager.Secret;
  parameters: DeveloperSignInParameters;
  /** The API's default stage, which throttles the public /v1/auth routes. */
  stage: apigwv2.CfnStage;
  /** The TurnRecords table (control-plane.ts), so the broker may write AI-tool audit records.
   * The concrete Table (as with slackSecret above): dynamodb.ITable's tableStreamArn is an
   * optional string, but Table's getter returns string | undefined, which this repo's
   * exactOptionalPropertyTypes rejects as an ITable. */
  turnRecords: dynamodb.Table;
  /** DEC 254zg (a), named environments only: the company layer's switch (control-plane.ts makes it from parameters.company, before the Slack company mode that requires it). */
  company?: CompanySignInSwitch;
}

export class DeveloperSignIn extends Construct {
  /** Existing table, exposed without changing its construct path or permissions. */
  readonly table: dynamodb.Table;
  /** Spec 062 Phase 7c1b: the sign-in function, whose Slack directory reads go through the Slack adapter when asked. */
  readonly function: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: DeveloperSignInProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    // Spec 064: without the task settings (the legacy deployment) the broker serves account linking only.
    const tasks = p.tasks;
    const issuer = `${props.api.attrApiEndpoint}/v1/auth`;

    const table = this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retained: developer records and session history must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const tokenKey = new kms.Key(this, "TokenKey", {
      alias: props.naming.developerTokenKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} developer access tokens`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Access tokens live one hour, so nothing outlives the key for long.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Named environments publish a stable task kid before a gateway is enabled. The legacy deployment (production) runs tasks too but has no such key: its template stays as deployed.
    const taskTokenKeyAlias = tasks === undefined ? undefined : props.naming.taskTokenKeyAlias;
    const taskTokenKey = taskTokenKeyAlias === undefined ? undefined : new kms.Key(this, "TaskTokenKey", {
      alias: taskTokenKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} task tokens`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Hosted wiring (c): the policy hook's question key, a separate key from the task key (plan v3.2 7.5: a question can never pass for a task token, or the other way round). Named
    // environments only; the legacy template stays as deployed.
    const policyHookKeyAlias = tasks === undefined ? undefined : props.naming.policyHookKeyAlias;
    const policyHookKey = policyHookKeyAlias === undefined ? undefined : new kms.Key(this, "PolicyHookKey", {
      alias: policyHookKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} policy hook questions`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // A question lives six minutes: nothing outlives the key for long.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const oidcSecretName = `agentx/${props.env}/developer-oidc`;
    const fn = this.function = packagedFunction(this, "Function", "packages/broker/src/aws/developer-identity.ts", {
      AGENTX_ENV: props.env,
      DEVELOPER_TOKEN_ISSUER: issuer,
      DEVELOPER_SIGNIN_TABLE_NAME: table.tableName,
      DEVELOPER_TOKEN_KEY_ARN: tokenKey.keyArn,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      SLACK_TEAM_ID: p.slackTeamId.valueAsString,
      DEVELOPER_SIGNIN_SLACK: p.slack.valueAsString,
      DEVELOPER_OIDC_ISSUER: p.oidcIssuer.valueAsString,
      DEVELOPER_OIDC_CLIENT_ID: p.oidcClientId.valueAsString,
      DEVELOPER_OIDC_REQUIRED_CLAIM: p.oidcRequiredClaim.valueAsString,
      DEVELOPER_OIDC_REQUIRED_VALUES: p.oidcRequiredValues.valueAsString,
      DEVELOPER_OIDC_DISPLAY_NAME: p.oidcDisplayName.valueAsString,
      DEVELOPER_OIDC_SECRET_ID: oidcSecretName,
      DEVELOPER_SIGNIN_SLACK_SINCE: p.slackSince.valueAsString,
      DEVELOPER_OIDC_SINCE: p.oidcSince.valueAsString,
      ...(tasks === undefined ? {} : { MCP_CONFIRM_ELICITATION: tasks.mcpConfirmElicitation.valueAsString }),
    }, Duration.seconds(15));
    // Exactly what DeveloperSignInStore sends: GetItem, PutItem, UpdateItem, and TransactWriteItems
    // made of Put and Update items (IAM authorizes each item as PutItem or UpdateItem).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [table.tableArn],
    }));
    // Spec 063: listing and removing sign-in clients, only in their own partition.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query", "dynamodb:DeleteItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [SIGN_IN_CLIENTS_PK] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
    tokenKey.grant(fn, "kms:Sign", "kms:GetPublicKey");
    tokenKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "SignAndGetPublicKeyOnlyAsDeveloperIdentity",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign", "kms:GetPublicKey"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": fn.role!.roleArn } },
    }));
    if (taskTokenKey !== undefined) {
      // Direct key-policy grant: the broker inline policy is near CDK's split threshold.
      taskTokenKey.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(props.broker.role!.roleArn)],
        actions: ["kms:Sign", "kms:GetPublicKey"],
        resources: ["*"],
      }));
      taskTokenKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: "SignOnlyAsBroker",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": props.broker.role!.roleArn } },
      }));
      taskTokenKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: "GetPublicKeyOnlyAsBrokerAndDeveloperIdentity",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:GetPublicKey"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": [props.broker.role!.roleArn, fn.role!.roleArn] } },
      }));
      taskTokenKey.grant(fn, "kms:GetPublicKey");
      fn.addEnvironment("TASK_TOKEN_KEY_ARN", taskTokenKey.keyArn);
      addBrokerName(props.broker, props.naming, "taskTokenKey", taskTokenKey.keyId, taskTokenKey.keyArn);
    }
    if (policyHookKey !== undefined) {
      // As the task key: key-policy grants, so the broker's inline policy does not grow. Only the broker (and the dispatcher, below) signs; only they and this function read the public key.
      policyHookKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: "BrokerSignsPolicyQuestions",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(props.broker.role!.roleArn)],
        actions: ["kms:Sign", "kms:GetPublicKey"],
        resources: ["*"],
      }));
      // CORE-DISPATCH-HOOK-SIGNER-20261117: the dispatcher signs its own questions (the engine's per-task limit before each model run), only as the question signer signs them (RS256 over
      // the raw signing input, developer/tokens.ts kmsTokenSigner), and reads the public key for the question's kid. Key-policy grants: the dispatcher's role policy does not change.
      const dispatcherRole = props.dispatcher?.role?.roleArn;
      if (dispatcherRole !== undefined) {
        policyHookKey.addToResourcePolicy(new iam.PolicyStatement({
          sid: "DispatcherSignsPolicyQuestions",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ArnPrincipal(dispatcherRole)],
          actions: ["kms:Sign"],
          resources: ["*"],
          conditions: { StringEquals: { "kms:SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256", "kms:MessageType": "RAW" } },
        }));
        policyHookKey.addToResourcePolicy(new iam.PolicyStatement({
          sid: "DispatcherReadsPolicyQuestionKey",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ArnPrincipal(dispatcherRole)],
          actions: ["kms:GetPublicKey"],
          resources: ["*"],
        }));
      }
      const signers = dispatcherRole === undefined ? props.broker.role!.roleArn : [props.broker.role!.roleArn, dispatcherRole];
      policyHookKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: "SignOnlyAsBroker",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": signers } },
      }));
      policyHookKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: "GetPublicKeyOnlyAsBrokerAndDeveloperIdentity",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:GetPublicKey"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": [props.broker.role!.roleArn, fn.role!.roleArn, ...(dispatcherRole === undefined ? [] : [dispatcherRole])] } },
      }));
      if (props.dispatcher !== undefined) {
        // The dispatcher's question signer: the key and the install's issuer (hosted-wiring.ts policyHookInstallFromEnvironment). Values the template already has, no new parameter.
        props.dispatcher.addEnvironment("POLICY_HOOK_KEY_ARN", policyHookKey.keyArn);
        props.dispatcher.addEnvironment("DEVELOPER_TOKEN_ISSUER", issuer);
      }
      policyHookKey.grant(fn, "kms:GetPublicKey");
      fn.addEnvironment("POLICY_HOOK_KEY_ARN", policyHookKey.keyArn);
      addBrokerName(props.broker, props.naming, "policyHookKey", policyHookKey.keyId, policyHookKey.keyArn);
    }
    const named = props.naming.env !== undefined;
    // #1129: in the legacy deployment (production) too: GitHub sign-in (served only while DeveloperSignInGithub and CompanySignIn are both enabled).
    if (tasks !== undefined) {
      if (p.github === undefined) throw new Error("a deployment with developer tasks declares the GitHub sign-in parameters");
      if (p.company === undefined) throw new Error("a deployment with developer tasks declares the company sign-in parameters");
      // DEC 254h: GitHub sign-in. The client secret is read by reference (its name) by this function only; the grant names that one secret.
      const githubSecretName = `agentx/${props.env}/developer-github`;
      fn.addEnvironment("DEVELOPER_SIGNIN_GITHUB", p.github.enabled.valueAsString);
      fn.addEnvironment("DEVELOPER_GITHUB_CLIENT_ID", p.github.clientId.valueAsString);
      fn.addEnvironment("DEVELOPER_GITHUB_SECRET_ID", githubSecretName);
      fn.addEnvironment("DEVELOPER_GITHUB_SINCE", p.github.since.valueAsString);
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        // Secrets Manager appends "-" and six characters to a secret's name in its ARN.
        resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${githubSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }));
      addBrokerSetting(props.broker, props.naming, "signInGithub", p.github.enabled.valueAsString);
      addBrokerSetting(props.broker, props.naming, "githubSince", p.github.since.valueAsString);
      // DEC 254zzz73: no step-up, so the sign-in function sends no email (no STEP_UP_EMAIL_FROM, no ses:SendEmail) and keeps no passkeys (no DEVELOPER_PASSKEYS, no PASSKEYS# reads or deletes).
    }
    props.slackSecret.grantRead(fn);
    // DEC 254zg (a): the company layer's switch; #1129: in the legacy deployment (production) too, off by default.
    const company = props.company;
    if (named && company === undefined) throw new Error("a named environment has the company sign-in switch");
    if (company !== undefined) {
      company.addTo(fn);
      fn.addEnvironment(COMPANY_SELF_SERVE_VARIABLE, company.selfServeValue);
      // Guided onboarding PR 4 (slack-install-identity.ts): Add to Slack's code exchange runs here, beside the Slack app's client secret; the bot token it gets is stored, read
      // (to revoke) and dropped under agentx/<env>/slack-workspaces/<company>/<team>, the family slack-workspace-tokens.ts reads. Creates carry no tags (no TagResource) and
      // nothing deletes: a dropped token is overwritten with a value holding none. DEC 254zg (a): a separate policy under CompanySignInOn, so with company sign-in off the
      // template holds no such grant.
      company.grant("SlackWorkspaceTokens", fn.role!, [new iam.PolicyStatement({
        sid: "WriteSlackWorkspaceTokens",
        actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"],
        resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/slack-workspaces/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      })]);
    }
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      // Secrets Manager appends "-" and six characters to a secret's name in its ARN.
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${oidcSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    // DEC 254zzz33: what the company layer's own sign-in writes and reads need beyond the grants above (each call site listed; staging audit 2026-11-18). Its own role policy (#1129: the
    // legacy deployment too, below), as the broker's BrokerCompanyImportReads: never the DefaultPolicy. Every table statement names its key families
    // with the Null guard; no ORG# family but the three named, for a company id of the shape OrgIdSchema accepts.
    const companyStatements = {
      signIn: [
        // (1) TransactWriteItems' condition checks: a member change's live-member and owner checks (company-membership.ts liveMemberCheck), self-serve create's switch
        // (company-invites.ts SELF_SERVE_KEY), a sign-in link's finish (sign-in-links.ts: DEVELOPER#, COMPANY_MEMBER#, SESSION#) and an admin's unlink (COMPANY_MEMBER#).
        new iam.PolicyStatement({
          actions: ["dynamodb:ConditionCheckItem"], resources: [table.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_MEMBER#*", "COMPANY_SELF_SERVE", "DEVELOPER#*", "SESSION#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
        }),
        // (2) Lists: a company's members (and the last-owner check), its pending pre-approvals, the invite codes, and a person's connected sign-ins.
        new iam.PolicyStatement({
          actions: ["dynamodb:Query"], resources: [table.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#MEMBERS", "ORG#org_????????????????????#PREAPPROVAL", "COMPANY_INVITE_CODES", "SIGNIN_LINKS#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
        }),
        // (4) Unlinking a connected sign-in deletes its link row only (sign-in-links.ts); the linked identity's DEVELOPER# record is kept, never deleted.
        new iam.PolicyStatement({
          actions: ["dynamodb:DeleteItem"], resources: [table.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SIGNIN_LINKS#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
        }),
        // (3) A company's own OIDC client secret (company-issuer.ts companyIssuerSecretName: agentx/<env>/org-signin/<company>/oidc), read-only. An operator stores it (no role writes it).
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `agentx/${props.env}/org-signin/*/oidc-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
        }),
      ],
      importUndo: [
        // (5) The operator's company import undo (company-import.ts undoImport): the imported company record, member views and memberships, each conditioned on being unchanged.
        new iam.PolicyStatement({
          actions: ["dynamodb:DeleteItem"], resources: [table.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#COMPANY", "ORG#org_????????????????????#MEMBERS", "COMPANY_MEMBER#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
        }),
      ],
    };
    // Named: one policy, as deployed. #1129, the legacy deployment (production): the company sign-in grants (1)-(4) only while CompanySignIn is on (a conditional policy,
    // company-signin.ts), and the import undo (5) always, since the operator imports the members (and may undo it) BEFORE switching company sign-in on (DEC 254b (b)).
    if (named) new iam.Policy(this, "SignInCompanyGrants", { roles: [fn.role!], statements: [...companyStatements.signIn.slice(0, 3), ...companyStatements.importUndo, ...companyStatements.signIn.slice(3)] });
    else if (company !== undefined) {
      company.grant("SignInCompanyGrants", fn.role!, companyStatements.signIn);
      new iam.Policy(this, "SignInCompanyImportUndo", { roles: [fn.role!], statements: companyStatements.importUndo });
    }

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0",
    });
    const authRoute = new apigwv2.CfnRoute(this, "AuthRoute", {
      apiId: props.api.ref, routeKey: SIGN_IN_ROUTE_KEY, target: `integrations/${integration.ref}`, authorizationType: "NONE",
    });
    fn.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/auth/*`,
    });

    // D17: no API Gateway JWT authorizer. One would fetch <api>/v1/auth's discovery document when it
    // is created, before this API exists, so a fresh install could never create it. The broker
    // verifies the developer access token itself (packages/broker/src/developer/verify-token.ts).
    const devRoute = new apigwv2.CfnRoute(this, "DevRoute", {
      apiId: props.api.ref, routeKey: DEV_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    // The review page uses its own opaque, revocable session cookie and owner checks in the broker.
    const feedbackReviewRoute = new apigwv2.CfnRoute(this, "FeedbackReviewRoute", {
      apiId: props.api.ref, routeKey: FEEDBACK_REVIEW_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    });
    // Lane L12, named environments with developer tasks only (the legacy template stays as deployed): the core's /v1/app/* routes. No authorizer, as DevRoute (D17): the broker
    // verifies the developer token itself, refuses a method and path with no row in its route table, and answers nothing here while the core switch is off.
    // Construct id "AppRoute" (logical ID DeveloperSignInAppRouteBAD38FAA) on purpose (switch-over incident 2026-11-16): the
    // 0.5.18 staging stack already holds ANY /v1/app/{proxy+} under that ID. A new ID made CloudFormation create a second route
    // with the same key before its cleanup deleted the old one, and the update failed with 409 AlreadyExists.
    // Pinned by tests/unit/collision-check.test.ts; check new previews with scripts/collision-check.ts.
    const coreAppRoute = named && tasks !== undefined ? new apigwv2.CfnRoute(this, "AppRoute", {
      apiId: props.api.ref, routeKey: CORE_APP_ROUTE_KEY, target: `integrations/${props.brokerIntegration.ref}`, authorizationType: "NONE",
    }) : undefined;
    // Public routes are stage-capped: bursts of 50, 20 requests a second on average,
    // across all callers. A developer signs in a few times a week, so this only bites a flood.
    const throttle = { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 };
    props.stage.routeSettings = { [SIGN_IN_ROUTE_KEY]: throttle, [DEV_ROUTE_KEY]: throttle, [FEEDBACK_REVIEW_ROUTE_KEY]: throttle, ...(coreAppRoute === undefined ? {} : { [CORE_APP_ROUTE_KEY]: throttle }) };
    // Route settings must name routes that already exist.
    props.stage.addDependency(authRoute);
    props.stage.addDependency(devRoute);
    props.stage.addDependency(feedbackReviewRoute);
    if (coreAppRoute !== undefined) props.stage.addDependency(coreAppRoute);

    const broker = props.broker;
    // ENV-ROOM (broker-names.ts): in a named environment, the names packed and the constrained settings packed; the legacy template passes each whole, as before.
    addBrokerName(broker, props.naming, "signInApi", props.api.ref, issuer);
    broker.addEnvironment("AGENTX_ENV", props.env);
    addBrokerName(broker, props.naming, "signInTable", table.tableName, table.tableName);
    addBrokerName(broker, props.naming, "identityFunction", fn.functionName, fn.functionArn);
    addBrokerSetting(broker, props.naming, "slackTeamId", p.slackTeamId.valueAsString);
    addBrokerSetting(broker, props.naming, "signInSlack", p.slack.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_ISSUER", p.oidcIssuer.valueAsString);
    addBrokerSetting(broker, props.naming, "signInSlackSince", p.slackSince.valueAsString);
    addBrokerSetting(broker, props.naming, "oidcSince", p.oidcSince.valueAsString);
    // DEC 254zg (a): the broker's COMPANY_SIGNIN (packed, a switch flag "1" or "0" the broker reads as "enabled" or "disabled"), from the same switch. #1149: the legacy broker packs
    // it too, so it gets the flag as well (it took the variable whole, "enabled" or "disabled", since #1129).
    if (company !== undefined) addBrokerSetting(broker, props.naming, "companySignIn", company.flag);
    if (tasks !== undefined) {
      addBrokerSetting(broker, props.naming, "mcpConfirmElicitation", tasks.mcpConfirmElicitation.valueAsString);
      // Hosted wiring (d), named environments only: the company audit and event reads (the /v1/dev/client/* routes are always on since DEC 254zzz81). Membership is read from
      // COMPANY_MEMBER# (granted below, also named only).
      // Derived by a named broker (DERIVED_BROKER_VARIABLES; DEC 254h, room for GitHub sign-in): synthesis stops unless the broker would set exactly "enabled".
      if (named) addDerivedBrokerVariable(broker, props.naming, "COMPANY_READS", "enabled");
    } else {
      broker.addEnvironment("DEVELOPER_API_SCOPE", "linking");
    }
    // Named: the control plane grants this with the plan evidence job's invoke, in one statement (control-plane.ts, ENV-ROOM 2's IAM room). Legacy: as before.
    if (!named) fn.grantInvoke(broker);
    // Spec 025 25e: EMAIL# is the email index resolveDeveloper reads to name a developer by email.
    // Spec 063: SIGNIN_CLIENTS holds the registered clients the access check authenticates.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*", "SIGNIN_CLIENTS", ...(taskTokenKeyAlias === undefined ? [] : ["COMPANY_MEMBER#*"])] } },
    }));
    // The output first: the rest is for developer tasks and admin changes. Spec 064: the legacy deployment takes the
    // sign-in client changes, so it gets their audit records (below) and none of the task grants.
    new CfnOutput(stack, "DeveloperSignInIssuer", { value: issuer });
    if (tasks === undefined) {
      broker.addToRolePolicy(adminChangeAudit(props.turnRecords));
      return;
    }

    // The workflow E2E terminal authority transaction also condition-checks the original creator
    // record. Keep that cross-table fence to developer identity rows only.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:ConditionCheckItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        Null: { "dynamodb:LeadingKeys": "false" },
      },
    }));

    // DEC 254zzz(2): the install company import (`agentx admin company import --from-install`, and its undo plan) reads Code's company record and member mirror on this table
    // (install-company-import.ts: GetItem ORG#<id>#COMPANY / META, Query ORG#<id>#MEMBERS / MEMBER#). Exactly those two partitions, for a company id of the shape
    // OrgIdSchema accepts (`org_` and 20 base-36 characters), read-only; nothing else under ORG#, and no write. Its own role policy, not the broker's DefaultPolicy:
    // that one is near CDK's split threshold (above), and a split would be a managed policy the deploy role cannot create. An inline AWS::IAM::Policy is what the deploy
    // role and the permissions boundary already allow (iam:PutRolePolicy under the install's role path).
    // #1129: the legacy deployment (production) too, always: the operator's import reads them BEFORE company sign-in is switched on (DEC 254b (b)).
    if (company !== undefined) new iam.Policy(this, "BrokerCompanyImportReads", {
      roles: [broker.role!],
      statements: [
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem"],
          resources: [table.tableArn],
          conditions: {
            // DEC 254zzz29: and the company's own sign-in issuer row (ORG#<id>#SIGNIN_ISSUER / OIDC), which the broker's company session check reads on every
            // request of a session in a company that is not the built-in one (developer-routes.ts companyOidcSession); without it that check was AccessDenied (401).
            // DEC 254zzz32: and the company's email index (ORG#<id>#EMAIL#<sha256>, store.ts emailIndexKey), which admin-actions.ts resolveDeveloper reads to name a
            // person by email in a company that is not the built-in one (project members, admin plans). Read-only, one company's index rows by key.
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#COMPANY", "ORG#org_????????????????????#SIGNIN_ISSUER", "ORG#org_????????????????????#EMAIL#*"] },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [table.tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#MEMBERS"] },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
        }),
      ],
    });
    // #1129: a named broker reads COMPANY_MEMBER# with the sign-in grants above (with the task token key); the legacy broker reads it (company-check.ts and
    // company-member-forwarding.ts: GetItem, one person's membership) only while company sign-in is on, through a conditional policy.
    if (!named && company !== undefined) {
      company.grant("BrokerCompanyMemberships", broker.role!, [new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"], resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_MEMBER#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
      })]);
    }

    // FR-037, R27: the developer task routes write immutable AI-tool turn records, only under TASK#.
    // No update or delete: a record is written once with a condition and never changed.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [props.turnRecords.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } },
    }));
    broker.addToRolePolicy(adminChangeAudit(props.turnRecords));
  }
}
