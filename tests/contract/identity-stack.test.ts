import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ADMIN_GROUP, CLI_CALLBACK_URL, IdentityStack, cliWriteAttributes, USER_WRITE_DENIED, type IdpMappedAttribute } from "../../infra/lib/identity.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { DEFAULT_CALLBACK_PORT } from "../../packages/cli/src/main.js";
import { ENVIRONMENT_PLACEHOLDER, renderTemplate } from "@agentx/contracts";
import { EXPECTED_CLIENT_WRITE_ATTRIBUTES } from "../support/cognito-write-attributes-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

function identityTemplate(env = "staging", idpMappedAttributes?: readonly IdpMappedAttribute[]): Template {
  const app = new App();
  return Template.fromStack(new IdentityStack(app, "Identity", { naming: environmentNaming(env), env: { region: "us-east-1", account: "123456789012" }, ...(idpMappedAttributes === undefined ? {} : { idpMappedAttributes }) }));
}

type Resource = { Type: string; Properties: Record<string, unknown> };
const resourcesOf = (template: Template, type: string): Resource[] => Object.values(template.toJSON().Resources as Record<string, Resource>).filter((resource) => resource.Type === type);

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
    expect(CLI_CALLBACK_URL).toBe("http://127.0.0.1:8765/callback");
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      // The loopback callback only, unless the install runs in the cloud (setup-page-signin.test.ts).
      CallbackURLs: { "Fn::If": ["HasSetupPage", Match.anyValue(), ["http://127.0.0.1:8765/callback"]] },
      LogoutURLs: { "Fn::If": ["HasSetupPage", Match.anyValue(), ["http://127.0.0.1:8765/callback"]] },
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("matches the CLI's actual loopback redirect, so the two can't drift apart", () => {
    // packages/cli/src/auth.ts builds the redirect URI as `http://127.0.0.1:${port}/callback`, and
    // packages/cli/src/main.ts's `login --callback-port` defaults that port to DEFAULT_CALLBACK_PORT.
    // A login with no --callback-port override sends exactly this URL.
    expect(CLI_CALLBACK_URL).toBe(`http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`);
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

  it("refuses an agentxIdentity value that is neither cognito, oidc, nor unset, naming it", () => {
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxIdentity: "okta" })).toThrow(/agentxIdentity/);
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxIdentity: "okta" })).toThrow(/okta/);
  });

  it("refuses agentxIdentity with no agentxEnv: the legacy deployment has no identity stack to configure", () => {
    expect(() => buildAgentXApp({ agentxIdentity: "cognito" })).toThrow(/agentxIdentity/);
    expect(() => buildAgentXApp({ agentxIdentity: "oidc" })).toThrow(/agentxIdentity/);
  });

  it("termination-protects the identity stack like the foundation and runtime stacks", () => {
    const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((c): c is Stack => Stack.isStack(c));
    const identity = stacks.find((stack) => stack.stackName === "agentx-staging-identity");
    expect(identity?.terminationProtection).toBe(true);
  }, 240_000);

  // COGNITO-WRITE-ATTRIBUTES (2026-11-25): defence in depth. This template has no password/SRP flow and no user.admin scope, so no token can call UpdateUserAttributes today; if one ever could,
  // a user must still not be able to mark an address verified, and a changed email must be verified at the new address before it takes effect (email itself stays writable: it is required).
  describe("what a signed-in user may write about themselves", () => {
    it("lets the app client write every standard attribute except the two verified flags, and keeps email writable (Cognito requires a required attribute in the list)", () => {
      const [client] = resourcesOf(identityTemplate(), "AWS::Cognito::UserPoolClient");
      const written = client!.Properties.WriteAttributes as string[];
      expect([...written].sort()).toEqual([...EXPECTED_CLIENT_WRITE_ATTRIBUTES].sort());
      for (const denied of USER_WRITE_DENIED) expect(written, denied).not.toContain(denied);
      expect(written).toContain("email");
      expect(USER_WRITE_DENIED).toEqual(["email_verified", "phone_number_verified"]);
    });

    it("makes the pool verify a new email before it replaces the old one", () => {
      identityTemplate().hasResourceProperties("AWS::Cognito::UserPool", {
        UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ["email"] },
        AutoVerifiedAttributes: ["email"],
      });
    });

    it("changes nothing that would replace the pool or the Cli client", () => {
      // Replacement-sensitive (CloudFormation: GenerateSecret and UserPoolId replace the client; the identity.ts comment lists what replaces the pool). Pinned as they were.
      const pool = resourcesOf(identityTemplate(), "AWS::Cognito::UserPool")[0]!.Properties;
      expect(pool.UsernameAttributes).toEqual(["email"]);
      expect(pool.AliasAttributes).toBeUndefined();
      expect(pool.Schema).toBeUndefined();
      expect(pool.UserPoolName).toBe("agentx-staging");
      const client = resourcesOf(identityTemplate(), "AWS::Cognito::UserPoolClient")[0]!.Properties;
      expect(client.GenerateSecret).toBe(false);
      expect(client.ClientName).toBeUndefined();
      expect(resourcesOf(identityTemplate(), "AWS::Cognito::UserPool")).toHaveLength(1);
      expect(resourcesOf(identityTemplate(), "AWS::Cognito::UserPoolClient")).toHaveLength(1);
    });

    it("keeps the attributes a federated identity provider maps writable, and only those", () => {
      // No provider is configured today. Cognito writes mapped attributes at federated sign-in and fails the sign-in if the client cannot write them.
      expect(cliWriteAttributes().attributes()).toEqual(expect.not.arrayContaining(["email_verified"]));
      const mapped = (names: readonly IdpMappedAttribute[]) => (resourcesOf(identityTemplate("staging", names), "AWS::Cognito::UserPoolClient")[0]!.Properties.WriteAttributes as string[]);
      expect(mapped(["email_verified"])).toEqual(expect.arrayContaining(["email", "email_verified"]));
      expect(mapped(["email_verified"])).not.toContain("phone_number_verified");
      expect(mapped([])).not.toContain("email_verified");
      expect(mapped([])).toEqual(resourcesOf(identityTemplate(), "AWS::Cognito::UserPoolClient")[0]!.Properties.WriteAttributes);
    });

    it("is carried by the published template, rendered for an environment", () => {
      const published = JSON.stringify(identityTemplate(ENVIRONMENT_PLACEHOLDER).toJSON());
      const rendered = JSON.parse(renderTemplate(published, "staging")) as { Resources: Record<string, Resource> };
      const pools = Object.values(rendered.Resources).filter((resource) => resource.Type === "AWS::Cognito::UserPool");
      const clients = Object.values(rendered.Resources).filter((resource) => resource.Type === "AWS::Cognito::UserPoolClient");
      expect(pools[0]!.Properties.UserAttributeUpdateSettings).toEqual({ AttributesRequireVerificationBeforeUpdate: ["email"] });
      const written = clients[0]!.Properties.WriteAttributes as string[];
      expect([...written].sort()).toEqual([...EXPECTED_CLIENT_WRITE_ATTRIBUTES].sort());
    });
  });
});
