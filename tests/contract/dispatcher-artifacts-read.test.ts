// L4-IAMR (owner decision 2026-11-18, DEC 254zzz26): the dispatcher's role may read the artifacts bucket's `private/*` and `workspaces/*` keys, so its company-bound artifact reader
// (createCompanyArtifactReader, for example the second eval pass) does not fail closed. What must hold:
//   1. exactly one new statement, in a named environment's control plane: Allow, s3:GetObject only, the bucket's own ARN with `/private/*` and `/workspaces/*`;
//   2. nothing wider: no list, no put, no delete, no `*` resource, no other prefix, no other bucket, no KMS (the bucket is S3-managed encrypted, so there is no key to grant);
//   3. the permissions boundary and the deploy role allow it (evaluated from code, no AWS call), and the deploy role needs no new action to put it on the dispatcher's role;
//   4. the legacy template does not change.
import { isDeepStrictEqual } from "node:util";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { defaultBoundaryArn, defaultBoundaryStatements, deployBoundaryStatements, serviceRoleStatements, type PolicyScope, type PolicyStatementJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack, DISPATCHER_ARTIFACTS_READ_PREFIXES, DISPATCHER_ARTIFACTS_READ_SID } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; NotAction?: string | string[]; Resource: unknown; Condition?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
type Json = { Resources: Record<string, Resource> };

const named = new ControlPlaneStack(new App(), "IamrNamedControlPlane", { naming: environmentNaming("staging") });
const namedJson = Template.fromStack(named).toJSON() as Json;
const legacyJson = Template.fromStack(new ControlPlaneStack(new App(), "IamrLegacyControlPlane")).toJSON() as Json;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const bucketIdOf = (json: Json): string => {
  const buckets = Object.entries(json.Resources).filter(([id, resource]) => resource.Type === "AWS::S3::Bucket" && /^Artifacts[0-9A-F]{8}$/u.test(id));
  expect(buckets).toHaveLength(1);
  return buckets[0]![0];
};
const dispatcherRoleIdOf = (json: Json): string => {
  const fn = Object.entries(json.Resources).find(([id, resource]) => /^Dispatcher[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
  return ((fn[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
};
/** The statements of every inline policy on the dispatcher's role. */
const dispatcherStatements = (json: Json): Statement[] => {
  const roleId = dispatcherRoleIdOf(json);
  return Object.values(json.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleId))
    .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
};
const objectsArn = (bucketId: string, key: string) => ({ "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, `/${key}`]] });

/** The one statement, exactly. */
const expectedStatement = (json: Json): Statement => ({
  Sid: "ReadCompanyArtifacts",
  Effect: "Allow",
  Action: "s3:GetObject",
  Resource: [objectsArn(bucketIdOf(json), "private/*"), objectsArn(bucketIdOf(json), "workspaces/*")],
});
/** The admission read the dispatcher already had (one prefix, GetObject only). */
const admissionStatement = (json: Json): Statement => ({ Effect: "Allow", Action: "s3:GetObject", Resource: objectsArn(bucketIdOf(json), "workflow-e2e-admissions/*") });

/**
 * What the dispatcher's role may do on S3 and KMS, as violations: any S3 or KMS statement other than the two exact ones (the admission read it already had and this lane's), and a
 * missing or inexact one. An empty list is the passing case; every widening below must make it non-empty.
 */
function violations(json: Json): string[] {
  const found: string[] = [];
  const statements = dispatcherStatements(json);
  // A statement with NotAction (or no Action) reaches S3 and KMS too, so it counts as touching them (review L1).
  const touching = statements.filter((statement) => "NotAction" in statement || statement.Action === undefined || list(statement.Action).some((action) => /^(s3:|\*)/u.test(String(action))));
  // KMS: the dispatcher already signs with the invoke signing key (kms:Sign) and nothing else; any other KMS action (Decrypt, GenerateDataKey, ...) is a violation.
  const kmsOther = statements.flatMap((statement) => list(statement.Action)).filter((action) => /^kms:/u.test(String(action)) && action !== "kms:Sign");
  if (kmsOther.length > 0) found.push(`KMS actions on the dispatcher beyond kms:Sign: ${kmsOther.join(",")}`);
  const own = touching.filter((statement) => statement.Sid === DISPATCHER_ARTIFACTS_READ_SID);
  if (own.length !== 1) found.push(`expected exactly one ${DISPATCHER_ARTIFACTS_READ_SID} statement, found ${own.length}`);
  else if (!isDeepStrictEqual(own[0], expectedStatement(json))) found.push(`the ${DISPATCHER_ARTIFACTS_READ_SID} statement is not the exact one: ${JSON.stringify(own[0])}`);
  const rest = touching.filter((statement) => statement.Sid !== DISPATCHER_ARTIFACTS_READ_SID);
  if (rest.length !== 1 || !isDeepStrictEqual(rest[0], admissionStatement(json))) found.push(`other S3 or KMS statements on the dispatcher: ${JSON.stringify(rest)}`);
  return found;
}

/** A copy of the named template with the dispatcher's S3 statement changed by `change`. */
function mutated(change: (statement: Statement, bucketId: string) => void): Json {
  const copy = structuredClone(namedJson);
  const bucketId = bucketIdOf(copy);
  const roleId = dispatcherRoleIdOf(copy);
  let changed = 0;
  for (const resource of Object.values(copy.Resources)) {
    if (resource.Type !== "AWS::IAM::Policy" || !JSON.stringify(resource.Properties.Roles).includes(roleId)) continue;
    for (const statement of (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement) {
      if (statement.Sid === DISPATCHER_ARTIFACTS_READ_SID) { change(statement, bucketId); changed += 1; }
    }
  }
  expect(changed).toBe(1);
  return copy;
}

describe("the dispatcher's read of company artifacts (L4-IAMR)", () => {
  it("names the owner's two prefixes and nothing else", () => {
    expect([...DISPATCHER_ARTIFACTS_READ_PREFIXES]).toEqual(["private/*", "workspaces/*"]);
    expect(DISPATCHER_ARTIFACTS_READ_SID).toBe("ReadCompanyArtifacts");
  });

  it("gives a named environment's dispatcher exactly one new statement: Allow, s3:GetObject, the bucket's private/* and workspaces/*", () => {
    const own = dispatcherStatements(namedJson).filter((statement) => statement.Sid === "ReadCompanyArtifacts");
    expect(own).toEqual([expectedStatement(namedJson)]);
    expect(violations(namedJson)).toEqual([]);
  });

  it("holds every other S3 grant of the dispatcher exactly as it was: the one admission read, no list, no put, and no KMS beyond its existing kms:Sign", () => {
    const kms = dispatcherStatements(namedJson).flatMap((statement) => list(statement.Action)).filter((action) => /^kms:/u.test(String(action)));
    expect(kms).toEqual(["kms:Sign"]);
    const touching = dispatcherStatements(namedJson).filter((statement) => list(statement.Action).some((action) => /^s3:/u.test(String(action))));
    expect(touching).toHaveLength(2);
    expect(touching.filter((statement) => statement.Sid !== "ReadCompanyArtifacts")).toEqual([admissionStatement(namedJson)]);
    for (const statement of touching) {
      expect(list(statement.Action)).toEqual(["s3:GetObject"]);
      expect(statement.Effect).toBe("Allow");
      expect(statement).not.toHaveProperty("Condition");
    }
  });

  it("needs no KMS grant: the bucket is S3-managed encrypted, so there is no customer key to decrypt with", () => {
    const bucket = namedJson.Resources[bucketIdOf(namedJson)]!;
    expect(bucket.Properties.BucketEncryption).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
    expect(JSON.stringify(bucket.Properties)).not.toContain("KMSMasterKeyID");
    expect(JSON.stringify(dispatcherStatements(namedJson))).not.toContain("kms:Decrypt");
  });

  it("gives the legacy template the same read since #1148 (the core engine there): the admission read and the company artifact reader, nothing else", () => {
    const statements = dispatcherStatements(legacyJson);
    expect(statements.filter((statement) => statement.Sid === DISPATCHER_ARTIFACTS_READ_SID)).toHaveLength(1);
    const touching = statements.filter((statement) => list(statement.Action).some((action) => /^s3:/u.test(String(action))));
    expect(touching).toHaveLength(2);
    expect(touching).toContainEqual(admissionStatement(legacyJson));
  });

  describe("widening mutants fail the exact check", () => {
    const mutants: Array<[string, (statement: Statement, bucketId: string) => void]> = [
      ["adds s3:PutObject", (s) => { s.Action = ["s3:GetObject", "s3:PutObject"]; }],
      ["adds s3:DeleteObject", (s) => { s.Action = ["s3:GetObject", "s3:DeleteObject"]; }],
      ["adds s3:ListBucket", (s) => { s.Action = ["s3:GetObject", "s3:ListBucket"]; }],
      ["widens the action to s3:*", (s) => { s.Action = "s3:*"; }],
      ["widens the action to s3:GetObject*", (s) => { s.Action = "s3:GetObject*"; }],
      ["uses a * resource", (s) => { s.Resource = "*"; }],
      ["names the whole bucket's objects", (s, id) => { s.Resource = objectsArn(id, "*"); }],
      ["names the bucket itself (list)", (s, id) => { s.Resource = [{ "Fn::GetAtt": [id, "Arn"] }, ...list(s.Resource)]; }],
      ["adds another prefix (evals/*)", (s, id) => { s.Resource = [...list(s.Resource), objectsArn(id, "evals/*")]; }],
      ["adds another prefix (nightly-maps/*)", (s, id) => { s.Resource = [...list(s.Resource), objectsArn(id, "nightly-maps/*")]; }],
      ["widens private/* to private*", (s, id) => { s.Resource = [objectsArn(id, "private*"), objectsArn(id, "workspaces/*")]; }],
      ["drops the workspaces prefix", (s, id) => { s.Resource = [objectsArn(id, "private/*")]; }],
      ["names another bucket", (s) => { s.Resource = [...list(s.Resource), "arn:aws:s3:::some-other-bucket/*"]; }],
      ["turns the Allow into something else", (s) => { s.Effect = "Deny"; }],
      ["drops the Sid", (s) => { delete s.Sid; }],
    ];
    for (const [name, change] of mutants) {
      it(`${name}`, () => {
        expect(violations(mutated(change)).length).toBeGreaterThan(0);
      });
    }

    it("a second statement that grants a KMS decrypt, or another S3 read, to the dispatcher fails", () => {
      for (const extra of [
        { Effect: "Allow", Action: "kms:Decrypt", Resource: "*" },
        { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
        { Effect: "Allow", Action: "s3:PutObject", Resource: "*" },
        { Sid: "Other", Effect: "Allow", NotAction: "iam:*", Resource: "*" },
      ] as unknown as Statement[]) {
        const copy = structuredClone(namedJson);
        const roleId = dispatcherRoleIdOf(copy);
        const policy = Object.values(copy.Resources).find((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleId))!;
        (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.push(extra);
        expect(violations(copy).length).toBeGreaterThan(0);
      }
    });

    it("removing the statement fails too", () => {
      const copy = structuredClone(namedJson);
      for (const resource of Object.values(copy.Resources)) {
        if (resource.Type !== "AWS::IAM::Policy") continue;
        const document = resource.Properties.PolicyDocument as { Statement: Statement[] };
        document.Statement = document.Statement.filter((statement) => statement.Sid !== DISPATCHER_ARTIFACTS_READ_SID);
      }
      expect(violations(copy).length).toBeGreaterThan(0);
    });
  });
});

// A small IAM evaluator for the boundary simulation: glob match on actions and resources, StringEquals / StringNotEquals conditions only (anything else throws, so the simulation never
// silently skips a condition). Explicit Deny wins; otherwise an Allow is needed. No AWS call.
const glob = (pattern: string, value: string, ignoreCase: boolean): boolean => {
  const source = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, ignoreCase ? "iu" : "u").test(value);
};
function conditionHolds(condition: unknown, context: Record<string, string>): boolean {
  if (condition === undefined) return true;
  return Object.entries(condition as Record<string, Record<string, string | string[]>>).every(([operator, keys]) => {
    if (operator !== "StringEquals" && operator !== "StringNotEquals") throw new Error(`the simulation does not evaluate condition operator ${operator}`);
    return Object.entries(keys).every(([key, expected]) => {
      const matches = list(expected).includes(context[key]);
      return operator === "StringEquals" ? matches : !matches;
    });
  });
}
function evaluate(statements: PolicyStatementJson[], action: string, resource: string, context: Record<string, string> = {}): "allow" | "deny" | "implicit-deny" {
  const applicable = statements.filter((statement) => list(statement.Action).some((pattern) => glob(String(pattern), action, true))
    && list(statement.Resource).some((pattern) => glob(String(pattern), resource, false)) && conditionHolds(statement.Condition, context));
  if (applicable.some((statement) => statement.Effect === "Deny")) return "deny";
  return applicable.some((statement) => statement.Effect === "Allow") ? "allow" : "implicit-deny";
}

describe("the deploy role and the permissions boundary allow it (simulated from the policy code)", () => {
  const scope: PolicyScope = {
    env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", artifactBucketArn: "arn:aws:s3:::agentx-staging-artifacts", pullThroughPrefix: "agentx", cloudFormationRoleName: "agentx-staging-cloudformation",
  };
  const boundary = defaultBoundaryStatements(scope);
  // TWO-BOUNDARIES: the deploy role is capped by the deploy boundary; the dispatcher's role (a runtime role) by the runtime one.
  const deployBoundary = deployBoundaryStatements(scope);
  const deploy = serviceRoleStatements(scope);
  const bucket = "arn:aws:s3:::agentx-staging-artifacts-0123456789ab";
  const allowedResources = ["private/", "workspaces/"].map((prefix) => `${bucket}/${prefix}company_x/workspace_y/artifact.json`);

  it("the boundary allows s3:GetObject on both prefixes, and no boundary Deny matches", () => {
    for (const resource of allowedResources) expect(evaluate(boundary, "s3:GetObject", resource)).toBe("allow");
    for (const statement of boundary.filter((candidate) => candidate.Effect === "Deny")) {
      for (const resource of allowedResources) expect(list(statement.Action).some((action) => glob(String(action), "s3:GetObject", true)) && list(statement.Resource).some((pattern) => glob(String(pattern), resource, false))).toBe(false);
    }
  });

  it("the deploy role's S3 wildcard covers the bucket and the boundary has no s3 deny, so creating the dispatcher's policy needs no new deploy-role action", () => {
    for (const resource of allowedResources) expect(evaluate(deploy, "s3:GetObject", resource)).toBe("allow");
    // What CloudFormation does to put the statement on the dispatcher's role is the same action it already uses for every role statement: iam:PutRolePolicy on a role of the environment's path,
    // with the environment's boundary on the role (the deploy role's own condition). No iam action is new.
    const dispatcherRole = `arn:aws:iam::${scope.account}:role/agentx/staging/agentx-staging-control-plane-DispatcherServiceRole-ABC123`;
    expect(evaluate(deploy, "iam:PutRolePolicy", dispatcherRole, { "iam:PermissionsBoundary": defaultBoundaryArn(scope) })).toBe("allow");
    expect(evaluate(deploy, "iam:PutRolePolicy", dispatcherRole, { "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/other" })).toBe("deny");
    // The deploy boundary allows role-policy writes only on a role that carries the RUNTIME boundary (IamRolesBounded), which the dispatcher's role does.
    expect(evaluate(deployBoundary, "iam:PutRolePolicy", dispatcherRole, { "iam:PermissionsBoundary": defaultBoundaryArn(scope) })).toBe("allow");
    expect(evaluate(deployBoundary, "iam:PutRolePolicy", dispatcherRole)).toBe("implicit-deny");
    // The only boundary Deny that names s3 is the release pipeline's (DenyRelease*), scoped to the pipeline's own buckets; none matches the artifacts bucket.
    for (const resource of allowedResources) {
      expect(boundary.some((statement) => statement.Effect === "Deny" && list(statement.Action).some((action) => glob(String(action), "s3:GetObject", true)) && list(statement.Resource).some((pattern) => glob(String(pattern), resource, false)))).toBe(false);
    }
    expect(boundary.filter((statement) => statement.Effect === "Deny" && list(statement.Action).some((action) => glob(String(action), "s3:GetObject", true))).map((statement) => statement.Sid)).toEqual(["DenyReleasePipeline"]);
  });

  it("the dispatcher's role carries the boundary in the app (so the boundary really bounds it)", () => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    const stack = app.node.children.find((child) => "stackName" in child && (child as { stackName: string }).stackName === "agentx-staging-control-plane")!;
    const json = Template.fromStack(stack as ControlPlaneStack).toJSON() as Json;
    const role = json.Resources[dispatcherRoleIdOf(json)]!;
    expect(role.Type).toBe("AWS::IAM::Role");
    expect(role.Properties.PermissionsBoundary).toBeDefined();
  });

  it("the simulator itself is not a rubber stamp: it denies what the boundary does not allow", () => {
    expect(evaluate(boundary, "iam:CreateUser", "*")).toBe("deny");
    expect(evaluate(boundary, "cloudtrail:StopLogging", "*")).toBe("implicit-deny");
  });
});
