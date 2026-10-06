// The installer stack (the Launch in AWS button) and the setup page's function. Nothing here reaches
// AWS.
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { InstallerStack, INSTALLER_TIMEOUT, START_INSTALLER_CODE } from "../../infra/lib/installer.js";
import { setupPageFunction, stackSetupIdentity } from "../../packages/cli/src/init/ui/setup-lambda.js";
import { memorySetupStore } from "../../packages/cli/src/init/ui/setup-store.js";
import { WIZARD_TOKEN_HEADER } from "../../packages/cli/src/init/ui/protocol.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const template = () => Template.fromStack(new InstallerStack(new App(), "Installer", { env: { region: "us-east-1", account: "123456789012" } }));

describe("the installer stack", () => {
  it("asks only for the install name, your email and the GitHub owner (the CLI's package has a default)", () => {
    const parameters = template().toJSON().Parameters as Record<string, { Default?: string; AllowedPattern?: string }>;
    expect(Object.keys(parameters).filter((name) => !name.startsWith("BootstrapVersion")).sort()).toEqual(["AdminEmail", "CliPackage", "GitHubOwner", "InstallName"]);
    expect(parameters.InstallName?.Default).toBe("prod");
    expect(parameters.AdminEmail?.Default).toBeUndefined();
    expect(parameters.CliPackage?.Default).toMatch(/@latest$/);
  });

  it("keeps the setup table encrypted with its own rotating key, with expiring items", () => {
    const stack = template();
    stack.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
    stack.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: "KMS" }),
    });
  });

  it("runs agentx init in CodeBuild as an administrator role that is deleted with the stack", () => {
    const stack = template();
    stack.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Service: "codebuild.amazonaws.com" } })] }),
      ManagedPolicyArns: [Match.objectLike({ "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp("AdministratorAccess")])] })],
    });
    const project = Object.values(stack.findResources("AWS::CodeBuild::Project"))[0] as { Properties: { TimeoutInMinutes: number; Source: { BuildSpec: string }; Environment: { EnvironmentVariables: Array<{ Name: string }> } } };
    expect(project.Properties.TimeoutInMinutes).toBe(INSTALLER_TIMEOUT.toMinutes());
    expect(project.Properties.Environment.EnvironmentVariables.map((variable) => variable.Name).sort()).toEqual(["ADMIN_EMAIL", "CLI_PACKAGE", "GITHUB_OWNER", "INSTALL_NAME", "SETUP_TABLE", "SETUP_URL"]);
    const spec = project.Properties.Source.BuildSpec;
    expect(spec).toContain('"nodejs": 22');
    expect(spec).toContain('init --region \\"$AWS_REGION\\" --setup-table \\"$SETUP_TABLE\\" --setup-url \\"$SETUP_URL\\" --admin-email \\"$ADMIN_EMAIL\\" --github-account \\"$GITHUB_OWNER\\"');
  });

  it("starts the job as soon as the stack is created", () => {
    const resources = template().toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    expect(Object.values(resources).some((resource) => resource.Type === "Custom::StartInstaller")).toBe(true);
    // Inline, so the published template needs no code package for it (CloudFormation takes at most 4096 characters).
    expect(START_INSTALLER_CODE.length).toBeLessThan(4096);
    expect(START_INSTALLER_CODE).toContain('if (event.RequestType === "Create") await new CodeBuildClient({}).send(new StartBuildCommand({ projectName: process.env.PROJECT }))');
    const starter = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties).includes("StartBuildCommand"));
    expect(starter?.Properties.Code).toEqual({ ZipFile: START_INSTALLER_CODE });
  });

  it("serves the setup page from a function behind an HTTP API, and says where it is", () => {
    const stack = template();
    stack.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
    stack.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: Match.objectLike({ SETUP_TABLE: Match.anyValue(), INSTALL_NAME: { Ref: "InstallName" }, SETUP_KEY_ID: Match.anyValue() }) } });
    stack.hasOutput("SetupPageUrl", Match.anyValue());
  });

  it("is built only when asked for, so no release or production deploy ever includes it", () => {
    expect(buildAgentXApp().node.tryFindChild("AgentXInstaller")).toBeUndefined();
    expect(buildAgentXApp({ agentxInstaller: "enabled" }).node.tryFindChild("AgentXInstaller")).toBeInstanceOf(InstallerStack);
  });
});

describe("the setup page's function", () => {
  it("reads the identity stack's sign-in once that stack is up, and keeps it", async () => {
    let calls = 0;
    const cloudFormation = {
      async send(command: unknown) {
        calls += 1;
        expect(command).toBeInstanceOf(DescribeStacksCommand);
        if (calls === 1) throw Object.assign(new Error("Stack with id agentx-prod-identity does not exist"), { name: "ValidationError" });
        return { Stacks: [{ Outputs: [{ OutputKey: "HostedUiDomain", OutputValue: "https://agentx-prod-1.auth.us-east-1.amazoncognito.com" }, { OutputKey: "ClientId", OutputValue: "client" }] }] };
      },
    };
    const identity = stackSetupIdentity({ cloudFormation: cloudFormation as never, env: "prod" });
    expect(await identity()).toBeUndefined();
    expect(await identity()).toEqual({ hostedUiDomain: "https://agentx-prod-1.auth.us-east-1.amazoncognito.com", clientId: "client" });
    await identity();
    expect(calls).toBe(2);
  });

  it("turns API Gateway's events into the page's requests: its own address, the cookies, and an encoded body", async () => {
    const store = memorySetupStore();
    const run = setupPageFunction({ store, env: "prod", auth: { kind: "token", token: "t0ken" } });
    const domainName = "abc123.execute-api.us-east-1.amazonaws.com";
    const page = await run({ rawPath: "/", rawQueryString: "t=t0ken", headers: { host: domainName }, requestContext: { domainName, http: { method: "GET" } } });
    expect(page.statusCode).toBe(200);
    const close = await run({
      rawPath: "/close", headers: { host: domainName, origin: `https://${domainName}`, [WIZARD_TOKEN_HEADER]: "t0ken" }, cookies: ["a=1", "b=2"],
      body: Buffer.from("{}").toString("base64"), isBase64Encoded: true, requestContext: { domainName, http: { method: "POST" } },
    });
    expect(close.statusCode).toBe(200);
    expect(await store.takeClose()).toBe(true);
    const refused = await run({ rawPath: "/", rawQueryString: "t=wrong", headers: { host: domainName }, requestContext: { domainName, http: { method: "GET" } } });
    expect(refused.statusCode).toBe(401);
  });
});
