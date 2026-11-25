import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  APPROVE_STAGE,
  AUTO_APPROVE_ACTION,
  CANARY_LEDGER_PREFIX,
  CI_CACHE_PREFIX,
  GUARD_ACTION,
  DECIDE_ACTION,
  EnvironmentReleasePipelineStack,
  POLICY_HASH_COMMAND,
  MANUAL_APPROVAL_ACTION,
  RELEASE_PROJECT_KEYS,
  RELEASE_ROLE_KEYS,
  RUN_ACCESS,
  RUN_WRITE_PREFIX,
  environmentReleaseNames,
  type ReleaseProjectKey,
  type ReleaseRoleKey,
} from "../../infra/lib/environment-release-pipeline.js";
import { ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// Lane P1 of the staging release pipeline (plan v3, sections 1, 4 and 7). These are template assertions: they read the synthesized CloudFormation,
// so they hold whatever the construct code looks like. Every value below is an example (an environment called "staging", a region, a sample owner).

const REGION = "us-west-2";
const names = environmentReleaseNames("staging");
const template = Template.fromStack(
  new EnvironmentReleasePipelineStack(new App(), "TestEnvironmentReleasePipeline", {
    environment: "staging",
    region: REGION,
    repository: { owner: "ExampleOrg", name: "example-repo", branch: "code/next" },
  }),
);
const json = template.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };

interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
/** A CloudFormation value as text, with intrinsic functions flattened (Ref and Fn::GetAtt keep their target's name). */
function flat(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flat).join("");
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("Fn::Join" in record) return (record["Fn::Join"] as [string, unknown[]])[1].map(flat).join((record["Fn::Join"] as [string, unknown[]])[0]);
    if ("Ref" in record) return `\${${String(record.Ref)}}`;
    if ("Fn::GetAtt" in record) return `\${${(record["Fn::GetAtt"] as string[]).join(".")}}`;
    return JSON.stringify(record);
  }
  return String(value);
}

const roleResources = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
const roleLogicalId = (name: string): string => {
  const found = roleResources.find(([, resource]) => resource.Properties.RoleName === name);
  if (found === undefined) throw new Error(`no role named ${name}`);
  return found[0];
};
/** Every allow/deny statement an inline policy attaches to the role, with the resources flattened to text. */
function policyStatementsOf(key: ReleaseRoleKey): Array<Statement & { resources: string[]; actions: string[] }> {
  const id = roleLogicalId(names.role(key));
  return Object.values(json.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" && (resource.Properties.Roles as Array<{ Ref: string }>).some((role) => role.Ref === id))
    .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
    .map((statement) => ({ ...statement, resources: list(statement.Resource).map(flat), actions: list(statement.Action) }));
}
const boundaryStatements = ((): Array<Statement & { resources: string[]; notResources: string[]; actions: string[] }> => {
  const boundary = Object.values(json.Resources).find((resource) => resource.Type === "AWS::IAM::ManagedPolicy");
  if (boundary === undefined) throw new Error("no boundary managed policy");
  return (boundary.Properties.PolicyDocument as { Statement: Statement[] }).Statement.map((statement) => ({
    ...statement,
    actions: list(statement.Action),
    resources: list(statement.Resource).map(flat),
    notResources: list(statement.NotResource).map(flat),
  }));
})();
const boundaryStatement = (sid: string) => {
  const found = boundaryStatements.find((statement) => statement.Sid === sid);
  if (found === undefined) throw new Error(`the boundary has no ${sid} statement`);
  return found;
};
/** The role ARNs a boundary deny exempts (its `aws:PrincipalArn` StringNotEquals list), as role keys. */
function exemptedRoles(sid: string): string[] {
  const condition = boundaryStatement(sid).Condition?.StringNotEquals?.["aws:PrincipalArn"];
  return list(condition).map((arn) => {
    const key = RELEASE_ROLE_KEYS.find((candidate) => flat(arn).endsWith(`:role/${names.role(candidate)}`));
    if (key === undefined) throw new Error(`${sid} exempts something that is not a pipeline role: ${flat(arn)}`);
    return key;
  }).sort();
}

const projectResources = Object.values(json.Resources).filter((resource) => resource.Type === "AWS::CodeBuild::Project");
const projectOf = (key: ReleaseProjectKey) => {
  const found = projectResources.find((resource) => resource.Properties.Name === names.project(key));
  if (found === undefined) throw new Error(`no project ${key}`);
  return found.Properties as { Name: string; ServiceRole: unknown; Environment: { PrivilegedMode?: boolean }; Source: { BuildSpec: unknown }; ConcurrentBuildLimit?: number };
};
const buildSpecOf = (key: ReleaseProjectKey): string => flat(projectOf(key).Source.BuildSpec);
const pipeline = Object.values(json.Resources).find((resource) => resource.Type === "AWS::CodePipeline::Pipeline")!.Properties as {
  ExecutionMode: string;
  PipelineType: string;
  Stages: Array<{ Name: string; Actions: Array<{ Name: string; RunOrder: number; Configuration: Record<string, unknown>; ActionTypeId: { Category: string; Provider: string } }>; OnFailure?: { Result: string } }>;
  Triggers: unknown;
  RestartExecutionOnUpdate: boolean;
};

const WRITE_ACTION = /^(s3:(Put|Delete)|ssm:(Put|Delete)|codepipeline:(Put|Start|Stop|Retry)|cloudformation:(Create|Update|Delete|Execute)|iam:)/u;

describe("environment release pipeline: the stages (plan section 1)", () => {
  it("is a V2 SUPERSEDED pipeline in the stated order, with Decide, an auto and a manual approval, and a Release stage that rolls back", () => {
    expect(pipeline.PipelineType).toBe("V2");
    expect(pipeline.ExecutionMode).toBe("SUPERSEDED");
    expect(pipeline.RestartExecutionOnUpdate).toBe(false);
    expect(pipeline.Stages.map((stage) => stage.Name)).toEqual(["Source", "Check", "Build", "Preview", "Gates", "Decide", APPROVE_STAGE, "Release"]);
    const approve = pipeline.Stages.find((stage) => stage.Name === APPROVE_STAGE)!;
    expect(approve.Actions.map((action) => `${action.Name}:${action.ActionTypeId.Provider}`).sort()).toEqual([`${MANUAL_APPROVAL_ACTION}:Manual`, `${AUTO_APPROVE_ACTION}:CodeBuild`].sort());
    const release = pipeline.Stages.find((stage) => stage.Name === "Release")!;
    expect(release.Actions.map((action) => `${action.Name}@${action.RunOrder}`)).toEqual(["Guard@1", "Deploy@2", "PostCheck@3", "Canary@4"]);
    expect(release.OnFailure).toEqual({ Result: "ROLLBACK" });
    expect(pipeline.Stages.filter((stage) => stage.Name !== "Release").every((stage) => stage.OnFailure === undefined)).toBe(true);
  });

  it("starts on a push to the branch only, with no file-path or tag filter, and takes the connection as a parameter", () => {
    expect(pipeline.Triggers).toEqual([
      { ProviderType: "CodeStarSourceConnection", GitConfiguration: { SourceActionName: "Code", Push: [{ Branches: { Includes: ["code/next"] } }] } },
    ]);
    const source = pipeline.Stages[0]!;
    expect(source.Actions.map((action) => action.Name)).toEqual(["Code", "Ops"]);
    for (const action of source.Actions) expect(action.Configuration.ConnectionArn).toEqual({ Ref: "GitHubConnectionArn" });
    expect(source.Actions[0]!.Configuration).toMatchObject({ FullRepositoryId: "ExampleOrg/example-repo", BranchName: "code/next", OutputArtifactFormat: "CODEBUILD_CLONE_REF" });
    template.hasParameter("GitHubConnectionArn", { AllowedPattern: regionPattern() });
    // Nothing account-specific is in the template: no 12-digit literal anywhere (the account comes from AWS::AccountId).
    expect(JSON.stringify(json)).not.toMatch(/(?<![0-9a-zA-Z])[0-9]{12}(?![0-9a-zA-Z])/u);
  });

  it("keeps every buildspec inline, and fails the stages closed while the pack scripts or the evaluator do not exist (P3, P8 fill them)", () => {
    for (const key of RELEASE_PROJECT_KEYS) {
      const spec = buildSpecOf(key);
      expect(spec).toContain("version");
      expect((projectOf(key).Source as { Type?: string; BuildSpec: unknown }).BuildSpec).toBeDefined();
    }
    for (const key of ["preview", "gates", "deploy", "postcheck"] as const) expect(buildSpecOf(key)).toContain("is missing: the stage fails closed");
    const decide = buildSpecOf("decide");
    // Decide's default is MANUAL, and only an evaluator that ran, with the pin equal to the pack's hash, exits 0 and says AUTO can change it.
    expect(decide).toContain('DECISION=MANUAL; REASON=\\"evaluator-not-run\\"');
    expect(decide).toContain("evaluator-missing");
    expect(decide).toContain("policy-pin-mismatch");
    expect(decide).toContain("MANUAL-ONLY");
    expect(decide.match(/DECISION=AUTO/gu)).toHaveLength(1);
    expect(decide).toContain("exported-variables");
  });

  it("makes AutoApprove check this execution's Decide action and the pin before it approves, and Canary a placeholder that moves no pointer", () => {
    const auto = buildSpecOf("auto-approver");
    expect(auto).toContain("list-action-executions");
    expect(auto).toContain(`actionName=='${DECIDE_ACTION}'`);
    expect(auto).toContain("policy_hash");
    expect(auto.indexOf("put-approval-result")).toBeGreaterThan(auto.indexOf("list-action-executions"));
    expect(auto.indexOf("put-approval-result")).toBeGreaterThan(auto.indexOf("policy_hash"));
    expect(auto.match(/put-approval-result/gu)).toHaveLength(1);
    const canary = buildSpecOf("canary");
    expect(canary).toContain("SKIPPED-PLACEHOLDER");
    expect(canary).not.toMatch(/ssm put-parameter/u);
  });

  it("alerts on the two topics: a new KMS-encrypted one, and the environment's OperatorAlerts topic", () => {
    template.hasResourceProperties("AWS::SNS::Topic", { TopicName: names.alertsTopic, KmsMasterKeyId: Match.anyValue() });
    for (const key of ["check", "decide", "auto-approver", "deploy", "postcheck", "canary"] as const) {
      const publish = policyStatementsOf(key).find((statement) => statement.Sid === "PublishAlerts");
      expect(publish?.actions).toEqual(["sns:Publish"]);
      expect(publish?.resources).toHaveLength(2);
      expect(publish?.resources.some((resource) => resource.endsWith(`:sns:${REGION}:\${AWS::AccountId}:agentx-staging-alerts`))).toBe(true);
    }
  });
});

describe("environment release pipeline: P-SEP, only Build runs the repository's code", () => {
  it("has repository commands (npm, tsx, docker) in the Build buildspec only", () => {
    expect(buildSpecOf("build")).toContain("npm ci");
    expect(buildSpecOf("build")).toContain("npm run release:build");
    for (const key of RELEASE_PROJECT_KEYS.filter((candidate) => candidate !== "build")) {
      expect(buildSpecOf(key), key).not.toMatch(/\b(npm|npx|tsx|yarn|pnpm|docker|make|cdk)\b/u);
    }
  });

  it("gives only Build a privileged environment, and Build alone the images and the repository's connection together with Check", () => {
    expect(RELEASE_PROJECT_KEYS.filter((key) => projectOf(key).Environment.PrivilegedMode === true)).toEqual(["build"]);
    const ecrWriters = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /^ecr:(PutImage|InitiateLayerUpload|UploadLayerPart|CompleteLayerUpload)$/u.test(action))));
    expect(ecrWriters).toEqual(["build"]);
    const connectionUsers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /connection/iu.test(action))));
    expect([...connectionUsers].sort()).toEqual(["build", "check", "source"]);
    expect(exemptedRoles("DenyConnectionExceptSourceCheckBuild")).toEqual(["build", "check", "source"]);
    expect(exemptedRoles("DenyImageWritesExceptBuild")).toEqual(["build"]);
  });

  it("lets the Build role create no change set, write no gate, decision, pointer, hold or approval, and touch no IAM", () => {
    const statements = policyStatementsOf("build").filter((statement) => statement.Effect === "Allow");
    const actions = statements.flatMap((statement) => statement.actions);
    expect(actions.filter((action) => /^(cloudformation:(Create|Update|Delete|Execute|Set|Continue|Cancel|Rollback)|codepipeline:|iam:|secretsmanager:|ssm:(Put|Delete|Label|Unlabel)|sns:|lambda:|ecs:|events:)/u.test(action))).toEqual([]);
    const s3Writes = statements.filter((statement) => statement.actions.some((action) => /^s3:(Put|Delete)/u.test(action)));
    expect(s3Writes.flatMap((statement) => statement.resources)).toEqual([expect.stringMatching(/^\$\{Runs[A-Za-z0-9]+\.Arn\}\/build\/\*$/u)]);
  });

  it("makes every Decide read come from CloudFormation itself, and gives Decide no connection and no write but its own records and alerts", () => {
    const allows = policyStatementsOf("decide").filter((statement) => statement.Effect === "Allow");
    expect(allows.some((statement) => statement.actions.includes("cloudformation:DescribeChangeSet") && statement.actions.includes("cloudformation:GetTemplate"))).toBe(true);
    const writes = allows.flatMap((statement) => statement.actions.filter((action) => WRITE_ACTION.test(action)).map((action) => `${action} ${statement.resources.join(",")}`));
    expect(writes).toEqual([expect.stringMatching(/^s3:PutObject \$\{Runs[A-Za-z0-9]+\.Arn\}\/decide\/\*$/u), expect.stringMatching(new RegExp(`^s3:PutObject .*/${CI_CACHE_PREFIX}\\*$`, "u"))]);
    expect(allows.flatMap((statement) => statement.actions).filter((action) => /connection|ecr:Put|cloudformation:(Create|Execute)/u.test(action))).toEqual([]);
  });

  it("writes each run's records under a prefix of the role's own, and nothing under another's (prefix-scoped writes)", () => {
    const runWriters: Record<string, string> = {};
    for (const key of RELEASE_ROLE_KEYS) {
      const writes = policyStatementsOf(key)
        .filter((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /^s3:(Put|Delete)/u.test(action)))
        .flatMap((statement) => statement.resources)
        .filter((resource) => resource.includes("${Runs") && !resource.includes(`/${CI_CACHE_PREFIX}`));
      const nonLedger = writes.filter((resource) => !resource.includes(`/${CANARY_LEDGER_PREFIX}`));
      // Nothing is allowed to delete, anywhere.
      expect(policyStatementsOf(key).flatMap((statement) => statement.actions).filter((action) => /^s3:Delete/u.test(action) && !/^s3:DeleteObject\*$/u.test(action))).toEqual([]);
      if (nonLedger.length > 0) runWriters[key] = nonLedger.map((resource) => resource.replace(/^\$\{Runs[A-Za-z0-9]+\.Arn\}\//u, "").replace(/\/\*$/u, "")).join(",");
    }
    // The CDK-managed artifact-bucket grants (s3:DeleteObject* on the pipeline's own artifacts) belong to the pipeline and source roles only.
    expect(Object.keys(runWriters).sort()).toEqual(["approver", "build", "canary", "check", "decide", "deploy", "gates", "guard", "postcheck", "preview"]);
    for (const [key, prefix] of Object.entries(runWriters)) expect(prefix, key).toBe(RUN_WRITE_PREFIX[key]);
    expect(RUN_WRITE_PREFIX).toMatchObject({ guard: "guard", build: "build", preview: "preview", gates: "gates", decide: "decide", check: "check", deploy: "release", postcheck: "release", canary: "canary", approver: "89" });
    // Only the canary writes the ledger, and the boundary says so too.
    const ledgerWriters = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.resources.some((resource) => resource.includes(`/${CANARY_LEDGER_PREFIX}`)) && statement.actions.includes("s3:PutObject")));
    expect(ledgerWriters).toEqual(["canary"]);
    expect(exemptedRoles("DenyLedgerWritesExceptCanary")).toEqual(["canary"]);
    expect(boundaryStatement("DenyRunsBucketDeletesAndRules").actions).toEqual(expect.arrayContaining(["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutBucketPolicy"]));
  });

  it("allows PutApprovalResult to exactly two roles, on exactly the one approval action, and the boundary denies it to every other role", () => {
    const approvers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.some((action) => action === "codepipeline:PutApprovalResult" || action === "codepipeline:*" || action === "*")));
    expect(approvers).toEqual(["auto-approver", "approver"].sort((a, b) => RELEASE_ROLE_KEYS.indexOf(a as ReleaseRoleKey) - RELEASE_ROLE_KEYS.indexOf(b as ReleaseRoleKey)));
    for (const key of approvers) {
      const statement = policyStatementsOf(key).find((candidate) => candidate.actions.includes("codepipeline:PutApprovalResult"))!;
      expect(statement.resources).toEqual([`arn:\${AWS::Partition}:codepipeline:${REGION}:\${AWS::AccountId}:${names.pipeline}/${APPROVE_STAGE}/${MANUAL_APPROVAL_ACTION}`]);
    }
    const deny = boundaryStatement("DenyApprovalExceptApprovers");
    expect(deny.actions).toEqual(["codepipeline:PutApprovalResult"]);
    expect(deny.resources).toEqual(["*"]);
    expect(exemptedRoles("DenyApprovalExceptApprovers")).toEqual(["approver", "auto-approver"]);
    // The pipeline never lets a build start a run, either.
    expect(exemptedRoles("DenyStartExceptStarter")).toEqual(["starter"]);
    for (const key of RELEASE_ROLE_KEYS.filter((candidate) => candidate !== "starter")) {
      expect(policyStatementsOf(key).flatMap((statement) => statement.actions), key).not.toContain("codepipeline:StartPipelineExecution");
    }
  });
});

describe("environment release pipeline: S2 and S3, the boundary and the roles", () => {
  it("puts the one boundary on every role", () => {
    const boundary = Object.entries(json.Resources).find(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy")![0];
    expect(roleResources).toHaveLength(RELEASE_ROLE_KEYS.length);
    for (const [, role] of roleResources) expect(role.Properties.PermissionsBoundary, String(role.Properties.RoleName)).toEqual({ Ref: boundary });
    expect(roleResources.map(([, role]) => role.Properties.RoleName).sort()).toEqual(RELEASE_ROLE_KEYS.map((key) => names.role(key)).sort());
  });

  it("denies, in the boundary, every IAM write, any other region, and any assume of a role outside this account (S2, S3)", () => {
    const iamWrites = boundaryStatement("DenyIamWrites");
    expect(iamWrites.Effect).toBe("Deny");
    expect(iamWrites.resources).toEqual(["*"]);
    expect(iamWrites.actions).toEqual(expect.arrayContaining(["iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*"]));
    const region = boundaryStatement("DenyOtherRegions");
    expect(region.Effect).toBe("Deny");
    expect(region.Condition).toEqual({ StringNotEquals: { "aws:RequestedRegion": REGION } });
    const assume = boundaryStatement("DenyAssumeOutsideAccount");
    expect(assume.Effect).toBe("Deny");
    expect(assume.actions).toEqual(["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity"]);
    expect(assume.notResources).toEqual([`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/*`]);
    // The ceiling itself grants no IAM write, so even without the deny nothing would allow one.
    const ceiling = boundaryStatement("Ceiling");
    expect(ceiling.actions.filter((action) => /^iam:/u.test(action) && !/^iam:(Get|List|PassRole|SimulatePrincipalPolicy)/u.test(action))).toEqual([]);
  });

  it("gives no role an allow that writes IAM, assumes outside this account, or names another account or region", () => {
    for (const key of RELEASE_ROLE_KEYS) {
      for (const statement of policyStatementsOf(key).filter((candidate) => candidate.Effect === "Allow")) {
        for (const action of statement.actions) {
          expect(action, `${key} ${statement.Sid ?? ""}`).not.toMatch(/^iam:(Create|Delete|Put|Attach|Detach|Update|Add|Remove|Set|Tag|Untag|Upload|Enable|Change|Reset)/u);
          expect(action).not.toBe("*");
          expect(action).not.toMatch(/^[a-z0-9-]+:\*$/u);
        }
        for (const resource of statement.resources) {
          expect(resource, `${key} ${statement.Sid ?? ""}`).not.toMatch(/:[a-z0-9-]+:(?!us-west-2:)[a-z]{2}-[a-z]+-[0-9]:/u);
          expect(resource).not.toMatch(/:iam::[0-9]{12}:/u);
        }
        if (statement.actions.includes("sts:AssumeRole")) {
          for (const resource of statement.resources) expect(resource).toMatch(/:iam::\$\{AWS::AccountId\}:role\/|^\$\{(source|pipeline)-?role[0-9A-F]+\.Arn\}$/iu);
        }
      }
    }
    // No trust of another account: every principal is a service, or the root of this account fenced by an exact principal ARN.
    for (const [, role] of roleResources) {
      for (const statement of (role.Properties.AssumeRolePolicyDocument as { Statement: Array<{ Principal: Record<string, unknown>; Condition?: Record<string, unknown> }> }).Statement) {
        const principal = statement.Principal;
        if ("Service" in principal) {
          expect(["codebuild.amazonaws.com", "codepipeline.amazonaws.com"]).toContain(principal.Service);
          expect(JSON.stringify(statement.Condition)).toContain("aws:SourceArn");
        } else {
          expect(flat(principal.AWS)).toBe("arn:${AWS::Partition}:iam::${AWS::AccountId}:root");
          expect(JSON.stringify(statement.Condition)).toContain("aws:PrincipalArn");
        }
      }
    }
  });

  it("never lets the pipeline change the access stack or itself, however a role was granted the right", () => {
    const deny = boundaryStatement("DenyAccessAndPipelineStackWrites");
    expect(deny.Effect).toBe("Deny");
    expect(deny.actions).toEqual(expect.arrayContaining(["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:ExecuteChangeSet", "cloudformation:UpdateTerminationProtection"]));
    expect(deny.resources.sort()).toEqual([
      `arn:\${AWS::Partition}:cloudformation:${REGION}:\${AWS::AccountId}:stack/agentx-staging-access/*`,
      `arn:\${AWS::Partition}:cloudformation:${REGION}:\${AWS::AccountId}:stack/${names.stack}/*`,
    ].sort());
    // And no role is allowed to execute a change set on the access stack in the first place.
    for (const key of RELEASE_ROLE_KEYS) {
      for (const statement of policyStatementsOf(key).filter((candidate) => candidate.Effect === "Allow" && candidate.actions.some((action) => /ExecuteChangeSet|CreateStack|UpdateStack/u.test(action)))) {
        expect(statement.resources.filter((resource) => /agentx-staging-access|release-pipeline/u.test(resource)), key).toEqual([]);
      }
    }
  });

  it("reserves the pin, the holds, both pointers and the secrets to their named roles in the boundary", () => {
    expect(exemptedRoles("DenyPinWritesExceptApprover")).toEqual(["approver"]);
    expect(boundaryStatement("DenyPinWritesExceptApprover").actions).toEqual(expect.arrayContaining(["ssm:PutParameter", "ssm:DeleteParameter"]));
    expect(boundaryStatement("DenyPinWritesExceptApprover").resources).toEqual([`arn:\${AWS::Partition}:ssm:${REGION}:\${AWS::AccountId}:parameter/rovara-release/staging/policy-pin`]);
    expect(exemptedRoles("DenyHoldDeletesExceptApprover")).toEqual(["approver"]);
    expect(exemptedRoles("DenyInstalledPointerExceptPostcheck")).toEqual(["postcheck"]);
    expect(exemptedRoles("DenyLastGoodPointerExceptCanary")).toEqual(["canary"]);
    expect(exemptedRoles("DenyCanarySecretExceptCanary")).toEqual(["canary"]);
    expect(exemptedRoles("DenySigningKeyExceptDeploy")).toEqual(["deploy"]);
    expect(boundaryStatement("DenySecretReadsExceptNamed").notResources).toHaveLength(2);
    const pinWriters = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.resources.some((resource) => resource.endsWith("/policy-pin")) && statement.actions.some((action) => /ssm:(Put|Delete)/u.test(action))));
    expect(pinWriters).toEqual(["approver"]);
    const holdDeleters = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.includes("ssm:DeleteParameter")));
    // The deploy role deletes exactly the environment deploy lock (checked in the lock test below); only the approver deletes holds.
    expect(holdDeleters.sort()).toEqual(["approver", "deploy"]);
    const secretReaders = Object.fromEntries(RELEASE_ROLE_KEYS.flatMap((key) => {
      const reads = policyStatementsOf(key).filter((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /^secretsmanager:/u.test(action)));
      return reads.length === 0 ? [] : [[key, reads.flatMap((statement) => statement.resources)]];
    }));
    expect(Object.keys(secretReaders).sort()).toEqual(["canary", "deploy"]);
    expect(secretReaders.canary).toEqual([expect.stringMatching(/:secret:rovara-release\/staging\/canary-credential-\?{6}$/u)]);
    expect(secretReaders.deploy).toEqual([expect.stringMatching(/:secret:agentx\/staging\/callback-signing-key-\?{6}$/u)]);
  });

  it("limits the Deploy role to EXECUTING the pipeline's own change sets on the environment's stacks: no create, no assume, no PassRole, no asset write, never the access stack (F1, F4)", () => {
    const statements = policyStatementsOf("deploy").filter((statement) => statement.Effect === "Allow");
    const actions = statements.flatMap((statement) => statement.actions);
    expect(actions.filter((action) => /^sts:Assume|CreateChangeSet|CreateStack|UpdateStack|iam:PassRole/u.test(action))).toEqual([]);
    expect(statements.filter((statement) => statement.actions.includes("ssm:PutParameter")).map((statement) => statement.Sid)).toEqual(["TakeAndReleaseDeployLock", "WriteSettingsRecord", "SetHold"]);
    expect(statements.filter((statement) => statement.actions.includes("ssm:DeleteParameter")).map((statement) => statement.Sid)).toEqual(["TakeAndReleaseDeployLock"]);
    const execute = statements.find((statement) => statement.actions.includes("cloudformation:ExecuteChangeSet"))!;
    expect(execute.actions).toEqual(["cloudformation:ExecuteChangeSet"]);
    expect(execute.resources).toHaveLength(5);
    expect(execute.resources.join(" ")).not.toContain("agentx-staging-access");
    expect(execute.Condition).toEqual({ StringLike: { "cloudformation:ChangeSetName": "rovara-pipeline-*" } });
    const tidy = statements.find((statement) => statement.Sid === "TidyChangeSets")!;
    expect(tidy.actions).toEqual(["cloudformation:DescribeChangeSet", "cloudformation:ListChangeSets", "cloudformation:DeleteChangeSet"]);
    expect(tidy.Condition).toEqual({ StringLike: { "cloudformation:ChangeSetName": "rovara-pipeline-*" } });
        expect(statements.filter((statement) => statement.actions.includes("s3:PutObject")).flatMap((statement) => statement.resources)).toEqual([expect.stringMatching(/\/release\/\*$/u)]);
    expect(statements.flatMap((statement) => statement.actions).filter((action) => /secretsmanager/u.test(action))).toEqual(["secretsmanager:GetSecretValue"]);
    // Plain AWS CLI from the pinned pack: no node, npm or the CLI from the release package.
    expect(buildSpecOf("deploy")).not.toMatch(/\b(node|npm|npx|tsx|agentx)\b/u);
  });

  it("assumes no role in any CodeBuild role: the only assumes are CodePipeline's, of the source role and itself (F1)", () => {
    for (const key of RELEASE_ROLE_KEYS.filter((candidate) => candidate !== "pipeline")) {
      expect(policyStatementsOf(key).flatMap((statement) => statement.actions).filter((action) => /^sts:Assume/u.test(action)), key).toEqual([]);
    }
  });

  it("denies every SNS action except on the two alert topics, and every image delete", () => {
    expect(boundaryStatement("DenySnsExceptAlertTopics").notResources).toHaveLength(2);
    expect(boundaryStatement("DenyImageDeletes").actions).toEqual(expect.arrayContaining(["ecr:BatchDeleteImage", "ecr:DeleteRepository"]));
  });

  it("names every role and project with the rovara- prefix, which the broker's agentx-* CodeBuild allow-list does not match", () => {
    for (const [, role] of roleResources) expect(String(role.Properties.RoleName)).toMatch(/^rovara-/u);
    for (const resource of projectResources) expect(String(resource.Properties.Name)).toMatch(/^rovara-/u);
    expect(projectOf("deploy").ConcurrentBuildLimit).toBe(1);
  });
});

describe("environment release pipeline: P0 facts folded in", () => {
  it("runs the rollback safety checks as Release's first action, and keeps Release the only stage that rolls back (fact 1)", () => {
    const release = pipeline.Stages.find((stage) => stage.Name === "Release")!;
    expect(release.Actions[0]!.Name).toBe(GUARD_ACTION);
    expect(release.Actions.map((action) => action.RunOrder)).toEqual([1, 2, 3, 4]);
    expect(pipeline.ExecutionMode).not.toBe("PARALLEL");
    // The guard fails closed when its pack script is missing, can set a hold, and deploys nothing.
    expect(buildSpecOf("guard")).toContain("is missing: the stage fails closed");
    const guard = policyStatementsOf("guard").filter((statement) => statement.Effect === "Allow");
    expect(guard.flatMap((statement) => statement.actions).filter((action) => /cloudformation:(Create|Execute|Update|Delete)|ecr:Put|secretsmanager/u.test(action))).toEqual([]);
    expect(guard.some((statement) => statement.Sid === "SetHold")).toBe(true);
  });

  it("gives an explicit rollback to one role only, with RollbackStage on the Release stage alone, and the last-good execution pointer to the canary only", () => {
    const rollbackers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.includes("codepipeline:RollbackStage")));
    expect(rollbackers).toEqual(["rollback"]);
    expect(policyStatementsOf("rollback").find((statement) => statement.actions.includes("codepipeline:RollbackStage"))?.resources).toEqual([`arn:\${AWS::Partition}:codepipeline:${REGION}:\${AWS::AccountId}:${names.pipeline}/Release`]);
    expect(exemptedRoles("DenyRollbackStageExceptRollback")).toEqual(["rollback"]);
    expect(boundaryStatement("DenyLastGoodPointerExceptCanary").resources.some((resource) => resource.endsWith("/*-last-good-execution"))).toBe(true);
    expect(policyStatementsOf("canary").find((statement) => statement.Sid === "WriteLastGoodPointers")?.resources).toHaveLength(2);
  });

  it("keeps artifacts 90 days, and makes the version a pipeline counter that only Check advances, tagged locally by Build (facts 2 and 4)", () => {
    const buckets = Object.values(json.Resources).filter((resource) => resource.Type === "AWS::S3::Bucket");
    const artifacts = buckets.find((bucket) => JSON.stringify(bucket.Properties.LifecycleConfiguration).includes('"ExpirationInDays":90'));
    expect(artifacts).toBeDefined();
    expect(exemptedRoles("DenyVersionCounterExceptCheck")).toEqual(["check"]);
    const advancers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.includes("ssm:PutParameter") && statement.resources.some((resource) => resource.endsWith("code-release-version"))));
    expect(advancers).toEqual(["check"]);
    expect(buildSpecOf("check")).toContain("code-release-version");
    const build = buildSpecOf("build");
    expect(build).toContain('git tag -f');
    expect(build).not.toContain("require('./package.json').version");
    expect(build).toContain("git bundle create out/source.bundle");
  });

  it("scopes the one signing-key read to the Deploy role and exactly that secret (fact 3)", () => {
    const readers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.resources.some((resource) => resource.includes("callback-signing-key"))));
    expect(readers).toEqual(["deploy"]);
  });

  it("has Preview use Build's one release package and record its hash, and Guard and Deploy refuse a package that differs; no other stage reads it (fact 5, F3)", () => {
    for (const key of ["preview", "guard", "deploy"] as const) expect(buildSpecOf(key), key).toContain("build/${EXEC_ID}/release/");
    expect(buildSpecOf("preview")).toContain("SYNTH_DIR");
    expect(buildSpecOf("preview")).toContain("release.sha256");
    for (const key of ["guard", "deploy"] as const) {
      expect(buildSpecOf(key), key).toContain("the release package differs from the one Preview recorded");
      expect(buildSpecOf(key), key).not.toContain("SYNTH_DIR");
    }
    for (const key of RELEASE_PROJECT_KEYS.filter((candidate) => !["preview", "guard", "deploy"].includes(candidate))) expect(buildSpecOf(key), key).not.toContain("build/${EXEC_ID}/release/");
    // The released commit and tag come as a bundle checked by sha (Preview), so no stage needs a GitHub connection to get them.
    expect(buildSpecOf("preview")).toContain("the source bundle is not the released commit");
    expect(policyStatementsOf("preview").flatMap((statement) => statement.actions).filter((action) => /connection/iu.test(action))).toEqual([]);
  });

  it("lets only Decide write the CI evidence cache, in the boundary and in the roles (fact 6)", () => {
    expect(exemptedRoles("DenyCiCacheWritesExceptDecide")).toEqual(["decide"]);
    const writers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.includes("s3:PutObject") && statement.resources.some((resource) => resource.includes(`/${CI_CACHE_PREFIX}`))));
    expect(writers).toEqual(["decide"]);
  });

  it("takes the connection as a parameter pinned to this region (fact 7: the owner's handshake makes the connection, its ARN is not in the template)", () => {
    expect(JSON.stringify(json)).not.toMatch(/:connection\/[0-9a-f-]{36}/u);
    template.hasParameter("GitHubConnectionArn", { Type: "String" });
  });
});

describe("environment release pipeline: the Opus review (F1 to F4)", () => {
  it("F2: pins EVERY file of the gate pack, and every stage that runs pack scripts (Build included) checks the pin first", () => {
    expect(POLICY_HASH_COMMAND).toContain("find . -type f");
    expect(POLICY_HASH_COMMAND).not.toMatch(/evaluator|manual-paths|order\.txt/u);
    for (const key of ["preview", "gates", "guard", "deploy", "postcheck", "build"] as const) {
      const spec = buildSpecOf(key);
      expect(spec, key).toContain("does not match the policy pin");
      expect(spec.indexOf("does not match the policy pin"), key).toBeLessThan(spec.indexOf(key === "build" ? "npm ci" : "bash \\\"$PACK/"));
    }
    const build = policyStatementsOf("build").find((statement) => statement.Sid === "ReadPolicyPin");
    expect(build?.actions).toEqual(["ssm:GetParameter"]);
  });

  it("F3: lays the runs out as <stage>/<execution>/ so no role's write resource has a leading wildcard", () => {
    const resources = RELEASE_ROLE_KEYS.flatMap((key) => policyStatementsOf(key).filter((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /^s3:Put/u.test(action))).flatMap((statement) => statement.resources));
    for (const resource of resources.filter((candidate) => candidate.includes("${Runs"))) expect(resource).toMatch(/^\$\{Runs[A-Za-z0-9]+\.Arn\}\/[a-z0-9-]+\/\*$/u);
    expect(JSON.stringify(json)).not.toContain("/runs/");
    expect(buildSpecOf("build")).toContain("s3://${RUNS_BUCKET}/build/${EXEC_ID}/");
  });

  it("F4: only Preview writes the assets and templates before Decide, and the boundary reserves both buckets to it", () => {
    expect(exemptedRoles("DenyAssetAndTemplateWritesExceptPreview")).toEqual(["preview"]);
    const writers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && ["PublishAssets", "PublishTemplates"].includes(statement.Sid ?? "")));
    expect(writers).toEqual(["preview"]);
  });

  describe("F5: the pin hash refuses anything in the pack that is not a regular file or a directory (a symlink would run unhashed)", () => {
    const hashPack = (root: string) => {
      const run = spawnSync("bash", ["-c", `set -u; ${POLICY_HASH_COMMAND}`], { env: { ...process.env, OPS: root }, encoding: "utf8" });
      return { status: run.status, out: run.stdout.trim(), err: run.stderr };
    };
    const withPack = (setup: (pack: string, root: string) => void) => {
      const root = mkdtempSync(join(tmpdir(), "p1-pack-"));
      try {
        const pack = join(root, "ops", "staging-release");
        mkdirSync(join(pack, "evaluator"), { recursive: true });
        writeFileSync(join(pack, "deploy.sh"), "echo deploy\n");
        writeFileSync(join(pack, "evaluator", "decide.sh"), "echo decide\n");
        setup(pack, root);
        return hashPack(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const expectedHash = (files: Record<string, string>) => {
      const lines = Object.keys(files).sort().map((name) => `${createHash("sha256").update(files[name]!).digest("hex")}  ./${name}\n`).join("");
      return createHash("sha256").update(lines).digest("hex");
    };

    it("hashes a normal pack as the sorted manifest of its files, as before", () => {
      const result = withPack(() => undefined);
      expect(result.status).toBe(0);
      expect(result.out).toBe(expectedHash({ "deploy.sh": "echo deploy\n", "evaluator/decide.sh": "echo decide\n" }));
    });

    it("refuses a symlinked script, a symlinked directory and a FIFO with a clear error and no hash", () => {
      const symlinkedScript = withPack((pack, root) => {
        writeFileSync(join(root, "elsewhere.sh"), "echo EVIL\n");
        symlinkSync(join(root, "elsewhere.sh"), join(pack, "preview.sh"));
      });
      const symlinkedDirectory = withPack((pack, root) => {
        mkdirSync(join(root, "elsewhere"));
        symlinkSync(join(root, "elsewhere"), join(pack, "more"));
      });
      const fifo = withPack((pack) => {
        expect(spawnSync("mkfifo", [join(pack, "pipe")]).status).toBe(0);
      });
      for (const result of [symlinkedScript, symlinkedDirectory, fifo]) {
        expect(result.status).not.toBe(0);
        expect(result.out).toBe("");
        expect(result.err).toContain("not a regular file or a directory");
      }
    });

    it("lets a stage that cannot hash the pack fail closed, and Decide turn it into MANUAL", () => {
      expect(buildSpecOf("deploy")).toContain("refused");
      expect(buildSpecOf("decide")).toContain("|| HASH=refused");
    });
  });

  describe("F6: the exact buildspec command lines run in a real bash (a `$((` would be arithmetic, and every stage would fail)", () => {
    // Every bash this machine has: the Mac's 3.2 and a 5.x when one is installed (Homebrew), plus the one on PATH. The name of each one that ran is in the test title.
    const bashes = [...new Set(["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash"].filter((path) => existsSync(path)).map((path) => realpathSync(path)))];
    const versionOf = (bash: string): string => /version (\S+)/u.exec(spawnSync(bash, ["--version"], { encoding: "utf8" }).stdout)?.[1] ?? "unknown";
    const commandsOf = (key: ReleaseProjectKey): string[] => (JSON.parse(buildSpecOf(key)) as { phases: { build: { commands: string[] } } }).phases.build.commands;
    /** The stage's own command lines up to and including the first one that satisfies `last`. */
    const upTo = (key: ReleaseProjectKey, last: (line: string) => boolean): string[] => {
      const commands = commandsOf(key);
      const index = commands.findIndex(last);
      if (index < 0) throw new Error(`no matching command in ${key}`);
      return commands.slice(0, index + 1);
    };
    const manifest = (files: Record<string, string>): string => {
      const lines = Object.keys(files).sort().map((name) => `${createHash("sha256").update(files[name]!).digest("hex")}  ./${name}\n`).join("");
      return createHash("sha256").update(lines).digest("hex");
    };
    const PACK_FILES = { "deploy.sh": "echo deploy\n", "evaluator/decide.sh": "echo decide\n" };
    interface Run { status: number | null; out: string; err: string }
    function runLines(bash: string, lines: string[], setup: (root: string, pack: string) => void, env: Record<string, string>, tail: string): Run {
      const root = mkdtempSync(join(tmpdir(), "p1-bash-"));
      try {
        const pack = join(root, "ops", "staging-release");
        mkdirSync(join(pack, "evaluator"), { recursive: true });
        for (const [name, text] of Object.entries(PACK_FILES)) writeFileSync(join(pack, name), text);
        mkdirSync(join(root, "bin"));
        // The stages only ask AWS for the policy pin here: a stand-in answers it.
        writeFileSync(join(root, "bin", "aws"), '#!/bin/sh\nif [ "$1 $2" = "ssm get-parameter" ]; then echo "$FAKE_PIN"; else echo "unexpected aws call: $*" >&2; exit 9; fi\n');
        chmodSync(join(root, "bin", "aws"), 0o755);
        setup(root, pack);
        const script = [...lines, tail].join("\n");
        const run = spawnSync(bash, ["-c", script], {
          cwd: root,
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, CODEBUILD_SRC_DIR: root, PARAM_PREFIX: "/p", PIPELINE_NAME: "x", EXEC_ID: "e", RELEASE_SHA: "s", ...env },
          encoding: "utf8",
        });
        return { status: run.status, out: run.stdout.trim(), err: run.stderr };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const symlinkIn = (root: string, pack: string): void => {
      writeFileSync(join(root, "elsewhere.sh"), "echo EVIL\n");
      symlinkSync(join(root, "elsewhere.sh"), join(pack, "preview.sh"));
    };

    it("has no arithmetic expansion in any command of any stage (no `$((`, no `$(` glued to a `(`)", () => {
      for (const key of RELEASE_PROJECT_KEYS) expect(buildSpecOf(key), key).not.toContain("$((");
    });

    for (const bash of bashes) {
      const label = `bash ${versionOf(bash)} at ${bash}`;
      it(`computes the pack hash in the Deploy stage's own lines, compares it with the pin, and still refuses a symlink (${label})`, () => {
        const lines = upTo("deploy", (line) => line.startsWith('if [ "${PIN}" != "MANUAL-ONLY"'));
        const pinned = runLines(bash, lines, () => undefined, { FAKE_PIN: manifest(PACK_FILES) }, 'echo "HASH=${HASH}"');
        expect(pinned.err).toBe("");
        expect(pinned.status).toBe(0);
        expect(pinned.out).toBe(`HASH=${manifest(PACK_FILES)}`);
        const wrongPin = runLines(bash, lines, () => undefined, { FAKE_PIN: "0".repeat(64) }, 'echo "HASH=${HASH}"');
        expect(wrongPin.status).not.toBe(0);
        expect(wrongPin.out).toContain("does not match the policy pin");
        // A symlink in the pack is refused even while the pin is MANUAL-ONLY.
        for (const pin of [manifest(PACK_FILES), "MANUAL-ONLY"]) {
          const linked = runLines(bash, lines, symlinkIn, { FAKE_PIN: pin }, 'echo "HASH=${HASH}"');
          expect(linked.status).not.toBe(0);
          expect(linked.err).toContain("not a regular file or a directory");
          expect(linked.out).not.toContain("HASH=");
        }
      });

      it(`computes the same hash in Build's and Decide's own lines, and Decide turns a symlink into MANUAL (${label})`, () => {
        const decide = upTo("decide", (line) => line.startsWith('HASH="$('));
        const ok = runLines(bash, decide, () => undefined, { FAKE_PIN: "x" }, 'echo "HASH=${HASH}"');
        expect(ok.status).toBe(0);
        expect(ok.out).toBe(`HASH=${manifest(PACK_FILES)}`);
        const linked = runLines(bash, decide, symlinkIn, { FAKE_PIN: "x" }, 'echo "HASH=${HASH}"');
        expect(linked.status).toBe(0);
        expect(linked.out).toBe("HASH=refused");
        const buildLines = (JSON.parse(buildSpecOf("build")) as { phases: { pre_build: { commands: string[] } } }).phases.pre_build.commands;
        const build = buildLines.slice(0, buildLines.findIndex((line) => line.startsWith('if [ "${PIN}" != "MANUAL-ONLY"')) + 1);
        const built = runLines(bash, build.map((line) => line.replace("CODEBUILD_SRC_DIR_Ops", "CODEBUILD_SRC_DIR")), () => undefined, { FAKE_PIN: manifest(PACK_FILES) }, 'echo "HASH=${HASH}"');
        expect(built.err).toBe("");
        expect(built.out).toBe(`HASH=${manifest(PACK_FILES)}`);
      });

      it(`computes the release package hash in the stage's own line (${label})`, () => {
        const line = commandsOf("deploy").find((command) => command.startsWith("RELEASE_HASH="))!;
        const run = runLines(bash, ["set -eu"], (root) => {
          mkdirSync(join(root, "work", "release", "sub"), { recursive: true });
          writeFileSync(join(root, "work", "release", "a.json"), "{}\n");
          writeFileSync(join(root, "work", "release", "sub", "b.json"), "[]\n");
        }, {}, `${line}\necho "RELEASE_HASH=\${RELEASE_HASH}"`);
        expect(run.err).toBe("");
        expect(run.out).toBe(`RELEASE_HASH=${manifest({ "a.json": "{}\n", "sub/b.json": "[]\n" })}`);
      });
    }
  });

  it("makes the guard refuse a rollback-type execution until the rollback rules exist (P9)", () => {
    expect(buildSpecOf("guard")).toContain("executionType");
    expect(buildSpecOf("guard")).toContain("the guard refuses");
  });

  it("denies every S3 call on a bucket of another account (the artifact bucket parameter takes any name)", () => {
    const deny = boundaryStatement("DenyS3OutsideAccount");
    expect(deny.actions).toEqual(["s3:*"]);
    expect(deny.Condition).toEqual({ Null: { "aws:ResourceAccount": "false" }, StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } } });
  });
});

describe("environment release pipeline: the gate pack's S3 paths vs the roles' grants (P3 review F2)", () => {
  interface StageAccess { read: string[]; list: string[]; write: string[] }
  const access = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/staging-release-s3-access.json", import.meta.url)), "utf8")) as { stages: Record<string, StageAccess> };
  const concrete = (key: string): string => key.replace(/<[a-z-]+>/gu, "X1");
  const globToRegExp = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^$()|[\]{}\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u");
  const folderOf = (key: string): string => key.split("/")[0]!;
  const BUCKET = /^\$\{Runs[A-Za-z0-9]+\.Arn\}/u;

  it("has a fixture for every stage role that reads or writes run records, and RUN_ACCESS agrees with it", () => {
    expect(Object.keys(access.stages).sort()).toEqual(Object.keys(RUN_ACCESS).sort());
    for (const [role, paths] of Object.entries(access.stages)) {
      const mine = RUN_ACCESS[role as keyof typeof RUN_ACCESS] as { read: readonly string[]; list: readonly string[]; write: readonly string[] };
      const folders = (keys: string[]): string[] => [...new Set(keys.map(folderOf))].sort();
      expect([...mine.read].sort(), `${role} read`).toEqual(folders(paths.read).filter((folder) => folder !== "ci-cache"));
      expect([...mine.list].sort(), `${role} list`).toEqual(folders(paths.list));
      expect(folders(paths.write).filter((folder) => folder !== "ci-cache"), `${role} write`).toEqual([...mine.write].sort());
    }
  });

  for (const [role, paths] of Object.entries(access.stages)) {
    it(`${role}: the grants cover every path its scripts read, list and write, and nothing broader`, () => {
      const allows = policyStatementsOf(role as ReleaseRoleKey).filter((statement) => statement.Effect === "Allow");
      const grants = (action: string) => allows.filter((statement) => statement.actions.includes(action));
      const inRuns = (resources: string[]): string[] => resources.filter((resource) => BUCKET.test(resource));
      // Object grants: `<stage>/*` only (no leading wildcard), one per stage the scripts touch.
      for (const [action, keys] of [["s3:GetObject", paths.read], ["s3:PutObject", paths.write]] as const) {
        const patterns = inRuns(grants(action).flatMap((statement) => statement.resources)).map((resource) => resource.replace(BUCKET, "").replace(/^\//u, ""));
        for (const pattern of patterns) expect(pattern, `${role} ${action}`).toMatch(/^[a-z0-9-]+\/\*$/u);
        for (const key of keys) expect(patterns.some((pattern) => globToRegExp(pattern).test(concrete(key))), `${role} ${action} ${key}`).toBe(true);
        expect([...new Set(patterns.map(folderOf))].sort(), `${role} ${action} is broader than the scripts`).toEqual([...new Set(keys.map(folderOf))].sort());
      }
      // Listing (a recursive copy lists the prefix): the bucket itself, only under the stages the scripts download whole.
      const lists = grants("s3:ListBucket").filter((statement) => statement.resources.some((resource) => BUCKET.test(resource)));
      if (paths.list.length === 0) {
        expect(lists, `${role} has a ListBucket it does not use`).toEqual([]);
      } else {
        expect(lists).toHaveLength(1);
        expect(lists[0]!.resources.every((resource) => BUCKET.test(resource) && !resource.includes("/"))).toBe(true);
        const condition = (lists[0] as unknown as { Condition: { StringLike: { "s3:prefix": string[] } } }).Condition.StringLike["s3:prefix"];
        for (const prefix of paths.list) expect(condition.some((pattern) => globToRegExp(pattern).test(concrete(prefix))), `${role} list ${prefix}`).toBe(true);
        for (const pattern of condition) expect(pattern).toMatch(/^[a-z0-9-]+\/\*$/u);
        expect([...new Set(condition.map(folderOf))].sort(), `${role} lists more than the scripts`).toEqual([...new Set(paths.list.map(folderOf))].sort());
      }
    });
  }
});

describe("environment release pipeline: the lock, the settings record, Decide's execution read, the image repositories (P1 follow-up)", () => {
  it("(a) grants the deploy role exactly the lock (put, delete) and the settings record (put), and reserves both to it in the boundary", () => {
    const allows = policyStatementsOf("deploy").filter((statement) => statement.Effect === "Allow");
    const lock = allows.find((statement) => statement.Sid === "TakeAndReleaseDeployLock")!;
    expect(lock.actions).toEqual(["ssm:PutParameter", "ssm:DeleteParameter"]);
    expect(lock.resources).toEqual([`arn:\${AWS::Partition}:ssm:${REGION}:\${AWS::AccountId}:parameter/agentx/staging/lock`]);
    const settings = allows.find((statement) => statement.Sid === "WriteSettingsRecord")!;
    expect(settings.actions).toEqual(["ssm:PutParameter"]);
    expect(settings.resources).toEqual([`arn:\${AWS::Partition}:ssm:${REGION}:\${AWS::AccountId}:parameter/agentx/staging/settings`]);
    const writers = RELEASE_ROLE_KEYS.filter((key) => policyStatementsOf(key).some((statement) => statement.Effect === "Allow" && statement.actions.some((action) => /^ssm:(Put|Delete)/u.test(action)) && statement.resources.some((resource) => /parameter\/agentx\/staging\/(lock|settings)$/u.test(resource))));
    expect(writers).toEqual(["deploy"]);
    expect(exemptedRoles("DenySettingsAndLockWritesExceptDeploy")).toEqual(["deploy"]);
    expect(boundaryStatement("DenySettingsAndLockWritesExceptDeploy").resources).toHaveLength(2);
  });

  describe("(a) the Deploy stage's own lines, run in a real bash with stand-ins for aws and the pack scripts", () => {
    const deployCommands = (JSON.parse(buildSpecOf("deploy")) as { phases: { build: { commands: string[] } } }).phases.build.commands;
    const start = deployCommands.findIndex((line) => line.includes("settings-record.sh is missing"));
    const end = deployCommands.findIndex((line) => line.startsWith('test -z "${LOCK_PROBLEM}"'));
    const lines = deployCommands.slice(start, end + 1);
    interface Outcome { status: number | null; calls: string[]; out: string }
    function run(options: { lockHeld?: boolean; deployFails?: boolean; omitSettingsScript?: boolean; takeover?: "other-holder" | "gone" }): Outcome {
      const root = mkdtempSync(join(tmpdir(), "p1-lock-"));
      try {
        const pack = join(root, "ops", "staging-release");
        mkdirSync(pack, { recursive: true });
        mkdirSync(join(root, "bin"));
        mkdirSync(join(root, "work"));
        mkdirSync(join(root, "out"));
        const log = join(root, "calls.log");
        const takeover = options.takeover === "other-holder" ? `printf '%s' '{"holder":"someone-else","command":"deploy upgrade","acquiredAt":"2026-11-23T00:00:00.000Z"}' > "${join(root, "lockstore")}"\n` : options.takeover === "gone" ? `rm -f "${join(root, "lockstore")}"\n` : "";
        writeFileSync(join(pack, "deploy.sh"), `echo "deploy" >> "${log}"\n${takeover}${options.deployFails === true ? "exit 3" : "exit 0"}\n`);
        if (options.omitSettingsScript !== true) writeFileSync(join(pack, "settings-record.sh"), `echo "settings version=$RELEASE_VERSION parameter=$SETTINGS_PARAMETER" >> "${log}"\n`);
        writeFileSync(join(root, "bin", "aws"), [
          "#!/bin/sh",
          `echo "aws $*" >> "${log}"`,
          'case "$1 $2" in',
          '  "s3 cp") printf "9.9.9" > "work/version.txt";;',
          '  "sts get-caller-identity") echo "arn:aws:sts::1:assumed-role/deploy/s";;',
          // The lock store: put keeps the --value, get returns it (or fails when it is gone), delete removes it.
          `  "ssm put-parameter") ${options.lockHeld === true ? 'echo "ParameterAlreadyExists" >&2; exit 254' : 'while [ $# -gt 0 ]; do if [ "$1" = "--value" ]; then printf "%s" "$2" > lockstore; fi; shift; done'};;`,
          '  "ssm get-parameter") if [ -f lockstore ]; then cat lockstore; else echo ParameterNotFound >&2; exit 254; fi;;',
          '  "ssm delete-parameter") rm -f lockstore;;',
          "esac",
          "",
        ].join("\n"));
        chmodSync(join(root, "bin", "aws"), 0o755);
        const script = ["set -eu", `PACK="${pack}"`, ...(options.omitSettingsScript === true ? [] : []), ...lines].join("\n");
        const result = spawnSync("bash", ["-c", script], {
          cwd: root,
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, EXEC_ID: "e1", RUNS_BUCKET: "b", ENV_SETTINGS_PREFIX: "/agentx/staging" },
          encoding: "utf8",
        });
        const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
        return { status: result.status, calls, out: result.stdout + result.stderr };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const verbs = (calls: string[]): string[] => calls.map((call) => (call.startsWith("aws ssm put-parameter") ? "lock" : call.startsWith("aws ssm delete-parameter") ? "unlock" : call.startsWith("aws") ? "aws" : call.split(" ")[0]!)).filter((verb) => verb !== "aws");

    it("takes the lock, deploys, writes the settings record (the release version and the settings parameter), then releases the lock", () => {
      const outcome = run({});
      expect(outcome.status).toBe(0);
      expect(verbs(outcome.calls)).toEqual(["lock", "deploy", "settings", "unlock"]);
      expect(outcome.calls.find((call) => call.startsWith("settings"))).toBe("settings version=9.9.9 parameter=/agentx/staging/settings");
      expect(outcome.calls.find((call) => call.startsWith("aws ssm put-parameter"))).toContain("--name /agentx/staging/lock");
      expect(outcome.calls.find((call) => call.startsWith("aws ssm put-parameter"))).not.toContain("--overwrite");
      expect(outcome.calls.find((call) => call.startsWith("aws ssm delete-parameter"))).toContain("--name /agentx/staging/lock");
    });

    it("writes no settings record when the deploy failed, still releases the lock, and fails the stage", () => {
      const outcome = run({ deployFails: true });
      expect(outcome.status).toBe(3);
      expect(verbs(outcome.calls)).toEqual(["lock", "deploy", "unlock"]);
    });

    it("deploys nothing while the lock is held (the Mac flow, or another run), and never takes it over", () => {
      const outcome = run({ lockHeld: true });
      expect(outcome.status).not.toBe(0);
      expect(outcome.out).toContain("deploy lock");
      expect(verbs(outcome.calls)).toEqual(["lock"]);
    });

    it("deletes the lock only when it is still ours: a lock someone else holds is NOT deleted and the stage fails loudly, even though the deploy succeeded", () => {
      const outcome = run({ takeover: "other-holder" });
      expect(outcome.status).not.toBe(0);
      expect(outcome.out).toContain("no longer ours");
      expect(verbs(outcome.calls)).toEqual(["lock", "deploy", "settings"]);
      expect(outcome.calls.some((call) => call.startsWith("aws ssm delete-parameter"))).toBe(false);
    });

    it("does not delete a lock that has vanished either, and fails the stage loudly", () => {
      const outcome = run({ takeover: "gone" });
      expect(outcome.status).not.toBe(0);
      expect(outcome.out).toContain("no longer ours");
      expect(outcome.calls.some((call) => call.startsWith("aws ssm delete-parameter"))).toBe(false);
    });

    it("keeps the deploy's own failure code when the lock is also not ours", () => {
      const outcome = run({ deployFails: true, takeover: "other-holder" });
      expect(outcome.status).toBe(3);
      expect(outcome.calls.some((call) => call.startsWith("aws ssm delete-parameter"))).toBe(false);
    });

    it("fails closed BEFORE the lock when the pack has no settings-record script", () => {
      const outcome = run({ omitSettingsScript: true });
      expect(outcome.status).not.toBe(0);
      expect(outcome.out).toContain("settings-record.sh is missing");
      expect(verbs(outcome.calls)).toEqual([]);
    });
  });

  it("(b) gives Decide GetPipelineExecution on its own pipeline only", () => {
    const grants = policyStatementsOf("decide").filter((statement) => statement.Effect === "Allow" && statement.actions.includes("codepipeline:GetPipelineExecution"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.actions).toEqual(["codepipeline:GetPipelineExecution"]);
    expect(grants[0]!.resources).toEqual([`arn:\${AWS::Partition}:codepipeline:${REGION}:\${AWS::AccountId}:${names.pipeline}`]);
  });

  it("(c) lets Build push to exactly the environment's own worker and slack repositories", () => {
    const push = policyStatementsOf("build").find((statement) => statement.Sid === "PushOwnImages")!;
    expect(push.resources).toEqual([
      `arn:\${AWS::Partition}:ecr:${REGION}:\${AWS::AccountId}:repository/agentx-staging/worker`,
      `arn:\${AWS::Partition}:ecr:${REGION}:\${AWS::AccountId}:repository/agentx-staging/slack`,
    ]);
  });
});

describe("environment release pipeline: selection and the production pipeline", () => {
  const withoutPipelineContext = (): ReturnType<typeof buildAgentXApp> => buildAgentXApp();

  it("leaves the production release pipeline template byte-identical, and adds nothing to the default app", () => {
    const app = withoutPipelineContext();
    const stackIds = app.node.children.map((child) => child.node.id);
    expect(stackIds).toContain("AgentXReleasePipeline");
    const production = app.node.children.find((child) => child.node.id === "AgentXReleasePipeline") as ReleasePipelineStack;
    expect(production).toBeInstanceOf(ReleasePipelineStack);
    // The RAW template's sha256 (a normalized template rewrites every 64-hex string, so a changed pinned tool checksum would pass), recorded from d66d3c158 and equal on that lane's code; re-pinned by L1 below.
    const digest = createHash("sha256").update(JSON.stringify(Template.fromStack(production).toJSON())).digest("hex");
    expect(digest).toBe(PRODUCTION_PIPELINE_TEMPLATE_SHA256);
  });

  it("builds only the pipeline stack for -c agentxReleasePipeline=<environment>, and refuses a missing region or a different named environment", () => {
    const app = buildAgentXApp({ agentxReleasePipeline: "staging", agentxRegion: REGION });
    expect(app.node.children.map((child) => child.node.id).filter((id) => id !== "Tree")).toEqual(["AgentXReleasePipeline"]);
    const stack = app.node.children.find((child) => child.node.id === "AgentXReleasePipeline") as EnvironmentReleasePipelineStack;
    expect(stack).toBeInstanceOf(EnvironmentReleasePipelineStack);
    expect(stack.stackName).toBe(names.stack);
    expect(Template.fromStack(stack).toJSON().Resources).toBeDefined();
    expect(() => buildAgentXApp({ agentxReleasePipeline: "staging" })).toThrow(/explicit agentxRegion/u);
    expect(() => buildAgentXApp({ agentxReleasePipeline: "staging", agentxRegion: REGION, agentxEnv: "other" })).toThrow(/does not match agentxEnv/u);
  });
});

function regionPattern(): string {
  return `^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):${REGION}:[0-9]{12}:connection/[0-9a-f-]{36}$`;
}

/** Recorded from the production release pipeline's normalized template before this lane changed release-pipeline.ts (a refactor that moved the shared tool-install commands to exports). */
// L1 (2026-11-24): re-pinned for exactly the Cloud half of the one pipeline and the Code Preflight. Pin before: 01152c761e64805857a650b5473c6e80ceac9fd586f39e062df2a836f2dc72c0. Changed resources: ReleaseBuild and BetaReleaseBuild (the
// buildspecs: a CODE_RELEASE check and skip guard on every Code step; the production one no longer closes the gate), ReleaseBuildRoleDefaultPolicy (the ClosePromotionGate statement moved out),
// PipelineRoleDefaultPolicy (may assume the new action roles), Pipeline (second source, the Cloud actions and a Code Preflight in each stage, three V2 variables, a Cloud tag trigger).
// Added: BetaCodePreflight and ProductionCodePreflight (CodeBuild project, role and policy each), CloudSourceActionRole (role and policy), and one CDK action role and policy for each of the
// 14 new actions (12 Cloud, 2 Code Preflight). Added parameters: CloudRepoOwner, CloudRepoName, CloudRepoBranch, CloudConnectionArn, CloudBetaProjectName, CloudProductionProjectName,
// PortGuardNamesParameterName, PortGuardNamesKeyArn. Added output: ArtifactBucketName. Nothing removed.
// L1 follow-up after the Opus review (pin before it: c46ace5e600246bccd478643c6b609bcb183c3c52ed2cada4442849a29e10640). Changed again, and only these: ReleaseBuild and BetaReleaseBuild (the buildspecs: a last command that records the
// released Code commit), ReleaseBuildRoleDefaultPolicy and BetaReleaseBuildRoleDefaultPolicy (one RecordReleasedCode ssm:PutParameter statement each), BetaCodePreflight and
// ProductionCodePreflight (the buildspec: the released commit is the trust anchor and the guard scans the full range from it), their two role default policies (one ReadReleasedCode
// ssm:GetParameter statement each) and Pipeline (a fourth variable PIPELINE_MODE, and PIPELINE_MODE and ROVARA_EXPECTED_DEPLOY_ACCOUNT on the 12 Cloud actions). Nothing added or removed.
// L1 follow-up 2 (pin before it: f831f1b1c94d538eb995700155b821ba596ace36618e42ca69f289914fd2ecdc): BetaCodePreflight and ProductionCodePreflight (the buildspec: PIPELINE_MODE default, a pre_build note that refuses any value but release or adopt) and Pipeline
// (PIPELINE_MODE on the two CodePreflight actions). Nothing added or removed; no ROVARA_ADOPT_* anywhere.
// L1 follow-up 3 (pin before it: 5e6b0f2ca31c79736bae0a0f6595d926ce124d0608aeb5cc53285493b569aae0): BetaCodePreflight and ProductionCodePreflight only (the buildspec: the refusal of a linear landing says how many commits and what to do). Nothing else.
// L1 follow-up 4 (pin before it: e0570793a770024be7c9ae931556aeaff5fe8c8159e165a9120c1e8966f17b3f): ReleaseBuild and BetaReleaseBuild (the record is CODEBUILD_RESOLVED_SOURCE_VERSION, checked to be 40 hex, in one braced group), BetaCodePreflight and
// ProductionCodePreflight (the linear-landing message says only what happened; an octopus merge has its own check and message). Nothing else; no policy, parameter or Pipeline change.
// L9b (2026-11-24; pin before it, L1 final: 63e95810236c96b19bd43940c2ac70d57ea2b7c55a6bfe5f5c001c2777b7703d; the first L9b pin f6c558b4... was replaced after the review's 1000-character finding): a Code rollback through the pipeline.
// Changed, and only these (nothing added or removed; no parameter or output change): ReleaseBuild and BetaReleaseBuild (the buildspecs: the release history is written first in the same braced step as the record; the mode,
// target and history/ancestor checks; a rollback checks the target out before anything is installed and records it), ReleaseBuildRoleDefaultPolicy and BetaReleaseBuildRoleDefaultPolicy (one RecordCodeHistory
// ssm:GetParameter and ssm:PutParameter statement each, on that stage's history parameter), BetaCodePreflight and ProductionCodePreflight (the buildspec: the rollback checks and the second guard range, one exported
// CODE_CTX), their role default policies (a ReadCodeHistory ssm:GetParameter statement each; Beta's also ReadWaitingRun, codepipeline:GetPipelineState and GetPipelineExecution on this pipeline) and Pipeline (a fifth
// variable CODE_ROLLBACK_TARGET, a namespace on the two CodePreflight actions, PIPELINE_MODE and CODE_ROLLBACK_TARGET on the Code release actions, and CODE_CTX on the two Cloud Preflight actions only).
// PH-S3-PREFIXES (2026-11-25; pin before it, L9b: 291ca54736e9e0f05f06fcbed1c04e118baea14d90ab4e5867786548eb1cdc80): each Code release role writes only its own output artifact into the artifact bucket. Changed, and only these (nothing added or removed;
// no parameter, output or bucket change; shown by a resource-by-resource comparison of the synthesized templates before and after): ReleaseBuildRoleDefaultPolicy and BetaReleaseBuildRoleDefaultPolicy (CDK's whole-bucket read-write
// statement became a read statement on the bucket and one s3:PutObject on that role's own output prefix, plus one Deny of s3:PutObject*, s3:DeleteObject* and s3:AbortMultipartUpload on everything but that prefix) and Pipeline (the twelve Cloud state
// (the Allow is s3:PutObject and s3:AbortMultipartUpload on that prefix; first pin of this change 82b1f0fc1d625770784c47b04832a0a19fce66d901f751c362078d2d57236f82, before the abort was added; re-run against the rebased base 6336ff3b0, whose own template is the same 291ca547 pin)
// artifacts renamed from Beta<Action>State and Production<Action>State to State<Beta|Prod><Action>, in the actions' input and output artifacts and in PIPELINE_STATE_ARTIFACT).
// PIPELINE-NAMESPACE-FIX (2026-11-25; pin before it: 5d132f12052ae5d438250549e7edca670208048e96421b91b4688586219eb679): CodePipeline refused the Cloud source action's namespace "CloudSource" (equal to its output artifact name). Changed, and only this: Pipeline, the Namespace of
// the CloudGitHub action, "CloudSource" -> "CloudSourceVariables" (the artifact keeps its name; nothing reads a #{CloudSource.*} variable; the legacy-templates snapshot changes by that one line).
// L1-RELEASE-TAG-TRIGGER (2026-11-25; pin before it: a1a1b3c352ec39a5cdb923036fb981ad32e749c770beb6d00119dfa968fbbecd): a Cloud tag push started a run with CLOUD_PROD=on and CLOUD_REF=latest. Changed, and only this: Pipeline (the CLOUD_REF variable's default
// latest -> from-trigger and its description; the CLOUD_PROD variable's default on -> off and its description; one CLOUD_SOURCE_COMMIT variable, #{CloudSourceVariables.CommitId}, on the Beta Cloud Preflight action only).
// Nothing added or removed, no other resource; the legacy-templates snapshot changes by those same lines.
// PROD-APPROVAL-BOUND (2026-11-25; pin before it: 6afbab33423ee9f888a3b10ea01311b6a1c3a46599d6521b25551d844b84d325; DEC 254zzz506, every production deploy needs the owner's approval for THAT run): the Production stage holds a CodePipeline manual approval,
// ApproveProduction, right after the read-only Code Preflight (which closes the transition first, so a rejected or timed-out run leaves the gate closed). An interim pin of the first draft, which put the approval FIRST, was b1a94978e3dd134df0c83c269750cc8fd956e2a38775f854533e9a66021044db.
// Changed, and only these (a resource-by-resource comparison of the synthesized templates before and after; the legacy-templates snapshot changes by the same hunks, edited by hand, no -u):
//   1. Pipeline: the Production stage gains the ApproveProduction action as its SECOND action (Approval/AWS/Manual, run order 2, a 1440-minute timeout, CustomData naming the execution, the Code commit, the Cloud source commit and the five run variables,
//      its own action role); the Code Preflight keeps run order 1 and the seven Production actions after the approval move one run order later (2-8 became 3-9); the disabled transition's Reason text changed (it names both steps).
//   2. PipelineProductionApproveProductionCodePipelineActionRole02F1F3F2: a NEW IAM role, assumable only by the pipeline role, with no policy of any kind (like every other action role of the pipeline).
//   3. PipelineRoleDefaultPolicy: one more sts:AssumeRole statement, on that new role.
//   4. ProductionCodePreflight (the CodeBuild project): its first install command (the disable-stage-transition call) passes the new Reason text.
//   5. ProductionCodePreflightRoleDefaultPolicy (added by the read-only-clone follow-up, pin before it: 2d8fa90cc5c8619e1cd99bb46eef16d0960ce240b03e389b0aa09acaee23aa0b): two Deny statements, ReadOnlyConnectionUse and ReadOnlyConnectionUseLegacy, on UseConnection of the GitHub connection
//      when codeconnections: / codestar-connections:ProviderPermissionsRequired is read_write (StringEquals, so a request without the key is not denied), so the step that runs before the owner's approval can clone but not push (11 -> 13 statements; nothing else moved).
//      Interim pin of the first draft of this hunk (StringNotEquals read_only): 84adb7fbf8b04fd6b8d84124c09eb547e7b0cdd73c875ab69affce9f65b461a9.
// No parameter, output, bucket, trigger, variable, other role or other policy moved; no role was given any codepipeline permission (release-pipeline-prod-approval.test.ts pins that).
// RELEASE-STACKS-ADDRESS (2026-11-25; pin before it: 7e66d04fc164d8a3edc90962636c21a8d514ec15369e0275dc04fa8283a30d46): the release roles may read the address stack. Changed, and only these (nothing added or removed; shown by a resource-by-resource comparison of the synthesized templates before and after):
// ReleaseBuildRoleDefaultPolicy and BetaReleaseBuildRoleDefaultPolicy, whose ReadReleaseStacks cloudformation:DescribeStacks statement gains one resource, stack/AgentXApiAddress/* (AGENTX_RELEASE_STACKS gained "AgentXApiAddress"). The legacy-templates snapshot changes by those two resources.
// PIPELINE-CODE-RELEASE-BY-TRIGGER (2026-11-25; pin before it: ddd23afa7a00a60f4559a3fd980009d3b476e0a5cead70d1e3e0307faa5f927b): CODE_RELEASE's default becomes from-trigger (decided from which source started the run). Changed, and only these (the legacy-templates snapshot changes by the same four hunks, applied by script from the failing test's own diff, no -u):
//   1. Pipeline: the CODE_RELEASE variable's default (run -> from-trigger) and description; the ApproveProduction CustomData text (what from-trigger means, and that Beta's Preflight log says whether Code was released).
//   2. BetaCodePreflight (the CodeBuild project): six commands before the CODE_CTX export (which source started the run) and a fifth trigger part in the Beta CODE_CTX value; Production's Code Preflight is unchanged.
//   3. BetaCodePreflightRoleDefaultPolicy: ReadWaitingRun gains codepipeline:ListActionExecutions (this pipeline only; read-only).
// No parameter, output, bucket, trigger, other variable, other role or other policy moved.
const PRODUCTION_PIPELINE_TEMPLATE_SHA256 = "f666faa65ac67edcd17eae5a4387458ea6c299e6bc67d426d08490cdea306e3f";
