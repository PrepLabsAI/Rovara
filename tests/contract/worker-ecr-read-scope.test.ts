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
//   4. the legacy (production) role reads ONE repository, the worker image's (it used to read `repository/*`: every image in the account), plus the five starter copies;
//      the default boundary still allows the actions.
//   5. (worker ECR scope lane, 2026-11-23) saved environment images (`rovara-env/<env>/o<org>/p<project>`): the worker's INSTANCE role, in both apps, can read, write, list or delete none of them, for
//      any company, any project, any environment, and holds no ECR write action on any repository; the company's own image is reached only through the broker's one-repository session
//      (pull / push / manage), which never names another company's repository; and the repository policy refuses the worker role too.
import { readFileSync, readdirSync } from "node:fs";
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  defaultBoundaryStatements,
  environmentPullThroughPrefix,
  mirroredStarterEntries,
  savedEnvManageSessionPolicy,
  savedEnvPullSessionPolicy,
  savedEnvPushSessionPolicy,
  savedEnvRepositoryArn,
  savedEnvRepositoryName,
  savedEnvRepositoryPolicy,
  serviceRoleStatements,
  type PolicyStatementJson,
} from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { AGENTX_PRODUCTION_WORKER_REPOSITORY } from "../../infra/lib/release-pipeline.js";
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
    expect(ecr.map((statement) => statement.Sid).sort()).toEqual(["EcrImageAccess", "EcrPullThroughCache", "EcrTokenAccess", "NoSavedEnvironmentImages", "TestServiceImageRead"]);
    for (const statement of ecr) {
      if (statement.Sid === "NoSavedEnvironmentImages") continue; // the one Deny; held in the saved-environment tests below
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
    ];
    expect(references).toHaveLength(10);
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
    // L4-NETG: sandbox-egress.sh and devcontainer-docker.sh pull nothing (checked just below); the only image they start is the worker image the boot already pulled, inside the scope above.
    expect(scripts).toEqual(["boot.sh", "devcontainer-docker.sh", "sandbox-egress.sh", "test-services-stage.sh"]);
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
    // L4-NETG (DEC 254zzz77): the gateway stage and the devcontainer wrapper make no pull and no ECR login. The gateway container, the program and deny-list reads and the boot probe all start `$AGENTX_WORKER_IMAGE`
    // (already on the host, pulled by pull_worker_image from agentx-<env>/worker, inside the pull-through prefix the role reads); `docker run`/`create` of a present image never pulls, and the wrapper only passes
    // `run`/`create` of whatever image the dev container CLI names to the same Docker daemon, exactly as the CLI did before (a dev container's own base image comes from its public registry through the host's dockerd, not through this role).
    const egress = read("sandbox-egress.sh");
    const wrapper = read("devcontainer-docker.sh");
    for (const [name, text] of [["sandbox-egress.sh", egress], ["devcontainer-docker.sh", wrapper]] as const) {
      expect(pulls(text), name).toEqual([]);
      expect(helperCalls(text), name).toEqual([]);
      expect([...text.matchAll(/ecr get-login-password|docker login|--pull(?:=|\s)always/gu)], name).toHaveLength(0);
    }
    // Every image the egress stage starts is the worker image, and nothing else names an image.
    // The three sites are se_image_node, se_gateway and se_probe; each starts
    // exactly "$AGENTX_WORKER_IMAGE". DNS25 replaced the two --dns probes with
    // one probe using the mounted resolver, so there is no fourth start.
    expect([...egress.matchAll(/"\$AGENTX_WORKER_IMAGE"/gu)]).toHaveLength(3);
    expect([...egress.matchAll(/docker (?:run|create)/gu)]).toHaveLength(3);
    expect(egress.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n")).not.toMatch(/\.dkr\.ecr\.|docker\.io\/|ghcr\.io\/|amazonaws\.com\/|node@sha256/u);
    expect(helperCalls(stage)).toEqual([]);
    // every ECR login is for this account's registry: the worker image's (boot.sh), the executor's (qualification), the starter copies' (stage)
    expect([...boot.matchAll(/ecr get-login-password/gu)]).toHaveLength(2);
    expect([...stage.matchAll(/ecr get-login-password/gu)]).toHaveLength(1);
  });

  it("the legacy (production) role reads exactly the worker image repository, no longer every repository in the account", () => {
    const old = legacy.filter((statement) => statement.Sid === "EcrImageAccess");
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ Effect: "Allow", Action: READ_ACTIONS });
    expect(resolveArn(old[0]!.Resource)).toBe(`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${AGENTX_PRODUCTION_WORKER_REPOSITORY}`);
    expect(legacy.map((statement) => statement.Sid)).not.toContain("EcrPullThroughCache");
    // no Allow on the role names a wildcard repository
    for (const statement of legacy.filter((candidate) => candidate.Effect === "Allow" && asList(candidate.Action).some((action) => String(action).startsWith("ecr:") && action !== "ecr:GetAuthorizationToken"))) {
      for (const resource of asList(statement.Resource)) expect(resolveArn(resource), `${statement.Sid}`).not.toContain("*");
    }
  });

  it("the legacy worker pulls its worker image (also the sandbox) and the five starter copies, and nothing else in the account", () => {
    const arns = readableRepositories(legacy);
    const at = (repository: string) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${repository}@sha256:${d("e")}`;
    expect(covered(arns, at(AGENTX_PRODUCTION_WORKER_REPOSITORY))).toBe(true);
    for (const entry of mirroredStarterEntries(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`, "production")) expect(covered(arns, entry.reference), entry.reference).toBe(true);
    for (const repository of [
      "agentx-slack-orchestrator", "agentx-embedder-production", "agentx-worker-production-old", "agentx-worker-productio", "agentx-worker",
      "other-product-production-images-abcdefghijkl", "cdk-hnb659fds-container-assets-111122223333-us-west-2", "rovara-catalog/production/svc/postgres",
      "rovara-bundle/production/embedder", "agentx-staging/worker",
    ]) expect(covered(arns, at(repository)), repository).toBe(false);
  });

  it("the default boundary and the deploy role still allow what the narrowed statement and the role's policy need", () => {
    const scope = { env: "staging", partition: "aws", region: REGION, account: ACCOUNT, artifactBucketArn: "arn:aws:s3:::bucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };
    for (const action of [...READ_ACTIONS, "ecr:GetAuthorizationToken", "ecr:BatchImportUpstreamImage", "ecr:CreateRepository"]) {
      expect(allows(defaultBoundaryStatements(scope), action), `boundary: ${action}`).toBe(true);
    }
    expect(serviceRoleStatements(scope).find((statement) => statement.Sid === "IamRoles")?.Action).toContain("iam:PutRolePolicy");
  });
});


// ---- saved environment images: the worker's instance role versus one company's repositories

/** What IAM does with one statement set: an explicit Deny wins; otherwise an Allow whose action and resource patterns match. Single account, so a resource policy would only ever ADD a Deny here. */
function evaluates(statements: readonly Statement[], action: string, resourceArn: string): "allow" | "deny" | "implicit-deny" {
  const named = (statement: Statement) => asList(statement.Action).some((pattern) => globMatches(String(pattern).toLowerCase(), action.toLowerCase()));
  const reaches = (statement: Statement) => asList(statement.Resource).some((resource) => (resource === "*" ? true : globMatches(resolveArn(resource), resourceArn)));
  const matching = statements.filter((statement) => named(statement) && reaches(statement));
  if (matching.some((statement) => statement.Effect === "Deny")) return "deny";
  return matching.some((statement) => statement.Effect === "Allow") ? "allow" : "implicit-deny";
}
/** Whether a policy document's statement list allows an action on a resource ARN (session policies: a literal ARN, an Allow, no Deny). */
const policyAllows = (policy: { Statement: Array<Record<string, unknown>> }, action: string, resourceArn: string): boolean =>
  policy.Statement.some((statement) => statement.Effect === "Allow" && [statement.Action].flat().some((pattern) => globMatches(String(pattern).toLowerCase(), action.toLowerCase())) && [statement.Resource].flat().some((resource) => globMatches(String(resource), resourceArn)));

const READ_DATA = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"];
const LIST_ACTIONS = ["ecr:DescribeImages", "ecr:ListImages", "ecr:DescribeRepositories", "ecr:GetRepositoryPolicy"];
const WRITE_ACTIONS = [
  "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:SetRepositoryPolicy",
  "ecr:DeleteRepositoryPolicy", "ecr:PutLifecyclePolicy", "ecr:PutImageTagMutability", "ecr:TagResource", "ecr:CreateRepository",
];
const SCOPE = { partition: "aws", region: REGION, account: ACCOUNT };
const savedEnvRepository = (env: string, orgId: string, projectId: string) => savedEnvRepositoryName({ env, orgId, projectId });
const ROLE_ARNS = { pushRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-push`, pullRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-pull`, manageRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-manage` };

describe("a worker cannot touch another company's saved environment image, or any saved environment image with its instance role (worker ECR scope lane)", () => {
  let staging: Statement[];
  let legacy: Statement[];
  beforeAll(() => {
    const foundation = Template.fromStack(stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-foundation")!);
    staging = workerStatements(foundation);
    legacy = stacksOf(buildAgentXApp()).flatMap((stack) => workerStatements(Template.fromStack(stack)));
  }, 240_000);

  const companies = [{ orgId: "org_company_a", projectId: "proj_1" }, { orgId: "org_company_b", projectId: "proj_1" }, { orgId: "org_company_a", projectId: "proj_2" }];

  it.each([["the legacy (production) app", "production"], ["a named environment (staging)", "staging"]] as const)("%s: the instance role is denied every ECR action on every company's repository, in this and any other environment", (_name, env) => {
    const statements = env === "production" ? legacy : staging;
    for (const environment of [env, "production", "staging", "dev-3"]) {
      for (const company of companies) {
        const arn = savedEnvRepositoryArn(SCOPE, savedEnvRepository(environment, company.orgId, company.projectId));
        for (const action of [...READ_DATA, ...LIST_ACTIONS, ...WRITE_ACTIONS]) expect(evaluates(statements, action, arn), `${action} on ${arn}`).toBe("deny");
      }
    }
    // a repository of a shape no module makes, still under the root: denied too (a hand-made or pre-template repository has no repository policy to fall back on)
    expect(evaluates(statements, "ecr:BatchGetImage", `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/${env}/handmade`)).toBe("deny");
    expect(evaluates(statements, "ecr:BatchGetImage", `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/${env}`)).toBe("deny");
  });

  it.each([["the legacy (production) app", "legacy"], ["a named environment (staging)", "staging"]] as const)("%s: the instance role holds no ECR write, delete or policy action on any repository", (_name, which) => {
    const statements = which === "legacy" ? legacy : staging;
    const repositories = ["agentx-worker-production", "agentx-staging/worker", "agentx-staging/anything", "agentx-staging--test-services/postgres-16/postgres", "agentx-slack-orchestrator", "rovara-env/staging/oa/pb", "some-other"];
    for (const repository of repositories) {
      for (const action of WRITE_ACTIONS) {
        const result = evaluates(statements, action, `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${repository}`);
        // the one write-like grant a named environment keeps: its OWN pull-through prefix (create + import for the cache), never a push, a delete or a policy change
        const cacheCreate = which === "staging" && action === "ecr:CreateRepository" && repository.startsWith("agentx-staging/");
        expect(result === "allow", `${action} on ${repository}`).toBe(cacheCreate);
      }
    }
  });

  it("the base images stay readable: the worker image (and sandbox) and the starter copies, in both apps", () => {
    const at = (repository: string) => `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${repository}`;
    for (const action of ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) {
      expect(evaluates(legacy, action, at(AGENTX_PRODUCTION_WORKER_REPOSITORY))).toBe("allow");
      expect(evaluates(staging, action, at("agentx-staging/worker"))).toBe("allow");
      expect(evaluates(staging, action, at("agentx-staging/executor"))).toBe("allow");
      for (const entry of mirroredStarterEntries(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`, "production")) {
        expect(evaluates(legacy, action, at(entry.reference.slice(entry.reference.indexOf("/") + 1).split("@")[0]!)), entry.reference).toBe("allow");
      }
    }
    expect(evaluates(legacy, "ecr:GetAuthorizationToken", "*")).toBe("allow");
    expect(evaluates(staging, "ecr:GetAuthorizationToken", "*")).toBe("allow");
  });

  it("a company's own image is reached only through the broker's one-repository session: company A's pull, push and manage sessions name A's repository and never B's", () => {
    const a = savedEnvRepository("staging", "org_company_a", "proj_1");
    const b = savedEnvRepository("staging", "org_company_b", "proj_1");
    const aSibling = savedEnvRepository("staging", "org_company_a", "proj_2");
    expect(new Set([a, b, aSibling]).size).toBe(3);
    const sessions = [
      ["pull", savedEnvPullSessionPolicy(SCOPE, a), READ_DATA.slice(0, 2)],
      ["push", savedEnvPushSessionPolicy(SCOPE, a), ["ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage"]],
      ["manage", savedEnvManageSessionPolicy(SCOPE, a), ["ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:ListImages"]],
    ] as const;
    for (const [kind, policy, actions] of sessions) {
      for (const action of actions) {
        expect(policyAllows(policy, action, savedEnvRepositoryArn(SCOPE, a)), `${kind} ${action} own`).toBe(true);
        expect(policyAllows(policy, action, savedEnvRepositoryArn(SCOPE, b)), `${kind} ${action} other company`).toBe(false);
        expect(policyAllows(policy, action, savedEnvRepositoryArn(SCOPE, aSibling)), `${kind} ${action} sibling project`).toBe(false);
      }
    }
    // the pull session cannot write or delete; the push session cannot delete
    expect(policyAllows(savedEnvPullSessionPolicy(SCOPE, a), "ecr:PutImage", savedEnvRepositoryArn(SCOPE, a))).toBe(false);
    expect(policyAllows(savedEnvPullSessionPolicy(SCOPE, a), "ecr:BatchDeleteImage", savedEnvRepositoryArn(SCOPE, a))).toBe(false);
    expect(policyAllows(savedEnvPushSessionPolicy(SCOPE, a), "ecr:BatchDeleteImage", savedEnvRepositoryArn(SCOPE, a))).toBe(false);
  });

  it("the repository policy every saved environment repository is created with refuses the worker's instance role: reads to anyone but push and pull, writes to anyone but push, image deletes to anyone but manage", () => {
    const workerRole = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-foundation-Ec2WorkersInstanceRole`;
    const statements = savedEnvRepositoryPolicy(ROLE_ARNS).Statement as Array<{ Effect: string; Action: string[]; Condition: { ArnNotEquals: { "aws:PrincipalArn": string | string[] } } }>;
    const deniedFor = (principal: string, action: string) => statements.some((statement) => statement.Effect === "Deny" && statement.Action.includes(action) && [statement.Condition.ArnNotEquals["aws:PrincipalArn"]].flat().every((arn) => arn !== principal));
    for (const action of [...READ_DATA, "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchDeleteImage"]) expect(deniedFor(workerRole, action), action).toBe(true);
    for (const action of READ_DATA) { expect(deniedFor(ROLE_ARNS.pullRoleArn, action)).toBe(false); expect(deniedFor(ROLE_ARNS.pushRoleArn, action)).toBe(false); }
    expect(deniedFor(ROLE_ARNS.pullRoleArn, "ecr:PutImage")).toBe(true);
    expect(deniedFor(ROLE_ARNS.pushRoleArn, "ecr:PutImage")).toBe(false);
    expect(deniedFor(ROLE_ARNS.pushRoleArn, "ecr:BatchDeleteImage")).toBe(true);
    expect(deniedFor(ROLE_ARNS.manageRoleArn, "ecr:BatchDeleteImage")).toBe(false);
  });
});
