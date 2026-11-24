import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { defaultBoundaryStatements, deployBoundaryStatements, releasePipelineDenyStatements, releasePipelineNames, serviceRoleStatements } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { EnvironmentReleasePipelineStack, RELEASE_PROJECT_KEYS, environmentReleaseNames } from "../../infra/lib/environment-release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// ACCESS-DENIES (binding before staging auto-approve is switched on): the environment's permissions boundary, created by the access stack, denies every role that carries it
// (the CloudFormation service role, the operator role and each role a merged template creates under /agentx/<env>/) the release pipeline's pointers, secret, buckets, build
// projects, approval and stack. These are template assertions plus a small policy evaluator run over the synthesized documents; the pipeline template is the oracle for
// what "the pipeline's resources" are, so a rename in either stack that is not made in both fails here.

const ACCOUNT = "111122223333";
const ENV_CFN_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-cloudformation`;
const ENV_BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/agentx/staging/agentx-staging-boundary`;
const REGION = "us-west-2";
const names = environmentReleaseNames("staging");

type Json = Record<string, unknown>;
interface Statement { Sid?: string; Effect: "Allow" | "Deny"; Action?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown }
interface TemplateJson { Resources: Record<string, { Type: string; Properties: Json }> }
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Resolves the intrinsics the documents use to concrete text: this account, the partition, and the ARNs of the pipeline template's own named resources. */
function resolver(json: TemplateJson): (value: unknown) => string {
  const arnOf = (id: string): string | undefined => {
    const resource = json.Resources[id];
    if (resource === undefined) return undefined;
    const name = (): string => resolve(resource.Properties.BucketName ?? resource.Properties.Name);
    if (resource.Type === "AWS::S3::Bucket") return `arn:aws:s3:::${name()}`;
    if (resource.Type === "AWS::CodeBuild::Project") return `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${name()}`;
    if (resource.Type === "AWS::CodePipeline::Pipeline") return `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${name()}`;
    if (resource.Type === "AWS::SNS::Topic") return `arn:aws:sns:${REGION}:${ACCOUNT}:${resolve(resource.Properties.TopicName)}`;
    if (resource.Type === "AWS::KMS::Key") return `arn:aws:kms:${REGION}:${ACCOUNT}:key/${id}`;
    return undefined;
  };
  function resolve(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(resolve).join("");
    if (value !== null && typeof value === "object") {
      const record = value as Json;
      if ("Fn::Join" in record) {
        const [separator, parts] = record["Fn::Join"] as [string, unknown[]];
        return parts.map(resolve).join(separator);
      }
      if ("Ref" in record) {
        const ref = String(record.Ref);
        if (ref === "AWS::AccountId") return ACCOUNT;
        if (ref === "AWS::Partition") return "aws";
        if (ref === "AWS::Region") return REGION;
        if (json.Resources[ref]?.Type === "AWS::SNS::Topic") return arnOf(ref)!;
        return `\${${ref}}`;
      }
      if ("Fn::GetAtt" in record) {
        const [id, attribute] = record["Fn::GetAtt"] as string[];
        return (attribute === "Arn" ? arnOf(id!) : undefined) ?? `\${${id}.${attribute}}`;
      }
      return JSON.stringify(record);
    }
    return String(value);
  }
  return resolve;
}

const globToRegExp = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`, "iu");
const matches = (patterns: string[], text: string): boolean => patterns.some((pattern) => globToRegExp(pattern).test(text));
/** A concrete sample of an IAM pattern: each `*` becomes "x". */
const sample = (pattern: string): string => pattern.replaceAll("*", "x");

// ---- the access stack's boundary, for one environment
function accessBoundary(env: string, which: "deploy" | "runtime" = "deploy"): { statements: Array<Statement & { actions: string[]; resources: string[]; notResources: string[] }>; json: TemplateJson } {
  const app = buildAgentXApp({ agentxEnv: env });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === `agentx-${env}-access`)!;
  const json = Template.fromStack(stack).toJSON() as TemplateJson;
  // TWO-BOUNDARIES: the access stack holds the DEPLOY boundary (the CloudFormation service role and the operator role) and the RUNTIME one (every role a merged template creates); both carry the
  // same Deny statements, and the escalation rules below (F1, F2) are the DEPLOY roles', which are the ones that can write roles and stacks.
  const policyName = which === "deploy" ? `agentx-${env}-deploy-boundary` : `agentx-${env}-boundary`;
  const policy = Object.values(json.Resources).find((resource) => resource.Type === "AWS::IAM::ManagedPolicy" && resource.Properties.ManagedPolicyName === policyName)!;
  const resolve = resolver(json);
  const statements = ((policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => ({
    ...statement,
    actions: list(statement.Action),
    resources: list(statement.Resource).map(resolve),
    notResources: list(statement.NotResource).map(resolve),
    Condition: statement.Condition === undefined ? undefined : Object.fromEntries(Object.entries(statement.Condition as Json).map(([operator, keys]) => [operator, Object.fromEntries(Object.entries(keys as Json).map(([key, value]) => [key, Array.isArray(value) ? value.map(resolve) : resolve(value)]))])),
  }));
  return { statements, json };
}
const staging = accessBoundary("staging");
const boundaryDenies = staging.statements.filter((statement) => statement.Effect === "Deny");
const denyOf = (sid: string) => {
  const found = boundaryDenies.find((statement) => statement.Sid === sid);
  if (found === undefined) throw new Error(`the boundary has no ${sid} deny`);
  return found;
};
/**
 * What the boundary does with one call by a role that carries it: an explicit Deny wins; otherwise some Allow of the ceiling must cover it. `aliases` are the aliases of the key a KMS
 * call names; `context` holds the other request keys (cloudformation:RoleArn, iam:PermissionsBoundary). A key the request lacks makes StringEquals and ForAnyValue false and
 * StringNotEquals true (the AWS rule for an absent key), which the CloudFormation role rule relies on.
 */
function evaluate(statements: typeof staging.statements, action: string, resource: string, aliases: string[] = [], context: Record<string, string> = {}): "denied" | "allowed" | "no-allow" {
  const conditionHolds = (condition: unknown): boolean => {
    if (condition === undefined) return true;
    return Object.entries(condition as Record<string, Record<string, string | string[]>>).every(([operator, keys]) =>
      Object.entries(keys).every(([key, patterns]) => {
        const value: string | undefined = context[key];
        const actual = key === "kms:ResourceAliases" ? aliases : value === undefined ? [] : [value];
        switch (operator) {
          case "ForAnyValue:StringLike": return list(patterns).some((pattern) => actual.some((one) => globToRegExp(pattern).test(one)));
          case "StringEquals": return list(patterns).some((pattern) => actual.includes(pattern));
          case "StringNotEquals": return !list(patterns).some((pattern) => actual.includes(pattern));
          default: throw new Error(`the evaluator does not know the condition operator ${operator}`);
        }
      }));
  };
  const covers = (statement: (typeof statements)[number]): boolean => matches(statement.actions, action)
    && (statement.notResources.length > 0 ? !matches(statement.notResources, resource) : statement.resources.length === 0 || matches(statement.resources, resource))
    && conditionHolds(statement.Condition);
  if (statements.some((statement) => statement.Effect === "Deny" && covers(statement))) return "denied";
  return statements.some((statement) => statement.Effect === "Allow" && covers(statement)) ? "allowed" : "no-allow";
}

// ---- the pipeline stack, the oracle for what the pipeline's resources are
const pipelineStack = new EnvironmentReleasePipelineStack(new App(), "AccessDeniesPipeline", { environment: "staging", region: REGION, repository: { owner: "ExampleOrg", name: "example-repo", branch: "code/next" } });
const pipelineJson = Template.fromStack(pipelineStack).toJSON() as TemplateJson;
const resolvePipeline = resolver(pipelineJson);
const pipelineAllows = Object.values(pipelineJson.Resources)
  .flatMap((resource) => (resource.Type === "AWS::IAM::Policy" ? ((resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement) : []))
  .filter((statement) => statement.Effect === "Allow")
  .map((statement) => ({ actions: list(statement.Action), resources: list(statement.Resource).map(resolvePipeline) }));
/** Every (action, resource) pair a pipeline role is allowed on one of the five services the denies cover, with the resource as a concrete sample. */
const SERVICES = ["ssm", "secretsmanager", "s3", "codebuild", "codepipeline", "sns", "kms"] as const;
const pipelineCalls = pipelineAllows.flatMap(({ actions, resources }) =>
  actions
    .filter((action) => SERVICES.some((service) => action.startsWith(`${service}:`)))
    .flatMap((action) => resources.filter((resource) => !resource.includes("${") && resource !== "*").map((resource) => ({ action: sample(action), resource: sample(resource) }))));
/** The pipeline's own resources: everything named rovara-... or under /rovara-release/. The environment's settings, the bootstrap assets and the access artifact bucket are not. */
const isPipelineResource = (resource: string): boolean => /rovara-|:key\/AlertsKey/u.test(resource);
/** The aliases a call on this resource carries: the pipeline's key has its alias (the pipeline template's alias resource), any other key none. */
const aliasesOf = (resource: string): string[] => (resource.includes(":key/AlertsKey") ? [releasePipelineNames("staging").keyAlias] : []);

describe("the environment boundary's release pipeline denies (shape)", () => {
  it("adds exactly two Deny statements to the default boundary (one unconditional, one by key alias), and nothing else", () => {
    const sids = staging.statements.map((statement) => statement.Sid);
    expect(sids.filter((sid) => sid?.startsWith("DenyRelease"))).toEqual(["DenyReleasePipeline", "DenyReleaseKey"]);
    expect(denyOf("DenyReleasePipeline").Condition).toBeUndefined();
    expect(denyOf("DenyReleaseKey")).toMatchObject({
      Effect: "Deny",
      actions: ["kms:*"],
      resources: ["*"],
      Condition: { "ForAnyValue:StringLike": { "kms:ResourceAliases": "alias/rovara-staging-release-*" } },
    });
    // The same statement, in the same place, as the pure function the CLI export bundle also renders.
    const pure = defaultBoundaryStatements({ env: "staging", partition: "aws", region: REGION, account: ACCOUNT, cloudFormationRoleName: "agentx-staging-cloudformation" });
    expect(pure.slice(-2).map((statement) => statement.Sid)).toEqual(["DenyReleasePipeline", "DenyReleaseKey"]);
    expect(pure.slice(-2)).toEqual(releasePipelineDenyStatements({ env: "staging", partition: "aws" }));
  });

  it("denies the pointers, the canary secret, both buckets, the projects, the pipeline, its stack, its alert topics and its key alias, by the names the pipeline stack gives them", () => {
    const deny = denyOf("DenyReleasePipeline");
    expect(deny.actions).toEqual(["ssm:*", "secretsmanager:*", "s3:*", "codebuild:*", "codepipeline:*", "sns:*", "kms:*", "cloudformation:Create*", "cloudformation:Update*", "cloudformation:Delete*", "cloudformation:Execute*"]);
    expect(deny.resources).toEqual([
      "arn:aws:ssm:*:*:parameter/rovara-release/staging*",
      "arn:aws:secretsmanager:*:*:secret:rovara-release/staging/*",
      "arn:aws:*rovara-staging-*rel*",
      "arn:aws:cloudformation:*:*:stack/agentx-staging-access/*",
    ]);
  });

  it("names the same strings as the pipeline stack: the two buckets are fixed-name, and the pipeline, stack, Decide and AutoApprove projects match the denies", () => {
    const shared = releasePipelineNames("staging");
    expect([names.pipeline, names.stack, names.parameterPrefix]).toEqual([shared.pipeline, shared.stack, shared.parameterPrefix]);
    const bucketNames = Object.values(pipelineJson.Resources).filter((resource) => resource.Type === "AWS::S3::Bucket").map((resource) => resolvePipeline(resource.Properties.BucketName)).sort();
    expect(bucketNames).toEqual([shared.artifactBucket(ACCOUNT), shared.runsBucket(ACCOUNT)].sort());
    const pipelineName = Object.values(pipelineJson.Resources).find((resource) => resource.Type === "AWS::CodePipeline::Pipeline")!.Properties.Name;
    expect(pipelineName).toBe(names.pipeline);
    const deny = denyOf("DenyReleasePipeline").resources;
    for (const key of RELEASE_PROJECT_KEYS) expect(matches(deny, `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project(key)}`), key).toBe(true);
    expect(names.project("decide")).toBe("rovara-staging-code-release-decide");
    expect(names.project("auto-approver")).toBe("rovara-staging-code-release-auto-approver");
    // The pipeline's stack is not in this list: the boundary's DenyCfnOutsideEnvStacks covers it (tested below), as it covers every stack outside agentx-<env>-*.
    expect(matches(deny, `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${names.pipeline}/Approve/ApproveDeploy`)).toBe(true);
    for (const bucket of bucketNames) expect(matches(deny, `arn:aws:s3:::${bucket}/some/key`), bucket).toBe(true);
    // The alert topic and the key alias are the pipeline stack's own, by the shared names.
    const topic = Object.values(pipelineJson.Resources).find((resource) => resource.Type === "AWS::SNS::Topic")!.Properties.TopicName;
    expect(topic).toBe(shared.alertsTopic);
    expect(matches(deny, `arn:aws:sns:${REGION}:${ACCOUNT}:${String(topic)}`)).toBe(true);
    const alias = Object.values(pipelineJson.Resources).find((resource) => resource.Type === "AWS::KMS::Alias")!.Properties;
    expect(alias.AliasName).toBe(shared.keyAlias);
    expect(matches(deny, `arn:aws:kms:${REGION}:${ACCOUNT}:${String(alias.AliasName)}`)).toBe(true);
    expect(globToRegExp(shared.keyAliasPattern).test(shared.keyAlias)).toBe(true);
    // The shared OperatorAlerts topic is the environment's, not the pipeline's: never denied.
    expect(matches(deny, `arn:aws:sns:${REGION}:${ACCOUNT}:agentx-staging-alerts`)).toBe(false);
  });

  it("keeps BOTH boundaries inside the managed policy's 6,144-character limit for the longest environment name on the longest partition (the headroom is pinned), and for the placeholder the export bundle renders", () => {
    // TWO-BOUNDARIES: the runtime boundary and the deploy boundary are separate managed policies, each with its own limit. The headroom numbers are what the next statement can spend.
    const size = (statements: typeof defaultBoundaryStatements, env: string, partition: string) => JSON.stringify({ Version: "2012-10-17", Statement: statements({ env, partition, region: partition === "aws" ? REGION : "us-gov-west-1", account: ACCOUNT, cloudFormationRoleName: `agentx-${env}-cloudformation` }) }).replace(/\s/gu, "").length;
    for (const env of ["staging", "a".repeat(20), "qqenv-placeholderqq"]) {
      for (const partition of ["aws", "aws-us-gov"]) {
        expect(size(defaultBoundaryStatements, env, partition), `runtime ${env} ${partition}`).toBeLessThanOrEqual(6144 - 1700);
        expect(size(deployBoundaryStatements, env, partition), `deploy ${env} ${partition}`).toBeLessThanOrEqual(6144 - 250);
      }
    }
    expect(releasePipelineNames("a".repeat(20)).runsBucket(ACCOUNT).length).toBeLessThanOrEqual(63);
  });
});

describe("a role with the environment boundary cannot touch the pipeline", () => {
  const pipelineArn = `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${names.pipeline}`;
  const calls: Array<[string, string, string, string[]?]> = [
    ["ssm:PutParameter", "the policy pin", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/policy-pin`],
    ["ssm:PutParameter", "the last-good pointer", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/code-last-good`],
    ["ssm:PutParameter", "the installed pointer", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/code-installed`],
    ["ssm:PutParameter", "a hold", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/code-hold/by-the-guard`],
    ["ssm:DeleteParameter", "a hold", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/code-hold/by-the-guard`],
    ["ssm:LabelParameterVersion", "the policy pin", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/staging/policy-pin`],
    ["s3:PutObject", "a run record", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}/decide/exec-1/decision.json`],
    ["s3:PutObject", "the canary ledger", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}/canary-ledger/1`],
    ["s3:PutObject", "the CI cache", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}/ci-cache/x`],
    ["s3:PutObject", "a pipeline artifact", `arn:aws:s3:::rovara-staging-code-rel-art-${ACCOUNT}/rovara-staging-code-release/Build/abc`],
    ["s3:DeleteObjectVersion", "a run record", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}/decide/exec-1/decision.json`],
    ["s3:PutBucketPolicy", "the runs bucket", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}`],
    ["s3:PutLifecycleConfiguration", "the runs bucket", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}`],
    ["secretsmanager:GetSecretValue", "the canary credential", `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rovara-release/staging/canary-credential-AbCdEf`],
    ["secretsmanager:PutSecretValue", "the canary credential", `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rovara-release/staging/canary-credential-AbCdEf`],
    ["codebuild:StartBuild", "Decide", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("decide")}`],
    ["codebuild:StartBuild", "AutoApprove", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("auto-approver")}`],
    ["codebuild:UpdateProject", "Decide", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("decide")}`],
    ["codebuild:UpdateProject", "AutoApprove", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("auto-approver")}`],
    ["codebuild:BatchGetProjects", "Decide", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("decide")}`],
    ["codebuild:DeleteProject", "Build", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${names.project("build")}`],
    ["codepipeline:PutApprovalResult", "the approval action", `${pipelineArn}/Approve/ApproveDeploy`],
    ["codepipeline:StartPipelineExecution", "the pipeline", pipelineArn],
    ["codepipeline:UpdatePipeline", "the pipeline", pipelineArn],
    ["codepipeline:RollbackStage", "the Release stage", `${pipelineArn}/Release`],
    ["cloudformation:UpdateStack", "the pipeline stack", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${names.stack}/1a2b3c`],
    ["cloudformation:CreateChangeSet", "the pipeline stack", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${names.stack}/1a2b3c`],
    ["cloudformation:DeleteStack", "the pipeline stack", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${names.stack}/1a2b3c`],
    ["sns:Publish", "the pipeline's alert topic", `arn:aws:sns:${REGION}:${ACCOUNT}:${names.alertsTopic}`],
    ["sns:SetTopicAttributes", "the pipeline's alert topic", `arn:aws:sns:${REGION}:${ACCOUNT}:${names.alertsTopic}`],
    ["sns:Subscribe", "the pipeline's alert topic", `arn:aws:sns:${REGION}:${ACCOUNT}:${names.alertsTopic}`],
    ["sns:DeleteTopic", "the pipeline's alert topic", `arn:aws:sns:${REGION}:${ACCOUNT}:${names.alertsTopic}`],
    ["sns:Publish", "a Chatbot topic of the pipeline", `arn:aws:sns:${REGION}:${ACCOUNT}:rovara-staging-release-chatbot`],
    ["kms:ScheduleKeyDeletion", "the pipeline's key", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/rovara-staging-release-alerts"]],
    ["kms:PutKeyPolicy", "the pipeline's key", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/rovara-staging-release-alerts"]],
    ["kms:DisableKey", "the pipeline's key", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/other", "alias/rovara-staging-release-alerts"]],
    ["kms:Decrypt", "the pipeline's key", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/rovara-staging-release-alerts"]],
    ["kms:DeleteAlias", "the pipeline's key alias", `arn:aws:kms:${REGION}:${ACCOUNT}:alias/rovara-staging-release-alerts`],
    ["kms:UpdateAlias", "the pipeline's key alias", `arn:aws:kms:${REGION}:${ACCOUNT}:alias/rovara-staging-release-alerts`],
  ];
  it.each(calls)("%s on %s is denied", (action, _what, resource, aliases) => {
    expect(evaluate(staging.statements, action, resource, aliases)).toBe("denied");
  });

  it("would otherwise have been allowed by the ceiling (ssm, s3, secretsmanager, codebuild, cloudformation, sns, kms), so the denies are what stops it", () => {
    const ceiling = staging.statements.filter((statement) => statement.Effect === "Allow");
    for (const [action, , resource, aliases] of calls.filter(([action]) => !action.startsWith("codepipeline:"))) {
      expect(evaluate(ceiling, action, resource, aliases), `${action} ${resource}`).toBe("allowed");
    }
  });

  it("is derived from the pipeline template: every ssm, s3, secret, project, pipeline, alert topic and key resource its roles are allowed is denied to the environment's roles", () => {
    const own = pipelineCalls.filter(({ resource }) => isPipelineResource(resource));
    expect(own.length).toBeGreaterThan(40);
    for (const service of SERVICES) expect(own.some(({ action }) => action.startsWith(`${service}:`)), service).toBe(true);
    for (const { action, resource } of own) expect(evaluate(staging.statements, action, resource, aliasesOf(resource)), `${action} ${resource}`).toBe("denied");
  });

  it("denies nothing the environment legitimately uses: its settings, secrets, projects, buckets, pipelines and stacks stay as they were (the pattern names are the pipeline's, not rovara-staging-* as a whole)", () => {
    const others: Array<[string, string, string[]?, Record<string, string>?]> = [
      // The shared OperatorAlerts topic (every alarm of the environment publishes to it) and keys that are not the pipeline's.
      ["sns:Publish", `arn:aws:sns:${REGION}:${ACCOUNT}:agentx-staging-alerts`],
      ["sns:Subscribe", `arn:aws:sns:${REGION}:${ACCOUNT}:agentx-staging-alerts`],
      ["sns:Publish", `arn:aws:sns:${REGION}:${ACCOUNT}:rovara-staging-code-ci-alerts`],
      ["kms:Decrypt", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/agentx-staging-chatgpt-token"]],
      ["kms:Decrypt", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`],
      ["kms:Decrypt", `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, ["alias/rovara-demo-release-alerts"]],
      ["kms:CreateAlias", `arn:aws:kms:${REGION}:${ACCOUNT}:alias/agentx-staging-new`],
      ["ssm:PutParameter", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/agentx/staging/settings/x`],
      ["ssm:GetParameter", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release-other/x`],
      ["secretsmanager:GetSecretValue", `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:agentx/staging/callback-signing-key-AbCdEf`],
      ["s3:PutObject", `arn:aws:s3:::agentx-staging-artifacts-${ACCOUNT}/x`],
      ["s3:PutObject", `arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT}-${REGION}/x`],
      ["s3:PutObject", `arn:aws:s3:::rovara-staging-code-ci-cache-${ACCOUNT}/x`],
      ["codebuild:StartBuild", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/agentx-staging-worker-build`],
      ["codebuild:StartBuild", `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/rovara-staging-code-ci-runner`],
      ["codepipeline:StartPipelineExecution", `arn:aws:codepipeline:${REGION}:${ACCOUNT}:agentx-release`],
      ["cloudformation:UpdateStack", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/agentx-staging-runtime/1a2b3c`, [], { "cloudformation:RoleArn": ENV_CFN_ROLE }],
      ["cloudformation:ExecuteChangeSet", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/agentx-staging-runtime/1a2b3c`],
      ["cloudformation:DescribeStacks", `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/rovara-staging-code-ci-runner/1a2b3c`],
    ];
    for (const [action, resource, aliases, context] of others) expect(evaluate(staging.statements, action, resource, aliases, context), `${action} ${resource}`).not.toBe("denied");
  });

  it("is scoped to this environment: another environment's pipeline is not named by the staging boundary, and staging's resources are not named by another's", () => {
    const other = accessBoundary("demo").statements;
    const demoCall: [string, string] = ["ssm:PutParameter", `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/rovara-release/demo/policy-pin`];
    expect(evaluate(staging.statements, ...demoCall)).toBe("allowed");
    expect(evaluate(other, ...demoCall)).toBe("denied");
    expect(evaluate(other, "codepipeline:PutApprovalResult", `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${names.pipeline}/Approve/ApproveDeploy`)).toBe("no-allow");
    expect(evaluate(other, "s3:PutObject", `arn:aws:s3:::rovara-staging-code-rel-runs-${ACCOUNT}/decide/x`)).toBe("allowed");
    expect(evaluate(other, "sns:Publish", `arn:aws:sns:${REGION}:${ACCOUNT}:${names.alertsTopic}`)).toBe("allowed");
    const stagingKey = `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
    expect(evaluate(other, "kms:Decrypt", stagingKey, ["alias/rovara-staging-release-alerts"])).toBe("allowed");
    expect(evaluate(other, "kms:Decrypt", stagingKey, ["alias/rovara-demo-release-alerts"])).toBe("denied");
    expect(JSON.stringify(other.filter((statement) => statement.Sid?.startsWith("DenyRelease")))).not.toContain("staging");
    expect(JSON.stringify(staging.statements.filter((statement) => statement.Sid?.startsWith("DenyRelease")))).not.toContain("demo");
  });
});

describe("a role with the environment boundary cannot step outside it (F1 stored role, F2 boundary self-escape)", () => {
  const stackArn = (name: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/1a2b3c`;
  const CDK_EXEC_ROLE = `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-${REGION}`;
  const withRole = (role: string) => ({ "cloudformation:RoleArn": role });
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/minted-role`;

  describe("F1: CloudFormation runs as the stack's stored role when the caller passes none", () => {
    it.each(["UpdateStack", "CreateChangeSet", "CreateStack"])("%s with the CDK bootstrap cfn-exec role is denied, with no role is denied, with the environment's CloudFormation role is allowed (on an environment stack)", (action) => {
      const stack = stackArn("agentx-staging-runtime");
      expect(evaluate(staging.statements, `cloudformation:${action}`, stack, [], withRole(CDK_EXEC_ROLE))).toBe("denied");
      expect(evaluate(staging.statements, `cloudformation:${action}`, stack)).toBe("denied");
      expect(evaluate(staging.statements, `cloudformation:${action}`, stack, [], withRole(ENV_CFN_ROLE))).toBe("allowed");
    });

    it("refuses every stack outside agentx-<env>-* even with the environment's role: the pipeline's stack, the stacks of other deployments, CDKToolkit, a new stack; and the access stack", () => {
      for (const name of [names.stack, "other-staging-app", "other-staging-gateway", "other-staging-gateway-images", "other-staging-web", "CDKToolkit", "scratch-test-stack", "agentx-staging-access"]) {
        for (const action of ["UpdateStack", "CreateChangeSet", "CreateStack", "DeleteStack", "ExecuteChangeSet", "UpdateTerminationProtection"]) {
          expect(evaluate(staging.statements, `cloudformation:${action}`, stackArn(name), [], withRole(ENV_CFN_ROLE)), `${action} ${name}`).toBe("denied");
        }
      }
    });

    it("keeps the environment's five deployed parts working for the roles that deploy them (change sets with the environment role, execute, delete, termination protection) and every read", () => {
      for (const part of ["foundation", "identity", "runtime", "control-plane", "slack"]) {
        for (const action of ["CreateChangeSet", "ExecuteChangeSet", "DeleteChangeSet", "UpdateTerminationProtection", "DeleteStack"]) {
          expect(evaluate(staging.statements, `cloudformation:${action}`, stackArn(`agentx-staging-${part}`), [], withRole(ENV_CFN_ROLE)), `${action} ${part}`).toBe("allowed");
        }
      }
      for (const name of ["agentx-staging-access", names.stack, "other-staging-app"]) {
        for (const action of ["DescribeStacks", "DescribeChangeSet", "GetTemplate", "ListStackResources"]) expect(evaluate(staging.statements, `cloudformation:${action}`, stackArn(name)), `${action} ${name}`).toBe("allowed");
      }
      expect(evaluate(staging.statements, "cloudformation:ValidateTemplate", "*")).toBe("allowed");
    });
  });

  describe("F2: the boundary carries the rules that keep a role bounded", () => {
    const bounded = { "iam:PermissionsBoundary": ENV_BOUNDARY };
    const admin = { "iam:PermissionsBoundary": "arn:aws:iam::aws:policy/AdministratorAccess" };
    it("CreateRole with no boundary, or the admin policy as boundary, is not allowed; with the environment boundary it is", () => {
      expect(evaluate(staging.statements, "iam:CreateRole", roleArn)).toBe("no-allow");
      expect(evaluate(staging.statements, "iam:CreateRole", roleArn, [], admin)).toBe("no-allow");
      expect(evaluate(staging.statements, "iam:CreateRole", roleArn, [], bounded)).toBe("allowed");
    });
    it("PutRolePermissionsBoundary to AdministratorAccess (or to nothing the environment owns) is not allowed; to the environment boundary it is", () => {
      expect(evaluate(staging.statements, "iam:PutRolePermissionsBoundary", roleArn, [], admin)).toBe("no-allow");
      expect(evaluate(staging.statements, "iam:PutRolePermissionsBoundary", roleArn)).toBe("no-allow");
      expect(evaluate(staging.statements, "iam:PutRolePermissionsBoundary", roleArn, [], bounded)).toBe("allowed");
    });
    it.each(["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"])("%s is not allowed on a role that carries another boundary or none (a role created without one can be given AdministratorAccess only through these), and is allowed on a bounded one", (action) => {
      expect(evaluate(staging.statements, action, roleArn)).toBe("no-allow");
      expect(evaluate(staging.statements, action, roleArn, [], admin)).toBe("no-allow");
      expect(evaluate(staging.statements, action, roleArn, [], bounded)).toBe("allowed");
    });
    it("DeleteRolePermissionsBoundary is never allowed, whatever the role carries (no Allow lists it)", () => {
      for (const context of [{}, bounded, admin]) expect(evaluate(staging.statements, "iam:DeleteRolePermissionsBoundary", roleArn, [], context)).toBe("denied");
    });
    it("AdministratorAccess attached to a bounded role does not widen it: the boundary still allows no user, group, policy or account change, and no sts:AssumeRole of a pipeline role", () => {
      for (const action of ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreatePolicy", "iam:CreatePolicyVersion", "organizations:CreateAccount", "sts:AssumeRole"]) {
        expect(evaluate(staging.statements, action, `arn:aws:iam::${ACCOUNT}:role/${names.role("approver")}`), action).not.toBe("allowed");
      }
    });
    it("leaves the reads and the other role actions the environment's roles need (GetRole, TagRole, UpdateAssumeRolePolicy, PassRole) allowed on its roles", () => {
      for (const action of ["iam:GetRole", "iam:GetRolePolicy", "iam:TagRole", "iam:UpdateAssumeRolePolicy", "iam:ListRolePolicies", "iam:PassRole"]) expect(evaluate(staging.statements, action, roleArn), action).toBe("allowed");
    });
  });
});

describe("the pipeline's two buckets refuse every request through an access point", () => {
  const policies = Object.values(pipelineJson.Resources).filter((resource) => resource.Type === "AWS::S3::BucketPolicy");
  it("has a bucket policy on each of the two buckets that denies s3:* to any principal when s3:DataAccessPointArn is present, on the bucket and its objects", () => {
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] & Array<{ Principal?: unknown }> }).Statement;
      const deny = statements.find((statement) => statement.Sid === "DenyAccessPoints")!;
      expect(deny).toMatchObject({ Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:*", Condition: { Null: { "s3:DataAccessPointArn": "false" } } });
      const resources = list(deny.Resource).map(resolvePipeline);
      expect(resources).toHaveLength(2);
      expect(resources.some((resource) => resource.endsWith("/*"))).toBe(true);
      expect(resources.every((resource) => /rovara-staging-code-rel-(runs|art)-111122223333/u.test(resource) || resource.includes("${"))).toBe(true);
    }
    expect(new Set(policies.map((policy) => flatBucketRef(policy.Properties.Bucket))).size).toBe(2);
  });
  it("does not touch the pipeline roles' own calls: they address the bucket directly, so s3:DataAccessPointArn is absent from them", () => {
    // No pipeline role statement names an access point ARN.
    expect(JSON.stringify(pipelineAllows)).not.toContain("accesspoint");
  });
});
const flatBucketRef = (value: unknown): string => JSON.stringify(value);

describe("the pipeline's own roles are unaffected (two boundaries, no collision)", () => {
  const roles = Object.entries(pipelineJson.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
  const pipelineBoundary = Object.keys(pipelineJson.Resources).find((id) => pipelineJson.Resources[id]!.Type === "AWS::IAM::ManagedPolicy" && /^Boundary/u.test(id))!;

  it("gives every pipeline role the pipeline's own boundary, so the environment boundary's denies are never evaluated for them (a role carries exactly one boundary)", () => {
    expect(roles.length).toBeGreaterThanOrEqual(14);
    for (const [id, role] of roles) {
      expect(role.Properties.PermissionsBoundary, id).toEqual({ Ref: pipelineBoundary });
    }
    const boundaryName = pipelineJson.Resources[pipelineBoundary]!.Properties.ManagedPolicyName;
    expect(boundaryName).toBe(names.boundary);
    // The pipeline boundary is a different policy from the environment's default boundary, and the pipeline template never mentions the default's name or the access stack's parameter.
    expect(names.boundary).not.toBe("agentx-staging-boundary");
    expect(JSON.stringify(pipelineJson)).not.toContain("agentx-staging-boundary");
    expect(JSON.stringify(pipelineJson)).not.toContain("PermissionsBoundaryArn");
  });

  it("is never given the environment boundary by the app: the pipeline stack builds alone, and the environment aspect only runs for environment stacks", () => {
    const app = buildAgentXApp({ agentxReleasePipeline: "staging", agentxRegion: REGION });
    const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
    expect(stacks.map((stack) => stack.stackName)).toEqual([names.stack]);
  });

  it("shares no statement with the environment boundary: the pipeline boundary holds none of the environment's denies, and its own allows on the pipeline's resources exist (they are the calls the environment's roles are refused)", () => {
    const own = pipelineCalls.filter(({ resource }) => isPipelineResource(resource));
    expect(own.length).toBeGreaterThan(40);
    const pipelineBoundarySids = ((pipelineJson.Resources[pipelineBoundary]!.Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => statement.Sid);
    expect(pipelineBoundarySids.filter((sid) => sid?.startsWith("DenyRelease"))).toEqual([]);
    expect(pipelineBoundarySids).not.toContain("DenyReleasePipeline");
  });
});

describe("what the denies do not need: prod and the legacy deployment", () => {
  it("adds nothing to the deployment that predates environments: no access stack, none of these release denies and no release pipeline name", () => {
    const stacks = buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child));
    for (const stack of stacks) {
      const text = JSON.stringify(Template.fromStack(stack).toJSON());
      // Exact Sids: the legacy runtime boundary (Fix A, DEC 254zzz443) has its own DenyReleasePipelineRoles / DenyReleaseProjects; these two must never reach it.
      expect(text, stack.stackName).not.toContain('"Sid":"DenyReleasePipeline"');
      expect(text, stack.stackName).not.toContain('"Sid":"DenyReleaseKey"');
      expect(text, stack.stackName).not.toContain("rovara-release");
      expect(text, stack.stackName).not.toContain("-rel-runs-");
    }
  });

  it("changes only the access stack's boundary policy in a named environment: no other stack, and not the CloudFormation service role's own policy", () => {
    const withDenies = serviceRoleStatements({ env: "staging", partition: "aws", region: REGION, account: ACCOUNT, artifactBucketArn: "arn:aws:s3:::b", pullThroughPrefix: "agentx", cloudFormationRoleName: "agentx-staging-cloudformation" });
    expect(withDenies.some((statement) => statement.Sid?.startsWith("DenyRelease"))).toBe(false);
    const app = buildAgentXApp({ agentxEnv: "staging" });
    for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child) && child.stackName !== "agentx-staging-access")) {
      expect(JSON.stringify(Template.fromStack(stack).toJSON()), stack.stackName).not.toContain("DenyRelease");
    }
  }, 300_000);
});
