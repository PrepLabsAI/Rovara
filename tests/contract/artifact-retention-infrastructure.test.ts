import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { E2E_ARTIFACT_RETENTION_DAYS, E2E_ARTIFACT_RETENTION_TAG, E2E_ARTIFACT_RETENTION_TAG_KEY, E2E_ARTIFACT_RETENTION_TAG_VALUE } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// M1.3 Task 3.7b, finding F8 and owner decision D4 ("reuse the existing private-artifact retention, else add a 30-day lifecycle rule"): the artifact bucket has no rule that
// reaches the current version of a screenshot, so it gets one. S3 lifecycle filters match the start of a key, and a screenshot's key starts with `private/<owner>/<workspace>/`
// like every other private object, so the rule matches an object tag the broker puts on a screenshot (and on nothing else).

skipLambdaBundling();
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
type Rule = { Id?: string; Status: string; ExpirationInDays?: number; NoncurrentVersionExpiration?: { NoncurrentDays: number }; TagFilters?: Array<{ Key: string; Value: string }>; Prefix?: string };

describe("the artifact bucket's retention of workflow screenshots", () => {
  const access = stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-access")!;
  const buckets = Object.entries(Template.fromStack(access).findResources("AWS::S3::Bucket") as Record<string, { Properties: { LifecycleConfiguration?: { Rules: Rule[] } } }>);
  const artifact = buckets.find(([id]) => id.startsWith("ArtifactBucket"))!;

  it("names the tag once, in the contracts, with the 30-day period of the owner's decision", () => {
    expect(E2E_ARTIFACT_RETENTION_DAYS).toBe(30);
    expect(E2E_ARTIFACT_RETENTION_TAG).toBe(`${E2E_ARTIFACT_RETENTION_TAG_KEY}=${E2E_ARTIFACT_RETENTION_TAG_VALUE}`);
  });

  it("expires an object that carries the screenshot tag after 30 days, and only such an object", () => {
    const rules = artifact[1].Properties.LifecycleConfiguration?.Rules ?? [];
    const screenshotRules = rules.filter((rule) => rule.ExpirationInDays !== undefined);
    expect(screenshotRules).toHaveLength(1);
    expect(screenshotRules[0]).toMatchObject({ Status: "Enabled", ExpirationInDays: E2E_ARTIFACT_RETENTION_DAYS,
      TagFilters: [{ Key: E2E_ARTIFACT_RETENTION_TAG_KEY, Value: E2E_ARTIFACT_RETENTION_TAG_VALUE }] });
    expect(screenshotRules[0]!.Prefix).toBeUndefined();
  });

  it("keeps the existing 30-day expiry of old versions, so an expired screenshot's versions go too", () => {
    const rules = artifact[1].Properties.LifecycleConfiguration?.Rules ?? [];
    expect(rules.some((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays === 30 && rule.TagFilters === undefined)).toBe(true);
  });

  it("is the only bucket with such a rule: no other bucket of the access stack expires current objects", () => {
    const others = buckets.filter(([id]) => !id.startsWith("ArtifactBucket"));
    for (const [, bucket] of others) expect((bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined)).toEqual([]);
  });
});

describe("the broker may put the tag on the object it stores", () => {
  type Statement = { Action: string | string[]; Resource: unknown };
  type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
  it("holds s3:PutObjectTagging on the artifact bucket, so no new IAM statement is needed (Task 3 tier: none)", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "RetentionControlPlane", { naming: environmentNaming("live25d") }));
    const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
      .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole"))).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    expect(statements.some((statement) => [statement.Action].flat().includes("s3:PutObjectTagging"))).toBe(true);
  });
});

describe("the broker tags a screenshot, and only a screenshot, with that retention tag", () => {
  const artifacts = readFileSync("packages/broker/src/aws/workflow-e2e-artifacts.ts", "utf8");

  it("puts the tag on the screenshot object it stores", () => {
    expect(artifacts).toContain("Tagging: E2E_ARTIFACT_RETENTION_TAG");
  });

  it("names the tag nowhere else in the broker, so no other object can expire on it", () => {
    const found = execFileSync("grep", ["-rl", "E2E_ARTIFACT_RETENTION_TAG\\|Tagging:", "packages", "--include=*.ts", "--exclude-dir=dist", "--exclude-dir=node_modules"], { encoding: "utf8" })
      .trim().split("\n").filter((file) => file !== "");
    expect(found.sort()).toEqual(["packages/broker/src/aws/workflow-e2e-artifacts.ts", "packages/contracts/src/e2e-view.ts"]);
  });
});
