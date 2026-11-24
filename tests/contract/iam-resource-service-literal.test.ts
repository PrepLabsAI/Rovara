// VENDOR FIX: the 0.5.51 access deploy rolled back with `Resource vendor must be fully qualified and cannot contain regexes` because the release pipeline Deny named a Resource
// `arn:<partition>:*rovara-<env>-*rel*` (a wildcard in the SERVICE field). A template diff, a change set and cfn-lint do not see it; IAM refuses it only at CREATE. This file holds the rule
// for EVERY IAM policy document the infrastructure synthesizes (the deployment that predates environments, with and without its optional stacks, a named environment with every flag on, and
// the environment release pipeline): every Resource and NotResource that is an ARN has a literal service name. scripts/validate-iam-policies.ts is the same rule plus IAM Access Analyzer.
import { describe, expect, it } from "vitest";
import {
  defaultBoundaryStatements, deployBoundaryStatements, operatorRoleStatements, releasePipelineDenyStatements, serviceRoleStatements, type PolicyScope,
} from "@agentx/contracts";
import {
  SCAN_CONTEXTS, extractPolicyDocuments, isBlocking, resolve, resourceStrings, serviceFieldProblem, serviceFieldProblems, synthesizePolicyDocuments, uniqueDocuments, validatePolicy,
  type PolicyDocument,
} from "../../scripts/validate-iam-policies.js";

describe("serviceFieldProblem (IAM's rule for the service field of a Resource ARN)", () => {
  it("rejects the bug that rolled the 0.5.51 access deploy back, and every other non-literal service", () => {
    for (const bad of [
      "arn:aws:*rovara-staging-*rel*",
      "arn:aws:*:*:*:rovara-staging-x",
      "arn:aws:s?s:::bucket",
      "arn:aws:s3*:::bucket",
      "arn:${AWS::Partition}:${Service}:*:*:x",
      "arn:aws::us-west-2:111122223333:x",
      "arn:aws",
      "arn:aws:",
    ]) expect(serviceFieldProblem(bad), bad).toBeDefined();
  });

  it("accepts a bare * (all resources), a literal service with wildcard region, account and resource, and the partitions", () => {
    for (const good of [
      "*",
      "arn:aws:cloudformation:*:*:stack/agentx-staging-*/*",
      "arn:aws:s3:::rovara-staging-*rel*",
      "arn:aws-us-gov:iam::111122223333:role/agentx/staging/*",
      "arn:aws-cn:cognito-idp:*:111122223333:userpool/*",
      "arn:aws:execute-api:us-west-2:111122223333:abc/*/POST/x",
    ]) expect(serviceFieldProblem(good), good).toBeUndefined();
  });

  it("reads Resource and NotResource, strings and lists, and Statement as an object or a list", () => {
    const document = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:*", Resource: ["arn:aws:s3:::a", "arn:aws:*b"] }, { Effect: "Deny", Action: "s3:*", NotResource: "arn:aws:*c" }] };
    expect(resourceStrings(document)).toEqual(["arn:aws:s3:::a", "arn:aws:*b", "arn:aws:*c"]);
    expect(resourceStrings({ Statement: { Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::a" } })).toEqual(["arn:aws:s3:::a"]);
    expect(serviceFieldProblems([{ label: "x", kind: "IDENTITY_POLICY", document }]).map((problem) => problem.slice(0, 2))).toEqual(["x:", "x:"]);
  });
});

describe("the boundary and role policy functions, at every partition and a long environment name", () => {
  it("never write a Resource or NotResource with a non-literal service", () => {
    for (const env of ["staging", "a".repeat(20)]) {
      for (const partition of ["aws", "aws-us-gov", "aws-cn"]) {
        const scope: PolicyScope = {
          env, partition, region: "us-west-2", account: "111122223333", artifactBucketArn: `arn:${partition}:s3:::agentx-${env}-access-artifactbucket-abc`, pullThroughPrefix: `agentx-${env}`, cloudFormationRoleName: `agentx-${env}-cloudformation`,
        };
        const statements = [
          ...defaultBoundaryStatements(scope), ...deployBoundaryStatements(scope), ...serviceRoleStatements(scope), ...operatorRoleStatements(scope), ...releasePipelineDenyStatements(scope),
        ];
        expect(serviceFieldProblems([{ label: `${env}/${partition}`, kind: "IDENTITY_POLICY", document: { Statement: statements } }])).toEqual([]);
      }
    }
  });
});

describe("every synthesized policy document", () => {
  const synthesized = synthesizePolicyDocuments();

  it("has a literal service in every Resource and NotResource, in every stack of every app (the named ones and the legacy ones)", () => {
    expect(serviceFieldProblems(synthesized.documents)).toEqual([]);
  }, 300_000);

  it("is the whole picture: the access stack's two boundaries and roles, the legacy runtime boundaries, the release pipeline's, trust documents and resource policies, with no intrinsic left unresolved", () => {
    const labels = synthesized.documents.map((document) => document.label);
    expect(synthesized.unresolved).toEqual([]);
    expect(SCAN_CONTEXTS.map((scan) => scan.name)).toEqual(["legacy", "legacy-optional", "named", "release-pipeline"]);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining("named:agentx-staging-access/DefaultPermissionsBoundary/"),
      expect.stringContaining("named:agentx-staging-access/DeployPermissionsBoundary/"),
      expect.stringContaining("named:agentx-staging-access/CloudFormationServiceRole"),
      expect.stringContaining("named:agentx-staging-access/OperatorRole"),
      expect.stringContaining("legacy:AgentXControlPlane/RuntimeBoundary"),
      expect.stringContaining("legacy:AgentXProductionFoundation/RuntimeBoundary"),
      expect.stringContaining("legacy:AgentXSlackOrchestrator/RuntimeBoundary"),
      expect.stringContaining("release-pipeline:rovara-staging-code-release-pipeline/Boundary"),
    ]));
    expect(synthesized.documents.length).toBeGreaterThan(300);
    expect(synthesized.documents.some((document) => document.resourceType === "AWS::IAM::AssumeRolePolicyDocument")).toBe(true);
    expect(synthesized.documents.some((document) => document.kind === "RESOURCE_POLICY" && document.resourceType === undefined)).toBe(true);
  });
});

describe("the extraction and the analyzer call", () => {
  it("resolves Fn::Sub, Fn::Join, Ref, Fn::GetAtt and Fn::If with placeholders of the right shape, and drops AWS::NoValue", () => {
    const context = { resources: { Bucket: { Type: "AWS::S3::Bucket" }, Fn: { Type: "AWS::Lambda::Function" }, Topic: { Type: "AWS::SNS::Topic" } }, unresolved: new Set<string>() };
    expect(resolve({ "Fn::Sub": "arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/x-*" }, context)).toBe("arn:aws:events:us-west-2:111122223333:rule/x-*");
    expect(resolve({ "Fn::Join": ["", [{ "Fn::GetAtt": ["Bucket", "Arn"] }, "/*"]] }, context)).toBe("arn:aws:s3:::placeholderBucket/*");
    expect(resolve({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":lambda:*:*:function:", { Ref: "Fn" }]] }, context)).toBe("arn:aws:lambda:*:*:function:placeholderFn");
    expect(resolve({ Ref: "Topic" }, context)).toBe("arn:aws:sns:us-west-2:111122223333:placeholderTopic");
    expect(resolve([{ Ref: "AWS::NoValue" }, "a", { "Fn::If": ["C", "b", { Ref: "AWS::NoValue" }] }], context)).toEqual(["a", "b"]);
    expect(context.unresolved.size).toBe(0);
  });

  it("finds role inline policies, trust documents, managed policies and resource policies, each with the analyzer type it needs", () => {
    const statement = { Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["Bucket", "Arn"] }, "/*"]] } };
    const document = { Version: "2012-10-17", Statement: [statement] };
    const found = extractPolicyDocuments("stack", {
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: document, Policies: [{ PolicyName: "p", PolicyDocument: document }] } },
        Managed: { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: document } },
        BucketPolicy: { Type: "AWS::S3::BucketPolicy", Properties: { PolicyDocument: document } },
        Queue: { Type: "AWS::SQS::QueuePolicy", Properties: { PolicyDocument: document } },
        Key: { Type: "AWS::KMS::Key", Properties: { KeyPolicy: JSON.stringify({ Version: "2012-10-17", Statement: [] }) } },
        Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    }).documents.map(({ label, kind, resourceType }) => ({ label, kind, resourceType }));
    expect(found).toEqual([
      { label: "stack/Role/AssumeRolePolicyDocument", kind: "RESOURCE_POLICY", resourceType: "AWS::IAM::AssumeRolePolicyDocument" },
      { label: "stack/Role/Policies[0].PolicyDocument", kind: "IDENTITY_POLICY", resourceType: undefined },
      { label: "stack/Managed/PolicyDocument", kind: "IDENTITY_POLICY", resourceType: undefined },
      { label: "stack/BucketPolicy/PolicyDocument", kind: "RESOURCE_POLICY", resourceType: "AWS::S3::Bucket" },
      { label: "stack/Queue/PolicyDocument", kind: "RESOURCE_POLICY", resourceType: undefined },
      { label: "stack/Key/KeyPolicy", kind: "RESOURCE_POLICY", resourceType: undefined },
    ]);
  });

  it("calls only `accessanalyzer validate-policy` through the caller's command, with the document, its type and the region; sends identical documents once; blocks only ERROR and SECURITY_WARNING that are not allow-listed", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const entry: PolicyDocument = { label: "a", kind: "RESOURCE_POLICY", resourceType: "AWS::IAM::AssumeRolePolicyDocument", document: { Version: "2012-10-17", Statement: [] } };
    const findings = validatePolicy(entry, { awsCommand: ["guard.sh", "aws"], region: "us-west-2" }, (file, args) => {
      calls.push({ file, args });
      return JSON.stringify({ findings: [{ findingType: "ERROR", issueCode: "X", findingDetails: "d" }] });
    });
    expect(calls).toEqual([{ file: "guard.sh", args: ["aws", "accessanalyzer", "validate-policy", "--policy-type", "RESOURCE_POLICY", "--policy-document", JSON.stringify(entry.document), "--output", "json", "--validate-policy-resource-type", "AWS::IAM::AssumeRolePolicyDocument", "--region", "us-west-2"] }]);
    expect(findings).toHaveLength(1);
    expect(uniqueDocuments([entry, { ...entry, label: "b" }, { ...entry, label: "c", kind: "IDENTITY_POLICY" }]).map((item) => item.labels)).toEqual([["a", "b"], ["c"]]);
    const finding = (findingType: string) => ({ findingType, issueCode: "X", findingDetails: "d" });
    expect(["ERROR", "SECURITY_WARNING", "WARNING", "SUGGESTION"].map((type) => isBlocking(finding(type), ["stack/a"], []))).toEqual([true, true, false, false]);
    expect(isBlocking(finding("ERROR"), ["other/b", "stack/a"], [{ label: "stack/a", issueCode: "X", reason: "accepted" }])).toBe(false);
    expect(isBlocking(finding("ERROR"), ["stack/a"], [{ label: "stack/a", issueCode: "Y", reason: "accepted" }])).toBe(true);
  });
});
