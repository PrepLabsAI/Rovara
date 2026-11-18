// L4-IAM (owner-approved 2026-11-17): the EC2 worker role's ECR image read is scoped to the repositories a worker boot pulls from, not to every repository in the account.
//
// What a named environment's worker pulls (one place for the PR body and for these tests):
//   boot.sh   pull_worker_image  -> AGENTX_WORKER_IMAGE   (also the SANDBOX image: AGENTX_SANDBOX_IMAGE=$AGENTX_WORKER_IMAGE; test-services stage reads a file out of it)
//   boot.sh   pull_executor_image -> EXECUTOR_IMAGE       (and the qualification script's pull of the same executor image)
//   boot.sh   pull_contained_image -> node@sha256:...     (Docker Hub, no ECR)
//   test-services-stage.sh docker pull $reference         -> the five starter copies (infra/lib/test-service-mirror.ts, its own TestServiceImageRead statement)
// Both ECR images come through the environment's pull-through cache prefix (`agentx-<env>/`), as does the staging build (`agentx-staging/worker`, `/executor`).
//
// Held here:
//   1. EcrImageAccess is exactly two read actions on exactly the environment's pull-through prefix; no bare `repository/*` anywhere on the role;
//   2. every image reference the boot paths pull is covered by an ARN the role reads, and a reference outside them (another environment, an unrelated repository) is not;
//   3. the set of `docker pull` sites in the boot scripts is pinned, so a new pull cannot appear without this file being revisited;
//   4. the legacy (production) template's statement is unchanged; the default boundary still allows the actions.
import { readFileSync, readdirSync } from "node:fs";
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements, environmentPullThroughPrefix, gcpPackWorkerEntries, mirroredStarterEntries, serviceRoleStatements, type PolicyStatementJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { privateImageUri } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const ofType = (template: Template, type: string) => Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, r]) => r.Type === type);
const READ_ACTIONS = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"];
const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const d = (c: string) => c.repeat(64);

/** The statements of every policy attached to the worker instance role. */
function workerStatements(template: Template): Statement[] {
  return ofType(template, "AWS::IAM::Policy")
    .filter(([, resource]) => JSON.stringify(resource.Properties.Roles).includes("InstanceRole"))
    .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
/** A CDK `Fn::Join` of literals and Partition/Region/AccountId refs, resolved to one ARN string. */
function resolveArn(value: unknown): string {
  if (typeof value === "string") return value;
  const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
  if (join === undefined) throw new Error(`unresolvable resource ${JSON.stringify(value)}`);
  return join[1].map((part) => {
    if (typeof part === "string") return part;
    const ref = (part as { Ref?: string }).Ref;
    if (ref === "AWS::Partition") return "aws";
    if (ref === "AWS::Region") return REGION;
    if (ref === "AWS::AccountId") return ACCOUNT;
    throw new Error(`unresolvable part ${JSON.stringify(part)}`);
  }).join(join[0]);
}
const globMatches = (pattern: string, value: string): boolean => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(value);

/** The repository ARN patterns the role may read images from: statements that grant BOTH read actions, with a concrete (non-"*") resource. */
function readableRepositories(statements: Statement[]): string[] {
  return statements
    .filter((statement) => statement.Effect === "Allow" && READ_ACTIONS.every((action) => asList(statement.Action).includes(action)))
    .flatMap((statement) => asList(statement.Resource).map(resolveArn));
}
/** The repository path inside an image reference: `<account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<digest>`. */
const arnOfReference = (reference: string): string => {
  const match = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+)@sha256:[0-9a-f]{64}$/u.exec(reference);
  if (match === null) throw new Error(`not an ECR image reference: ${reference}`);
  return `arn:aws:ecr:${match[2]}:${match[1]}:repository/${match[3]}`;
};
const covered = (arns: string[], reference: string): boolean => arns.some((pattern) => globMatches(pattern, arnOfReference(reference)));

function allows(statements: readonly PolicyStatementJson[], action: string): boolean {
  const named = (statement: PolicyStatementJson) => [statement.Action].flat().some((pattern) => globMatches(String(pattern).toLowerCase(), action.toLowerCase()));
  if (statements.some((statement) => statement.Effect === "Deny" && named(statement))) return false;
  return statements.some((statement) => statement.Effect === "Allow" && statement.Resource === "*" && named(statement));
}

describe("the worker role's ECR image read is scoped (L4-IAM)", () => {
  let staging: Statement[];
  let legacy: Statement[];

  beforeAll(() => {
    const foundation = Template.fromStack(stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-foundation")!);
    staging = workerStatements(foundation);
    legacy = stacksOf(buildAgentXApp()).flatMap((stack) => workerStatements(Template.fromStack(stack)));
  }, 240_000);

  it("EcrImageAccess is exactly two read actions on exactly the environment's pull-through prefix", () => {
    const statements = staging.filter((statement) => statement.Sid === "EcrImageAccess");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toEqual({
      Sid: "EcrImageAccess", Effect: "Allow", Action: READ_ACTIONS,
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:repository/${environmentPullThroughPrefix("staging")}/*`]] },
    });
  });

  it("no ECR statement on the role has a wildcard repository, and the token statement is the only ECR action on *", () => {
    const ecr = staging.filter((statement) => asList(statement.Action).some((action) => String(action).startsWith("ecr:")));
    expect(ecr.map((statement) => statement.Sid).sort()).toEqual(["EcrImageAccess", "EcrPullThroughCache", "EcrTokenAccess", "GcpPackImageRead", "TestServiceImageRead"]);
    for (const statement of ecr) {
      if (statement.Sid === "EcrTokenAccess") { expect(statement).toMatchObject({ Action: "ecr:GetAuthorizationToken", Resource: "*" }); continue; }
      for (const resource of asList(statement.Resource)) {
        const arn = resolveArn(resource);
        expect(arn, `${statement.Sid}: ${arn}`).toMatch(/:repository\/[a-z0-9]/u); // never `repository/*`, never `*`
        // the only wildcard allowed is the trailing `/*` of the environment's own prefix
        const star = arn.indexOf("*");
        if (star !== -1) expect(arn.slice(arn.indexOf("repository/") + "repository/".length)).toBe(`${environmentPullThroughPrefix("staging")}/*`);
      }
    }
  });

  it("every image the worker boot pulls is covered by an ARN the role reads: worker, sandbox, executor, the staging build, the five starter copies", () => {
    // EcrImageAccess and TestServiceImageRead alone must cover every image, so dropping the pull-through statement's read later cannot break a boot.
    const arns = readableRepositories(staging.filter((statement) => statement.Sid !== "EcrPullThroughCache"));
    const target = { account: ACCOUNT, region: REGION, prefix: environmentPullThroughPrefix("staging") };
    const worker = privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("a")}`, target);
    const executor = privateImageUri(`public.ecr.aws/agentx/agentx-executor@sha256:${d("b")}`, target);
    const references = [
      worker,
      worker, // the sandbox image is the worker image (boot.sh: AGENTX_SANDBOX_IMAGE=$AGENTX_WORKER_IMAGE)
      executor,
      `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agentx-staging/worker@sha256:${d("c")}`, // the staging build's own repositories (0517-build-images.sh)
      `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agentx-staging/executor@sha256:${d("d")}`,
      ...mirroredStarterEntries(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`, "staging").map((entry) => entry.reference),
      // L4-E8I: the GCP pack's three mirrored copies (GcpPackImageRead). Its pulled SDK image is Google's, not ECR's: no ARN.
      ...gcpPackWorkerEntries(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`, "staging", "mirrored:bigquery").map((entry) => entry.reference).filter((reference) => reference.includes(".dkr.ecr.")),
    ];
    expect(references).toHaveLength(13);
    for (const reference of references) expect(covered(arns, reference), reference).toBe(true);
  });

  it("references outside those repositories are not covered: another environment, a prefix lookalike, an unrelated repository, production's", () => {
    const arns = readableRepositories(staging);
    const at = (repository: string) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${repository}@sha256:${d("e")}`;
    for (const repository of ["agentx-other/worker", "agentx-staging-2/worker", "agentx-stagingworker", "agentx-staging", "agentx-embedder-staging", "agentx-worker-production", "agentx-dev-3/worker", "worker", "agentx-other--test-services/postgres-16/postgres"]) {
      expect(covered(arns, at(repository)), repository).toBe(false);
    }
    // another account or region is a different ARN
    expect(covered(arns, `${"9".repeat(12)}.dkr.ecr.${REGION}.amazonaws.com/agentx-staging/worker@sha256:${d("e")}`)).toBe(false);
    expect(covered(arns, `${ACCOUNT}.dkr.ecr.eu-west-1.amazonaws.com/agentx-staging/worker@sha256:${d("e")}`)).toBe(false);
  });

  it("the boot scripts' docker pull sites are exactly the ones this scope was derived from", () => {
    // every EC2 boot script except the swebench one (its own role): a new script cannot add a pull unseen
    const scripts = readdirSync("packages/worker/ec2").filter((name) => name.endsWith(".sh") && name !== "swebench-boot.sh").sort();
    expect(scripts).toEqual(["boot.sh", "test-services-stage.sh"]);
    const read = (name: string) => readFileSync(`packages/worker/ec2/${name}`, "utf8");
    const boot = read("boot.sh");
    const stage = read("test-services-stage.sh");
    // `docker pull X` and `docker image pull X`, whether X is a variable or a literal reference
    const pulls = (text: string) => [...text.matchAll(/docker (?:image )?pull(?: --[a-z-]+)* (\S+)/gu)].map((match) => match[1]!.replace(/[";|&)]+$/u, "").replace(/["{}]/gu, "")).sort();
    // calls of the helper that wraps `docker pull "$1"`
    const helperCalls = (text: string) => [...text.matchAll(/pull_image_once (\S+)/gu)].map((match) => match[1]!).filter((arg) => arg !== "()").sort();
    expect(pulls(boot)).toEqual(["$1", "$CONTAINED_IMAGE", "$EXECUTOR", "$EXECUTOR_IMAGE"]);
    expect(helperCalls(boot)).toEqual(['"$AGENTX_WORKER_IMAGE"']); // the worker image only (pull_worker_image)
    expect(boot).toContain("AGENTX_SANDBOX_IMAGE=$AGENTX_WORKER_IMAGE");
    expect(boot).toContain("readonly CONTAINED_IMAGE=node@sha256:"); // Docker Hub: no ECR
    expect(pulls(stage)).toEqual(["$reference"]);
    expect(helperCalls(stage)).toEqual([]);
    // every ECR login is for this account's registry: the worker image's (boot.sh), the executor's (qualification), the starter copies' (stage)
    expect([...boot.matchAll(/ecr get-login-password/gu)]).toHaveLength(2);
    expect([...stage.matchAll(/ecr get-login-password/gu)]).toHaveLength(1);
  });

  it("the legacy (production) role's statement is unchanged: this change is for named environments", () => {
    const old = legacy.filter((statement) => statement.Sid === "EcrImageAccess");
    expect(old).toHaveLength(1);
    expect(resolveArn(old[0]!.Resource)).toBe(`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/*`);
    expect(old[0]!.Action).toEqual(READ_ACTIONS);
    expect(legacy.map((statement) => statement.Sid)).not.toContain("EcrPullThroughCache");
  });

  it("the default boundary and the deploy role still allow what the narrowed statement and the role's policy need", () => {
    const scope = { env: "staging", partition: "aws", region: REGION, account: ACCOUNT, artifactBucketArn: "arn:aws:s3:::bucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };
    for (const action of [...READ_ACTIONS, "ecr:GetAuthorizationToken", "ecr:BatchImportUpstreamImage", "ecr:CreateRepository"]) {
      expect(allows(defaultBoundaryStatements(scope), action), `boundary: ${action}`).toBe(true);
    }
    expect(serviceRoleStatements(scope).find((statement) => statement.Sid === "IamRoles")?.Action).toContain("iam:PutRolePolicy");
  });
});
