// The export bundle: everything a platform team needs to deploy the access stack themselves, with
// their own AWS credentials and no AWS call ever made by our CLI. It writes a self-contained
// directory: the access stack's template and parameters, a deploy script that uses the AWS CLI
// only, the policy the platform team attaches to run that script, and the inline policies every
// later stack's roles carry (with this environment's real account, region and partition, so they
// can be reviewed as plain JSON). Every part's template and parameters are included, in install
// order, so the bundle also documents the full deploy — even though only the access stack's is
// meant to be run directly here; every later stack is deployed by the AgentX operator through the
// service role the access stack creates (`agentx init --resume`, phase 15d).
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultBoundaryArn,
  defaultBoundaryStatements,
  environmentCloudFormationRoleName,
  environmentOperatorRoleName,
  environmentPullThroughPrefix,
  environmentRuntimeName,
  environmentStackName,
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
 * The policy a platform team attaches to whoever runs `deploy-access.sh`, scoped to exactly what
 * the access stack's own template declares (verified against the real synthesized template; see
 * requiredActionsFor below and task-6-report.md's "Fix round 1" section for what AWS documentation
 * this could and couldn't confirm):
 *
 * - CloudFormation on the access stack alone.
 * - IAM role management, scoped to the two roles' *exact* ARNs (known at export from the
 *   environment name alone) — never `iam:PassRole`, `iam:UpdateAssumeRolePolicy`,
 *   `iam:DeleteRolePermissionsBoundary` or `iam:CreateServiceLinkedRole`, none of which this
 *   principal (as opposed to the roles it creates) ever needs, and none of which a bare
 *   `iam:*Role*` wildcard could be trusted to exclude.
 * - IAM managed-policy management, scoped to the exact default-boundary ARN.
 * - The artifact bucket: created, configured (encryption, versioning, lifecycle, public-access
 *   block, its own bucket policy, tags) and — since a failed create can roll back, or the platform
 *   team may want to tear a stalled attempt down — read and deleted. The bucket's real name has a
 *   random suffix only CloudFormation assigns at deploy time (it declares no `BucketName`), but
 *   CloudFormation's own default physical-naming rule for an unnamed resource is
 *   "<StackName>-<LogicalID>-<uniqueID>" (docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/
 *   resources-section-structure.html#resources-section-physical-id), so the name always starts
 *   with the stack's own name — the pattern used here.
 * - The ECR pull-through cache rule: `*`, because neither action supports resource-level scoping
 *   (documented in README.md as the one place this policy can't be scoped down).
 */
function accessDeployerStatements(scope: { env: string; partition: string; region: string; account: string }): PolicyStatementJson[] {
  const { env, partition, region, account } = scope;
  const stackArn = `arn:${partition}:cloudformation:${region}:${account}:stack/${environmentStackName(env, "access")}/*`;
  const roleArns = [
    `arn:${partition}:iam::${account}:role/${environmentCloudFormationRoleName(env)}`,
    `arn:${partition}:iam::${account}:role/${environmentOperatorRoleName(env)}`,
  ];
  const boundaryArn = defaultBoundaryArn({ env, partition, account });
  const bucketArn = `arn:${partition}:s3:::${environmentStackName(env, "access")}-*`;
  return [
    { Sid: "AccessStack", Effect: "Allow", Action: ["cloudformation:*"], Resource: stackArn },
    {
      Sid: "IamRoles",
      Effect: "Allow",
      Action: [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
      ],
      Resource: roleArns,
    },
    {
      Sid: "IamManagedPolicy",
      Effect: "Allow",
      Action: [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: boundaryArn,
    },
    {
      Sid: "ArtifactBucket",
      Effect: "Allow",
      Action: [
        "s3:CreateBucket*",
        "s3:PutBucket*",
        "s3:GetBucket*",
        "s3:DeleteBucket*",
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:GetLifecycleConfiguration",
      ],
      Resource: bucketArn,
    },
    {
      Sid: "PullThroughCache",
      Effect: "Allow",
      Action: ["ecr:CreatePullThroughCacheRule", "ecr:DeletePullThroughCacheRule", "ecr:DescribePullThroughCacheRules"],
      Resource: "*",
    },
  ];
}

/**
 * The bash script the platform team runs: the six-step change-set flow (create, wait, describe the
 * changes, execute, wait, enable termination protection) using the AWS CLI only, with a
 * y/N confirmation before executing (skipped with `--yes`) and recovery guidance on failure.
 *
 * The change set name follows the same pinned format the templates deploy engine uses
 * (templates-engine.ts, `agentx-<version with . replaced by ->-<unix seconds>`), baked in from the
 * release version at export time.
 *
 * The access stack takes no secret parameters (its only parameters are `PermissionsBoundaryArn`
 * and `OperatorPrincipalArn`), so this script never reads or prints one. Every variable is quoted.
 */
function deployAccessScript(scope: { env: string; region: string; version: string }): string {
  const stackName = environmentStackName(scope.env, "access");
  const dashedVersion = scope.version.replaceAll(".", "-");
  const region = scope.region;
  return `#!/usr/bin/env bash
set -euo pipefail

# Deploys the access stack for the "${scope.env}" AgentX environment in ${region}: the one stack a
# platform team deploys directly, with their own AWS credentials (policies/access-deployer.json
# names exactly what that principal needs). Every later stack is deployed by the AgentX operator
# through the CloudFormationServiceRole this stack creates, by running \`agentx init --resume\`
# (see README.md). The access stack takes no secret parameters, so this script never reads or
# prints one.
#
# Pass --yes to execute the change set without the interactive prompt. If a step fails, see
# README.md's "If it fails" section — this script prints the reason and the exact recovery command.

STACK_NAME="${stackName}"
CHANGE_SET_NAME="agentx-${dashedVersion}-$(date +%s)"
YES=false
if [ "\${1:-}" = "--yes" ]; then
  YES=true
fi

on_failure() {
  local exit_code=$?
  echo "" >&2
  echo "deploy-access.sh failed." >&2

  local cs_status
  cs_status="$(aws cloudformation describe-change-set --stack-name "\${STACK_NAME}" --change-set-name "\${CHANGE_SET_NAME}" --region "${region}" --query "Status" --output text 2>/dev/null || echo "")"
  if [ "\${cs_status}" = "FAILED" ]; then
    local cs_reason
    cs_reason="$(aws cloudformation describe-change-set --stack-name "\${STACK_NAME}" --change-set-name "\${CHANGE_SET_NAME}" --region "${region}" --query "StatusReason" --output text 2>/dev/null || echo "unknown")"
    echo "Change set \${CHANGE_SET_NAME} failed: \${cs_reason}" >&2
    echo "Recovery: delete the failed change set, then run this script again:" >&2
    echo "  aws cloudformation delete-change-set --stack-name \\"\${STACK_NAME}\\" --change-set-name \\"\${CHANGE_SET_NAME}\\" --region \\"${region}\\"" >&2
  fi

  local stack_status
  stack_status="$(aws cloudformation describe-stacks --stack-name "\${STACK_NAME}" --region "${region}" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "")"
  if [ "\${stack_status}" = "REVIEW_IN_PROGRESS" ] || [ "\${stack_status}" = "ROLLBACK_COMPLETE" ]; then
    echo "Stack \${STACK_NAME} is \${stack_status}." >&2
    echo "Recovery: delete the stack, then run this script again:" >&2
    echo "  aws cloudformation delete-stack --stack-name \\"\${STACK_NAME}\\" --region \\"${region}\\"" >&2
  elif [ -n "\${stack_status}" ]; then
    echo "Stack \${STACK_NAME} is \${stack_status}. Recent failure reasons:" >&2
    aws cloudformation describe-stack-events --stack-name "\${STACK_NAME}" --region "${region}" \\
      --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[LogicalResourceId,ResourceStatusReason]" \\
      --output text 2>/dev/null | head -n 10 >&2 || true
  fi

  exit "\${exit_code}"
}
trap on_failure ERR

cd "$(dirname "\${BASH_SOURCE[0]}")"

echo "Creating change set \${CHANGE_SET_NAME} for stack \${STACK_NAME} in ${region}..."
aws cloudformation create-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --change-set-type CREATE \\
  --template-body "file://templates/access.template.json" \\
  --parameters "file://parameters/access.json" \\
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \\
  --region "${region}"

echo "Waiting for the change set to finish creating..."
aws cloudformation wait change-set-create-complete \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${region}"

echo "Changes:"
aws cloudformation describe-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${region}" \\
  --query "Changes"

if [ "\${YES}" = false ]; then
  read -r -p "Execute this change set? [y/N] " REPLY
  if [[ ! "\${REPLY}" =~ ^[Yy]$ ]]; then
    echo "Not executing. The change set \${CHANGE_SET_NAME} is ready; rerun with --yes, execute it yourself, or delete it:" >&2
    echo "  aws cloudformation delete-change-set --stack-name \\"\${STACK_NAME}\\" --change-set-name \\"\${CHANGE_SET_NAME}\\" --region \\"${region}\\"" >&2
    exit 0
  fi
fi

echo "Executing the change set..."
aws cloudformation execute-change-set \\
  --stack-name "\${STACK_NAME}" \\
  --change-set-name "\${CHANGE_SET_NAME}" \\
  --region "${region}"

echo "Waiting for the stack to finish creating..."
aws cloudformation wait stack-create-complete \\
  --stack-name "\${STACK_NAME}" \\
  --region "${region}"

echo "Enabling termination protection..."
aws cloudformation update-termination-protection \\
  --enable-termination-protection \\
  --stack-name "\${STACK_NAME}" \\
  --region "${region}"

echo "Done. Stack outputs:"
aws cloudformation describe-stacks --stack-name "\${STACK_NAME}" --region "${region}" --query "Stacks[0].Outputs"
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

**Note:** \`ecr:CreatePullThroughCacheRule\` and \`ecr:DeletePullThroughCacheRule\` support no
resource-level scoping in IAM, so \`policies/access-deployer.json\` grants them on every resource
(\`*\`) — whoever deploys this bundle can also create or delete another environment's pull-through
cache rule. There is no tighter scope available today.

## Deploying

Run \`./deploy-access.sh\` with AWS CLI credentials that can create the resources above (see
\`policies/access-deployer.json\` for exactly what that principal needs). Pass \`--yes\` to skip the
confirmation prompt. It runs, in order:

1. \`aws cloudformation create-change-set\` (\`--change-set-type CREATE\`, the templates and
   parameters in this bundle, \`--capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM\`)
2. \`aws cloudformation wait change-set-create-complete\`
3. \`aws cloudformation describe-change-set --query Changes\` (review the changes)
4. Prompts \`Execute this change set? [y/N]\` (skipped with \`--yes\`)
5. \`aws cloudformation execute-change-set\`
6. \`aws cloudformation wait stack-create-complete\`
7. \`aws cloudformation update-termination-protection --enable-termination-protection\`

The access stack takes no secret parameters; the script never reads or prints one.

## If it fails

If \`deploy-access.sh\` fails partway through, it prints why — the change set's \`StatusReason\`, or
the most recent failed stack events' reasons — and the exact command to recover, then exits
non-zero:

- **A failed change set** (the stack is still \`REVIEW_IN_PROGRESS\`; nothing was actually created):
  delete the change set, then run this script again.
  \`\`\`
  aws cloudformation delete-change-set --stack-name ${stackName} --change-set-name <name> --region ${region}
  \`\`\`
- **A failed stack creation** (the stack rolled back to \`ROLLBACK_COMPLETE\`): delete the whole
  stack, then run this script again from the start.
  \`\`\`
  aws cloudformation delete-stack --stack-name ${stackName} --region ${region}
  \`\`\`

Either way, nothing from a failed attempt is reused; the next run always creates a fresh change set.

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

/** Refuses when `dir` exists and already holds files. A dir that doesn't exist, or exists and is
 * empty, is fine — nothing is written by this check either way. */
async function assertClaimable(dir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (existing.length > 0) throw new Error(`export directory ${dir} is not empty`);
}

/**
 * Writes the export bundle: the access stack's real template and parameters (and every later
 * part's, for review, in install order), the deploy script, and the policy documents. Makes no AWS
 * call. Refuses (writing nothing) a non-empty `dir` or a region the release does not cover.
 *
 * Writes into a fresh directory next to `dir` (same parent, so the final move is a same-filesystem
 * rename) and only renames it onto `dir` once every file is written successfully — so a failure
 * partway through (a corrupt package, a release the region check somehow missed, anything) leaves
 * `dir` exactly as it was before the call, never a half-written bundle a rerun would then have to
 * fight past. The scratch directory is removed on any failure.
 */
export async function writeExportBundle(input: ExportBundleInput): Promise<ExportBundleResult> {
  const { dir, answers, release } = input;
  const { env, region, account } = answers;
  const partition = answers.partition ?? "aws";

  if (!release.regions().includes(region)) {
    throw new Error(`release ${release.manifest.version} does not cover region ${region}`);
  }
  await assertClaimable(dir);

  const resolvedDir = resolve(dir);
  const scratchDir = await mkdtemp(join(dirname(resolvedDir), `.${basename(resolvedDir)}.`));
  try {
    const files: string[] = [];
    async function write(relativePath: string, content: string | Buffer, options: { mode?: number } = {}): Promise<void> {
      const target = join(scratchDir, relativePath);
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
    // CloudFormation assigns at deploy time (see accessDeployerStatements' comment), so its ARN
    // here is the same pattern the access-deployer policy uses.
    const policyScope: PolicyScope = {
      env,
      partition,
      region,
      account,
      artifactBucketArn: `arn:${partition}:s3:::${environmentStackName(env, "access")}-*`,
      pullThroughPrefix: environmentPullThroughPrefix(env),
      cloudFormationRoleName: environmentCloudFormationRoleName(env),
      runtimeName: environmentRuntimeName(env),
      ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    };
    await write("policies/service-role.json", policyDocument(serviceRoleStatements(policyScope)));
    await write("policies/operator-role.json", policyDocument(operatorRoleStatements(policyScope)));
    await write("policies/default-boundary.json", policyDocument(defaultBoundaryStatements(policyScope)));
    await write("policies/access-deployer.json", policyDocument(accessDeployerStatements({ env, partition, region, account })));

    await write("deploy-access.sh", deployAccessScript({ env, region, version: release.manifest.version }), { mode: 0o755 });
    await write("README.md", readme({ env, region, account, order }));

    // Publish atomically: remove `dir` if it exists (assertClaimable already confirmed it's empty,
    // and rmdir refuses a non-empty directory itself as a second, independent guard), then move the
    // fully-written bundle into place with a single rename.
    try {
      await rmdir(resolvedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(scratchDir, resolvedDir);

    return { files: files.sort() };
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}
