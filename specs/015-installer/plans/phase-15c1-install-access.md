# Phase 15c1: Install Access and Deploy Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every named environment gets a small first stack, `agentx-<env>-access`, that holds what every
later deploy needs:
- the artifact bucket for code packages and templates;
- the ECR pull-through cache rule that serves AgentX images from ECR Public;
- the CloudFormation service role that deploys all other stacks;
- the narrow AgentX operator role for day-2 commands.

Every environment role honours an optional permission boundary. The worker and Slack service can
pull images through the cache. A pure, tested module computes every stack's parameters from the
release, the environment's answers and earlier stacks' outputs. The deploy engines in phase 15c2
then only have to run it.

**Architecture:**
- **The access stack** is deployed first, with the installing admin's own rights. Every other stack
  is deployed through its CloudFormation service role. This is the only way to have a service role
  at all: the role cannot deploy the stack that creates it.
- **IAM is the only service whose resources are name-scoped** in the service role's policy, and it
  is where privilege escalation happens. The role may create or change roles only named
  `agentx-<env>-*`, and only with the permission boundary when one is set. Other services are
  allowed by action, because CloudFormation-generated names are not predictable enough to scope.
- **A generated test keeps the policy complete.** Every resource type in every environment template
  must map to a service the service role may use.
- **The permission boundary** is a template parameter on every environment stack. A CDK aspect sets
  it on every `AWS::IAM::Role`, conditionally.
- **The parameter model** (`packages/cli/src/deploy/parameters.ts`) is pure. A test checks it
  against the real templates: every parameter without a default is supplied, and nothing unknown is
  supplied.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest, AWS CDK v2 2.269.0
(`aws-ecr` `CfnPullThroughCacheRule`, `aws-iam`, `aws-s3`, `Aspects`), existing phase 15a naming and
phase 15b release modules.

**Spec:** [../spec.md](../spec.md): FR-010 (images in private ECR through the pull-through cache;
proof recorded in phase 15b), FR-022 to FR-025 (admin once, the operator role, the service role,
permission boundaries), and the parameter wiring FR-018 step 2 needs ("stack outputs passed between
them automatically"). The deploy engines, engine mismatch and `--export` (FR-007, FR-009, FR-011,
FR-013, FR-026) are phase 15c2. The phase map is in [README.md](README.md).

**Branch:** `feat/015c1-install-access`, cut from mainline `0fea6a7` (phase 15b merged). One PR,
against `mainline`.

## Decisions recorded by this plan

- **A separate access stack** holds the service role, operator role, artifact bucket and
  pull-through rule, because the service role cannot deploy its own stack. For an enterprise, the
  access stack is the one template the platform team deploys and reviews. It creates every IAM
  role that operators and CloudFormation will use.
- **Deploy order.**
  - **Fresh install:** access, foundation, identity, control-plane, runtime, slack. The runtime
    takes the control plane's URL as a parameter, so the control plane must exist first. The
    control plane needs the GitHub App's details, so `init` (phase 15d) creates the GitHub App
    before deploying the control plane.
  - **Upgrade:** access, foundation, identity, runtime, control-plane, slack. The runtime goes
    before the control plane, as in the release pipeline, because the worker parses strictly and
    must be the tolerant side of the window.
  - The identity stack is skipped when the environment brings its own OIDC.
- **Pull-through prefix `agentx-<env>`,** at most 27 characters, within ECR's 30-character prefix
  limit. The private image URI for `public.ecr.aws/<alias>/<repo>@sha256:<d>` is
  `<account>.dkr.ecr.<region>.amazonaws.com/agentx-<env>/<alias>/<repo>@sha256:<d>`. The phase 15b
  spike showed that path shape.
- **Fixed role names:** `agentx-<env>-cloudformation` and `agentx-<env>-operator`, so the policies
  and the documentation can name them.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv` context, templates are
  byte-identical: `tests/contract/legacy-templates.test.ts` snapshots must not change. Never run
  vitest with `-u`. Every change here applies only under environment naming.
- **Phase 15b's guarantees hold.** Rendered templates equal a direct synthesis
  (`tests/contract/template-rendering.test.ts`). Release builds stay reproducible. Every template
  asset parameter is covered by one package.
- **`STACK_PARTS` deploy order after this phase:** `access`, `foundation`, `identity`, `runtime`,
  `control-plane`, `slack`. That is the list order. Deploy order is decided by `installOrder` and
  `upgradeOrder`, not by the list.
- **Exact names under environment naming:**
  - stack `agentx-<env>-access`;
  - service role `agentx-<env>-cloudformation`;
  - operator role `agentx-<env>-operator`;
  - pull-through prefix `agentx-<env>` with upstream `public.ecr.aws`.
- **Permission boundary parameter:** `PermissionsBoundaryArn`, type String, default `""`, allowed
  pattern `^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$`. It sits on every environment stack, and
  every `AWS::IAM::Role` in those stacks gets
  `PermissionsBoundary: Fn::If [HasPermissionsBoundary, Ref PermissionsBoundaryArn, Ref AWS::NoValue]`.
  *Superseded (owner decision 2026-09-26, option B): the boundary is always set; the default boundary `agentx-<env>-boundary` applies when none is given (the else branch is its ARN, not `AWS::NoValue`).*
- **Operator principal parameter (access stack only):** `OperatorPrincipalArn`, type String, default
  `""`, allowed pattern `^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$`. When empty, the
  operator role trusts the account root.
- **No secret values in templates, parameters files, logs or settings.** The callback signing key
  reaches the control plane only as its existing `NoEcho` parameter.
- **Commands:** the gate is `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22 (`export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`).
  - Known load flakes (issue #59): rerun that file alone.

## Review Focus

1. **A resource type the service role cannot create.** For example, a new construct adds
   `AWS::Events::Rule` and the first install fails half-way with AccessDenied. Task 2's generated
   test maps every resource type in every environment template to an allowed service prefix.
2. **The service role or operator role able to escalate privileges:** creating a role without the
   boundary, attaching `AdministratorAccess`, passing a role other than AgentX's, or changing a
   non-AgentX stack. Task 2 asserts each IAM statement's actions, resources and conditions.
3. **A stack parameter left unset, or set under the wrong name.** The deploy fails with "Parameters:
   [X] must have values", or CloudFormation rejects an unknown parameter. Task 5 checks the model
   against every real template.
4. **The permission boundary silently missing from a role**, such as a CDK-generated custom-resource
   role, or applied to legacy templates. Task 3 walks every `AWS::IAM::Role` in every environment
   template, and the legacy snapshots guard the other side.
5. **An image the runtime or Slack service cannot pull** on first use through the cache, because the
   role lacks `ecr:BatchImportUpstreamImage` or `ecr:CreateRepository`, or because the URI has the
   wrong path shape. Task 4 asserts the permissions, and Task 5 asserts the URI mapping.

---

### Task 1: The `access` stack part and its names

**Files:**
- Modify: `packages/contracts/src/environments.ts` (`StackPart`, `STACK_PARTS`)
- Modify: `infra/lib/naming.ts` (`pullThroughPrefix`, `cloudFormationRoleName`, `operatorRoleName`)
- Modify: `packages/cli/src/environments/settings.ts` (`stacks.access` optional)
- Modify: `scripts/release/manifest.ts` (template `part` enum adds `access`)
- Modify: `tests/contract/environments.test.ts`, `tests/contract/environment-naming.test.ts`,
  `tests/contract/release-build.test.ts`: only the assertions that list the parts, deliberately
- Test: the files above

**Interfaces:**
- Produces:
  - `StackPart` includes `"access"`.
  - `STACK_PARTS = ["access", "foundation", "identity", "runtime", "control-plane", "slack"]`.
  - `AgentXNaming` gains the fields below. Under legacy naming, reading these three fields throws
    `new Error("the access stack exists only for named environments")`, like
    `legacyNaming().stackName("identity")`. Implement them as getters on the legacy object so that
    legacy synthesis never touches them.

```ts
readonly pullThroughPrefix: string;       // `agentx-${env}`
readonly cloudFormationRoleName: string;  // `agentx-${env}-cloudformation`
readonly operatorRoleName: string;        // `agentx-${env}-operator`
```

- [ ] **Step 1: Write the failing tests**

In `tests/contract/environment-naming.test.ts`, add:

```ts
it("names the access stack's pieces with the environment", () => {
  const naming = environmentNaming("dev-2");
  expect(naming.stackName("access")).toBe("agentx-dev-2-access");
  expect(naming.pullThroughPrefix).toBe("agentx-dev-2");
  expect(naming.cloudFormationRoleName).toBe("agentx-dev-2-cloudformation");
  expect(naming.operatorRoleName).toBe("agentx-dev-2-operator");
});

it("keeps the pull-through prefix within ECR's 30-character limit for the longest name", () => {
  expect(environmentNaming("abcdefghijklmnopqrst").pullThroughPrefix.length).toBeLessThanOrEqual(30);
});

it("has no access stack pieces for the deployment that predates environments", () => {
  const naming = legacyNaming();
  expect(() => naming.stackName("access")).toThrow(/named environments/);
  expect(() => naming.pullThroughPrefix).toThrow(/named environments/);
  expect(() => naming.cloudFormationRoleName).toThrow(/named environments/);
  expect(() => naming.operatorRoleName).toThrow(/named environments/);
});
```

Change the `STACK_PARTS` assertion in `tests/contract/environments.test.ts` to the new list, and add
`expect(environmentStackName("staging", "access")).toBe("agentx-staging-access")`. Do not change `tests/contract/release-build.test.ts` in this task. The builder iterates
`STACK_PARTS` and expects a stack for every part, so until Task 2 creates the access stack, make
the release builder skip a part that has no stack in the placeholder assembly only if that part is
`access`. Task 2 removes that skip and updates the release-build test's expected parts to
`["access", "foundation", "identity", "runtime", "control-plane", "slack"]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/environment-naming.test.ts tests/contract/environments.test.ts`
Expected: FAIL, `naming.pullThroughPrefix` is undefined and `STACK_PARTS` lacks `access`.

- [ ] **Step 3: Implement**

Add the three fields to the `AgentXNaming` interface. In `environmentNaming(env)`:

```ts
pullThroughPrefix: `agentx-${name}`,
cloudFormationRoleName: `agentx-${name}-cloudformation`,
operatorRoleName: `agentx-${name}-operator`,
```

In `legacyNaming()`, define them as getters that throw. `LEGACY_STACK_NAMES` and
`ADOPTED_STACK_NAMES` become `Record<Exclude<StackPart, "identity" | "access">, string>`.
`legacyNaming().stackName("access")` throws with the same message as `identity`. Add `access` to
`StackPart` and put it first in `STACK_PARTS`. Add `access: z.string().optional()` to the settings
`stacks` object. Add `"access"` to the manifest `part` enum.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/environment-naming.test.ts tests/contract/environments.test.ts tests/contract/environment-settings.test.ts tests/contract/environment-adopt.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS, and the legacy snapshots are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/environments.ts infra/lib/naming.ts packages/cli/src/environments/settings.ts packages/cli/src/environments/adopt.ts scripts/release/manifest.ts scripts/release/build.ts tests/contract
git commit -m "feat: access stack part and its environment names"
```

### Task 2: The access stack (artifact bucket, pull-through rule, service role, operator role)

**Files:**
- Create: `infra/lib/access.ts`
- Create: `infra/lib/access-policies.ts` (the two policy documents as pure functions)
- Modify: `infra/lib/app.ts` (build the access stack first, under environment naming only)
- Test: `tests/contract/access-stack.test.ts`, `tests/contract/access-policies.test.ts`

**Interfaces:**
- Consumes: Task 1's naming fields.
- Produces:

```ts
// infra/lib/access-policies.ts
export interface PolicyScope { env: string; partition: string; region: string; account: string; artifactBucketArn: string; pullThroughPrefix: string; cloudFormationRoleName: string; permissionsBoundaryArn?: string }
export interface PolicyStatementJson { Sid: string; Effect: "Allow" | "Deny"; Action: string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> }
/** Services the service role may use with any resource; IAM is handled separately and name-scoped. */
export const SERVICE_ROLE_SERVICES: readonly string[];
export function serviceRoleStatements(scope: PolicyScope): PolicyStatementJson[];
export function operatorRoleStatements(scope: PolicyScope): PolicyStatementJson[];

// infra/lib/access.ts
export class AccessStack extends Stack  // props: { naming: AgentXNaming } & StackProps
```

`AccessStack` contents, exact:
- **Parameters:**
  - `PermissionsBoundaryArn`, per Global Constraints. This task adds it directly; Task 3 generalizes
    it to every stack. Declare it through the Task 3 helper if Task 3 has landed. Otherwise inline it
    here, and Task 3 moves it to the helper.
  - `OperatorPrincipalArn`, per Global Constraints.
- **Conditions:** `HasPermissionsBoundary` (the value is not `""`) and `HasOperatorPrincipal`.
- **`ArtifactBucket`** (`s3.Bucket`):
  - block all public access, S3-managed encryption, `enforceSSL: true`, versioned;
  - lifecycle rule expiring noncurrent versions after 30 days;
  - `removalPolicy: RETAIN`;
  - no fixed bucket name (CloudFormation generates a unique one).
- **`PullThroughCacheRule`** (`ecr.CfnPullThroughCacheRule`): `ecrRepositoryPrefix: naming.pullThroughPrefix`,
  `upstreamRegistryUrl: "public.ecr.aws"`.
- **`CloudFormationServiceRole`:**
  - role name `naming.cloudFormationRoleName`;
  - trust `cloudformation.amazonaws.com` with `aws:SourceAccount` equal to the account;
  - inline policy from `serviceRoleStatements`;
  - the boundary applied conditionally.
- **`OperatorRole`** (`iam.CfnRole`, because the trust principal is conditional):
  - role name `naming.operatorRoleName`;
  - trust `Fn::If [HasOperatorPrincipal, Ref OperatorPrincipalArn, arn:<partition>:iam::<account>:root]`
    with action `sts:AssumeRole`;
  - `MaxSessionDuration: 3600`;
  - inline policy from `operatorRoleStatements`;
  - the boundary applied conditionally.
- **Outputs:** `ArtifactBucketName`, `CloudFormationRoleArn`, `OperatorRoleArn`, `PullThroughPrefix`.

`serviceRoleStatements`, exact shape:
1. Sid `Services`: actions `SERVICE_ROLE_SERVICES.map((s) => `${s}:*`)`, Resource `"*"`.
   `SERVICE_ROLE_SERVICES` starts as:
   `["apigateway", "bedrock-agentcore", "cloudformation", "cloudwatch", "cognito-idp", "dynamodb", "ec2", "ecr", "ecs", "events", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "application-autoscaling"]`.
   Add any service the generated test (below) proves necessary, and nothing else.
2. Sid `IamRoles`:
   - actions `iam:CreateRole`, `iam:DeleteRole`, `iam:GetRole`, `iam:UpdateRole`, `iam:TagRole`,
     `iam:UntagRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:GetRolePolicy`,
     `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:UpdateAssumeRolePolicy`,
     `iam:PutRolePermissionsBoundary`, `iam:ListRolePolicies`, `iam:ListAttachedRolePolicies`;
   - Resource `arn:<partition>:iam::<account>:role/agentx-<env>-*`.
3. Sids `IamRequireBoundary` and `IamKeepBoundary`, emitted only when a boundary is set (the stack
   wraps both with `Fn::If [HasPermissionsBoundary, …, AWS::NoValue]`; the pure function takes an
   optional `permissionsBoundaryArn` and returns them only when it is given):
   *Superseded (owner decision 2026-09-26, option B): the boundary is always set; the default boundary `agentx-<env>-boundary` applies when none is given; both Deny statements are always emitted and name the effective boundary.*
   - **`IamRequireBoundary`:** Effect `Deny`; actions only `iam:CreateRole` and
     `iam:PutRolePermissionsBoundary` (the two actions that carry the `iam:PermissionsBoundary`
     key); Resource `role/agentx-<env>-*`; Condition
     `StringNotEquals: { "iam:PermissionsBoundary": <the boundary ARN> }`.
     Do not add any other action to this Deny. For actions without the key, `StringNotEquals`
     evaluates true, so the Deny would block every ordinary role change.
   - **`IamKeepBoundary`:** Effect `Deny`; action `iam:DeleteRolePermissionsBoundary`; Resource
     `role/agentx-<env>-*`.
4. Sid `PassRoles`: `iam:PassRole` on `arn:<partition>:iam::<account>:role/agentx-<env>-*`.
5. Sid `ServiceLinkedRoles`: `iam:CreateServiceLinkedRole` on
   `arn:<partition>:iam::<account>:role/aws-service-role/*`, with Condition
   `StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com", "bedrock-agentcore.amazonaws.com"] }`.
   Extend that service list only if the generated test shows a need.

`operatorRoleStatements`, exact shape (no `*` action anywhere):
1. Sid `Stacks`:
   - actions `cloudformation:DescribeStacks`, `DescribeStackEvents`, `DescribeStackResources`,
     `GetTemplate`, `GetTemplateSummary`, `CreateChangeSet`, `DescribeChangeSet`,
     `ExecuteChangeSet`, `DeleteChangeSet`, `ListChangeSets`, `ListStackResources`;
   - Resource `arn:<partition>:cloudformation:<region>:<account>:stack/agentx-<env>-*/*`.
2. Sid `Templates`: `cloudformation:ValidateTemplate` on `*`. This action supports no resource-level
   scoping.
3. Sid `PassServiceRole`: `iam:PassRole` on the service role's ARN only, with Condition
   `StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" }`.
4. Sid `Artifacts`: `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the bucket ARN and `<bucket>/*`.
5. Sid `Settings`: `ssm:GetParameter`, `ssm:PutParameter`, `ssm:DeleteParameter`,
   `ssm:GetParametersByPath` on `parameter/agentx/<env>` and `parameter/agentx/<env>/*`.
6. Sid `Secrets`: `secretsmanager:CreateSecret`, `PutSecretValue`, `DescribeSecret`,
   `GetSecretValue`, `TagResource` on `secret:agentx/<env>/*`.
7. Sid `Images`: `ecr:DescribeRepositories`, `ecr:DescribeImages` on
   `repository/<pullThroughPrefix>/*`.
8. Sid `ModelChecks`: `bedrock:InvokeModel`, `bedrock:Converse` on `arn:<partition>:bedrock:*::foundation-model/*`
   and `arn:<partition>:bedrock:<region>:<account>:inference-profile/*`.
9. Sid `Identity`: `sts:GetCallerIdentity` on `*`.
10. Sid `Logs`: `logs:FilterLogEvents`, `logs:StartQuery`, `logs:GetQueryResults`,
    `logs:DescribeLogGroups` on `log-group:agentx-<env>-*`. `logs:GetQueryResults` and
    `logs:DescribeLogGroups` need `*`; put them in a separate statement on `*` if the IAM reference
    requires it.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/access-policies.test.ts
import { describe, expect, it } from "vitest";
import { SERVICE_ROLE_SERVICES, operatorRoleStatements, serviceRoleStatements, type PolicyScope } from "../../infra/lib/access-policies.js";

const scope: PolicyScope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};
const actions = (statements: ReturnType<typeof serviceRoleStatements>) => statements.flatMap((s) => s.Action);

describe("service role policy", () => {
  it("scopes every IAM action to roles named for the environment, except service-linked roles", () => {
    for (const statement of serviceRoleStatements(scope).filter((s) => s.Action.some((a) => a.startsWith("iam:")))) {
      const resources = [statement.Resource].flat();
      if (statement.Sid === "ServiceLinkedRoles") {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/aws-service-role/*"]);
        expect(statement.Condition?.StringLike?.["iam:AWSServiceName"]).toBeDefined();
      } else {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/agentx-staging-*"]);
      }
    }
  });

  it("adds the boundary rules only when a boundary is set, limited to the actions that carry the key", () => {
    expect(serviceRoleStatements(scope).some((s) => s.Sid === "IamRequireBoundary")).toBe(false);
    const withBoundary = serviceRoleStatements({ ...scope, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/Boundary" });
    const require = withBoundary.find((s) => s.Sid === "IamRequireBoundary")!;
    expect(require.Action.sort()).toEqual(["iam:CreateRole", "iam:PutRolePermissionsBoundary"]);
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/Boundary" } });
    expect(withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Action).toEqual(["iam:DeleteRolePermissionsBoundary"]);
  });

  it("never grants iam:* or wildcard IAM user, group or policy management", () => {
    const all = actions(serviceRoleStatements(scope));
    expect(all).not.toContain("iam:*");
    expect(all.filter((a) => /^iam:(Create|Delete|Put|Attach).*(User|Group|Policy)$/.test(a) && a !== "iam:PutRolePolicy")).toEqual([]);
  });

  it("allows only the listed services by wildcard", () => {
    const wildcard = serviceRoleStatements(scope).find((s) => s.Sid === "Services")!;
    expect(wildcard.Action).toEqual(SERVICE_ROLE_SERVICES.map((s) => `${s}:*`));
    expect(SERVICE_ROLE_SERVICES).not.toContain("iam");
    expect(SERVICE_ROLE_SERVICES).not.toContain("organizations");
    expect(SERVICE_ROLE_SERVICES).not.toContain("sts");
  });
});

describe("operator role policy", () => {
  it("has no wildcard actions", () => {
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.endsWith(":*") || a === "*")).toEqual([]);
  });

  it("may pass only the CloudFormation service role, and only to CloudFormation", () => {
    const pass = operatorRoleStatements(scope).filter((s) => s.Action.includes("iam:PassRole"));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Resource).toBe("arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect(pass[0]!.Condition).toEqual({ StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } });
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.startsWith("iam:") && a !== "iam:PassRole")).toEqual([]);
  });

  it("changes only this environment's stacks, settings and secrets", () => {
    const byId = Object.fromEntries(operatorRoleStatements(scope).map((s) => [s.Sid, [s.Resource].flat()]));
    expect(byId.Stacks).toEqual(["arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-*/*"]);
    expect(byId.Settings).toEqual(["arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging", "arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging/*"]);
    expect(byId.Secrets).toEqual(["arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/*"]);
  });
});
```

```ts
// tests/contract/access-stack.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_ROLE_SERVICES } from "../../infra/lib/access-policies.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));

describe("access stack", () => {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const access = stacksOf(app).find((s) => s.stackName === "agentx-staging-access")!;
  const template = Template.fromStack(access);

  it("exists only for named environments, first in the app", () => {
    expect(access).toBeDefined();
    expect(stacksOf(buildAgentXApp()).some((s) => s.stackName.toLowerCase().includes("access"))).toBe(false);
  });

  it("creates a private, encrypted, versioned artifact bucket kept on delete", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  it("creates the pull-through cache rule for ECR Public", () => {
    template.hasResourceProperties("AWS::ECR::PullThroughCacheRule", { EcrRepositoryPrefix: "agentx-staging", UpstreamRegistryUrl: "public.ecr.aws" });
  });

  it("creates the CloudFormation service role and the operator role with fixed names", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation",
      AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "cloudformation.amazonaws.com" } })]) }) });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", MaxSessionDuration: 3600 });
  });

  it("outputs what later deploys need", () => {
    expect(Object.keys(template.toJSON().Outputs as object).sort()).toEqual(["ArtifactBucketName", "CloudFormationRoleArn", "OperatorRoleArn", "PullThroughPrefix"]);
  });

  it("lets the service role create every resource type the environment templates contain", () => {
    const serviceOf = (type: string) => type.split("::")[1]!.toLowerCase().replace("bedrockagentcore", "bedrock-agentcore").replace("apigatewayv2", "apigateway").replace("cognito", "cognito-idp").replace("applicationautoscaling", "application-autoscaling");
    const types = new Set(stacksOf(app).filter((s) => s.stackName !== "agentx-staging-access")
      .flatMap((s) => Object.values(Template.fromStack(s).toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type)));
    // AWS::CDK::Metadata is a CDK pseudo-resource, not an AWS service call. Custom resources are
    // backed by Lambda, so they need the lambda service.
    const needed = [...types].filter((t) => t !== "AWS::CDK::Metadata" && t !== "AWS::IAM::Role" && t !== "AWS::IAM::Policy")
      .map((t) => (t.startsWith("Custom::") || t === "AWS::CloudFormation::CustomResource" ? "lambda" : serviceOf(t)));
    expect([...new Set(needed)].filter((service) => !SERVICE_ROLE_SERVICES.includes(service))).toEqual([]);
  }, 240_000);
});
```

If a resource type maps to a service name the helper's replacements don't cover (for example
`AWS::CloudWatch::Alarm` becomes `cloudwatch`, which is fine), extend `serviceOf` with the correct
IAM service prefix and add that prefix to `SERVICE_ROLE_SERVICES`. Custom resources are already
mapped to `lambda` in the test. `AWS::CDK::Metadata` is excluded, because it is not an AWS
service call.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/access-policies.test.ts tests/contract/access-stack.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement the policies, the stack, and wire the app**

Write `access-policies.ts` exactly as specified above, with no CDK imports, so it can be unit
tested and later printed by `--export`. Write `access.ts` using it. In `app.ts`, under environment
naming only, create
`new AccessStack(app, "AgentXAccess", { stackName: naming.stackName("access"), naming, terminationProtection: true, env: { region } })`
before every other stack.

- [ ] **Step 4: Run the tests, the naming, rendering and release tests, and the legacy snapshots**

Run: `npx vitest run tests/contract/access-policies.test.ts tests/contract/access-stack.test.ts tests/contract/environment-naming.test.ts tests/contract/template-rendering.test.ts tests/contract/release-build.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS. Remove Task 1's temporary skip of `access` in `scripts/release/build.ts`, and update
the release-build test's expected parts to the six-part list. The release build now has six
template parts, and the rendering equality holds for the access stack too.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/access.ts infra/lib/access-policies.ts infra/lib/app.ts scripts/release/build.ts tests/contract/access-stack.test.ts tests/contract/access-policies.test.ts tests/contract/release-build.test.ts
git commit -m "feat(infra): access stack with artifact bucket, pull-through rule, service and operator roles"
```

### Task 3: The permission boundary on every environment role

**Files:**
- Create: `infra/lib/permissions-boundary.ts`
- Modify: `infra/lib/app.ts` (apply it to every environment stack)
- Modify: `infra/lib/access.ts` (use the shared parameter and condition)
- Test: `tests/contract/permissions-boundary.test.ts`

**Interfaces:**
- Produces:
  - `export function applyPermissionsBoundaryParameter(stack: Stack): { parameter: CfnParameter; condition: CfnCondition }`.
    It creates the `PermissionsBoundaryArn` parameter and the `HasPermissionsBoundary` condition
    once per stack. Calling it again returns the same pair.
  - It adds an aspect that sets every `iam.CfnRole`'s `permissionsBoundary` to
    `Fn.conditionIf(condition.logicalId, parameter.valueAsString, Aws.NO_VALUE)`.
  - The aspect overwrites nothing that already sets a boundary. It throws if a role already has
    one, because we have none today.

- [ ] **Step 1: Write the failing test**

> Superseded (owner decision 2026-09-26, option B): the boundary is always set; the default boundary `agentx-<env>-boundary` applies when none is given (the `Fn::If` else branch is that ARN, not `AWS::NoValue`).

```ts
// tests/contract/permissions-boundary.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));

describe("permission boundary", () => {
  it("is a parameter on every environment stack and conditionally on every role", () => {
    for (const stack of stacksOf(buildAgentXApp({ agentxEnv: "staging" }))) {
      const json = Template.fromStack(stack).toJSON() as { Parameters: Record<string, { Default?: string; AllowedPattern?: string }>; Conditions: Record<string, unknown>; Resources: Record<string, { Type: string; Properties: { PermissionsBoundary?: unknown } }> };
      expect(json.Parameters.PermissionsBoundaryArn, stack.stackName).toMatchObject({ Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
      expect(json.Conditions.HasPermissionsBoundary, stack.stackName).toBeDefined();
      for (const [id, resource] of Object.entries(json.Resources).filter(([, r]) => r.Type === "AWS::IAM::Role")) {
        expect(resource.Properties.PermissionsBoundary, `${stack.stackName} ${id}`).toEqual({ "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }] });
      }
    }
  }, 300_000);

  it("is absent from the deployment that predates environments", () => {
    for (const stack of stacksOf(buildAgentXApp())) {
      expect(JSON.stringify(Template.fromStack(stack).toJSON()), stack.stackName).not.toContain("PermissionsBoundaryArn");
    }
  }, 300_000);
});
```

- [ ] **Step 2: Run it to verify it fails, implement, apply to every environment stack in `app.ts`, and run it to see it pass**

Run: `npx vitest run tests/contract/permissions-boundary.test.ts tests/contract/legacy-templates.test.ts tests/contract/template-rendering.test.ts`
Expected: first FAIL, then PASS. The legacy snapshots are unchanged.

- [ ] **Step 3: Commit**

```bash
git add infra/lib/permissions-boundary.ts infra/lib/app.ts infra/lib/access.ts tests/contract/permissions-boundary.test.ts
git commit -m "feat(infra): optional permission boundary on every environment role"
```

### Task 4: The worker and Slack service can pull through the cache

**Files:**
- Modify: `infra/lib/agent-runtime.ts` (runtime execution role, environment naming only)
- Modify: `infra/lib/slack-orchestrator.ts` (task execution role, environment naming only)
- Test: `tests/contract/pull-through-permissions.test.ts`

**Interfaces:**
- Consumes: `naming.pullThroughPrefix` (Task 1).
- Produces:
  - **Runtime:** under environment naming, the runtime execution role gains `ecr:BatchGetImage`,
    `ecr:GetDownloadUrlForLayer`, `ecr:BatchImportUpstreamImage` and `ecr:CreateRepository` on
    `arn:<partition>:ecr:<region>:<account>:repository/agentx-<env>/*`.
  - **Slack service:** its execution role gains the same four actions plus
    `ecr:BatchCheckLayerAvailability`, on the same resource.
  - Legacy statements are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/pull-through-permissions.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
function statements(stack: Stack): Array<{ Action: string | string[]; Resource: unknown }> {
  return Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { PolicyDocument?: { Statement: Array<{ Action: string | string[]; Resource: unknown }> }; Policies?: Array<{ PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }> } }>)
    .flatMap((r) => [...(r.Properties?.PolicyDocument?.Statement ?? []), ...(r.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement)]);
}
const grants = (stack: Stack, action: string) => statements(stack).filter((s) => [s.Action].flat().includes(action)).map((s) => JSON.stringify(s.Resource));

describe("pulling AgentX images through the cache", () => {
  const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
  it.each(["agentx-staging-runtime", "agentx-staging-slack"])("%s may import upstream images into its cache prefix", (name) => {
    const stack = stacks.find((s) => s.stackName === name)!;
    for (const action of ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) {
      expect(grants(stack, action).some((r) => r.includes("repository/agentx-staging/*")), `${name} ${action}`).toBe(true);
    }
  }, 240_000);

  it("adds nothing to the deployment that predates environments", () => {
    for (const stack of stacksOf(buildAgentXApp())) {
      expect(grants(stack, "ecr:BatchImportUpstreamImage"), stack.stackName).toEqual([]);
    }
  }, 240_000);
});
```

- [ ] **Step 2: Run it to verify it fails, implement, and run it with the legacy snapshots**

Run: `npx vitest run tests/contract/pull-through-permissions.test.ts tests/contract/legacy-templates.test.ts tests/contract/infrastructure.test.ts`
Expected: first FAIL, then PASS, and the legacy snapshots are unchanged.

- [ ] **Step 3: Commit**

```bash
git add infra/lib/agent-runtime.ts infra/lib/slack-orchestrator.ts tests/contract/pull-through-permissions.test.ts
git commit -m "feat(infra): runtime and Slack service pull AgentX images through the cache"
```

### Task 5: The deploy parameter model

**Files:**
- Create: `packages/contracts/src/release.ts` (the release manifest schema moves here, so the CLI can read `release.json`)
- Modify: `packages/contracts/src/index.ts` (export it)
- Modify: `scripts/release/manifest.ts` (re-export from `@agentx/contracts`)
- Create: `packages/cli/src/deploy/parameters.ts`
- Modify: `packages/cli/src/environments/settings.ts` (optional `access` block)
- Test: `tests/contract/deploy-parameters.test.ts`

**Interfaces:**
- Consumes: Task 1's `STACK_PARTS`; Task 2's access outputs; the phase 15b release manifest.
- Produces:

```ts
// packages/cli/src/deploy/parameters.ts
export type StackOutputs = Record<string, string>;
export type DeployPart = "access" | "foundation" | "identity" | "runtime" | "control-plane" | "slack";
export interface InstallAnswers {
  env: string; region: string; account: string; partition?: string; // default "aws"
  release: ReleaseManifest;
  models: { orchestrator: string; classifier: string; worker: string };
  identity: { mode: "cognito" } | { mode: "oidc"; issuer: string; audience: string };
  github: { account: string; appId: string; installationId: string; privateKeySecretArn: string; credentialRef?: string };
  callbackSigningKey: string;         // the value; the caller reads it from Secrets Manager, never logs it
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
}
export function installOrder(identityMode: "cognito" | "oidc"): DeployPart[];
export function upgradeOrder(identityMode: "cognito" | "oidc"): DeployPart[];
/** public.ecr.aws/<alias>/<repo>@sha256:<d> → <account>.dkr.ecr.<region>.amazonaws.com/<prefix>/<alias>/<repo>@sha256:<d> */
export function privateImageUri(publicRef: string, target: { account: string; region: string; prefix: string }): string;
/** Parameters for one stack. Throws a clear error naming the missing input or output. */
export function stackParameters(part: DeployPart, answers: InstallAnswers, outputs: Partial<Record<DeployPart, StackOutputs>>): Record<string, string>;
/** The parameter names whose values must never be printed. */
export const SECRET_PARAMETERS: ReadonlySet<string>; // new Set(["CallbackSigningKey"])
```

Mapping, exact. `B` is `answers.permissionsBoundaryArn ?? ""` and appears on every part as
`PermissionsBoundaryArn`.
- **access:** `PermissionsBoundaryArn: B`, `OperatorPrincipalArn: answers.operatorPrincipalArn ?? ""`.
- **foundation, identity:** `PermissionsBoundaryArn: B`.
- **control-plane:**
  - `OidcIssuer` and `OidcAudience`: from identity outputs `Issuer`/`Audience` in Cognito mode, or
    from `answers.identity` in OIDC mode;
  - `CallbackSigningKey`;
  - `GitHubAppAccount`, `GitHubAppId`, `GitHubAppInstallationId`, `GitHubAppPrivateKeySecretArn`,
    and `GitHubAppCredentialRef` only if given;
  - for each release package whose `parts` include `control-plane`: `bucketParameter` set to access
    output `ArtifactBucketName`, `keyParameter` set to the package's `keyParameterValue`, and
    `hashParameter` set to the package's `assetId`.
- **runtime:**
  - `WorkerImageUri`: `privateImageUri(release.images.worker, { prefix: access output PullThroughPrefix })`;
  - `ControlPlaneUrl`: control-plane output `ApiEndpoint`;
  - `ModelProvider: "amazon-bedrock"`, `ModelId: models.worker`;
  - `CapacityProviderArn`: foundation output `CapacityProviderArn`.
- **slack:**
  - `OrchestratorImageUri`: `privateImageUri(release.images.slack, …)`;
  - `TaskRoleArn`: control-plane `SlackOrchestratorTaskRoleArn`;
  - `ControlPlaneUrl`: control-plane `ApiEndpoint`;
  - `SlackRequestQueueUrl`, `SlackThreadsTableName`, `TurnRecordsTableName`: from the control plane;
  - `ThreadSessionBucketName`: control-plane `SlackThreadSessionBucketName`;
  - `SlackSecretArn`: control-plane `SlackSecretArn`;
  - `VpcId`, `PrivateSubnetIds`: from the foundation;
  - `ModelProvider: "amazon-bedrock"`, `ModelId: models.orchestrator`,
    `GateClassifierModelId: models.classifier`.
- A missing image in the release throws "release <version> has no <worker|slack> image digest".
- A missing output throws "stack agentx-<env>-<part> has no output <Name>".

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/deploy-parameters.test.ts
import { Stack } from "aws-cdk-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, renderTemplate, type ReleaseManifest } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SECRET_PARAMETERS, installOrder, privateImageUri, stackParameters, upgradeOrder, type DeployPart, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";

const d = (c: string) => c.repeat(64);
let templates: Map<string, { Parameters?: Record<string, { Default?: unknown }> }>;
let release: ReleaseManifest;

beforeAll(() => {
  const assembly = buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy" }).synth();
  templates = new Map();
  const packages = new Map<string, ReleaseManifest["packages"][number]>();
  for (const stack of assembly.stacks) {
    const part = stack.stackName.replace(`agentx-${ENVIRONMENT_PLACEHOLDER}-`, "");
    templates.set(part, JSON.parse(renderTemplate(JSON.stringify(stack.template), "staging")) as never);
    for (const asset of stack.assets.filter((a) => a.packaging === "zip")) {
      const existing = packages.get(asset.id);
      packages.set(asset.id, existing ? { ...existing, parts: [...existing.parts, part] } : {
        assetId: asset.id, file: `packages/${asset.id}.zip`, sha256: d("0"), parts: [part],
        bucketParameter: (asset as { s3BucketParameter: string }).s3BucketParameter,
        keyParameter: (asset as { s3KeyParameter: string }).s3KeyParameter,
        hashParameter: (asset as { artifactHashParameter: string }).artifactHashParameter,
        keyParameterValue: `packages/||${asset.id}.zip`,
      });
    }
  }
  release = { schemaVersion: 1, version: "1.0.0", gitCommit: "a".repeat(40), environmentPlaceholder: ENVIRONMENT_PLACEHOLDER, templates: [], packages: [...packages.values()],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${d("c")}` } };
}, 300_000);

const answers = (): InstallAnswers => ({
  env: "staging", region: "us-east-1", account: "123456789012", release,
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
  callbackSigningKey: "k".repeat(40),
});
const outputs = {
  access: { ArtifactBucketName: "agentx-staging-access-artifactbucket-abc", CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", PullThroughPrefix: "agentx-staging" },
  foundation: { CapacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx_staging_capacity-AbCdEfGhIj", VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2" },
  identity: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123" },
  "control-plane": { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask", SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b", SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x" },
};

describe("deploy parameters", () => {
  it.each(["access", "foundation", "identity", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s and nothing unknown", (part) => {
    const params = stackParameters(part, answers(), outputs);
    const declared = templates.get(part)!.Parameters ?? {};
    const required = Object.entries(declared).filter(([, p]) => p.Default === undefined).map(([name]) => name);
    expect(required.filter((name) => !(name in params))).toEqual([]);
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
  });

  it("maps a public image to its private pull-through address", () => {
    expect(privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, { account: "123456789012", region: "us-east-1", prefix: "agentx-staging" }))
      .toBe(`123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-worker@sha256:${d("b")}`);
    expect(() => privateImageUri("public.ecr.aws/agentx/agentx-worker:latest", { account: "1", region: "r", prefix: "p" })).toThrow(/digest/);
    expect(() => privateImageUri(`docker.io/x/y@sha256:${d("b")}`, { account: "1", region: "r", prefix: "p" })).toThrow(/public.ecr.aws/);
  });

  it("orders a fresh install and an upgrade differently, and skips identity for your own OIDC", () => {
    expect(installOrder("cognito")).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect(upgradeOrder("cognito")).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
    expect(installOrder("oidc")).not.toContain("identity");
  });

  it("takes the OIDC issuer from the identity stack or from your own provider", () => {
    expect(stackParameters("control-plane", answers(), outputs)).toMatchObject({ OidcIssuer: outputs.identity.Issuer, OidcAudience: "client123" });
    const own = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx" } };
    const { identity: _identity, ...withoutIdentity } = outputs;
    expect(stackParameters("control-plane", own, withoutIdentity)).toMatchObject({ OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" });
  });

  it("names the missing output or image", () => {
    const { VpcId: _gone, ...foundation } = outputs.foundation;
    expect(() => stackParameters("slack", answers(), { ...outputs, foundation })).toThrow("stack agentx-staging-foundation has no output VpcId");
    const noWorker = { ...answers(), release: { ...release, images: {} } };
    expect(() => stackParameters("runtime", noWorker, outputs)).toThrow("release 1.0.0 has no worker image digest");
  });

  it("marks the callback signing key as secret", () => {
    expect([...SECRET_PARAMETERS]).toEqual(["CallbackSigningKey"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/deploy-parameters.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement**

Move `ReleaseManifestSchema` and `ReleaseManifest` into `packages/contracts/src/release.ts`, with
the part enum from Task 1. `scripts/release/manifest.ts` becomes
`export { ReleaseManifestSchema, type ReleaseManifest } from "@agentx/contracts";`. The release
scripts and their tests must keep working unchanged.

Write `parameters.ts` to the mapping above:
- a `required(outputs, part, name, env)` helper that throws the exact message;
- a `requiredImage(release, which)` helper.

Add `access?: { artifactBucket: string; cloudFormationRoleArn: string; operatorRoleArn: string; pullThroughPrefix: string; permissionsBoundaryArn?: string }`
(strict) to the settings schema, with a round-trip test in `tests/contract/environment-settings.test.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/deploy-parameters.test.ts tests/contract/environment-settings.test.ts tests/contract/release-build.test.ts tests/contract/release-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/release.ts packages/contracts/src/index.ts scripts/release/manifest.ts packages/cli/src/deploy/parameters.ts packages/cli/src/environments/settings.ts tests/contract/deploy-parameters.test.ts tests/contract/environment-settings.test.ts
git commit -m "feat(cli): deploy parameter model wiring release, answers and stack outputs"
```

### Task 6: Documentation and the phase map

**Files:**
- Modify: `docs/architecture-production.md` (a short "Access stack" section; `docs/` is gitignored, so use `git add -f`)
- Modify: `specs/015-installer/plans/README.md` (split 15c into 15c1 and 15c2)
- Modify: `specs/015-installer/spec.md` (Decisions: the access stack; the install and upgrade orders)

- [ ] **Step 1: Write the docs (the architecture section under 40 lines)**

The architecture section explains, in plain words:
- what the access stack holds and why it deploys first with admin rights;
- what the service role may and may not do (IAM limited to `agentx-<env>-*` roles, the boundary);
- what the operator role may do;
- the permission boundary parameter;
- the pull-through prefix and the private image address.

In the phase map, replace the 15c row with two rows:
- **15c1:** this plan. It covers FR-010, FR-022 to FR-025, and the parameter wiring.
- **15c2:** `phase-15c2-deploy-engines.md`. It covers the templates and cdk engines behind one
  deployer interface: uploading packages and rendered templates to the artifact bucket,
  change-set-based deploys through the service role, stack order from `installOrder`/`upgradeOrder`,
  output wiring from `stackParameters`, engine mismatch refusal, the CDK bootstrap check, and
  `agentx init --export`. It covers FR-007, FR-009, FR-011, FR-013 and FR-026.

In the spec's Decisions, add the access-stack bullet and the two deploy orders, dated 2026-09-26,
using the text from this plan's Decisions.

- [ ] **Step 2: Run the full gate and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass, and the legacy snapshots are unchanged.

```bash
git add -f docs/architecture-production.md
git add specs/015-installer/plans/README.md specs/015-installer/spec.md
git commit -m "docs: access stack, deploy orders, and the 15c1/15c2 split"
```

## Not in this phase

- Running any deploy, whether with CloudFormation change sets or CDK. That is phase 15c2.
- `agentx init`, the GitHub App, Slack, connectors and alerts. That is phase 15d.
