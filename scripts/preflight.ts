import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { evaluateEc2Preflight, gatherEc2Facts, type PreflightCheck } from "./ec2-preflight.js";

export interface PreflightResult {
  node: string;
  region?: string | undefined;
  mode: "local" | "aws";
  account?: string | undefined;
  principalArn?: string | undefined;
  /** EC2 worker prerequisites (#87); present with --aws. */
  checks?: PreflightCheck[];
}

export async function runPreflight(options: {
  aws?: boolean;
  region?: string;
  env?: string;
}): Promise<PreflightResult> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node >=22.19.0 is required, found ${process.versions.node}`);
  }

  if (!options.aws) {
    return { node: process.versions.node, mode: "local", region: options.region };
  }

  const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION or --region is required for AWS preflight");

  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  // Read-only: every check describes or reads; nothing is launched, signed or changed.
  const checks = evaluateEc2Preflight(await gatherEc2Facts({ region, ...(options.env === undefined ? {} : { env: options.env }) }));

  return {
    node: process.versions.node,
    region,
    mode: "aws",
    account: identity.Account,
    principalArn: identity.Arn,
    checks,
  };
}

function parseArgs(argv: string[]): { aws: boolean; region?: string; env?: string } {
  const aws = argv.includes("--aws");
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    const found = index >= 0 ? argv[index + 1] : undefined;
    if (index >= 0 && !found) throw new Error(`${flag} requires a value`);
    return found;
  };
  const region = value("--region");
  const env = value("--env");
  return { aws, ...(region === undefined ? {} : { region }), ...(env === undefined ? {} : { env }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreflight(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.checks?.some((check) => check.level === "fail")) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Preflight failed: ${message}\n`);
      process.exitCode = 1;
    });
}
