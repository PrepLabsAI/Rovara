import { resolve } from "node:path";
import { parseAdditionalGitHubAppBindings, type GitHubAppBinding } from "@agentx/contracts";
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_s3 as s3,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface ControlPlaneStackProps extends StackProps {
  additionalGitHubApps?: GitHubAppBinding[];
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: ControlPlaneStackProps) {
    super(scope, id, props);

    const additional = parseAdditionalGitHubAppBindings(props?.additionalGitHubApps ?? [], "github-agentx-sdlc");
    if (Buffer.byteLength(JSON.stringify(additional), "utf8") > 2048) {
      throw new Error("additional GitHub App registry exceeds the environment budget");
    }
    for (const binding of additional) {
      const parts = binding.privateKeySecretArn.split(":");
      if (Token.isUnresolved(this.account) || Token.isUnresolved(this.region) ||
          parts[1] !== "aws" || parts[3] !== this.region || parts[4] !== this.account) {
        throw new Error("additional GitHub App secret requires a matching explicit AWS account and region");
      }
    }

    const oidcIssuer = new CfnParameter(this, "OidcIssuer", { type: "String" });
    const oidcAudience = new CfnParameter(this, "OidcAudience", { type: "String" });
    const callbackSigningKey = new CfnParameter(this, "CallbackSigningKey", {
      type: "String",
      noEcho: true,
      minLength: 32,
      description: "Random secret used to scope and authenticate worker callbacks",
    });
    const adminClaim = new CfnParameter(this, "AdminClaim", {
      type: "String",
      default: "cognito:groups",
    });
    const adminValues = new CfnParameter(this, "AdminValues", {
      type: "String",
      default: '["agentx-admin"]',
      description: "JSON string array of claim values that grant AgentX administrator access",
    });
    const githubAppCredentialRef = new CfnParameter(this, "GitHubAppCredentialRef", {
      type: "String",
      default: "github-agentx-sdlc",
    });
    const githubAppAccount = new CfnParameter(this, "GitHubAppAccount", { type: "String" });
    const githubAppId = new CfnParameter(this, "GitHubAppId", { type: "String" });
    const githubAppInstallationId = new CfnParameter(this, "GitHubAppInstallationId", {
      type: "String",
    });
    const githubAppPrivateKeySecretArn = new CfnParameter(this, "GitHubAppPrivateKeySecretArn", {
      type: "String",
      description: "Complete Secrets Manager ARN containing the GitHub App private key PEM",
    });

    const state = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const artifacts = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const deadLetterQueue = new sqs.Queue(this, "DispatchDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const dispatchQueue = new sqs.Queue(this, "DispatchQueue", {
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(2),
    });

    const broker = packagedFunction(this, "Broker", "packages/broker/src/aws/broker.ts", {
      STATE_TABLE_NAME: state.tableName,
      ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      OIDC_ISSUER: oidcIssuer.valueAsString,
      ADMIN_CLAIM: adminClaim.valueAsString,
      ADMIN_VALUES: adminValues.valueAsString,
      CALLBACK_SIGNING_KEY: callbackSigningKey.valueAsString,
      GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString,
      GITHUB_APP_ACCOUNT: githubAppAccount.valueAsString,
      GITHUB_APP_ID: githubAppId.valueAsString,
      GITHUB_APP_INSTALLATION_ID: githubAppInstallationId.valueAsString,
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
    });
    state.grantReadWriteData(broker);
    artifacts.grantReadWrite(broker);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:StopRuntimeSession"],
      resources: [runtimeArn(this)],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [githubAppPrivateKeySecretArn.valueAsString],
    }));
    if (additional.length > 0) {
      broker.addEnvironment("GITHUB_APP_ADDITIONAL_BINDINGS", JSON.stringify(additional));
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [...new Set(additional.map((binding) => binding.privateKeySecretArn))],
      }));
    }

    const outboxPublisher = packagedFunction(
      this,
      "OutboxPublisher",
      "packages/broker/src/aws/outbox-publisher.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        DISPATCH_QUEUE_URL: dispatchQueue.queueUrl,
      },
    );
    state.grantStreamRead(outboxPublisher);
    state.grantReadWriteData(outboxPublisher);
    dispatchQueue.grantSendMessages(outboxPublisher);
    new lambda.EventSourceMapping(this, "OutboxStreamMapping", {
      target: outboxPublisher,
      eventSourceArn: state.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 3,
      bisectBatchOnError: true,
    });

    const dispatcher = packagedFunction(
      this,
      "Dispatcher",
      "packages/broker/src/aws/dispatcher.ts",
      { STATE_TABLE_NAME: state.tableName },
      Duration.seconds(60),
    );
    dispatchQueue.grantConsumeMessages(dispatcher);
    state.grantReadWriteData(dispatcher);
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: [runtimeArn(this)],
    }));
    new lambda.EventSourceMapping(this, "DispatchQueueMapping", {
      target: dispatcher,
      eventSourceArn: dispatchQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });

    const api = new apigwv2.CfnApi(this, "HttpApi", {
      name: "agentx-control-plane",
      protocolType: "HTTP",
    });
    const integration = new apigwv2.CfnIntegration(this, "BrokerIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: broker.functionArn,
      payloadFormatVersion: "2.0",
    });
    const authorizer = new apigwv2.CfnAuthorizer(this, "JwtAuthorizer", {
      apiId: api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: "agentx-jwt",
      jwtConfiguration: {
        audience: [oidcAudience.valueAsString],
        issuer: oidcIssuer.valueAsString,
      },
    });
    new apigwv2.CfnRoute(this, "ProxyRoute", {
      apiId: api.ref,
      routeKey: "ANY /{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "JWT",
      authorizerId: authorizer.ref,
    });
    new apigwv2.CfnRoute(this, "WorkerCallbackRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/internal/{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
    });
    broker.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/*`,
    });

    new CfnOutput(this, "ApiEndpoint", { value: api.attrApiEndpoint });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "DispatchDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
  }
}

function packagedFunction(
  scope: Construct,
  id: string,
  entry: string,
  environment: Record<string, string>,
  timeout = Duration.seconds(30),
): lambdaNodejs.NodejsFunction {
  return new lambdaNodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: resolve(process.cwd(), entry),
    handler: "handler",
    timeout,
    memorySize: 512,
    tracing: lambda.Tracing.ACTIVE,
    environment,
    bundling: {
      externalModules: [],
      minify: true,
      sourceMap: true,
      target: "node22",
    },
  });
}

function runtimeArn(stack: Stack): string {
  return `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*`;
}
