// EC2 worker prerequisites (issue #87): everything a session launch needs, checked read-only before a
// deploy or a cutover. `evaluateEc2Preflight` judges collected facts; `gatherEc2Facts` collects them.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  DescribeImagesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeSubnetsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { DescribeKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetAccountSettingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetServiceQuotaCommand, ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { DescribeStateMachineCommand, SFNClient } from "@aws-sdk/client-sfn";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { WORKER_SETTING_PARAMETERS, environmentSettingsPrefix, environmentStackName } from "../packages/contracts/src/index.js";

/** The worker instance type's vCPUs: one session needs this much On-Demand Standard headroom. */
const WORKER_VCPUS = 1;
/** Below this, the account's Lambda concurrency throttles the control plane under load. */
const LAMBDA_CONCURRENCY_ADVISED = 50;
/** A subnet with fewer free addresses than this can run out while sessions start. */
const MIN_FREE_ADDRESSES = 16;
/** "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances", in vCPUs. */
export const STANDARD_VCPU_QUOTA = "L-1216C47A";
const STANDARD_FAMILIES = /^(a|c|d|h|i|m|r|t|z)\d/;

export interface Ec2PreflightFacts {
  launchTemplate?: { instanceType?: string; imageId?: string; httpTokens?: string; hopLimit?: number };
  /** What the launch template's `resolve:ssm:` image parameter resolves to now. */
  image?: { imageId: string; architecture?: string; state?: string };
  subnets: Array<{ subnetId: string; availabilityZone: string; state?: string; freeAddresses?: number }>;
  /** Availability zones offering the launch template's instance type. */
  instanceTypeZones: string[];
  signingKey?: { enabled: boolean; keySpec?: string; keyUsage?: string };
  workspaceKey?: { enabled: boolean };
  workerSettings: Record<keyof typeof WORKER_SETTING_PARAMETERS, string | undefined>;
  stateMachines: Array<{ name: string; status?: string }>;
  vcpuQuota?: number;
  runningStandardVcpus: number;
  lambdaConcurrency?: number;
}

export interface PreflightCheck {
  name: string;
  level: "pass" | "warn" | "fail";
  detail: string;
}

const check = (name: string, ok: boolean, detail: string, level: "warn" | "fail" = "fail"): PreflightCheck =>
  ({ name, level: ok ? "pass" : level, detail });

export function evaluateEc2Preflight(facts: Ec2PreflightFacts): PreflightCheck[] {
  const template = facts.launchTemplate;
  const checks: PreflightCheck[] = [
    check("launch template", template !== undefined, template === undefined ? "the worker launch template was not found" : `instance type ${template.instanceType}`),
    check("IMDSv2 at hop limit 1", template?.httpTokens === "required" && template.hopLimit === 1,
      `httpTokens ${template?.httpTokens ?? "unset"}, hop limit ${template?.hopLimit ?? "unset"}`),
    check("worker AMI", facts.image?.state === "available" && facts.image.architecture === "arm64",
      facts.image === undefined ? "the image parameter did not resolve" : `${facts.image.imageId} (${facts.image.architecture}, ${facts.image.state})`),
    check("subnets", facts.subnets.length > 0 && facts.subnets.every((subnet) => subnet.state === "available"),
      facts.subnets.map((subnet) => `${subnet.availabilityZone}=${subnet.subnetId} ${subnet.state ?? "missing"}`).join(", ") || "no worker subnets"),
    check("subnet addresses", facts.subnets.every((subnet) => (subnet.freeAddresses ?? 0) >= MIN_FREE_ADDRESSES),
      facts.subnets.map((subnet) => `${subnet.subnetId}: ${subnet.freeAddresses ?? 0} free`).join(", "), "warn"),
    check("instance type offered", facts.subnets.every((subnet) => facts.instanceTypeZones.includes(subnet.availabilityZone)),
      `${template?.instanceType ?? "unknown"} is offered in ${facts.instanceTypeZones.join(", ") || "no zone"}`),
    check("invoke signing key", facts.signingKey?.enabled === true && facts.signingKey.keySpec === "ECC_NIST_P256" && facts.signingKey.keyUsage === "SIGN_VERIFY",
      facts.signingKey === undefined ? "not found" : `${facts.signingKey.enabled ? "enabled" : "disabled"}, ${facts.signingKey.keySpec}, ${facts.signingKey.keyUsage}`),
    check("workspace volume key", facts.workspaceKey?.enabled === true, facts.workspaceKey === undefined ? "not found" : facts.workspaceKey.enabled ? "enabled" : "disabled"),
  ];
  const missingSettings = Object.entries(facts.workerSettings).filter(([, value]) => !value).map(([key]) => key);
  const image = facts.workerSettings.workerImage;
  checks.push(check("worker settings", missingSettings.length === 0 && image !== undefined && /@sha256:[0-9a-f]{64}$/.test(image),
    missingSettings.length > 0 ? `missing ${missingSettings.join(", ")}` : `worker image ${image}`));
  checks.push(check("session state machines", facts.stateMachines.length === 2 && facts.stateMachines.every((machine) => machine.status === "ACTIVE"),
    facts.stateMachines.map((machine) => `${machine.name} ${machine.status ?? "missing"}`).join(", ") || "not found"));
  const headroom = facts.vcpuQuota === undefined ? undefined : facts.vcpuQuota - facts.runningStandardVcpus;
  checks.push(check("On-Demand vCPU quota", headroom !== undefined && headroom >= WORKER_VCPUS,
    headroom === undefined ? "the quota could not be read" : `${facts.runningStandardVcpus} of ${facts.vcpuQuota} vCPUs in use: room for ${Math.floor(headroom / WORKER_VCPUS)} more worker(s)`));
  checks.push(check("Lambda concurrency", (facts.lambdaConcurrency ?? 0) >= LAMBDA_CONCURRENCY_ADVISED,
    `account limit ${facts.lambdaConcurrency ?? "unknown"}; ${LAMBDA_CONCURRENCY_ADVISED} or more is advised (quota L-B99A9384)`, "warn"));
  return checks;
}

export async function gatherEc2Facts(options: { region: string; env?: string }): Promise<Ec2PreflightFacts> {
  const config = { region: options.region };
  const cloudFormation = new CloudFormationClient(config);
  const ec2 = new EC2Client(config);
  const outputs = async (stackName: string): Promise<Record<string, string | undefined>> => {
    const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    return Object.fromEntries((stack?.Outputs ?? []).map((output) => [output.OutputKey ?? "", output.OutputValue]));
  };
  const stackName = (part: "foundation" | "control-plane") => options.env === undefined
    ? { foundation: "AgentXProductionFoundation", "control-plane": "AgentXControlPlane" }[part]
    : environmentStackName(options.env, part);
  const foundation = await outputs(stackName("foundation"));
  const controlPlane = await outputs(stackName("control-plane"));

  const version = (await ec2.send(new DescribeLaunchTemplateVersionsCommand({
    LaunchTemplateId: foundation.Ec2WorkerLaunchTemplateId,
    Versions: ["$Default"],
  }))).LaunchTemplateVersions?.[0]?.LaunchTemplateData;
  const ssm = new SSMClient(config);
  const imageParameter = version?.ImageId?.startsWith("resolve:ssm:") ? version.ImageId.slice("resolve:ssm:".length) : undefined;
  const resolvedImageId = imageParameter === undefined
    ? version?.ImageId
    : (await ssm.send(new GetParametersCommand({ Names: [imageParameter] }))).Parameters?.[0]?.Value;
  const image = resolvedImageId === undefined ? undefined : (await ec2.send(new DescribeImagesCommand({ ImageIds: [resolvedImageId] }))).Images?.[0];

  const pairs = (foundation.Ec2WorkerSubnets ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]);
  const described = pairs.length === 0 ? [] : (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: pairs.map(([, subnetId]) => subnetId) }))).Subnets ?? [];
  const offerings = version?.InstanceType === undefined ? [] : (await ec2.send(new DescribeInstanceTypeOfferingsCommand({
    LocationType: "availability-zone",
    Filters: [{ Name: "instance-type", Values: [version.InstanceType] }],
  }))).InstanceTypeOfferings ?? [];

  const kms = new KMSClient(config);
  const key = async (keyId: string | undefined) => keyId === undefined ? undefined : (await kms.send(new DescribeKeyCommand({ KeyId: keyId }))).KeyMetadata;
  const signing = await key(controlPlane.InvokeSigningKeyArn);
  const workspace = await key(foundation.WorkspaceKmsKeyArn);

  const prefix = options.env === undefined ? "/agentx/production/" : environmentSettingsPrefix(options.env);
  const settingNames = Object.fromEntries(Object.entries(WORKER_SETTING_PARAMETERS).map(([setting, name]) => [setting, `${prefix}${name}`]));
  const settingValues = new Map(((await ssm.send(new GetParametersCommand({ Names: Object.values(settingNames) }))).Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]));

  const sfn = new SFNClient(config);
  const stateMachines: Ec2PreflightFacts["stateMachines"] = [];
  for (const [name, arn] of [["provisioner", controlPlane.SessionProvisionerArn], ["deleter", controlPlane.SessionDeleterArn]] as const) {
    const status = arn === undefined ? undefined : (await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }))).status;
    stateMachines.push({ name, ...(status === undefined ? {} : { status }) });
  }

  const quota = (await new ServiceQuotasClient(config).send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: STANDARD_VCPU_QUOTA }))).Quota?.Value;
  let runningStandardVcpus = 0;
  let NextToken: string | undefined;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: ["pending", "running"] }], ...(NextToken ? { NextToken } : {}) }));
    for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
      if (STANDARD_FAMILIES.test(instance.InstanceType ?? "")) runningStandardVcpus += (instance.CpuOptions?.CoreCount ?? 1) * (instance.CpuOptions?.ThreadsPerCore ?? 1);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  const lambdaConcurrency = (await new LambdaClient(config).send(new GetAccountSettingsCommand({}))).AccountLimit?.ConcurrentExecutions;

  return {
    ...(version === undefined ? {} : { launchTemplate: {
      ...(version.InstanceType === undefined ? {} : { instanceType: version.InstanceType }),
      ...(version.ImageId === undefined ? {} : { imageId: version.ImageId }),
      ...(version.MetadataOptions?.HttpTokens === undefined ? {} : { httpTokens: version.MetadataOptions.HttpTokens }),
      ...(version.MetadataOptions?.HttpPutResponseHopLimit === undefined ? {} : { hopLimit: version.MetadataOptions.HttpPutResponseHopLimit }),
    } }),
    ...(image?.ImageId === undefined ? {} : { image: { imageId: image.ImageId, ...(image.Architecture ? { architecture: image.Architecture } : {}), ...(image.State ? { state: image.State } : {}) } }),
    subnets: pairs.map(([availabilityZone, subnetId]) => {
      const subnet = described.find((candidate) => candidate.SubnetId === subnetId);
      return {
        subnetId,
        availabilityZone,
        ...(subnet?.State === undefined ? {} : { state: subnet.State }),
        ...(subnet?.AvailableIpAddressCount === undefined ? {} : { freeAddresses: subnet.AvailableIpAddressCount }),
      };
    }),
    instanceTypeZones: offerings.map((offering) => offering.Location!).filter(Boolean),
    ...(signing === undefined ? {} : { signingKey: { enabled: signing.Enabled === true, ...(signing.KeySpec ? { keySpec: signing.KeySpec } : {}), ...(signing.KeyUsage ? { keyUsage: signing.KeyUsage } : {}) } }),
    ...(workspace === undefined ? {} : { workspaceKey: { enabled: workspace.Enabled === true } }),
    workerSettings: Object.fromEntries(Object.entries(settingNames).map(([setting, name]) => [setting, settingValues.get(name)])) as Ec2PreflightFacts["workerSettings"],
    stateMachines,
    ...(quota === undefined ? {} : { vcpuQuota: quota }),
    runningStandardVcpus,
    ...(lambdaConcurrency === undefined ? {} : { lambdaConcurrency }),
  };
}
