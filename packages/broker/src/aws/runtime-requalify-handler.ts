import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DescribeSubnetsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IAMClient } from "@aws-sdk/client-iam";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Ec2RuntimeBindingSchema, type Ec2RuntimeBinding } from "@agentx/contracts";
import { requiredEnvironment } from "./lambda.js";
import { requalifyDrainCount } from "../e2e/requalify-hold.js";
import { ec2RequalifyInstanceReader } from "./runtime-requalify.js";
import { runRequalifyAction, type RequalifyDrainPort, type RequalifyStepsDependencies } from "./runtime-requalify-steps.js";

/**
 * The renewal's Lambda (AR-2): the step machine and the daily scheduler call it with `{ action, state }`. It wires the AWS clients and the deployment's
 * settings to `runRequalifyAction`; it holds no logic of its own.
 *
 * The drain answers with the real count of rounds and setup runs still running on the old machine (`requalifyDrainCount`, AR-3).
 */

const region = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const ec2 = new EC2Client(region);
let publicKey: Promise<string> | undefined;
let binding: Promise<Ec2RuntimeBinding> | undefined;

/** The foundation's worker binding: the launch template and one subnet per zone, in the order of the PrivateSubnetIds the stack was given (as the foundation's Ec2WorkerSubnets lists them). */
async function workerBinding(): Promise<Ec2RuntimeBinding> {
  const ids = requiredEnvironment("PRIVATE_SUBNET_IDS").split(",").map((id) => id.trim()).filter((id) => id !== "");
  const described = (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: ids }))).Subnets ?? [];
  const subnets = ids.map((subnetId) => {
    const availabilityZone = described.find((subnet) => subnet.SubnetId === subnetId)?.AvailabilityZone;
    if (availabilityZone === undefined) throw new Error("a worker subnet was not found");
    return { availabilityZone, subnetId };
  });
  return Ec2RuntimeBindingSchema.parse({ deploymentMode: "ec2-ebs", launchTemplateId: requiredEnvironment("EC2_WORKER_LAUNCH_TEMPLATE_ID"), subnets, volumeSizeGiB: 20, volumeType: "gp3" });
}

// The count of rounds and setup runs still running on the old machine (AR-3): the dispatchers defer new work while the hold stands, so this only falls.
let drain: RequalifyDrainPort | undefined;
const drainPort = (store: { documentClient: DynamoDBDocumentClient; tableName: string }): RequalifyDrainPort => (drain ??= { activeWork: () => requalifyDrainCount(store, Date.now()) });

let dependencies: Promise<RequalifyStepsDependencies> | undefined;

export function createRequalifyDependencies(): Promise<RequalifyStepsDependencies> {
  binding ??= workerBinding();
  dependencies ??= binding.then((expectedBinding): RequalifyStepsDependencies => {
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region));
    const tableName = requiredEnvironment("STATE_TABLE_NAME");
    return {
      documentClient,
      s3: new S3Client(region),
      tableName,
      artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
      setupCatalogId: requiredEnvironment("AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID"),
      featureCatalogId: requiredEnvironment("AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID"),
      environment: requiredEnvironment("REQUALIFY_ENVIRONMENT"),
      expectedBinding,
      describeInstance: ec2RequalifyInstanceReader(ec2),
      config: {
        workerRoleArn: requiredEnvironment("EC2_WORKER_ROLE_ARN"), workerSettingsPrefix: requiredEnvironment("WORKER_SETTINGS_PREFIX"), amiParameterName: requiredEnvironment("AMI_PARAMETER_NAME"),
        controlPlaneUrl: requiredEnvironment("CONTROL_PLANE_URL"), logGroupName: requiredEnvironment("WORKER_LOG_GROUP_NAME"), operatorTopicArn: requiredEnvironment("OPERATOR_TOPIC_ARN"),
        metricsNamespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), stateMachineArn: requiredEnvironment("REQUALIFY_STATE_MACHINE_ARN"),
      },
      ec2, ssm: new SSMClient(region), iam: new IAMClient(region), sns: new SNSClient(region), cloudwatch: new CloudWatchClient(region), sfn: new SFNClient(region),
      drain: drainPort({ documentClient, tableName }),
      // Bundled beside the handler from packages/worker/ec2/boot.sh.
      bootScript: () => readFileSync(join(process.env.LAMBDA_TASK_ROOT ?? ".", "boot.sh"), "utf8"),
      invokePublicKey() {
        publicKey ??= new KMSClient(region).send(new GetPublicKeyCommand({ KeyId: requiredEnvironment("INVOKE_SIGNING_KEY_ARN") }))
          .then((response) => Buffer.from(response.PublicKey ?? new Uint8Array()).toString("base64"));
        return publicKey;
      },
    };
  });
  return dependencies;
}

export const handler = async (event: unknown): Promise<unknown> => runRequalifyAction(await createRequalifyDependencies(), event);
