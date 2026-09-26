import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ADMIN_GROUP, CLI_CALLBACK_URL, IdentityStack } from "../../infra/lib/identity.js";
import { environmentNaming } from "../../infra/lib/naming.js";

function identityTemplate(env = "staging"): Template {
  const app = new App();
  return Template.fromStack(new IdentityStack(app, "Identity", { naming: environmentNaming(env), env: { region: "us-east-1", account: "123456789012" } }));
}

describe("identity stack", () => {
  it("creates an invite-only user pool named for the environment, kept on delete", () => {
    const template = identityTemplate();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "agentx-staging",
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: ["email"],
      DeletionProtection: "ACTIVE",
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
    });
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("creates the admin group the control plane expects", () => {
    expect(ADMIN_GROUP).toBe("agentx-admin");
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "agentx-admin" });
  });

  it("creates a public PKCE app client for the CLI's loopback login", () => {
    expect(CLI_CALLBACK_URL).toBe("http://localhost:8765/callback");
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      CallbackURLs: ["http://localhost:8765/callback"],
      LogoutURLs: ["http://localhost:8765/callback"],
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("restricts the app client to refresh-token auth only, never password auth", () => {
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.arrayEquals(["ALLOW_REFRESH_TOKEN_AUTH"]),
    });
  });

  it("uses a hosted UI domain prefix with the environment and account", () => {
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "agentx-staging-123456789012" });
  });

  it("refuses an environment name Cognito would reject in the hosted UI domain", () => {
    for (const env of ["aws-dev", "amazon", "mycognito"]) {
      expect(() => identityTemplate(env), env).toThrow(/Cognito domain/);
    }
  });

  it("outputs what the control plane and the CLI need", () => {
    const outputs = identityTemplate().toJSON().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs).sort()).toEqual(["Audience", "ClientId", "HostedUiDomain", "Issuer", "UserPoolId"]);
    expect(JSON.stringify(outputs.Issuer)).toContain("https://cognito-idp.");
  });

  it("is built only for environments, and not when bringing your own OIDC", () => {
    const names = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c)).map((s) => s.stackName);
    expect(names(buildAgentXApp())).not.toContain("agentx-production-identity");
    expect(names(buildAgentXApp()).some((n) => n.toLowerCase().includes("identity"))).toBe(false);
    expect(names(buildAgentXApp({ agentxEnv: "staging" }))).toContain("agentx-staging-identity");
    expect(names(buildAgentXApp({ agentxEnv: "staging", agentxIdentity: "oidc" }))).not.toContain("agentx-staging-identity");
  }, 240_000);
});
