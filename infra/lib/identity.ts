import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

export const ADMIN_GROUP = "agentx-admin";
// Must be exactly what the CLI's loopback listener sends: packages/cli/src/auth.ts builds
// `http://127.0.0.1:${port}/callback`, and packages/cli/src/main.ts's `login --callback-port`
// defaults that port to DEFAULT_CALLBACK_PORT (8765). tests/contract/identity-stack.test.ts ties
// this literal to that default so the two can't silently drift.
export const CLI_CALLBACK_URL = "http://127.0.0.1:8765/callback";

export interface IdentityStackProps extends StackProps {
  naming: AgentXNaming;
}

/** Sign-in for a fresh install. The control plane's AdminValues default is agentx-admin. */
export class IdentityStack extends Stack {
  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const env = props.naming.env;
    if (env === undefined) throw new Error("the identity stack exists only for named environments");
    // Cognito refuses hosted UI domain prefixes containing these words; fail at synth, not deploy.
    const reserved = ["aws", "amazon", "cognito"].find((word) => env.includes(word));
    if (reserved !== undefined) throw new Error(`environment name ${env} cannot be used for the Cognito domain (it contains "${reserved}"); choose another name or bring your own OIDC`);

    // Changing signInAliases/autoVerify (UsernameAttributes/AliasAttributes) or adding custom
    // Schema attributes replaces the user pool: Cognito does not support updating those in place,
    // so CloudFormation deletes and recreates it (every user would be lost). Once deployed, treat
    // them as fixed. Likewise, UserPoolClient.generateSecret can't be toggled on an existing client;
    // changing it replaces the "Cli" client (and invalidates the CLI's stored client ID).
    // Invitation and verification emails go out through Cognito's built-in default email sender
    // (no SES configuration here), which is capped at roughly 50 emails/day per user pool. That's
    // fine for an invite-only admin pool; move to SES if an environment ever needs more.
    const pool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `agentx-${env}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: pool.userPoolId,
      groupName: ADMIN_GROUP,
      description: "AgentX administrators",
    });
    const domain = pool.addDomain("HostedUi", { cognitoDomain: { domainPrefix: `agentx-${env}-${this.account}` } });
    const client = pool.addClient("Cli", {
      generateSecret: false,
      // No interactive-auth API flows for this app client: sign-in happens through the hosted UI's
      // authorization-code grant. Only refresh-token auth is enabled, never a password-based flow.
      authFlows: { adminUserPassword: false, custom: false, userPassword: false, userSrp: false, user: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [CLI_CALLBACK_URL],
        logoutUrls: [CLI_CALLBACK_URL],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "Issuer", { value: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}` });
    new CfnOutput(this, "ClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "Audience", { value: client.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: domain.baseUrl() });
  }
}
