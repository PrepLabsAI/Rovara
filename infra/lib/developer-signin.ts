// Spec 025 phase 25a: the control plane as the developers' sign-in server. Named environments only
// (R3): the legacy deployment must not change.
import { ArnFormat, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DEVELOPER_TOKEN_AUDIENCE } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { packagedFunction } from "./control-plane.js";

const SIGN_IN_ROUTE_KEY = "ANY /v1/auth/{proxy+}";

export interface DeveloperSignInParameters {
  slackTeamId: CfnParameter; slack: CfnParameter; oidcIssuer: CfnParameter; oidcClientId: CfnParameter;
  oidcRequiredClaim: CfnParameter; oidcRequiredValues: CfnParameter; oidcDisplayName: CfnParameter;
  slackSince: CfnParameter; oidcSince: CfnParameter;
}

/** Declared on the stack itself, so the parameter names are exactly these. */
export function developerSignInParameters(stack: Stack): DeveloperSignInParameters {
  return {
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
}

export interface DeveloperSignInProps {
  naming: AgentXNaming;
  env: string;
  api: apigwv2.CfnApi;
  brokerIntegration: apigwv2.CfnIntegration;
  broker: lambdaNodejs.NodejsFunction;
  /** The concrete Secret (F5): control-plane.ts passes a secretsmanager.Secret. */
  slackSecret: secretsmanager.Secret;
  parameters: DeveloperSignInParameters;
  /** The API's default stage, which throttles the public /v1/auth routes. */
  stage: apigwv2.CfnStage;
}

export class DeveloperSignIn extends Construct {
  constructor(scope: Construct, id: string, props: DeveloperSignInProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    const issuer = `${props.api.attrApiEndpoint}/v1/auth`;

    const table = new dynamodb.Table(this, "Table", {
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

    const oidcSecretName = `agentx/${props.env}/developer-oidc`;
    const fn = packagedFunction(this, "Function", "packages/broker/src/aws/developer-identity.ts", {
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
    }, Duration.seconds(15));
    // Exactly what DeveloperSignInStore sends: GetItem, PutItem, UpdateItem, and TransactWriteItems
    // made of Put and Update items (IAM authorizes each item as PutItem or UpdateItem).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [table.tableArn],
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
    props.slackSecret.grantRead(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      // Secrets Manager appends "-" and six characters to a secret's name in its ARN.
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${oidcSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0",
    });
    const authRoute = new apigwv2.CfnRoute(this, "AuthRoute", {
      apiId: props.api.ref, routeKey: SIGN_IN_ROUTE_KEY, target: `integrations/${integration.ref}`, authorizationType: "NONE",
    });
    // The sign-in routes are public, so the stage caps them: bursts of 50, 20 requests a second on
    // average, across all callers. A developer signs in a few times a week, so this only bites a flood.
    props.stage.routeSettings = { [SIGN_IN_ROUTE_KEY]: { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 } };
    // Route settings must name a route that already exists.
    props.stage.addDependency(authRoute);
    fn.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/auth/*`,
    });

    const authorizer = new apigwv2.CfnAuthorizer(this, "Authorizer", {
      apiId: props.api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: "agentx-developer-jwt",
      jwtConfiguration: { audience: [DEVELOPER_TOKEN_AUDIENCE], issuer },
    });
    new apigwv2.CfnRoute(this, "DevRoute", {
      apiId: props.api.ref, routeKey: "ANY /v1/dev/{proxy+}", target: `integrations/${props.brokerIntegration.ref}`,
      authorizationType: "JWT", authorizerId: authorizer.ref,
    });

    const broker = props.broker;
    broker.addEnvironment("DEVELOPER_TOKEN_ISSUER", issuer);
    broker.addEnvironment("AGENTX_ENV", props.env);
    broker.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", table.tableName);
    broker.addEnvironment("DEVELOPER_IDENTITY_FUNCTION_ARN", fn.functionArn);
    broker.addEnvironment("SLACK_TEAM_ID", p.slackTeamId.valueAsString);
    broker.addEnvironment("DEVELOPER_SIGNIN_SLACK", p.slack.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_ISSUER", p.oidcIssuer.valueAsString);
    broker.addEnvironment("DEVELOPER_SIGNIN_SLACK_SINCE", p.slackSince.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_SINCE", p.oidcSince.valueAsString);
    fn.grantInvoke(broker);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*"] } },
    }));

    // The issuer the developer authorizer and the tokens use, for operators and scripts to read.
    new CfnOutput(stack, "DeveloperSignInIssuer", { value: issuer });
  }
}
