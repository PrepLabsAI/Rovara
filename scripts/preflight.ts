import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  ListCapacityProvidersCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const INSTANCE_REGIONS = new Set([
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "eu-central-1",
  "eu-west-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
]);

export interface PreflightResult {
  node: string;
  region?: string;
  mode: "local" | "aws";
  account?: string;
  principalArn?: string;
  agentCoreReachable?: boolean;
}

export function validateRuntimeSessionId(value: string): void {
  if (value.length < 33 || value.length > 256) {
    throw new Error("AgentCore runtime session IDs must be between 33 and 256 characters");
  }
}

export function validateInstanceRegion(region: string): void {
  if (!INSTANCE_REGIONS.has(region)) {
    throw new Error(
      `AgentCore Runtime Instances are not recorded as supported in ${region}; ` +
        "verify the current AWS region table before changing this guard",
    );
  }
}

export async function runPreflight(options: {
  aws?: boolean;
  region?: string;
}): Promise<PreflightResult> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node >=22.19.0 is required, found ${process.versions.node}`);
  }

  if (!options.aws) {
    return { node: process.versions.node, mode: "local", region: options.region };
  }

  const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION or --region is required for AWS preflight");
  validateInstanceRegion(region);

  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const control = new BedrockAgentCoreControlClient({ region });
  await Promise.all([
    control.send(new ListAgentRuntimesCommand({ maxResults: 1 })),
    control.send(new ListCapacityProvidersCommand({ maxResults: 1 })),
  ]);

  // Keep the data-plane command imports compile-checked without invoking or stopping a runtime.
  void BedrockAgentCoreClient;
  void InvokeAgentRuntimeCommand;
  void StopRuntimeSessionCommand;

  return {
    node: process.versions.node,
    region,
    mode: "aws",
    account: identity.Account,
    principalArn: identity.Arn,
    agentCoreReachable: true,
  };
}

function parseArgs(argv: string[]): { aws: boolean; region?: string } {
  const aws = argv.includes("--aws");
  const regionIndex = argv.indexOf("--region");
  const region = regionIndex >= 0 ? argv[regionIndex + 1] : undefined;
  if (regionIndex >= 0 && !region) throw new Error("--region requires a value");
  return { aws, region };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreflight(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Preflight failed: ${message}\n`);
      process.exitCode = 1;
    });
}
