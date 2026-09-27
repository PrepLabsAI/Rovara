// The export bundle: everything a platform team needs to deploy the access stack themselves, with
// their own AWS credentials and no AWS call ever made by our CLI. It writes a self-contained
// directory: the access stack's template and parameters, a deploy script that uses the AWS CLI
// only, the policy the platform team attaches to run that script, and the inline policies every
// later stack's roles carry (with this environment's real account, region and partition, so they
// can be reviewed as plain JSON). Every part's template and parameters are included, in install
// order, so the bundle also documents the full deploy — even though only the access stack's is
// meant to be run directly here; every later stack is deployed by the AgentX operator through the
// service role the access stack creates (`agentx init --resume`, phase 15d).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  environmentRolePath,
  environmentStackName,
  defaultBoundaryStatements,
  operatorRoleStatements,
  serviceRoleStatements,
  type PolicyScope,
  type PolicyStatementJson,
} from "@agentx/contracts";
import type { DeployAnswers } from "./deploy-environment.js";
import { sha256Hex } from "./hash.js";
import { installOrder, stackParameters, type DeployPart, type InstallAnswers, type StackOutputs } from "./parameters.js";
import type { LoadedRelease } from "./release.js";
import { callbackSigningKeySecretName } from "./signing-key.js";

export interface ExportBundleInput {
  /** Must be empty or absent. */
  dir: string;
  answers: DeployAnswers & { clientId?: string };
  release: LoadedRelease;
}

export interface ExportBundleResult {
  /** Every file written, relative to `dir`, sorted. */
  files: string[];
}

/** Every marker this bundle ever writes in place of a value only known once install begins. Kept
 * together so every place that could leak a real value (the tests, and anyone reviewing this file)
 * can name exactly what "safe" looks like. */
const outputMarker = (part: DeployPart, name: string): string => `{{output:${part}.${name}}}`;
const githubMarker = (field: string): string => `{{github:${field}}}`;

/**
 * An outputs map whose every read, for every part and every output name, returns
 * `{{output:<part>.<name>}}`. Built this way — rather than listing today's exact set of output
 * names `stackParameters` happens to read — so the marker mapping can never drift out of sync with
 * what `stackParameters` actually asks for: whatever key it reads, it gets the matching marker.
 */
function markerOutputs(): Partial<Record<DeployPart, StackOutputs>> {
  const outputs: Partial<Record<DeployPart, StackOutputs>> = {};
  for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"] as const) {
    outputs[part] = new Proxy<StackOutputs>({}, {
      get: (_target, name) => (typeof name === "string" ? outputMarker(part, name) : undefined),
    });
  }
  return outputs;
}

/**
 * `answers` widened to a full `InstallAnswers` for `stackParameters`, with every value the export
 * bundle cannot know yet replaced by its marker: the callback signing key (a secret,
 * `signing-key.ts`'s `callbackSigningKey` is never called here) and the GitHub App (not set up
 * until the operator configures it, phase 15d). Everything else — region, account, models,
 * identity, the release manifest, the operator's own boundary/principal choices — is already known
 * and is carried through as given.
 */
function markerAnswers(answers: DeployAnswers, release: LoadedRelease): InstallAnswers {
  return {
    ...answers,
    release: release.manifest,
    callbackSigningKey: `{{secret:${callbackSigningKeySecretName(answers.env)}}}`,
    github: {
      account: githubMarker("account"),
      appId: githubMarker("appId"),
      installationId: githubMarker("installationId"),
      privateKeySecretArn: githubMarker("privateKeySecretArn"),
    },
  };
}

function parameterList(parameters: Record<string, string>): Array<{ ParameterKey: string; ParameterValue: string }> {
  return Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
}

function policyDocument(statements: PolicyStatementJson[]): string {
  return `${JSON.stringify({ Version: "2012-10-17", Statement: statements }, null, 2)}\n`;
}

/**
 * The policy a platform team attaches to whoever runs `deploy-access.sh`: CloudFormation on the
 * access stack alone, role and policy management scoped to this environment's IAM path, creating
 * the default permission boundary, creating the artifact bucket, and the ECR pull-through cache
 * rule (which has no resource-level scoping). The bucket resource is a pattern, not the bucket's
 * real name: the access stack's bucket declares no `BucketName`, so CloudFormation names it itself
 * at deploy time as "<StackName>-<LogicalID>-<uniqueID>" (docs.aws.amazon.com/AWSCloudFormation/
 * latest/UserGuide/resources-section-structure.html#resources-section-physical-id) — always
 * starting with the stack's own name, `agentx-<env>-access`.
 */
function accessDeployerStatements(scope: { env: string; partition: string; region: string; account: string }): PolicyStatementJson[] {
  const { env, partition, region, account } = scope;
  const stackArn = `arn:${partition}:cloudformation:${region}:${account}:stack/${environmentStackName(env, "access")}/*`;
  const roleArn = `arn:${partition}:iam::${account}:role/agentx-${env}-*`;
  const policyArn = `arn:${partition}:iam::${account}:policy${environmentRolePath(env)}*`;
  const bucketArn = `arn:${partition}:s3:::${environmentStackName(env, "access")}-*`;
  return [
    { Sid: "AccessStack", Effect: "Allow", Action: ["cloudformation:*"], Resource: stackArn },
    { Sid: "IamRoles", Effect: "Allow", Action: ["iam:*Role*"], Resource: roleArn },
    { Sid: "IamPolicies", Effect: "Allow", Action: ["iam:*Policy*", "iam:CreatePolicy"], Resource: policyArn },
    { Sid: "ArtifactBucket", Effect: "Allow", Action: ["s3:CreateBucket*", "s3:PutBucket*"], Resource: bucketArn },
    { Sid: "PullThroughCache", Effect: "Allow", Action: ["ecr:CreatePullThroughCacheRule", "ecr:DeletePullThroughCacheRule"], Resource: "*" },
  ];
}

/**
 * The bash script the platform team runs: the exact five-step change-set flow (create, wait,
 * describe so the changes are reviewed before anything happens, execute, wait) plus turning on
 * termination protection, using the AWS CLI only. The access stack takes no secret parameters (its
 * only parameters are `PermissionsBoundaryArn` and `OperatorPrincipalArn`), so this script never
 * reads or prints one. Every variable is quoted.
 */
function deployAccessScript(scope: { env: string; region: string }): string {
  const stackName = environmentStackName(scope.env, "access");
  return `#!/usr/bin/env bash
set -euo pipefail

# Deploys the access stack for the "${scope.env}" AgentX environment in ${scope.region}: the one
# stack a platform team deploys directly, with their own AWS credentials (policies/access-deployer.json
# names exactly what that principal needs). Every later stack is deployed by the AgentX operator
# through the CloudFormationServiceRole this stack creates, by running \`agentx init --resume\`
# (see README.md). The access stack takes no secret parameters, so this script never reads or
# prints one.

STACK_NAME="${stackName}"
CHANGE_SET_NAME="${stackName}-$(date +%s)"

cd "$(dirname "\${BASH_SOURCE[0]}")"

echo "Creating change set \${CHANGE_SET_NAME} for stack \${STACK_NAME} in ${scope.region}..."
aws cloudformation create-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --change-set-type CREATE \\
  --template-body "file://templates/access.template.json" \\
  --parameters "file://parameters/access.json" \\
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \\
  --region "${scope.region}"

echo "Waiting for the change set to finish creating..."
aws cloudformation wait change-set-create-complete \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${scope.region}"

echo "Changes:"
aws cloudformation describe-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${scope.region}"

echo "Executing the change set..."
aws cloudformation execute-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${scope.region}"

echo "Waiting for the stack to finish creating..."
aws cloudformation wait stack-create-complete \\
  --stack-name "\${STACK_NAME}" \\
  --region "${scope.region}"

echo "Enabling termination protection..."
aws cloudformation update-termination-protection \\
  --enable-termination-protection \\
  --stack-name "\${STACK_NAME}" \\
  --region "${scope.region}"

echo "Done. Stack outputs:"
aws cloudformation describe-stacks --stack-name "\${STACK_NAME}" --region "${scope.region}" --query "Stacks[0].Outputs"
`;
}

function readme(input: { env: string; region: string; account: string; order: DeployPart[] }): string {
  const { env, region, account, order } = input;
  const stackName = environmentStackName(env, "access");
  const laterParts = order.filter((part) => part !== "access");
  return `# AgentX access stack: platform-team deploy bundle

This bundle deploys the **access stack** (\`${stackName}\`) for the \`${env}\` AgentX environment in
\`${region}\` (AWS account \`${account}\`). The access stack is the only stack a platform team ever
deploys directly, with their own AWS credentials: it creates the artifact bucket, the ECR
pull-through cache rule, and the two IAM roles every later stack needs.

## What it creates

- \`agentx-${env}-cloudformation\` — the role CloudFormation assumes to deploy every later AgentX
  stack for this environment.
- \`agentx-${env}-operator\` — the role an AgentX operator assumes to run \`agentx\` against this
  environment.
- \`agentx-${env}-boundary\` (only when no permissions boundary ARN is given) — the default
  permission boundary applied to both roles above and every role the later stacks create.
- An S3 bucket for release artifacts (templates and code packages) and an ECR pull-through cache
  rule prefixed \`agentx-${env}\`.

## Deploying

Run \`./deploy-access.sh\` with AWS CLI credentials that can create the resources above (see
\`policies/access-deployer.json\` for exactly what that principal needs). It runs, in order:

1. \`aws cloudformation create-change-set\` (\`--change-set-type CREATE\`, the templates and
   parameters in this bundle, \`--capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM\`)
2. \`aws cloudformation wait change-set-create-complete\`
3. \`aws cloudformation describe-change-set\` (review the changes)
4. \`aws cloudformation execute-change-set\`
5. \`aws cloudformation wait stack-create-complete\`
6. \`aws cloudformation update-termination-protection --enable-termination-protection\`

The access stack takes no secret parameters; the script never reads or prints one.

## After this stack exists

Every other stack — ${laterParts.join(", ")} — is deployed by the AgentX operator through the
\`agentx-${env}-cloudformation\` role this stack creates, by running \`agentx init --resume\` (phase
15d). The platform team's own credentials are never needed again.

## Files in this bundle

- \`templates/<part>.template.json\` — every stack's CloudFormation template (${order.join(", ")}),
  already rendered for \`${env}\`.
- \`parameters/<part>.json\` — that stack's parameters, as CloudFormation's
  \`[{ "ParameterKey", "ParameterValue" }]\` array. A value only known once install begins — an
  earlier stack's output, the control-plane's callback signing key, or the GitHub App — is written
  as a \`{{output:<part>.<Name>}}\`, \`{{secret:...}}\` or \`{{github:<field>}}\` marker instead of a
  real value.
- \`packages/\` — the release's code packages, plus \`packages/SHA256SUMS\` to check them
  (\`sha256sum -c SHA256SUMS\` from inside that directory).
- \`policies/service-role.json\`, \`policies/operator-role.json\`, \`policies/default-boundary.json\`
  — the inline policies the later stacks' roles carry, with this environment's real account,
  region and partition.
- \`policies/access-deployer.json\` — the policy for whoever runs \`deploy-access.sh\`.
`;
}

/** Refuses when `dir` exists and already holds files; creates it when absent. */
async function claimExportDir(dir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dir, { recursive: true });
      return;
    }
    throw error;
  }
  if (existing.length > 0) throw new Error(`export directory ${dir} is not empty`);
}

/**
 * Writes the export bundle: the access stack's real template and parameters (and every later
 * part's, for review, in install order), the deploy script, and the policy documents. Makes no AWS
 * call. Refuses (writing nothing) a non-empty `dir` or a region the release does not cover.
 */
export async function writeExportBundle(input: ExportBundleInput): Promise<ExportBundleResult> {
  const { dir, answers, release } = input;
  const { env, region, account } = answers;
  const partition = answers.partition ?? "aws";

  if (!release.regions().includes(region)) {
    throw new Error(`release ${release.manifest.version} does not cover region ${region}`);
  }
  await claimExportDir(dir);

  const files: string[] = [];
  async function write(relativePath: string, content: string | Buffer, options: { mode?: number } = {}): Promise<void> {
    const target = join(dir, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, options.mode === undefined ? undefined : { mode: options.mode });
    files.push(relativePath);
  }

  const order = installOrder(answers.identity.mode);
  const bundleAnswers = markerAnswers(answers, release);
  const outputs = markerOutputs();

  for (const part of order) {
    await write(`templates/${part}.template.json`, release.template(part, region, env));
    const parameters = stackParameters(part, bundleAnswers, outputs);
    await write(`parameters/${part}.json`, `${JSON.stringify(parameterList(parameters), null, 2)}\n`);
  }

  const sortedPackages = [...release.manifest.packages].sort((a, b) => a.assetId.localeCompare(b.assetId));
  const sums: string[] = [];
  for (const pkg of sortedPackages) {
    const bytes = await readFile(release.packagePath(pkg.assetId));
    // Verified once already when the release was loaded; check the bytes actually copied too,
    // mirroring the templates engine's own upload check (templates-engine.ts).
    const actual = sha256Hex(bytes);
    if (actual !== pkg.sha256) throw new Error(`release file ${pkg.file} does not match release.json`);
    await write(`packages/${pkg.assetId}.zip`, bytes);
    sums.push(`${pkg.sha256}  ${pkg.assetId}.zip`);
  }
  await write("packages/SHA256SUMS", sums.length === 0 ? "" : `${sums.join("\n")}\n`);

  // Deterministic, ahead of any deploy: the artifact bucket's real name has a random suffix only
  // CloudFormation assigns at deploy time (see accessDeployerStatements' comment), so its ARN here
  // is the same pattern the access-deployer policy uses. pullThroughPrefix, cloudFormationRoleName
  // and runtimeName mirror infra/lib/naming.ts's environmentNaming(env) (recomputed here, not
  // imported, because this package may depend on @agentx/contracts but not infra/) — keep them in
  // sync if that ever changes.
  const policyScope: PolicyScope = {
    env,
    partition,
    region,
    account,
    artifactBucketArn: `arn:${partition}:s3:::${environmentStackName(env, "access")}-*`,
    pullThroughPrefix: `agentx-${env}`,
    cloudFormationRoleName: `agentx-${env}-cloudformation`,
    runtimeName: `agentx_${env.replaceAll("-", "_")}_worker`,
    ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
  };
  await write("policies/service-role.json", policyDocument(serviceRoleStatements(policyScope)));
  await write("policies/operator-role.json", policyDocument(operatorRoleStatements(policyScope)));
  await write("policies/default-boundary.json", policyDocument(defaultBoundaryStatements(policyScope)));
  await write("policies/access-deployer.json", policyDocument(accessDeployerStatements({ env, partition, region, account })));

  await write("deploy-access.sh", deployAccessScript({ env, region }), { mode: 0o755 });
  await write("README.md", readme({ env, region, account, order }));

  return { files: files.sort() };
}
