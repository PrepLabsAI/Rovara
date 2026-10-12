import { Aws, CfnCondition, Duration, Fn, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import type { CfnParameter, aws_dynamodb as dynamodb, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { resolve } from "node:path";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

const APPROVED_ENV = "agentxlivetest123";
const APPROVED_ACCOUNT = "944937319445";
const APPROVED_REGION = "us-east-1";
const DEVELOPER_ATTRIBUTES = ["pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName"];

export interface TaskPersonProofProps {
  readonly naming: AgentXNaming;
  readonly enabled: CfnParameter;
  readonly slackTeamId: CfnParameter;
  readonly slackSecret: secretsmanager.Secret;
  readonly developerSignInTable: dynamodb.Table;
  readonly dispatcher: lambdaNodejs.NodejsFunction;
}

/** Isolated read-only proof workload for the owner-approved named TEST environment. */
export class TaskPersonProof extends Construct {
  constructor(scope: Construct, id: string, props: TaskPersonProofProps) {
    super(scope, id);
    if (props.naming.env !== APPROVED_ENV) throw new Error("Task Person proof is available only in agentxlivetest123");
    if (props.dispatcher.role === undefined) throw new Error("the dispatcher has no execution role");

    const install = new CfnCondition(this, "InstallTaskPersonProof", {
      expression: Fn.conditionAnd(
        Fn.conditionEquals(props.enabled.valueAsString, "true"),
        Fn.conditionEquals(Aws.ACCOUNT_ID, APPROVED_ACCOUNT),
        Fn.conditionEquals(Aws.REGION, APPROVED_REGION),
      ),
    });

    const proofRole = new iam.Role(this, "Role", {
      roleName: `${APPROVED_ENV}-task-person-proof`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Reads the existing named TEST Slack secret for fresh task person proof",
    });
    const proofRoleResource = proofRole.node.defaultChild as iam.CfnRole;
    proofRoleResource.cfnOptions.condition = install;

    const proof = new lambdaNodejs.NodejsFunction(this, "Function", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/aws/task-person-proof-runtime.ts"),
      handler: "handler",
      role: proofRole,
      timeout: Duration.seconds(7),
      memorySize: 512,
      tracing: lambda.Tracing.DISABLED,
      environment: {
        AGENTX_ENV: APPROVED_ENV,
        SLACK_TEAM_ID: props.slackTeamId.valueAsString,
        SLACK_SECRET_ARN: props.slackSecret.secretArn,
      },
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });
    const proofFunctionResource = proof.node.defaultChild as lambda.CfnFunction;
    proofFunctionResource.cfnOptions.condition = install;
    const version = proof.currentVersion;
    const versionResource = version.node.defaultChild as lambda.CfnVersion;
    versionResource.cfnOptions.condition = install;

    const proofSecretPolicy = new iam.CfnPolicy(this, "SecretReadPolicy", {
      policyName: `${APPROVED_ENV}-task-person-proof-secret-read`,
      roles: [proofRole.roleName],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [props.slackSecret.secretArn],
        }],
      },
    });
    proofSecretPolicy.cfnOptions.condition = install;

    const developerRead = {
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [props.developerSignInTable.tableArn],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": DEVELOPER_ATTRIBUTES },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    };
    const invokeProof = {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: [version.functionArn],
    };
    const dispatcherPolicy = new iam.CfnPolicy(this, "DispatcherPolicy", {
      policyName: `${APPROVED_ENV}-task-person-proof-dispatcher`,
      roles: [props.dispatcher.role.roleName],
      policyDocument: { Version: "2012-10-17", Statement: [developerRead, invokeProof] },
    });
    dispatcherPolicy.cfnOptions.condition = install;

    const whenInstalled = (value: string): string => Fn.conditionIf(install.logicalId, value, "").toString();
    props.dispatcher.addEnvironment("TASK_PERSON_PROOF_FUNCTION_ARN", whenInstalled(version.functionArn));
    props.dispatcher.addEnvironment("SLACK_TEAM_ID", whenInstalled(props.slackTeamId.valueAsString));
    props.dispatcher.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", whenInstalled(props.developerSignInTable.tableName));
  }
}
