// The installer: the one stack the Launch in AWS button creates. It installs an AgentX environment
// with no terminal: a CodeBuild job runs `agentx init` in the customer's own account, and a setup
// page (a Lambda function behind an HTTP API) asks the questions that need a person, through a
// DynamoDB table both share (packages/cli/src/init/ui/setup-*.ts).
//
// It holds only the installer. Everything the install makes is in its own agentx-<name>-* stacks,
// so deleting this stack removes the installer and leaves the environment running; `agentx
// destroy` removes the environment.
import {
  Aws, CfnOutput, CfnParameter, CustomResource, Duration, RemovalPolicy, Stack, type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_codebuild as codebuild,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { CLI_PACKAGE_NAME, ENVIRONMENT_NAME_PATTERN } from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";

/** Starts the installer job on Create and answers CloudFormation; Update and Delete only answer.
 * CloudFormation's own response protocol, written out: a failure to start fails the stack. */
export const START_INSTALLER_CODE = `
const https = require("node:https");
const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");
const answer = (event, status, reason) => new Promise((resolve) => {
  const body = JSON.stringify({ Status: status, Reason: reason, PhysicalResourceId: "start-installer", StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId });
  const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-type": "", "content-length": Buffer.byteLength(body) } }, (response) => { response.resume(); response.on("end", resolve); });
  request.on("error", resolve);
  request.end(body);
});
exports.handler = async (event) => {
  try {
    if (event.RequestType === "Create") await new CodeBuildClient({}).send(new StartBuildCommand({ projectName: process.env.PROJECT }));
    await answer(event, "SUCCESS", "ok");
  } catch (error) {
    await answer(event, "FAILED", String(error && error.message || error).slice(0, 200));
  }
};
`;

/** The installer stack's description, the same in the cdk app and the published template. */
export const INSTALLER_DESCRIPTION = "AgentX installer: installs an AgentX environment from its setup page, with no terminal";

/** How long the installer job may run. A step that waits on a person keeps it running. */
export const INSTALLER_TIMEOUT = Duration.hours(8);

export class InstallerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const installName = new CfnParameter(this, "InstallName", {
      type: "String",
      default: "prod",
      allowedPattern: ENVIRONMENT_NAME_PATTERN.source,
      constraintDescription: "lowercase letters, digits and hyphens, starting with a letter, at most 20 characters",
      description: "A short name for this AgentX install; its stacks are named agentx-<name>-*",
    });
    const adminEmail = new CfnParameter(this, "AdminEmail", {
      type: "String",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      constraintDescription: "an email address",
      description: "Your email: your AgentX admin sign-in, the setup link and alerts go here",
    });
    const githubOwner = new CfnParameter(this, "GitHubOwner", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
      constraintDescription: "a GitHub organization or user name",
      description: "The GitHub organization or user that will own AgentX's GitHub App",
    });
    const cliPackage = new CfnParameter(this, "CliPackage", {
      type: "String",
      default: `${CLI_PACKAGE_NAME}@latest`,
      description: "The AgentX CLI the installer runs (an npm package spec); leave as is",
    });

    // The quick-create form: the three answers first, in plain words, the CLI's package last.
    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          { Label: { default: "Your AgentX install" }, Parameters: [adminEmail.logicalId, githubOwner.logicalId, installName.logicalId] },
          { Label: { default: "Advanced" }, Parameters: [cliPackage.logicalId] },
        ],
        ParameterLabels: {
          [adminEmail.logicalId]: { default: "Your email" },
          [githubOwner.logicalId]: { default: "GitHub owner (organization or user)" },
          [installName.logicalId]: { default: "Install name" },
          [cliPackage.logicalId]: { default: "AgentX CLI package" },
        },
      },
    };

    // The table's own key: it also seals the admin's sign-in on its way to the job.
    const key = new kms.Key(this, "SetupKey", {
      description: "AgentX installer: the setup table and the admin's sign-in hand-off",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    const table = new dynamodb.Table(this, "SetupTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      timeToLiveAttribute: "expiresAt",
      // Holds only what passes between the page and the job while the install runs.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The setup page.
    const page = packagedFunction(this, "SetupPage", "packages/cli/src/init/ui/setup-lambda.ts", {
      SETUP_TABLE: table.tableName,
      INSTALL_NAME: installName.valueAsString,
      SETUP_KEY_ID: key.keyArn,
    }, Duration.seconds(20));
    table.grantReadWriteData(page);
    key.grant(page, "kms:Encrypt");
    page.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks"],
      resources: [`arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/agentx-${installName.valueAsString}-identity/*`],
    }));
    const api = new apigwv2.CfnApi(this, "SetupApi", { name: `agentx-installer-${installName.valueAsString}`, protocolType: "HTTP" });
    const integration = new apigwv2.CfnIntegration(this, "SetupIntegration", {
      apiId: api.ref, integrationType: "AWS_PROXY", integrationUri: page.functionArn, payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "SetupRoute", { apiId: api.ref, routeKey: "$default", target: `integrations/${integration.ref}` });
    new apigwv2.CfnStage(this, "SetupStage", { apiId: api.ref, stageName: "$default", autoDeploy: true });
    page.addPermission("SetupApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${api.ref}/*`,
    });
    const setupUrl = api.attrApiEndpoint;

    // The installer job. `agentx init` creates IAM roles (the access stack) and deploys every other
    // stack, as an administrator running it on a computer does: the role is AdministratorAccess,
    // and is deleted with this stack.
    const role = new iam.Role(this, "InstallerRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")],
      description: "AgentX installer: runs agentx init in this account; deleted with the installer stack",
    });
    const project = new codebuild.Project(this, "InstallerJob", {
      description: "AgentX installer: runs agentx init, asking its questions on the setup page",
      role,
      timeout: INSTALLER_TIMEOUT,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: {
        INSTALL_NAME: { value: installName.valueAsString },
        ADMIN_EMAIL: { value: adminEmail.valueAsString },
        GITHUB_OWNER: { value: githubOwner.valueAsString },
        CLI_PACKAGE: { value: cliPackage.valueAsString },
        SETUP_TABLE: { value: table.tableName },
        SETUP_URL: { value: setupUrl },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: { "runtime-versions": { nodejs: 22 } },
          build: {
            commands: [
              'npx --yes --package "$CLI_PACKAGE" rovara --env "$INSTALL_NAME" init --region "$AWS_REGION" --setup-table "$SETUP_TABLE" --setup-url "$SETUP_URL" --admin-email "$ADMIN_EMAIL" --github-account "$GITHUB_OWNER"',
            ],
          },
        },
      }),
    });
    table.grantReadWriteData(role);

    // The job starts as soon as the stack exists: Create stack is the only thing anyone presses.
    // Its code is inline, so the quick-create template needs no code package for it.
    const starter = new lambda.Function(this, "StartInstallerFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.seconds(30),
      code: lambda.Code.fromInline(START_INSTALLER_CODE),
      environment: { PROJECT: project.projectName },
      description: "AgentX installer: starts the installer job when the stack is created",
    });
    starter.addToRolePolicy(new iam.PolicyStatement({ actions: ["codebuild:StartBuild"], resources: [project.projectArn] }));
    new CustomResource(this, "StartInstaller", { serviceToken: starter.functionArn, resourceType: "Custom::StartInstaller" });

    new CfnOutput(this, "SetupPageUrl", {
      value: setupUrl,
      description: "Open this once the email with your temporary password arrives (about five minutes)",
    });
    new CfnOutput(this, "InstallerJobName", { value: project.projectName });
  }
}
