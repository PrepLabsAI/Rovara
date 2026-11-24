// The environment release pipeline's resource names (infra/lib/environment-release-pipeline.ts builds them) and the Deny statements the environment's permissions
// boundary carries so that no role a merged template creates can touch them. One source for both: the pipeline stack takes its names from here, and the boundary
// denies are written against the same strings (a test pins the pair). Pure functions, no CDK imports.
import type { PolicyScope, PolicyStatementJson } from "./access-policies.js";

/** What the pipeline of one environment is called. `kind` is `code` today (a Cloud pipeline would be `cloud`). */
export function releasePipelineNames(env: string, kind = "code"): {
  readonly pipeline: string;
  readonly stack: string;
  readonly projectPrefix: string;
  readonly parameterPrefix: string;
  readonly canarySecretName: string;
  /** Matches both buckets and every object in them (and nothing of another environment). */
  readonly bucketPattern: string;
  /** The pipeline's alert topic (the one the team channel's Chatbot attaches to). The shared OperatorAlerts topic (`agentx-<env>-alerts`) is NOT the pipeline's and is never denied. */
  readonly alertsTopic: string;
  /** Matches the alert topic and any other topic the pipeline owns (`rovara-<env>-release-*`). */
  readonly topicPattern: string;
  /** The alias of the pipeline's KMS key (it encrypts the alert topic); the key's ARN is not known when the boundary is synthesized, so the boundary denies by alias. */
  readonly keyAlias: string;
  /** Matches the key alias and any other alias the pipeline owns. */
  readonly keyAliasPattern: string;
  runsBucket(account: string): string;
  artifactBucket(account: string): string;
} {
  return {
    pipeline: `rovara-${env}-${kind}-release`,
    stack: `rovara-${env}-${kind}-release-pipeline`,
    projectPrefix: `rovara-${env}-${kind}-release-`,
    /** SSM prefix of the release pointers (installed, last-good, version counter), the holds and the policy pin. */
    parameterPrefix: `/rovara-release/${env}`,
    canarySecretName: `rovara-release/${env}/canary-credential`,
    bucketPattern: `rovara-${env}-${kind}-rel-*`,
    alertsTopic: `rovara-${env}-release-alerts`,
    topicPattern: `rovara-${env}-release-*`,
    keyAlias: `alias/rovara-${env}-release-alerts`,
    keyAliasPattern: `alias/rovara-${env}-release-*`,
    // Bucket names are global, so the account id keeps them unique; at most 7+20+1+5+10+12 = 55 characters for the longest environment name.
    runsBucket: (account) => `rovara-${env}-${kind}-rel-runs-${account}`,
    artifactBucket: (account) => `rovara-${env}-${kind}-rel-art-${account}`,
  };
}

/**
 * Deny statements for the environment's permissions boundary (the shared OperatorAlerts topic `agentx-<env>-alerts` is deliberately NOT in them: other alarms publish to it): every role
 * that carries it (the CloudFormation service role, the operator role and each role a merged template creates under /agentx/<env>/) is refused the pipeline's pointers, secret, buckets,
 * build projects, approval, alert topics, KMS key, and (write actions) the environment's access stack. The pipeline's own roles carry the pipeline stack's boundary instead (a role has
 * exactly one), so these never apply to them. Every resource is this environment's (the env is in each name), over any region and any kind (`code`, `cloud`). The account is a wildcard,
 * not this account: the roles cannot reach another account's resources anyway, and the 6,144-character managed policy limit pays for every character, so the five resources that share
 * the name shape `rovara-<env>-<kind>-rel...` (both buckets, the projects, the pipeline, the alert topic, the key alias) are one pattern each in their own service's ARN (IAM needs a literal service).
 */
export function releasePipelineDenyStatements(scope: Pick<PolicyScope, "env" | "partition">): PolicyStatementJson[] {
  const { env, partition } = scope;
  const names = releasePipelineNames(env, "*");
  const arn = (service: string, resource: string): string => `arn:${partition}:${service}:*:*:${resource}`;
  // One statement: an action that does not apply to a resource in the list (ssm on a bucket) is simply never matched. Reads are denied too, since nothing outside the
  // pipeline has a reason to read these. `*` crosses `/` and `:` in an ARN, so one pattern names a bucket and every object in it, a pipeline and every action of it.
  return [
    {
      // ssm: the policy pin, the installed and last-good pointers, the version counter and the holds (`<env>*` also covers the bare path GetParametersByPath names; it over-denies an
      // environment whose name starts with this one, harmlessly). secretsmanager: the canary credential. s3: the run records, the canary ledger, the CI cache and the pipeline's artifacts
      // (a bucket policy, lifecycle or versioning change included). codebuild: Decide, AutoApprove and the other projects. codepipeline: PutApprovalResult above all (it names the action,
      // <pipeline>/<stage>/<action>), and every other way to steer the pipeline. sns, kms: the alert topic and the key's alias. cloudformation (writes only): the access stack, whose stored
      // role may be the admin CDK role; the pipeline's own stack and every other stack outside the environment's deployed parts is covered by the boundary's DenyCfnOutsideEnvStacks.
      Sid: "DenyReleasePipeline",
      Effect: "Deny",
      Action: ["ssm:*", "secretsmanager:*", "s3:*", "codebuild:*", "codepipeline:*", "sns:*", "kms:*", "cloudformation:Create*", "cloudformation:Update*", "cloudformation:Delete*", "cloudformation:Execute*"],
      Resource: [
        arn("ssm", `parameter${names.parameterPrefix}*`),
        arn("secretsmanager", `secret:rovara-release/${env}/*`),
        // VENDOR FIX: IAM refuses a Resource whose SERVICE (third ARN component) is not a literal name ("Resource vendor must be fully qualified and cannot contain regexes"), so the single
        // `arn:<partition>:*rovara-<env>-*rel*` this was cannot be created. One ARN per service of the five resources that share the name shape, each as wide as that service's ARN can be.
        // (The old pattern also matched ssm, secretsmanager and cloudformation ARNs of this name shape; the pipeline's own parameters, secret and stacks are named by the entries above and below, and its
        // own stack by DenyCfnOutsideEnvStacks, so those three services are not repeated: the room is the managed-policy limit's.)
        `arn:${partition}:s3:::rovara-${env}-*rel*`,
        arn("codebuild", `project/rovara-${env}-*rel*`),
        arn("codepipeline", `rovara-${env}-*rel*`),
        arn("sns", `rovara-${env}-*rel*`),
        arn("kms", `alias/rovara-${env}-*rel*`),
        arn("cloudformation", `stack/agentx-${env}-access/*`),
      ],
    },
    // The pipeline's KMS key (it encrypts the alert topic): a role with kms:* must not disable it, schedule its deletion or rewrite its key policy. The key's ARN is generated, so
    // the key is named by its alias (kms:ResourceAliases is set on every call that names the key); the alias itself matches the pattern above.
    {
      Sid: "DenyReleaseKey",
      Effect: "Deny",
      Action: ["kms:*"],
      Resource: "*",
      Condition: { "ForAnyValue:StringLike": { "kms:ResourceAliases": names.keyAliasPattern } },
    },
  ];
}
