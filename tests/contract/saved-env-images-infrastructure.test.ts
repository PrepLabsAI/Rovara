/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- a synthesized CloudFormation template is untyped JSON: the walks and the mutants below index into it freely */
// L4-SE6 (owner-approved 2026-11-18): saved environment images on hosted, the IAM and infrastructure half. This asserts, for a NAMED environment only:
//   1. the three roles (push, pull, manage): trust only the broker role, ECR actions only on repositories under `rovara-env/<env>/*` (the registry token call is the one `*`), a session limit of 3,600 seconds;
//   2. ONE repository creation template for `rovara-env/<env>`: AES-256, immutable tags, the contracts' lifecycle and repository policies, no KMS, no custom role, no tags;
//   3. the output contract (briefs/lead4/L4-SE-OUTPUT-CONTRACT.md): five exact keys, `SavedEnvRegistryReady` "1" only beside the roles AND the template, and the broker's four variables;
//   4. nothing else: the broker's own identity policy has no `sts:AssumeRole`; no other new resource; the legacy (production) templates carry none of it;
//   5. the boundary and the deploy role, simulated FROM THE POLICY DOCUMENTS (contracts access-policies.ts): the broker may assume exactly those three roles, nobody else may, the fixed-name lookups and the ECR
//      template service-linked role are allowed and nothing wider is; the sizes stay under IAM's limits;
//   6. widening mutants, run against the same checker: a `*` resource, another prefix, extra actions, a widened trust, a KMS key, a custom role, and more, all refused.
import { isDeepStrictEqual } from "node:util";
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements, deployBoundaryStatements, savedEnvManageListSessionPolicy, savedEnvRepositoryName, serviceRoleStatements, type PolicyStatementJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import {
  ROLE_ACTIONS, SAVED_ENV_BROKER_VARIABLES, SAVED_ENV_OUTPUT_KEYS, SAVED_ENV_ROLE_KINDS, expectedAccessStatements, idsOf, roleNameOf, withoutSavedEnvAccess, withoutSavedEnvImages, type SavedEnvRoleKind,
} from "../support/saved-env-images-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: unknown };
type TemplateJson = { Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
type Statement = { Sid?: string; Effect: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
const stacksOf = (app: App) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const synth = (env: string | undefined, stackName: string): TemplateJson => {
  const stack = stacksOf(env === undefined ? buildAgentXApp() : buildAgentXApp({ agentxEnv: env })).find((candidate) => candidate.stackName === stackName)!;
  return Template.fromStack(stack).toJSON() as TemplateJson;
};
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const ENV = "staging";
const ACCOUNT = "111122223333";
const REGION = "us-west-2";

// ---------------------------------------------------------------------------------------------------------------- the checker
/** What the roles' own policies may hold, by kind (the push role without the scan actions: scanning is off in v1). */
const ALLOWED_ECR = ROLE_ACTIONS;

/** The whole of the registry side, as one checker. Throws a message naming the first thing that is not exactly as approved. Semantic checks first (what each statement could do), then the exact document. */
function check(input: TemplateJson, env: string): void {
  const template = structuredClone(input);
  const ids = idsOf(template);
  const prefixArn = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/${env}/*`;
  // Roles and their policies, in meaning.
  const resolve = resolver(template);
  for (const kind of SAVED_ENV_ROLE_KINDS) {
    const role = template.Resources[ids.roles[kind]]!;
    const trust = role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] };
    if (trust.Statement.length !== 1) throw new Error(`${kind}: the trust has ${trust.Statement.length} statements, not one`);
    const principal = JSON.stringify(trust.Statement[0]!.Principal);
    if (principal !== JSON.stringify({ AWS: { "Fn::GetAtt": [ids.brokerRole, "Arn"] } })) throw new Error(`${kind}: the trust names ${principal}, not the broker role alone`);
    if (JSON.stringify(trust.Statement[0]!.Action) !== '"sts:AssumeRole"' || trust.Statement[0]!.Effect !== "Allow" || trust.Statement[0]!.Condition !== undefined) throw new Error(`${kind}: the trust is not a plain sts:AssumeRole Allow`);
    if (role.Properties.MaxSessionDuration !== 3600) throw new Error(`${kind}: the session may last longer than 3,600 seconds`);
    if (role.Properties.RoleName !== roleNameOf(kind, env) || role.Properties.Path !== `/agentx/${env}/`) throw new Error(`${kind}: not the fixed name under the environment's path`);
    if ("Policies" in role.Properties || "ManagedPolicyArns" in role.Properties) throw new Error(`${kind}: the role carries a policy beyond the one the stack attaches`);
    const policy = template.Resources[ids.policies[kind]]!.Properties.PolicyDocument as { Statement: Statement[] };
    for (const statement of policy.Statement) {
      const actions = list(statement.Action);
      if (statement.Effect !== "Allow" || statement.NotAction !== undefined || actions.length === 0) throw new Error(`${kind}: ${statement.Sid} is not a plain Allow of named actions`);
      const resource = resolve(statement.Resource);
      if (resource === "*") {
        if (!isDeepStrictEqual(actions, ["ecr:GetAuthorizationToken"]) || kind === "Manage") throw new Error(`${kind}: ${statement.Sid} has resource * for ${actions.join(",")}`);
      } else if (resource !== prefixArn) {
        throw new Error(`${kind}: ${statement.Sid} names ${String(resource)}, not ${prefixArn}`);
      } else if (!isDeepStrictEqual(actions, [...ALLOWED_ECR[kind]])) {
        throw new Error(`${kind}: ${statement.Sid} has actions ${actions.join(",")}`);
      }
    }
  }
  // The creation template: one, exactly this.
  const creation = ofType(template, "AWS::ECR::RepositoryCreationTemplate");
  if (creation.length !== 1) throw new Error(`${creation.length} repository creation templates`);
  const properties = creation[0]![1].Properties;
  if (properties.Prefix !== `rovara-env/${env}`) throw new Error(`the template covers ${String(properties.Prefix)}`);
  if (JSON.stringify(properties.EncryptionConfiguration) !== '{"EncryptionType":"AES256"}') throw new Error("the template is not AES-256");
  if (properties.ImageTagMutability !== "IMMUTABLE") throw new Error("tags are not immutable");
  if ("CustomRoleArn" in properties || "ResourceTags" in properties) throw new Error("the template has a custom role or resource tags");
  // Nothing else new in the stack: the only IAM roles with an img name are the three; the broker's identity policy has no AssumeRole; no KMS key was added for it.
  const imgRoles = ofType(template, "AWS::IAM::Role").filter(([, role]) => /img/u.test(String(role.Properties.RoleName)));
  if (imgRoles.length !== 3) throw new Error(`${imgRoles.length} image roles`);
  for (const [, policy] of ofType(template, "AWS::IAM::Policy")) {
    if (!JSON.stringify(policy.Properties.Roles).includes(ids.brokerRole)) continue;
    for (const statement of (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement) {
      if (list(statement.Action).some((action) => /^(sts:|\*$)/iu.test(action)) || statement.NotAction !== undefined) throw new Error("the broker's identity policy has an sts statement");
    }
  }
  // The outputs and the broker's variables: exactly the contract's, "ready" only beside the roles AND the template.
  for (const key of SAVED_ENV_OUTPUT_KEYS) if (template.Outputs[key] === undefined) throw new Error(`output ${key} is missing`);
  const variables = (template.Resources[ids.brokerFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  for (const name of SAVED_ENV_BROKER_VARIABLES) if (variables[name] === undefined) throw new Error(`broker variable ${name} is missing`);
  // Finally the exact document: every property, and the removal leaves nothing behind (asserted by the support helper the digest pins use).
  withoutSavedEnvImages(template, env);
}

/** `Fn::Join` / `Ref` / `GetAtt` of one resource to a plain string, with a fixed account and region. */
function resolver(template: TemplateJson) {
  const resolveOne = (value: unknown): unknown => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(resolveOne);
    const record = value as Record<string, any> | null;
    if (record === null || typeof record !== "object") return value;
    if ("Ref" in record) return record.Ref === "AWS::Partition" ? "aws" : record.Ref === "AWS::AccountId" ? ACCOUNT : record.Ref === "AWS::Region" ? REGION : `<ref:${String(record.Ref)}>`;
    if ("Fn::GetAtt" in record) {
      const [id, attribute] = record["Fn::GetAtt"] as [string, string];
      const role = template.Resources[id];
      if (role?.Type === "AWS::IAM::Role" && attribute === "Arn") return `arn:aws:iam::${ACCOUNT}:role${String(role.Properties.Path ?? "/")}${String(role.Properties.RoleName ?? id)}`;
      return `<getatt:${id}.${attribute}>`;
    }
    if ("Fn::Join" in record) return (record["Fn::Join"][1] as unknown[]).map(resolveOne).join(record["Fn::Join"][0] as string);
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, resolveOne(inner)]));
  };
  return resolveOne as (value: unknown) => any;
}

// ---------------------------------------------------------------------------------------------------------------- the simulator (policy documents)
const globToRegExp = (pattern: string): RegExp => new RegExp(`^${pattern.split("").map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))).join("")}$`, "u");
const actionMatches = (pattern: string, action: string): boolean => globToRegExp(pattern.toLowerCase()).test(action.toLowerCase());
interface Request { action: string; resource: string; principalArn?: string; context?: Record<string, string> }

function conditionHolds(condition: Record<string, Record<string, unknown>> | undefined, request: Request): boolean {
  if (condition === undefined) return true;
  const context: Record<string, string | undefined> = { "aws:PrincipalArn": request.principalArn, ...request.context };
  for (const [operator, entries] of Object.entries(condition)) {
    for (const [key, expected] of Object.entries(entries)) {
      const actual = context[key];
      const wanted = list(expected as string | string[]).map(String);
      if (operator === "ArnEquals" || operator === "StringEquals") { if (actual === undefined || !wanted.includes(actual)) return false; }
      else if (operator === "ArnLike" || operator === "StringLike") { if (actual === undefined || !wanted.some((pattern) => globToRegExp(pattern).test(actual))) return false; }
      else throw new Error(`the simulator does not know the operator ${operator}`);
    }
  }
  return true;
}
function statementApplies(statement: PolicyStatementJson, request: Request): boolean {
  return list(statement.Action).some((pattern) => actionMatches(pattern, request.action)) && list(statement.Resource).some((pattern) => globToRegExp(pattern).test(request.resource)) && conditionHolds(statement.Condition, request);
}
/** IAM's rule for an identity policy under a boundary: allowed when both allow, and no Deny in either. */
function allowedUnderBoundary(identity: PolicyStatementJson[], boundary: PolicyStatementJson[], request: Request): boolean {
  const denied = [...identity, ...boundary].some((statement) => statement.Effect === "Deny" && statementApplies(statement, request));
  if (denied) return false;
  return identity.some((statement) => statement.Effect === "Allow" && statementApplies(statement, request)) && boundary.some((statement) => statement.Effect === "Allow" && statementApplies(statement, request));
}
/** What a role's own policy (from the synthesized template) allows, boundary applied. */
function roleStatements(template: TemplateJson, roleId: string): PolicyStatementJson[] {
  const resolve = resolver(template);
  return ofType(template, "AWS::IAM::Policy").filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(`"${roleId}"`)).flatMap(([, policy]) => (resolve(policy.Properties.PolicyDocument) as { Statement: PolicyStatementJson[] }).Statement);
}

// ---------------------------------------------------------------------------------------------------------------- the tests
describe("saved environment images: the registry side (L4-SE6)", () => {
  let named: TemplateJson;
  let longest: TemplateJson;
  let legacy: TemplateJson;
  let access: TemplateJson;
  const LONGEST_ENV = "a1234567890123456789";

  beforeAll(() => {
    named = synth(ENV, "agentx-staging-control-plane");
    access = synth(ENV, "agentx-staging-access");
    legacy = synth(undefined, "AgentXControlPlane");
    longest = synth(LONGEST_ENV, `agentx-${LONGEST_ENV}-control-plane`);
  }, 300_000);

  it("is exactly the approved shape (named staging, and the longest environment name)", () => {
    expect(() => check(named, ENV)).not.toThrow();
    expect(() => check(longest, LONGEST_ENV)).not.toThrow();
  });

  it("the three roles: fixed names under the environment's path, trusting only the broker role", () => {
    const ids = idsOf(named);
    for (const kind of SAVED_ENV_ROLE_KINDS) {
      const role = named.Resources[ids.roles[kind]]!;
      expect(role.Properties.RoleName).toBe(`agentx-staging-img-${kind.toLowerCase()}`);
      expect(role.Properties.Path).toBe("/agentx/staging/");
      expect(role.Properties.AssumeRolePolicyDocument).toEqual({ Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [ids.brokerRole, "Arn"] } } }], Version: "2012-10-17" });
      // The environment's boundary applies to each, as to every role of the stack.
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain("HasPermissionsBoundary");
    }
  });

  it("each role's policy: ECR on the one prefix only; the push role writes, the pull role reads, the manage role lists and deletes", () => {
    const ids = idsOf(named);
    const policies = Object.fromEntries(SAVED_ENV_ROLE_KINDS.map((kind) => [kind, roleStatements(named, ids.roles[kind])]));
    const prefix = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/staging/*`;
    const allow = (kind: SavedEnvRoleKind, action: string, resource: string) => policies[kind]!.some((statement) => statement.Effect === "Allow" && statementApplies(statement, { action, resource }));
    const inThisEnvironment = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/staging/o${"a".repeat(32)}/p${"b".repeat(32)}`;
    const otherEnvironment = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/prod/o${"a".repeat(32)}/p${"b".repeat(32)}`;
    const pullThrough = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/agentx-staging/library/node`;
    for (const [kind, actions] of Object.entries(ALLOWED_ECR) as Array<[SavedEnvRoleKind, readonly string[]]>) {
      for (const action of actions) {
        expect(allow(kind, action, inThisEnvironment), `${kind} ${action} here`).toBe(true);
        expect(allow(kind, action, otherEnvironment), `${kind} ${action} in another environment`).toBe(false);
        expect(allow(kind, action, pullThrough), `${kind} ${action} on the pull-through cache`).toBe(false);
      }
    }
    expect(policies.Push!.map((statement) => [statement.Sid, statement.Resource === "*" ? "*" : prefix === statement.Resource ? "prefix" : "other"])).toEqual([["RegistryToken", "*"], ["ThisEnvironmentsImages", "prefix"]]);
    expect(policies.Pull!.map((statement) => statement.Sid)).toEqual(["RegistryToken", "ThisEnvironmentsImages"]);
    expect(policies.Manage!.map((statement) => statement.Sid)).toEqual(["ThisEnvironmentsImages"]);
    // What each must NOT do, wherever it is.
    for (const [kind, action] of [["Push", "ecr:DeleteRepository"], ["Push", "ecr:BatchDeleteImage"], ["Push", "ecr:SetRepositoryPolicy"], ["Push", "ecr:StartImageScan"], ["Pull", "ecr:PutImage"], ["Pull", "ecr:InitiateLayerUpload"],
      ["Pull", "ecr:BatchDeleteImage"], ["Manage", "ecr:PutImage"], ["Manage", "ecr:GetDownloadUrlForLayer"], ["Manage", "ecr:BatchGetImage"], ["Manage", "ecr:GetAuthorizationToken"], ["Manage", "ecr:CreateRepository"]] as const) {
      expect(allow(kind, action, inThisEnvironment) || allow(kind, action, "*"), `${kind} ${action}`).toBe(false);
    }
    // No role may use KMS, STS, IAM, S3 or anything outside ECR.
    for (const kind of SAVED_ENV_ROLE_KINDS) for (const statement of policies[kind]!) for (const action of list(statement.Action)) expect(action, `${kind} ${String(statement.Sid)}`).toMatch(/^ecr:/u);
  });

  it("one creation template for rovara-env/staging: AES-256, immutable tags, the lifecycle and repository policies, no KMS, no custom role, no tags", () => {
    const templates = ofType(named, "AWS::ECR::RepositoryCreationTemplate");
    expect(templates).toHaveLength(1);
    const properties = templates[0]![1].Properties;
    expect(Object.keys(properties).sort()).toEqual(["AppliedFor", "Description", "EncryptionConfiguration", "ImageTagMutability", "LifecyclePolicy", "Prefix", "RepositoryPolicy"]);
    expect(properties).toMatchObject({ Prefix: "rovara-env/staging", AppliedFor: ["CREATE_ON_PUSH"], ImageTagMutability: "IMMUTABLE", EncryptionConfiguration: { EncryptionType: "AES256" } });
    expect(JSON.parse(properties.LifecyclePolicy as string).rules.map((rule: { rulePriority: number }) => rule.rulePriority)).toEqual([1, 2]);
    const policy = resolver(named)(properties.RepositoryPolicy) as string;
    const document = JSON.parse(policy) as { Statement: Statement[] };
    expect(document.Statement.map((statement) => [statement.Sid, statement.Effect])).toEqual([["OnlyTheRolesMayRead", "Deny"], ["OnlyThePushRoleMayWrite", "Deny"], ["OnlyTheManageRoleMayDeleteImages", "Deny"]]);
    expect(policy).toContain("arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-img-push");
    expect(ofType(named, "AWS::KMS::Key").filter(([id, key]) => /SavedEnv/u.test(id) || /rovara-env|saved environment/iu.test(JSON.stringify(key))).length).toBe(0);
  });

  it("publishes the output contract: five exact keys, ready only with the roles and the template, and the broker gets the four values", () => {
    const ids = idsOf(named);
    expect(SAVED_ENV_OUTPUT_KEYS).toEqual(["SavedEnvImgPushRoleArn", "SavedEnvImgPullRoleArn", "SavedEnvImgManageRoleArn", "SavedEnvRepoPrefix", "SavedEnvRegistryReady"]);
    const resolve = resolver(named);
    expect(Object.fromEntries(SAVED_ENV_OUTPUT_KEYS.map((key) => [key, resolve(named.Outputs[key]!.Value)]))).toEqual({
      SavedEnvImgPushRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-push`,
      SavedEnvImgPullRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-pull`,
      SavedEnvImgManageRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-manage`,
      SavedEnvRepoPrefix: "rovara-env/staging",
      SavedEnvRegistryReady: "1",
    });
    expect(ids.creationTemplate).toBeDefined();
    const variables = (named.Resources[ids.brokerFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.fromEntries(SAVED_ENV_BROKER_VARIABLES.map((name) => [name, resolve(variables[name])]))).toEqual({
      ROVARA_SAVED_ENV_PUSH_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-push`,
      ROVARA_SAVED_ENV_PULL_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-pull`,
      ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-manage`,
      ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/staging",
    });
    // Another stack of the install publishes none of the five keys.
    for (const stackName of ["agentx-staging-foundation", "agentx-staging-runtime", "agentx-staging-identity", "agentx-staging-slack"]) {
      const other = synth(ENV, stackName);
      for (const key of SAVED_ENV_OUTPUT_KEYS) expect(other.Outputs?.[key], `${stackName} ${key}`).toBeUndefined();
    }
  });

  it("the broker's own identity policy is untouched: no sts statement of any kind (the trust and the boundary carry the AssumeRole)", () => {
    const ids = idsOf(named);
    const statements = roleStatements(named, ids.brokerRole);
    expect(statements.filter((statement) => list(statement.Action).some((action) => /^sts:/iu.test(action)))).toEqual([]);
    expect(JSON.stringify(statements)).not.toContain("img-");
  });

  it("adds nothing else: the stack's new resources are the three roles, their three policies and the template, and (#1148) the legacy template has the same seven, under rovara-env/production", () => {
    const added = Object.keys(named.Resources).filter((id) => id.startsWith("SavedEnvImages"));
    expect(added).toHaveLength(7);
    expect(Object.keys(legacy.Resources).filter((id) => id.startsWith("SavedEnvImages"))).toHaveLength(7);
    expect(JSON.stringify(legacy)).toContain("rovara-env/production");
    for (const key of SAVED_ENV_OUTPUT_KEYS) expect(legacy.Outputs?.[key], key).toBeDefined();
  });

  it("the boundary names the broker role exactly as the template creates it", () => {
    const ids = idsOf(named);
    const resolve = resolver(named);
    const broker = named.Resources[ids.brokerRole]!;
    expect(broker.Properties.RoleName).toBe("agentx-staging-broker-role");
    const brokerArn = `arn:aws:iam::${ACCOUNT}:role${String(broker.Properties.Path)}${String(broker.Properties.RoleName)}`;
    const { runtimeBoundary } = expectedAccessStatements(ENV);
    const assume = runtimeBoundary.find((statement) => statement.Sid === "AssumeSessionRoles")!;
    expect(resolveAccess(assume.Condition)).toEqual({ ArnEquals: { "aws:PrincipalArn": brokerArn } });
    expect(list(resolveAccess(assume.Resource) as string[]).sort()).toEqual(SAVED_ENV_ROLE_KINDS.map((kind) => String(resolve({ "Fn::GetAtt": [ids.roles[kind], "Arn"] }))).sort());
  });

  describe("the deploy role and the default boundary (simulated from the policy documents; a template diff misses the boundary)", () => {
    const scope = { env: ENV, partition: "aws", region: REGION, account: ACCOUNT, cloudFormationRoleName: "agentx-staging-cloudformation", artifactBucketArn: "arn:aws:s3:::agentx-staging-artifacts", pullThroughPrefix: "agentx-staging" } as const;
    const boundary = defaultBoundaryStatements(scope);
    // TWO-BOUNDARIES: the roles a template creates (the broker and the saved environment roles) are capped by the runtime boundary; the CloudFormation service role by the deploy boundary.
    const deployBoundary = deployBoundaryStatements(scope);
    const deploy = serviceRoleStatements({ ...scope, permissionsBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/agentx/staging/agentx-staging-boundary` });
    const brokerArn = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-broker-role`;
    const imgArn = (kind: string) => `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-${kind}`;
    // The broker's role has no sts statement of its own: AssumeRole comes from the trust policies, the boundary is the ceiling. So "allowed" for the broker is: a trust names it AND the boundary allows.
    const brokerMayAssume = (resource: string, action = "sts:AssumeRole", principalArn = brokerArn): boolean => {
      const trusted = ["push", "pull", "manage"].some((kind) => imgArn(kind) === resource) && principalArn === brokerArn;
      return trusted && boundary.some((statement) => statement.Effect === "Allow" && statementApplies(statement, { action, resource, principalArn })) && !boundary.some((statement) => statement.Effect === "Deny" && statementApplies(statement, { action, resource, principalArn }));
    };
    const boundaryAllows = (action: string, resource: string, principalArn?: string): boolean => boundary.some((statement) => statement.Effect === "Allow" && statementApplies(statement, { action, resource, ...(principalArn === undefined ? {} : { principalArn }) })) && !boundary.some((statement) => statement.Effect === "Deny" && statementApplies(statement, { action, resource, ...(principalArn === undefined ? {} : { principalArn }) }));

    it("the broker role may assume each of the three roles, and the boundary has no other sts:AssumeRole", () => {
      for (const kind of ["push", "pull", "manage"]) {
        expect(brokerMayAssume(imgArn(kind)), kind).toBe(true);
        expect(boundaryAllows("sts:AssumeRole", imgArn(kind), brokerArn), `boundary ${kind}`).toBe(true);
      }
      // The runtime boundary's other assume is the Slack service's, on its one token reader role (R5; its tests are in slack-company-token-reader-infrastructure.test.ts). The deploy boundary has none.
      expect(boundary.filter((statement) => list(statement.Action).some((action) => /^sts:(AssumeRole|\*)/u.test(action))).map((statement) => statement.Sid)).toEqual(["AssumeSessionRoles", "SlackTokenReader"]);
      expect(deployBoundary.filter((statement) => list(statement.Action).some((action) => /^sts:(AssumeRole|\*)/u.test(action)))).toEqual([]);
      expect(boundaryAllows("sts:AssumeRole", imgArn("push"), `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-control-plane-SlackOrchestratorTaskRole-ABC`)).toBe(false);
    });

    it("no other principal may assume them, and the broker may assume nothing else", () => {
      const dispatcher = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-control-plane-DispatcherServiceRole-ABCDEF`;
      const worker = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-runtime-WorkerRole-ABCDEF`;
      const operator = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-operator`;
      for (const principal of [dispatcher, worker, operator, `arn:aws:iam::${ACCOUNT}:root`, `arn:aws:iam::${ACCOUNT}:role/agentx/other/agentx-other-broker-role`, `${brokerArn}-x`]) {
        for (const kind of ["push", "pull", "manage"]) expect(boundaryAllows("sts:AssumeRole", imgArn(kind), principal), `${principal} ${kind}`).toBe(false);
      }
      for (const resource of [
        `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-create`, `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-*`, `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-other`,
        `arn:aws:iam::${ACCOUNT}:role/agentx-staging-img-push`, `arn:aws:iam::${ACCOUNT}:role/agentx/prod/agentx-prod-img-push`, `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-broker-role`,
        `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-company-secrets`, `arn:aws:iam::210987654321:role/agentx/staging/agentx-staging-img-push`, `arn:aws:iam::${ACCOUNT}:role/agentx-staging-operator`,
      ]) {
        expect(boundaryAllows("sts:AssumeRole", resource, brokerArn), resource).toBe(false);
      }
      expect(boundaryAllows("sts:TagSession", imgArn("push"), brokerArn)).toBe(false);
      expect(boundaryAllows("sts:AssumeRoleWithWebIdentity", imgArn("push"), brokerArn)).toBe(false);
      expect(boundaryAllows("sts:*", imgArn("push"), brokerArn)).toBe(false);
    });

    it("a bounded role cannot reach what the three roles can, whatever it holds: another environment's repositories are outside every role policy (simulated through the template's own policies)", () => {
      const ids = idsOf(named);
      const other = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/prod/o${"a".repeat(32)}/p${"b".repeat(32)}`;
      for (const kind of SAVED_ENV_ROLE_KINDS) for (const action of ALLOWED_ECR[kind]) {
        expect(allowedUnderBoundary(roleStatements(named, ids.roles[kind]), boundary, { action, resource: other }), `${kind} ${action}`).toBe(false);
      }
    });

    it("the deploy role may look the three fixed-name roles up by their path-less ARN (and delete them on a rolled-back create), never create or change one", () => {
      const lookups = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRole"];
      for (const kind of ["push", "pull", "manage"]) {
        const resource = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-img-${kind}`;
        for (const action of lookups) expect(allowedUnderBoundary(deploy, deployBoundary, { action, resource }), `${kind} ${action}`).toBe(true);
        for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:PutRolePermissionsBoundary", "iam:TagRole"]) {
          expect(allowedUnderBoundary(deploy, deployBoundary, { action, resource, context: { "iam:PermissionsBoundary": `arn:aws:iam::${ACCOUNT}:policy/agentx/staging/agentx-staging-boundary` } }), `${kind} ${action}`).toBe(false);
        }
      }
      for (const resource of [`arn:aws:iam::${ACCOUNT}:role/agentx-staging-broker-role`, `arn:aws:iam::${ACCOUNT}:role/agentx-staging-img-create`, `arn:aws:iam::${ACCOUNT}:role/agentx-staging-img-*`, `arn:aws:iam::${ACCOUNT}:role/agentx-prod-img-push`, `arn:aws:iam::${ACCOUNT}:role/agentx-staging-operator`]) {
        expect(allowedUnderBoundary(deploy, deployBoundary, { action: "iam:GetRole", resource }), resource).toBe(false);
      }
    });

    it("the deploy role may create ECR's repository creation template service-linked role, and no other", () => {
      const ecr = `arn:aws:iam::${ACCOUNT}:role/aws-service-role/ecr.amazonaws.com/AWSServiceRoleForECRTemplate`;
      expect(allowedUnderBoundary(deploy, deployBoundary, { action: "iam:CreateServiceLinkedRole", resource: ecr, context: { "iam:AWSServiceName": "ecr.amazonaws.com" } })).toBe(true);
      for (const [resource, service] of [
        [ecr, "replication.ecr.amazonaws.com"], [ecr, "ecs.amazonaws.com.evil"], [ecr, "inspector2.amazonaws.com"],
        [`arn:aws:iam::${ACCOUNT}:role/aws-service-role/ecr.amazonaws.com/AWSServiceRoleForECRReplication`, "ecr.amazonaws.com"],
        [`arn:aws:iam::${ACCOUNT}:role/aws-service-role/inspector2.amazonaws.com/AWSServiceRoleForAmazonInspector2`, "inspector2.amazonaws.com"],
        [`arn:aws:iam::210987654321:role/aws-service-role/ecr.amazonaws.com/AWSServiceRoleForECRTemplate`, "ecr.amazonaws.com"],
      ] as const) {
        expect(allowedUnderBoundary(deploy, deployBoundary, { action: "iam:CreateServiceLinkedRole", resource, context: { "iam:AWSServiceName": service } }), `${resource} ${service}`).toBe(false);
      }
    });

    it("the statements the access template holds are exactly contracts' (asserted and taken out), and nothing else in the access stack changed in meaning", () => {
      const stripped = withoutSavedEnvAccess(structuredClone(access), ENV);
      expect(JSON.stringify(stripped)).not.toMatch(/AssumeSessionRoles|IamFixedNameRolesNotYetCreated|EcrTemplateServiceLinkedRole/u);
      expect(expectedAccessStatements(ENV).runtimeBoundary.map((statement) => statement.Sid)).toEqual(["AssumeSessionRoles"]);
      expect(expectedAccessStatements(ENV).deployBoundary.map((statement) => statement.Sid)).toEqual(["IamFixedNameRolesNotYetCreated", "EcrTemplateServiceLinkedRole"]);
      expect(expectedAccessStatements(ENV).deploy.map((statement) => statement.Sid)).toEqual(["IamFixedNameRolesNotYetCreated", "EcrTemplateServiceLinkedRole"]);
    });

    it("stays under IAM's size limits: the managed boundary under 6,144 characters, the deploy role's inline policy under 10,240 (compact JSON, the longest environment name)", () => {
      for (const env of ["staging", "a1234567890123456789"]) {
        const longScope = { ...scope, env, cloudFormationRoleName: `agentx-${env}-cloudformation`, pullThroughPrefix: `agentx-${env}` };
        const boundarySize = JSON.stringify({ Version: "2012-10-17", Statement: deployBoundaryStatements(longScope) }).length;
        const deploySize = JSON.stringify({ Version: "2012-10-17", Statement: serviceRoleStatements({ ...longScope, permissionsBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/agentx/${env}/agentx-${env}-boundary` }) }).length;
        // The headroom was 1,024 characters; the release pipeline denies, the CloudFormation role rules (F1) and the boundary's own role rules (F2) use most of it (the policy is about 5,940 of 6,144
        // at the longest name), so the pin is now 128. tests/contract/release-access-denies.test.ts holds the same pin for the placeholder name the export bundle renders.
        expect(boundarySize, `${env} boundary`).toBeLessThanOrEqual(6144 - 128);
        expect(deploySize, `${env} deploy`).toBeLessThanOrEqual(10240 - 1024);
      }
    });
  });

  // L4-SE6b (owner-approved 2026-11-18): company erase lists ONE company's repositories. The manage role ALREADY holds ecr:DescribeRepositories on `rovara-env/<env>/*` (asserted here), so this adds NO role,
  // boundary, template or deploy-role change: only a session policy (contracts savedEnvManageListSessionPolicy). Effective permission of such a session = the role's policy AND the session policy AND the boundary.
  describe("the company listing session (L4-SE6b): effective permission, simulated from the template's manage role and the session policy", () => {
    const scope = { partition: "aws", region: REGION, account: ACCOUNT };
    const A = "org_aaaaaaaaaaaaaaaaaaaa";
    const B = "org_bbbbbbbbbbbbbbbbbbbb";
    const repoArn = (company: string, project: string, env = ENV) => `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${savedEnvRepositoryName({ env, orgId: company, projectId: project })}`;
    const session = savedEnvManageListSessionPolicy(scope, { env: ENV, orgId: A }).Statement as unknown as PolicyStatementJson[];
    const managePolicy = (template: TemplateJson) => roleStatements(template, idsOf(template).roles.Manage);
    /** Role policy AND session policy (IAM intersects a session policy with the role's identity policy; the helper's "boundary" slot is exactly that second intersection). */
    const effective = (template: TemplateJson, action: string, resource: string): boolean => allowedUnderBoundary(managePolicy(template), session, { action, resource });

    it("the manage role already allows ecr:DescribeRepositories on rovara-env/<env>/* (so no role, template, boundary or deploy-role change is needed)", () => {
      const statement = managePolicy(named).find((candidate) => candidate.Sid === "ThisEnvironmentsImages")!;
      expect(list(statement.Action)).toContain("ecr:DescribeRepositories");
      expect(JSON.stringify(statement.Resource)).toContain("rovara-env/staging/*");
    });

    it("describes company A's repositories, any project, and nothing else of A's session", () => {
      for (const project of ["project-1", "project-2", "x"]) expect(effective(named, "ecr:DescribeRepositories", repoArn(A, project)), project).toBe(true);
      for (const action of ["ecr:ListImages", "ecr:DescribeImages", "ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:GetRepositoryPolicy", "ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:PutImage", "ecr:CreateRepository", "ecr:*", "*"]) {
        expect(effective(named, action, repoArn(A, "project-1")), action).toBe(false);
      }
    });

    it("cannot describe company B's repositories, another environment's, or the environment as a whole", () => {
      expect(effective(named, "ecr:DescribeRepositories", repoArn(B, "project-1"))).toBe(false);
      expect(effective(named, "ecr:DescribeRepositories", repoArn(A, "project-1", "prod"))).toBe(false);
      expect(effective(named, "ecr:DescribeRepositories", `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/staging/*`)).toBe(false);
      expect(effective(named, "ecr:DescribeRepositories", `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/*`)).toBe(false);
      expect(effective(named, "ecr:DescribeRepositories", `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/other/repo`)).toBe(false);
    });

    it("the widening mutants of the session policy are caught: env-wide listing, another company's prefix, extra actions, a `*` resource", () => {
      const wide = (statement: Record<string, unknown>) => [{ ...(session[0] as unknown as Record<string, unknown>), ...statement }] as unknown as PolicyStatementJson[];
      const bOnly = savedEnvManageListSessionPolicy(scope, { env: ENV, orgId: B }).Statement as unknown as PolicyStatementJson[];
      const allowed = (policy: PolicyStatementJson[], action: string, resource: string) => allowedUnderBoundary(managePolicy(named), policy, { action, resource });
      // the real policy passes the checks the mutants must fail
      const checks: Array<[string, string, boolean]> = [["ecr:DescribeRepositories", repoArn(A, "p"), true], ["ecr:DescribeRepositories", repoArn(B, "p"), false], ["ecr:ListImages", repoArn(A, "p"), false], ["ecr:BatchDeleteImage", repoArn(A, "p"), false]];
      const verdicts = (policy: PolicyStatementJson[]) => checks.map(([action, resource]) => allowed(policy, action, resource));
      const expected = checks.map(([, , want]) => want);
      expect(verdicts(session)).toEqual(expected);
      const mutants: Array<[string, PolicyStatementJson[]]> = [
        ["env-wide listing", wide({ Resource: `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/rovara-env/staging/*` })],
        ["another company's prefix", bOnly],
        ["both companies", wide({ Resource: [repoArn(A, "p").replace(/\/p[0-9a-f]{32}$/u, "/*"), repoArn(B, "p").replace(/\/p[0-9a-f]{32}$/u, "/*")] })],
        ["an extra action (ListImages)", wide({ Action: ["ecr:DescribeRepositories", "ecr:ListImages"] })],
        ["an extra action (BatchDeleteImage)", wide({ Action: ["ecr:DescribeRepositories", "ecr:BatchDeleteImage"] })],
        ["every ECR action", wide({ Action: ["ecr:*"] })],
        ["a * resource", wide({ Resource: "*" })],
      ];
      for (const [label, mutant] of mutants) expect(verdicts(mutant), label).not.toEqual(expected);
    });
  });

  describe("widening mutants fail the same checker", () => {
    const clone = (): TemplateJson => structuredClone(named);
    const policyOf = (template: TemplateJson, kind: SavedEnvRoleKind): { Statement: Array<Record<string, any>> } => template.Resources[idsOf(template).policies[kind]]!.Properties.PolicyDocument;
    const roleOf = (template: TemplateJson, kind: SavedEnvRoleKind): Resource => template.Resources[idsOf(template).roles[kind]]!;
    const creationOf = (template: TemplateJson): Resource => template.Resources[idsOf(template).creationTemplate]!;
    const brokerPolicy = (template: TemplateJson): { Statement: unknown[] } => ofType(template, "AWS::IAM::Policy").find(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(idsOf(template).brokerRole))![1].Properties.PolicyDocument;
    const mutants: Array<[string, (template: TemplateJson) => void]> = [
      ["M1 the push role's images resource is *", (t) => { policyOf(t, "Push").Statement[1]!.Resource = "*"; }],
      ["M2 the push role's images resource is another prefix (the pull-through cache)", (t) => { policyOf(t, "Push").Statement[1]!.Resource = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":repository/agentx-staging/*"]] }; }],
      ["M3 the pull role's images resource is every saved environment (rovara-env/*)", (t) => { policyOf(t, "Pull").Statement[1]!.Resource = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":repository/rovara-env/*"]] }; }],
      ["M4 the manage role's images resource is another environment", (t) => { policyOf(t, "Manage").Statement[0]!.Resource = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":repository/rovara-env/prod/*"]] }; }],
      ["M5 the pull role may write (PutImage)", (t) => { policyOf(t, "Pull").Statement[1]!.Action.push("ecr:PutImage"); }],
      ["M6 the manage role is ecr:*", (t) => { policyOf(t, "Manage").Statement[0]!.Action = ["ecr:*"]; }],
      ["M7 the push role may delete the repository", (t) => { policyOf(t, "Push").Statement[1]!.Action.push("ecr:DeleteRepository"); }],
      ["M8 the push role gets the scan actions back (scanning is off)", (t) => { policyOf(t, "Push").Statement[1]!.Action.push("ecr:StartImageScan", "ecr:DescribeImageScanFindings"); }],
      ["M9 the manage role gets the registry token", (t) => { policyOf(t, "Manage").Statement.unshift({ Sid: "RegistryToken", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" }); }],
      ["M10 the token statement allows more than the token call", (t) => { policyOf(t, "Pull").Statement[0]!.Action = ["ecr:GetAuthorizationToken", "ecr:BatchGetImage"]; }],
      ["M11 a role policy gains a non-ECR statement (s3:*)", (t) => { policyOf(t, "Push").Statement.push({ Sid: "More", Effect: "Allow", Action: "s3:*", Resource: "*" }); }],
      ["M12 the trust is any AWS principal", (t) => { roleOf(t, "Push").Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: "*" }; }],
      ["M13 the trust is the account root", (t) => { roleOf(t, "Pull").Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }; }],
      ["M14 the trust adds a second principal (the dispatcher role)", (t) => { roleOf(t, "Manage").Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: [{ "Fn::GetAtt": [idsOf(t).brokerRole, "Arn"] }, { "Fn::GetAtt": [Object.keys(t.Resources).find((id) => /^DispatcherServiceRole/u.test(id))!, "Arn"] }] }; }],
      ["M15 the trust is another role", (t) => { roleOf(t, "Push").Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: { "Fn::GetAtt": [Object.keys(t.Resources).find((id) => /^DispatcherServiceRole/u.test(id))!, "Arn"] } }; }],
      ["M16 the trust adds a service principal", (t) => { roleOf(t, "Pull").Properties.AssumeRolePolicyDocument.Statement.push({ Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" } }); }],
      ["M17 the trust action is sts:*", (t) => { roleOf(t, "Manage").Properties.AssumeRolePolicyDocument.Statement[0].Action = "sts:*"; }],
      ["M18 the trust gains TagSession", (t) => { roleOf(t, "Push").Properties.AssumeRolePolicyDocument.Statement[0].Action = ["sts:AssumeRole", "sts:TagSession"]; }],
      ["M19 a session may last 12 hours", (t) => { roleOf(t, "Push").Properties.MaxSessionDuration = 43200; }],
      ["M20 the role sits at the root path", (t) => { roleOf(t, "Pull").Properties.Path = "/"; }],
      ["M21 the role has another name", (t) => { roleOf(t, "Pull").Properties.RoleName = "agentx-staging-img-pull2"; }],
      ["M22 the role carries an inline policy of its own", (t) => { roleOf(t, "Push").Properties.Policies = [{ PolicyName: "x", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] } }]; }],
      ["M23 a fourth image role (img-create) is added", (t) => { t.Resources.SavedEnvImagesCreateRole00000000 = { Type: "AWS::IAM::Role", Properties: { RoleName: "agentx-staging-img-create", AssumeRolePolicyDocument: { Statement: [] } } }; }],
      ["M24 the template uses KMS", (t) => { creationOf(t).Properties.EncryptionConfiguration = { EncryptionType: "KMS", KmsKey: "arn:aws:kms:us-west-2:111122223333:key/x" }; }],
      ["M25 the template names a custom creation role", (t) => { creationOf(t).Properties.CustomRoleArn = "arn:aws:iam::111122223333:role/x"; }],
      ["M26 the template carries resource tags", (t) => { creationOf(t).Properties.ResourceTags = [{ Key: "a", Value: "b" }]; }],
      ["M27 tags are mutable", (t) => { creationOf(t).Properties.ImageTagMutability = "MUTABLE"; }],
      ["M28 the template covers every repository (ROOT)", (t) => { creationOf(t).Properties.Prefix = "ROOT"; }],
      ["M29 the template covers the whole rovara-env prefix", (t) => { creationOf(t).Properties.Prefix = "rovara-env"; }],
      ["M30 the repository policy loses its read Deny", (t) => { creationOf(t).Properties.RepositoryPolicy["Fn::Join"][1][0] = (creationOf(t).Properties.RepositoryPolicy["Fn::Join"][1][0] as string).replace('"Effect":"Deny","Principal":"*","Action":["ecr:BatchGetImage"', '"Effect":"Allow","Principal":"*","Action":["ecr:BatchGetImage"'); }],
      ["M31 a second creation template for another prefix", (t) => { t.Resources.SavedEnvImagesCreationTemplateABCDEF12 = structuredClone(creationOf(t)); }],
      ["M32 the broker's identity policy may assume any role", (t) => { brokerPolicy(t).Statement.push({ Effect: "Allow", Action: "sts:AssumeRole", Resource: "*" }); }],
      ["M33 the broker's identity policy gains a NotAction statement", (t) => { brokerPolicy(t).Statement.push({ Effect: "Allow", NotAction: "s3:*", Resource: "*" }); }],
      ["M34 the ready output is gone", (t) => { delete t.Outputs.SavedEnvRegistryReady; }],
      ["M35 ready is 'true'", (t) => { t.Outputs.SavedEnvRegistryReady!.Value = "true"; }],
      ["M36 the creation template is gone but ready stays", (t) => { delete t.Resources[idsOf(t).creationTemplate]; }],
      ["M37 the push output names the pull role", (t) => { t.Outputs.SavedEnvImgPushRoleArn!.Value = { "Fn::GetAtt": [idsOf(t).roles.Pull, "Arn"] }; }],
      ["M38 the prefix output is another prefix", (t) => { t.Outputs.SavedEnvRepoPrefix!.Value = "rovara-env/prod"; }],
      ["M39 the broker's push variable names the manage role", (t) => { ((t.Resources[idsOf(t).brokerFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables).ROVARA_SAVED_ENV_PUSH_ROLE_ARN = { "Fn::GetAtt": [idsOf(t).roles.Manage, "Arn"] }; }],
      ["M40 the broker's prefix variable is missing", (t) => { delete ((t.Resources[idsOf(t).brokerFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables).ROVARA_SAVED_ENV_REPO_PREFIX; }],
    ];
    it("the unmutated template passes", () => { expect(() => check(clone(), ENV)).not.toThrow(); });
    for (const [label, mutate] of mutants) {
      it(`${label} is refused`, () => {
        const mutated = clone();
        expect(() => mutate(mutated), "the mutant itself applies").not.toThrow();
        expect(isDeepStrictEqual(mutated, named), "the mutant changed the template").toBe(false);
        expect(() => check(mutated, ENV)).toThrow(/.+/u);
      });
    }
  });
});

/** The access statements' Fn::Join pieces, flattened to plain ARNs (partition `aws`, account 111122223333) for the test above. */
function resolveAccess(value: unknown): unknown {
  return resolver({ Resources: {}, Outputs: {} })(value);
}
