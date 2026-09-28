// The export bundle: everything a platform team needs to deploy the access stack themselves, with
// their own AWS credentials and no AWS call ever made by our CLI. It writes a self-contained
// directory: the access stack's template and parameters, a deploy script that uses the AWS CLI
// only, the policy the platform team attaches to run that script, and the inline policies every
// later stack's roles carry (with this environment's real account, region and partition, so they
// can be reviewed as plain JSON). Every part's template and parameters are included, in install
// order, so the bundle also documents the full deploy — even though only the access stack's is
// meant to be run directly here; every later stack is deployed by the AgentX operator through the
// service role the access stack creates (`agentx init --resume --from-bundle <this directory>`,
// which reads the answers the export knew from `init-answers.json`).
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  agentXError,
  defaultBoundaryArn,
  defaultBoundaryStatements,
  environmentCloudFormationRoleName,
  environmentOperatorRoleName,
  environmentPullThroughPrefix,
  environmentStackName,
  EnvironmentNameSchema,
  operatorRoleStatements,
  serviceRoleStatements,
  type PolicyScope,
  type PolicyStatementJson,
} from "@agentx/contracts";
import type { InitAnswers } from "../init/install-state.js";
import { ACCOUNT_PATTERN, IdentityAnswersSchema, ModelsAnswersSchema, REGION_PATTERN } from "./answer-schemas.js";
import type { DeployAnswers } from "./deploy-environment.js";
import { sha256Hex } from "./hash.js";
import { installOrder, stackParameters, type DeployPart, type InstallAnswers, type StackOutputs } from "./parameters.js";
import { assertReleaseCoversRegion, type LoadedRelease } from "./release.js";
import { callbackSigningKeySecretName } from "./signing-key.js";
import { PROTECTED_PARTS } from "./deployer.js";

export interface ExportBundleInput {
  /** Must be empty or absent. */
  dir: string;
  answers: DeployAnswers & { clientId?: string };
  release: LoadedRelease;
}

/** The answers an export knows, written to `init-answers.json` so the AgentX operator's
 * `agentx init --resume --from-bundle` asks only the rest (alerts, budget, GitHub, Slack). Answers
 * only, never a secret: the same fields `InitAnswers` holds, which never holds one either. */
export type BundleAnswers = Pick<InitAnswers, "schemaVersion" | "env" | "region" | "account" | "engine" | "releaseVersion" | "identity" | "models" | "permissionsBoundaryArn" | "operatorPrincipalArn">;

/** A bundle is always the templates engine: the platform team deploys published templates. The
 * boundary and principal patterns are `InitAnswersSchema`'s, so a bundle answer the resume accepts
 * is never refused later when the answers are saved. */
export const BundleAnswersSchema: z.ZodType<BundleAnswers> = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  region: z.string().regex(REGION_PATTERN),
  account: z.string().regex(ACCOUNT_PATTERN),
  engine: z.literal("templates"),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  identity: IdentityAnswersSchema,
  models: ModelsAnswersSchema,
  permissionsBoundaryArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/).optional(),
  operatorPrincipalArn: z.string().regex(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/).optional(),
}).strict();

export const BUNDLE_ANSWERS_FILE = "init-answers.json";

function invalidBundleAnswers(where: string, issues: z.core.$ZodIssue[]): Error {
  return agentXError("CONFIG_INVALID", `${where} is invalid: ${issues[0]?.path.join(".") ?? ""} ${issues[0]?.message ?? ""}`.trim());
}

/** F5: derived here from the export's own inputs (no new input field), so every caller gets the
 * file and it can never hold `undefined`. Parsed before it is written, so an export never writes a
 * bundle its own resume would refuse. */
function bundleAnswersFor(answers: DeployAnswers, release: LoadedRelease): BundleAnswers {
  const parsed = BundleAnswersSchema.safeParse({
    schemaVersion: 1,
    env: answers.env,
    region: answers.region,
    account: answers.account,
    engine: "templates",
    releaseVersion: release.manifest.version,
    identity: answers.identity,
    models: answers.models,
    ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    ...(answers.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: answers.operatorPrincipalArn }),
  });
  if (!parsed.success) throw invalidBundleAnswers(`the export's ${BUNDLE_ANSWERS_FILE}`, parsed.error.issues);
  return parsed.data;
}

/** Reads and checks a bundle's `init-answers.json`. */
export async function readBundleAnswers(dir: string): Promise<BundleAnswers> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(dir, BUNDLE_ANSWERS_FILE), "utf8"));
  } catch {
    throw agentXError("CONFIG_INVALID", `${dir} has no readable ${BUNDLE_ANSWERS_FILE}; pass the bundle agentx init --export wrote`);
  }
  const parsed = BundleAnswersSchema.safeParse(json);
  if (!parsed.success) throw invalidBundleAnswers(`${dir}/${BUNDLE_ANSWERS_FILE}`, parsed.error.issues);
  return parsed.data;
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
      appId: githubMarker("appId"),
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
 * The policy a platform team attaches to whoever runs `deploy-access.sh`: exactly the actions the
 * CloudFormation registry's own published `create`/`read`/`delete` handler permissions for the
 * access stack's five resource types require (`AWS::S3::Bucket`, `AWS::S3::BucketPolicy`,
 * `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy`, `AWS::ECR::PullThroughCacheRule` — the only types the
 * real synthesized access template contains), fetched from
 * https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip and checked into
 * `tests/fixtures/cfn-handler-permissions.json`, which `export-bundle.test.ts`'s coverage test reads
 * so these action lists can never silently drift from that authoritative source again.
 *
 * `update` handler permissions are deliberately excluded (this principal only ever runs a `CREATE`
 * change set; see `deployAccessScript`), which is why `iam:UpdateRole`, `iam:UpdateRoleDescription`,
 * `iam:PutRolePermissionsBoundary`, `iam:UpdateAssumeRolePolicy`, `iam:DeleteRolePermissionsBoundary`
 * and `iam:CreatePolicyVersion`/`iam:SetDefaultPolicyVersion` are all absent — `CreateRole` accepts
 * both `Description` and `PermissionsBoundary` directly, so none of those are needed just to create
 * the roles either. Documented in README.md: updating this stack needs more, and is the AgentX
 * operator's or a broader admin's job, not this principal's.
 *
 * `iam:PassRole` is never granted anywhere in this policy, even though it appears in the S3 bucket
 * and ECR pull-through-cache-rule handlers' own permission lists (for bucket replication and for a
 * pull-through rule's `CredentialArn`/`CustomRoleArn`, respectively) — this template configures
 * neither feature, so it's excluded, with the one IAM action the pull-through-cache-rule handler
 * genuinely needs (`iam:CreateServiceLinkedRole`) granted in its own statement, scoped to a
 * service-linked-role ARN and conditioned on `iam:AWSServiceName` = `ecr.amazonaws.com`.
 * `secretsmanager:GetSecretValue` (also `CredentialArn`-only) is excluded the same way.
 *
 * IAM role and managed-policy actions are scoped to the *exact* resource ARNs (the two roles' names
 * and the default boundary's ARN, all deterministic from the environment name), never a path or
 * name wildcard.
 *
 * The artifact bucket's real name has a random suffix only CloudFormation assigns at deploy time
 * (it declares no `BucketName`), but CloudFormation's own default physical-naming rule for an
 * unnamed resource is "<StackName>-<LogicalID>-<uniqueID>" (docs.aws.amazon.com/AWSCloudFormation/
 * latest/UserGuide/resources-section-structure.html#resources-section-physical-id), so the name
 * always starts with the stack's own name — the pattern used here. The S3 handlers' full
 * permission set includes some actions this bucket's own configuration never exercises (the
 * `s3tables:*` table-bucket actions, in particular — a different feature and a different ARN
 * format entirely) because the registry schema publishes the handler's whole permission set, not
 * one filtered to a particular template's properties; granting them is inert here, not harmful.
 *
 * The ECR pull-through-cache-rule actions (aside from the service-linked-role one above) stay
 * unscoped (`*`): neither action supports resource-level scoping (documented in README.md as the
 * one place this policy can't be scoped down).
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
  const serviceLinkedRoleArn = `arn:${partition}:iam::${account}:role/aws-service-role/*`;
  return [
    { Sid: "AccessStack", Effect: "Allow", Action: ["cloudformation:*"], Resource: stackArn },
    {
      // AWS::IAM::Role's create+read+delete handler permissions, verbatim (see the function doc
      // comment) — never iam:PassRole, iam:UpdateAssumeRolePolicy, iam:DeleteRolePermissionsBoundary
      // or a wildcard: those are update-only, or belong to the roles this principal creates, not to
      // this principal itself.
      Sid: "IamRoles",
      Effect: "Allow",
      Action: [
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      Resource: roleArns,
    },
    {
      // AWS::IAM::ManagedPolicy's create+read+delete handler permissions, verbatim.
      Sid: "IamManagedPolicy",
      Effect: "Allow",
      Action: [
        "iam:AttachGroupPolicy",
        "iam:AttachRolePolicy",
        "iam:AttachUserPolicy",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:DetachGroupPolicy",
        "iam:DetachRolePolicy",
        "iam:DetachUserPolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListEntitiesForPolicy",
        "iam:ListPolicyVersions",
      ],
      Resource: boundaryArn,
    },
    {
      // The one IAM action the ECR pull-through-cache-rule handler needs outside CredentialArn's
      // own PassRole: creating the AWSServiceRoleForECR service-linked role, the first time any
      // pull-through cache rule is created in the account. Scoped to service-linked roles only, and
      // only for ECR — never a bare grant of iam:CreateServiceLinkedRole.
      Sid: "EcrServiceLinkedRole",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: serviceLinkedRoleArn,
      Condition: { StringEquals: { "iam:AWSServiceName": "ecr.amazonaws.com" } },
    },
    {
      // AWS::S3::Bucket's (and, redundantly, AWS::S3::BucketPolicy's) create+read+delete handler
      // permissions, verbatim, minus iam:PassRole (see the function doc comment).
      Sid: "ArtifactBucket",
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:CreateBucketMetadataTableConfiguration",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        "s3:DeleteObject",
        "s3:GetAccelerateConfiguration",
        "s3:GetAnalyticsConfiguration",
        "s3:GetBucketAbac",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetBucketLogging",
        "s3:GetBucketMetadataTableConfiguration",
        "s3:GetBucketNotification",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetBucketWebsite",
        "s3:GetEncryptionConfiguration",
        "s3:GetIntelligentTieringConfiguration",
        "s3:GetInventoryConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetMetricsConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:ListBucket",
        "s3:ListTagsForResource",
        "s3:PutAccelerateConfiguration",
        "s3:PutAnalyticsConfiguration",
        "s3:PutBucketAbac",
        "s3:PutBucketCORS",
        "s3:PutBucketLogging",
        "s3:PutBucketNotification",
        "s3:PutBucketObjectLockConfiguration",
        "s3:PutBucketOwnershipControls",
        "s3:PutBucketPolicy",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketReplication",
        "s3:PutBucketTagging",
        "s3:PutBucketVersioning",
        "s3:PutBucketWebsite",
        "s3:PutEncryptionConfiguration",
        "s3:PutIntelligentTieringConfiguration",
        "s3:PutInventoryConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:PutMetricsConfiguration",
        "s3:PutObjectAcl",
        "s3:PutObjectLockConfiguration",
        "s3:PutReplicationConfiguration",
        "s3:TagResource",
        "s3tables:CreateNamespace",
        "s3tables:CreateTable",
        "s3tables:CreateTableBucket",
        "s3tables:GetTable",
        "s3tables:GetTableMetadataLocation",
        "s3tables:PutTableBucketPolicy",
        "s3tables:PutTableEncryption",
        "s3tables:PutTablePolicy",
        "s3tables:UpdateTableMetadataLocation",
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
 * Never executes unattended: with no `--yes`, a declined prompt or no terminal to prompt on at all
 * (stdin isn't a TTY — e.g. run from cron or a pipe) both print the change set's id, the exact
 * `delete-change-set`/`delete-stack` cleanup commands, and exit 1, distinct from the generic
 * `on_failure` message (nothing here actually failed).
 *
 * The access stack takes no secret parameters (its only parameters are `PermissionsBoundaryArn`
 * and `OperatorPrincipalArn`), so this script never reads or prints one. Every variable is quoted.
 */
/** The command the AgentX operator runs once the access stack exists: it deploys every later part,
 * never access itself (the operator role is denied change sets on the access stack). */
function operatorResumeCommand(env: string, region: string): string {
  return `agentx init --resume --env ${env} --region ${region} --from-bundle <this directory>`;
}

/** One wording for a failed or refused change set on a new stack, shared by the script and README. */
const NEW_STACK_RECOVERY = "delete the change set, then delete the stack only if it is still REVIEW_IN_PROGRESS with no resources";

function deployAccessScript(scope: { env: string; region: string; version: string }): string {
  const stackName = environmentStackName(scope.env, "access");
  const dashedVersion = scope.version.replaceAll(".", "-");
  const region = scope.region;
  return `#!/usr/bin/env bash
set -euo pipefail

# Deploys the access stack for the "${scope.env}" AgentX environment in ${region}: the one stack a
# platform team deploys directly, with their own AWS credentials (policies/access-deployer.json
# names exactly what that principal needs). Every later stack is deployed by the AgentX operator
# through the CloudFormationServiceRole this stack creates, by running (see README.md):
#   ${operatorResumeCommand(scope.env, region)}
# The access stack takes no secret parameters, so this script never reads or prints one. It does
# not create the callback signing key either: agentx deploy creates it on its first run.
#
# Pass --yes to execute the change set without the interactive prompt. If a step fails, see
# README.md's "If it fails" section; this script prints the reason and the exact recovery command.

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
  fi

  local stack_status
  stack_status="$(aws cloudformation describe-stacks --stack-name "\${STACK_NAME}" --region "${region}" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "")"
  if [ "\${stack_status}" = "REVIEW_IN_PROGRESS" ]; then
    echo "Stack \${STACK_NAME} is REVIEW_IN_PROGRESS: nothing was created." >&2
    echo "Recovery: ${NEW_STACK_RECOVERY}, then run this script again:" >&2
    echo "  aws cloudformation delete-change-set --stack-name \\"\${STACK_NAME}\\" --change-set-name \\"\${CHANGE_SET_NAME}\\" --region \\"${region}\\"" >&2
    echo "  aws cloudformation describe-stacks --stack-name \\"\${STACK_NAME}\\" --region \\"${region}\\" --query \\"Stacks[0].StackStatus\\"" >&2
    echo "  aws cloudformation delete-stack --stack-name \\"\${STACK_NAME}\\" --region \\"${region}\\"" >&2
  elif [ "\${stack_status}" = "ROLLBACK_COMPLETE" ]; then
    echo "Stack \${STACK_NAME} is ROLLBACK_COMPLETE: its create failed." >&2
    echo "Recovery: delete the stack, then run this script again (the failed create already removed what it made; see README.md):" >&2
    echo "  aws cloudformation delete-stack --stack-name \\"\${STACK_NAME}\\" --region \\"${region}\\"" >&2
  elif [ "\${cs_status}" = "FAILED" ]; then
    echo "Recovery: delete the failed change set, then run this script again:" >&2
    echo "  aws cloudformation delete-change-set --stack-name \\"\${STACK_NAME}\\" --change-set-name \\"\${CHANGE_SET_NAME}\\" --region \\"${region}\\"" >&2
  fi
  if [ -n "\${stack_status}" ] && [ "\${stack_status}" != "REVIEW_IN_PROGRESS" ] && [ "\${stack_status}" != "ROLLBACK_COMPLETE" ]; then
    echo "Stack \${STACK_NAME} is \${stack_status}. Recent failure reasons:" >&2
    aws cloudformation describe-stack-events --stack-name "\${STACK_NAME}" --region "${region}" \\
      --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[LogicalResourceId,ResourceStatusReason]" \\
      --output text 2>/dev/null | head -n 10 >&2 || true
  fi

  exit "\${exit_code}"
}
trap on_failure ERR

# Prints why nothing was executed and how to clean up, then exits 1: deliberately not through
# on_failure/exit_code above, since nothing here failed; the operator (or the absence of one) chose
# not to proceed.
not_executed() {
  echo "not executed; the change set \${CHANGE_SET_NAME} is left for review" >&2
  echo "To clean up: ${NEW_STACK_RECOVERY}:" >&2
  echo "  aws cloudformation delete-change-set --stack-name \\"\${STACK_NAME}\\" --change-set-name \\"\${CHANGE_SET_NAME}\\" --region \\"${region}\\"" >&2
  echo "  aws cloudformation delete-stack --stack-name \\"\${STACK_NAME}\\" --region \\"${region}\\"" >&2
  exit 1
}

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
  if [ ! -t 0 ]; then
    # No terminal to prompt on, and --yes wasn't given: never execute a change set unattended.
    not_executed
  fi
  read -r -p "Execute this change set? [y/N] " REPLY
  if [[ ! "\${REPLY}" =~ ^[Yy]$ ]]; then
    not_executed
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
  const deleteOrder = [...order].reverse().map((part) => environmentStackName(env, part));
  const protectedStacks = order.filter((part) => PROTECTED_PARTS.has(part)).map((part) => environmentStackName(env, part));
  // EC2 worker instances and volumes are launched by Step Functions, outside CloudFormation (#79-#97),
  // so they survive every stack delete above and must be torn down by hand. They must go after the
  // control-plane stack (whose Step Functions launch them) and before the foundation stack (whose
  // worker security group a still-running instance would block from deleting).
  const controlPlaneDeleteIndex = deleteOrder.indexOf(environmentStackName(env, "control-plane"));
  const deleteOrderThroughControlPlane = deleteOrder.slice(0, controlPlaneDeleteIndex + 1);
  const deleteOrderAfterControlPlane = deleteOrder.slice(controlPlaneDeleteIndex + 1);
  return `# AgentX access stack: platform-team deploy bundle

This bundle deploys the **access stack** (\`${stackName}\`) for the \`${env}\` AgentX environment in
\`${region}\` (AWS account \`${account}\`). The access stack is the only stack a platform team ever
deploys directly, with their own AWS credentials: it creates the artifact bucket, the ECR
pull-through cache rule, and the two IAM roles every later stack needs.

## What it creates

- \`agentx-${env}-cloudformation\`: the role CloudFormation assumes to deploy every later AgentX
  stack for this environment.
- \`agentx-${env}-operator\`: the role an AgentX operator assumes to run \`agentx\` against this
  environment.
- \`agentx-${env}-boundary\` (only when no permissions boundary ARN is given): the default
  permission boundary applied to both roles above and every role the later stacks create.
- An S3 bucket for release artifacts (templates and code packages) and an ECR pull-through cache
  rule prefixed \`agentx-${env}\`.

**Note:** \`ecr:CreatePullThroughCacheRule\` and \`ecr:DeletePullThroughCacheRule\` support no
resource-level scoping in IAM, so \`policies/access-deployer.json\` grants them on every resource
(\`*\`). Whoever deploys this bundle can also create or delete another environment's pull-through
cache rule. There is no tighter scope available today.

**\`policies/access-deployer.json\` is for *creating* this stack only.** It grants exactly the
CloudFormation registry's published \`create\`/\`read\`/\`delete\` handler permissions for this
stack's resource types, never the \`update\` ones. Updating this stack later (for example, a
changed permissions boundary, which needs \`iam:UpdateAssumeRolePolicy\` and
\`iam:DeleteRolePermissionsBoundary\` on the roles it created) needs a broader principal than this
one: a separate, broader admin action outside this bundle, not something \`deploy-access.sh\` does.

## Deploying

Run \`./deploy-access.sh\` with AWS CLI credentials that can create the resources above (see
\`policies/access-deployer.json\` for exactly what that principal needs). Pass \`--yes\` to skip the
confirmation prompt; without it, on a non-interactive shell (no terminal on stdin) the script never
executes unattended. It runs, in order:

1. \`aws cloudformation create-change-set\` (\`--change-set-type CREATE\`, the templates and
   parameters in this bundle, \`--capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM\`)
2. \`aws cloudformation wait change-set-create-complete\`
3. \`aws cloudformation describe-change-set --query Changes\` (review the changes)
4. Prompts \`Execute this change set? [y/N]\` (skipped with \`--yes\`; declining, or having no
   terminal to prompt on, prints the change set's id and the cleanup commands and exits 1, leaving
   the change set for review rather than executing it)
5. \`aws cloudformation execute-change-set\`
6. \`aws cloudformation wait stack-create-complete\`
7. \`aws cloudformation update-termination-protection --enable-termination-protection\`

The access stack takes no secret parameters; the script never reads or prints one.
\`deploy-access.sh\` does not create the callback signing key (\`agentx/${env}/callback-signing-key\`)
either. That is deliberate: \`agentx deploy\` creates it on its first run, in Secrets Manager only.

## If it fails

If \`deploy-access.sh\` fails partway through, it prints why (the change set's \`StatusReason\`, or
the most recent failed stack events' reasons) and the exact command to recover, then exits
non-zero:

- **A failed or refused change set** (the stack is still \`REVIEW_IN_PROGRESS\`; nothing was
  created): ${NEW_STACK_RECOVERY}. Then run this script again.
  \`\`\`
  aws cloudformation delete-change-set --stack-name ${stackName} --change-set-name <name> --region ${region}
  aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} --query "Stacks[0].StackStatus"
  aws cloudformation delete-stack --stack-name ${stackName} --region ${region}
  \`\`\`
- **A failed stack creation** (the stack rolled back to \`ROLLBACK_COMPLETE\`): delete the whole
  stack, then run this script again from the start. A failed first create removes what it made,
  the artifact bucket too (it is kept only on a delete or a replacing update), so nothing else needs
  removing.
  \`\`\`
  aws cloudformation delete-stack --stack-name ${stackName} --region ${region}
  \`\`\`

Either way, nothing from a failed attempt is reused; the next run always creates a fresh change set.

## After this stack exists

The AgentX operator then runs, with the operator role, from a machine with a browser:

\`\`\`
${operatorResumeCommand(env, region)}
\`\`\`

It deploys every other stack (${laterParts.join(", ")}) through the \`agentx-${env}-cloudformation\`
role, creates the GitHub and Slack apps, the admin user, the first project and channel, and the
alerts, and ends when AgentX answers in Slack.

It reads the answers this export already knew from \`init-answers.json\` (no secret is in it) and
asks only the rest. It never deploys the access stack: the operator role is denied change sets on
it. The platform team's own credentials are never needed again. Use AWS credentials whose session
lasts at least as long as the deploy (plan for about an hour).

## Tearing down an environment

\`agentx destroy\` is planned for phase 15e. Until then, tear an environment down by hand, with
credentials that can delete every resource below.

1. **Record what the stacks retain.** Stack deletion keeps some resources on purpose. Before you
   delete anything, list them, for example:
   \`\`\`
   aws cloudformation list-stack-resources --stack-name <stack> --region ${region} \\
     --query "StackResourceSummaries[].[ResourceType,PhysicalResourceId]" --output text
   \`\`\`
2. **Turn termination protection off** on ${protectedStacks.join(", ")}:
   \`\`\`
   aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name <stack> --region ${region}
   \`\`\`
3. **Delete the stacks down through control-plane, in reverse install order**, waiting for each
   one: ${deleteOrderThroughControlPlane.join(", ")}.
   \`\`\`
   aws cloudformation delete-stack --stack-name <stack> --region ${region}
   aws cloudformation wait stack-delete-complete --stack-name <stack> --region ${region}
   \`\`\`
4. **Terminate the EC2 workers**, before the foundation stack below deletes. EC2 worker instances and
   volumes are launched by Step Functions, outside CloudFormation (the control plane's own state
   machines), so no stack delete removes them, and a worker instance still running in the worker security
   group blocks the foundation stack's delete.
   \`\`\`
   aws ec2 describe-instances --region ${region} \\
     --filters Name=tag:Environment,Values=${env} Name=tag:DeploymentMode,Values=ec2-ebs \\
     --query "Reservations[].Instances[].InstanceId" --output text
   aws ec2 terminate-instances --instance-ids <ids> --region ${region}
   aws ec2 wait instance-terminated --instance-ids <ids> --region ${region}
   aws ec2 describe-volumes --region ${region} \\
     --filters Name=tag:Environment,Values=${env} Name=tag:DeploymentMode,Values=ec2-ebs \\
     --query "Volumes[].VolumeId" --output text
   aws ec2 delete-volume --volume-id <id> --region ${region}
   \`\`\`
   (\`describe-instances\` and \`describe-volumes\` can each list more than one id: terminate and wait
   on every instance id together, then repeat \`delete-volume\` for each volume id.)
5. **Delete the remaining stacks in reverse install order**, waiting for each one:
   ${deleteOrderAfterControlPlane.join(", ")}.
   \`\`\`
   aws cloudformation delete-stack --stack-name <stack> --region ${region}
   aws cloudformation wait stack-delete-complete --stack-name <stack> --region ${region}
   \`\`\`
6. **Remove what survives stack deletion:**
   - **The Cognito user pool** (identity), which has deletion protection:
     \`\`\`
     aws cognito-idp update-user-pool --user-pool-id <id> --deletion-protection INACTIVE --region ${region}
     aws cognito-idp delete-user-pool --user-pool-id <id> --region ${region}
     \`\`\`
     \`update-user-pool\` resets settings you leave out; since the pool is being deleted, that is fine.
   - **Three S3 buckets**: the access stack's artifact bucket and the control plane's
     \`SlackThreadSessions\` bucket are versioned, so empty every object version and delete
     marker first; the control plane's \`Artifacts\` bucket is not versioned.
     \`\`\`
     aws s3api delete-objects --region ${region} --bucket <bucket> --delete "$(aws s3api list-object-versions --region ${region} --bucket <bucket> \\
       --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: \`true\`}' --output json)"
     aws s3 rb s3://<bucket> --force --region ${region}
     \`\`\`
     (\`delete-objects\` takes at most 1,000 keys per call: repeat until the listing is empty.)
   - **Three DynamoDB tables** (the control plane's \`State\`, \`SlackThreads\` and \`TurnRecords\`):
     \`\`\`
     aws dynamodb delete-table --table-name <table> --region ${region}
     \`\`\`
   - **The foundation's VPC flow-log group**:
     \`\`\`
     aws logs delete-log-group --log-group-name <name> --region ${region}
     \`\`\`
   - **The KMS workspace key** (\`alias/agentx/${env}/workspaces\`): schedule its deletion (7 days is
     the minimum) and delete the alias.
     \`\`\`
     aws kms schedule-key-deletion --key-id <key id> --pending-window-in-days 7 --region ${region}
     aws kms delete-alias --alias-name alias/agentx/${env}/workspaces --region ${region}
     \`\`\`
   - **Two secrets**: \`agentx/${env}/callback-signing-key\` (created by \`agentx deploy\`, outside any
     stack) and \`agentx/${env}/slack\`. Delete them without a recovery window, so the names can be
     reused by a new install:
     \`\`\`
     aws secretsmanager delete-secret --secret-id agentx/${env}/callback-signing-key --force-delete-without-recovery --region ${region}
     aws secretsmanager delete-secret --secret-id agentx/${env}/slack --force-delete-without-recovery --region ${region}
     \`\`\`

A failed first create removes what it made (the kept resources use RetainExceptOnCreate), so
"delete the stack and rerun" works. The one exception is the identity stack's Cognito user pool,
whose deletion protection keeps it; its name is not unique, so it never blocks a rerun.

## Files in this bundle

- \`templates/<part>.template.json\`: every stack's CloudFormation template (${order.join(", ")}),
  already rendered for \`${env}\`.
- \`parameters/<part>.json\`: that stack's parameters, as CloudFormation's
  \`[{ "ParameterKey", "ParameterValue" }]\` array. A value only known once install begins (an
  earlier stack's output, the control-plane's callback signing key, or the GitHub App) is written
  as a \`{{output:<part>.<Name>}}\`, \`{{secret:...}}\` or \`{{github:<field>}}\` marker instead of a
  real value.
- \`packages/\`: the release's code packages, plus \`packages/SHA256SUMS\` to check them
  (\`sha256sum -c SHA256SUMS\` from inside that directory).
- \`policies/service-role.json\`, \`policies/operator-role.json\`, \`policies/default-boundary.json\`:
  the inline policies the later stacks' roles carry, with this environment's real account,
  region and partition.
- \`policies/access-deployer.json\`: the policy for whoever runs \`deploy-access.sh\`.
- \`init-answers.json\`: the answers this export knew, for the operator's
  \`agentx init --resume --from-bundle\`. It holds no secret.
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
 * Writes into a fresh directory next to `dir` (same parent, created first if missing, so the final
 * move is a same-filesystem rename) and only renames it onto `dir` once every file is written
 * successfully — so a failure partway through (a corrupt package, a release the region check
 * somehow missed, anything) leaves `dir` exactly as it was before the call, never a half-written
 * bundle a rerun would then have to fight past. The scratch directory is removed on any failure;
 * on success, the final bundle directory is left `0755` (mkdtemp's own default, `0700`, would
 * otherwise be unreadable to anyone but the caller).
 */
export async function writeExportBundle(input: ExportBundleInput): Promise<ExportBundleResult> {
  const { dir, answers, release } = input;
  const { env, region, account } = answers;
  const partition = answers.partition ?? "aws";

  assertReleaseCoversRegion(release, region);
  await assertClaimable(dir);
  const initAnswers = bundleAnswersFor(answers, release);

  const resolvedDir = resolve(dir);
  const parentDir = dirname(resolvedDir);
  // mkdtemp needs its parent to already exist; `dir` itself may be several levels deep in a path
  // nothing has created yet (assertClaimable's ENOENT above only confirms `dir` itself is absent,
  // not that its parent chain is).
  await mkdir(parentDir, { recursive: true });
  const scratchDir = await mkdtemp(join(parentDir, `.${basename(resolvedDir)}.`));
  try {
    const files: string[] = [];
    async function write(relativePath: string, content: string | Buffer, options: { mode?: number } = {}): Promise<void> {
      const target = join(scratchDir, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, options.mode === undefined ? undefined : { mode: options.mode });
      files.push(relativePath);
    }

    const order = installOrder(answers.identity.mode);
    // F24: `parameterAnswers` never carries `developerSignIn` (`markerAnswers` does not set it), so
    // `stackParameters`'s control-plane case adds none of the sign-in parameters here. That is
    // correct, not an oversight: an export bundle is always a fresh install of a brand-new access
    // stack (see this function's own doc comment — "everything a platform team needs to deploy the
    // access stack themselves"), never a redeploy of an existing, already-configured environment, so
    // there is no stored sign-in choice for it to carry and nothing it could ever reset.
    const parameterAnswers = markerAnswers(answers, release);
    const outputs = markerOutputs();

    for (const part of order) {
      await write(`templates/${part}.template.json`, release.template(part, region, env));
      const parameters = stackParameters(part, parameterAnswers, outputs);
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
      ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    };
    await write("policies/service-role.json", policyDocument(serviceRoleStatements(policyScope)));
    await write("policies/operator-role.json", policyDocument(operatorRoleStatements(policyScope)));
    await write("policies/default-boundary.json", policyDocument(defaultBoundaryStatements(policyScope)));
    await write("policies/access-deployer.json", policyDocument(accessDeployerStatements({ env, partition, region, account })));

    await write("deploy-access.sh", deployAccessScript({ env, region, version: release.manifest.version }), { mode: 0o755 });
    await write("README.md", readme({ env, region, account, order }));
    await write(BUNDLE_ANSWERS_FILE, `${JSON.stringify(initAnswers, null, 2)}\n`);

    // Publish atomically: remove `dir` if it exists (assertClaimable already confirmed it's empty,
    // and rmdir refuses a non-empty directory itself as a second, independent guard), then move the
    // fully-written bundle into place with a single rename.
    try {
      await rmdir(resolvedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(scratchDir, resolvedDir);
    // mkdtemp creates its directory 0700 (owner-only); the platform team's own tooling should be
    // able to read and traverse the bundle it just asked for.
    await chmod(resolvedDir, 0o755);

    return { files: files.sort() };
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}
