// DEC 254zm: the install's own copies of the test-service starter images (infra/lib/test-service-mirror.ts), on the synthesised foundation template of a named environment.
// What must hold:
//   1. exactly five ECR repositories, one per starter image, named from the contracts (the same names the worker's boot stage and the copy script use); immutable tags, scan on push, AES256;
//      no lifecycle rule; outside the pull-through prefix; kept on a stack delete (RetainExceptOnCreate in a named environment);
//   2. the worker role reads exactly those five repositories with exactly three ECR read actions, in one statement; no push, delete, pull-through or create;
//   3. the deploy role and the default boundary allow everything CloudFormation does for these resources (checked against the policy documents; template diffs miss the boundary);
//   4. the legacy deployment gets none of it.
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements, environmentPullThroughPrefix, mirroredStarterEntries, OWNER_STARTER_IMAGES, serviceRoleStatements, testServiceMirrorRepositories, type PolicyStatementJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { TEST_SERVICE_MIRROR_READ_ACTIONS } from "../../infra/lib/test-service-mirror.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Template, type: string) => Object.entries(resourcesOf(template)).filter(([, r]) => r.Type === type);
const repositoryArn = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:repository/${name}`]] });

/** Whether an action matches an IAM action pattern (`ecr:*`, `ecr:Put*`). */
const matches = (pattern: string, action: string): boolean => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "iu").test(action);
/** A plain evaluation for one action on any resource: allowed by some Allow statement whose resource is `*`, and denied by no Deny statement that names it. */
function allows(statements: readonly PolicyStatementJson[], action: string): boolean {
  const named = (statement: PolicyStatementJson) => [statement.Action].flat().some((pattern) => matches(String(pattern), action));
  if (statements.some((statement) => statement.Effect === "Deny" && named(statement))) return false;
  return statements.some((statement) => statement.Effect === "Allow" && statement.Resource === "*" && named(statement));
}

describe("the test service starter copies (DEC 254zm)", () => {
  let foundation: Template;
  let legacy: Template[];

  beforeAll(() => {
    foundation = Template.fromStack(stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-foundation")!);
    legacy = stacksOf(buildAgentXApp()).map((stack) => Template.fromStack(stack));
  }, 240_000);

  it("names five repositories, one per starter, from the starter list's own digests", () => {
    const mirrors = testServiceMirrorRepositories("staging");
    expect(mirrors.map((mirror) => mirror.repositoryName)).toEqual([
      "agentx-staging--test-services/postgres-16/postgres", "agentx-staging--test-services/postgres-17/postgres", "agentx-staging--test-services/mysql-8/mysql",
      "agentx-staging--test-services/redis-7/redis", "agentx-staging--test-services/mongo-7/mongo",
    ]);
    expect(mirrors.map((mirror) => `sha256:${mirror.digest}`)).toEqual(OWNER_STARTER_IMAGES.map((image) => image.reference.slice(image.reference.indexOf("@") + 1)));
    expect(mirrors.map((mirror) => mirror.tag)).toEqual(OWNER_STARTER_IMAGES.map((image) => `${image.version}-${image.reference.slice(image.reference.indexOf("@sha256:") + 8, image.reference.indexOf("@sha256:") + 20)}`));
    // Outside the environment's ECR pull-through prefix (`agentx-<env>/`), which the worker role may import into and create repositories under.
    for (const mirror of mirrors) expect(mirror.repositoryName.startsWith(`${environmentPullThroughPrefix("staging")}/`)).toBe(false);
    // Nor any other environment's: the double hyphen is in no environment name, so `agentx-<other env>/` never matches.
    for (const mirror of mirrors) expect(mirror.repositoryName.split("/")[0]).toBe("agentx-staging--test-services");
    expect(() => environmentPullThroughPrefix("staging--test-services")).toThrow();
    expect(() => testServiceMirrorRepositories("Staging")).toThrow();
    expect(() => testServiceMirrorRepositories("")).toThrow();
  });

  it("creates exactly those five repositories: immutable tags, scan on push, AES256, no lifecycle, kept on delete", () => {
    // (L4-E8I: the GCP pack's three repositories are in the same stack and are checked in gcp-pack-infrastructure.test.ts; these are the starters'.)
    const repositories = ofType(foundation, "AWS::ECR::Repository").filter(([id]) => !id.includes("GcpPackRepository"));
    expect(repositories.map(([, resource]) => resource.Properties.RepositoryName)).toEqual(testServiceMirrorRepositories("staging").map((mirror) => mirror.repositoryName));
    for (const [, resource] of repositories) {
      expect(resource.Properties.ImageTagMutability).toBe("IMMUTABLE");
      expect(resource.Properties.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
      expect(resource.Properties.EncryptionConfiguration).toEqual({ EncryptionType: "AES256" });
      expect(resource.Properties).not.toHaveProperty("RepositoryPolicyText");
      expect(resource.DeletionPolicy).toBe("RetainExceptOnCreate");
      // No lifecycle: nothing may expire a pinned copy or the platform images of one.
      expect(resource.Properties).not.toHaveProperty("LifecyclePolicy");
    }
  });

  it("lets the worker role read exactly those five repositories, with exactly the three ECR read actions, in one statement, and nothing more", () => {
    const policies = ofType(foundation, "AWS::IAM::Policy").filter(([, resource]) => JSON.stringify(resource.Properties.Roles).includes("InstanceRole"));
    const statements = policies.flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const read = statements.filter((statement) => statement.Sid === "TestServiceImageRead");
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual({
      Sid: "TestServiceImageRead", Effect: "Allow", Action: [...TEST_SERVICE_MIRROR_READ_ACTIONS],
      Resource: testServiceMirrorRepositories("staging").map((mirror) => repositoryArn(mirror.repositoryName)),
    });
    expect([...TEST_SERVICE_MIRROR_READ_ACTIONS]).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
    // No other statement names a copy, and no write action touches the test-services repositories anywhere in the stack.
    const others = statements.filter((statement) => statement.Sid !== "TestServiceImageRead" && statement.Sid !== "GcpPackImageRead" && JSON.stringify(statement.Resource).includes("test-services"));
    expect(others).toEqual([]);
    // The worker's pull-through statement (import, create) names repositories under the prefix only, so it does not reach the copies.
    const pullThrough = statements.find((statement) => statement.Sid === "EcrPullThroughCache")!;
    expect(JSON.stringify(pullThrough.Resource)).toContain(`:repository/${environmentPullThroughPrefix("staging")}/*`);
    for (const mirror of testServiceMirrorRepositories("staging")) expect(mirror.repositoryName.startsWith(`${environmentPullThroughPrefix("staging")}/`)).toBe(false);
    // ECR's login token is the worker's existing statement (ECR requires *).
    expect(statements.find((statement) => statement.Sid === "EcrTokenAccess")).toMatchObject({ Action: "ecr:GetAuthorizationToken", Resource: "*" });
  });

  it("the deploy role and the default boundary allow what CloudFormation does for these repositories and the worker's new statement (checked on the policy documents: a template diff misses the boundary)", () => {
    const scope = { env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", artifactBucketArn: "arn:aws:s3:::bucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };
    const deploy = serviceRoleStatements(scope);
    const boundary = defaultBoundaryStatements(scope);
    const cloudFormationActions = ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories", "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:PutEncryptionConfiguration", "ecr:TagResource", "ecr:UntagResource", "ecr:ListTagsForResource"];
    // The deploy role is itself bounded by the effective boundary (the access stack's aspect), so both documents must allow every action.
    for (const action of cloudFormationActions) {
      expect(allows(deploy, action), `deploy role: ${action}`).toBe(true);
      expect(allows(boundary, action), `boundary: ${action}`).toBe(true);
    }
    // iam:PutRolePolicy for the worker role's policy is the deploy role's existing, path-scoped IamRoles statement.
    expect(deploy.find((statement) => statement.Sid === "IamRoles")?.Action).toContain("iam:PutRolePolicy");
    for (const action of [...TEST_SERVICE_MIRROR_READ_ACTIONS, "ecr:GetAuthorizationToken"]) expect(allows(boundary, action), `boundary: ${action}`).toBe(true);
  });

  it("the worker's owner list names exactly these copies, by the starter digests", () => {
    const entries = mirroredStarterEntries("111122223333.dkr.ecr.us-west-2.amazonaws.com", "staging");
    expect(entries.map((entry) => entry.reference)).toEqual(testServiceMirrorRepositories("staging").map((mirror) => `111122223333.dkr.ecr.us-west-2.amazonaws.com/${mirror.repositoryName}@sha256:${mirror.digest}`));
  });

  it("the legacy deployment has no copies and no read statement", () => {
    for (const template of legacy) {
      expect(ofType(template, "AWS::ECR::Repository").filter(([, resource]) => String(resource.Properties.RepositoryName).includes("test-services"))).toEqual([]);
      expect(JSON.stringify(template.toJSON())).not.toContain("TestServiceImageRead");
    }
  });
});
