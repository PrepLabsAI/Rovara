import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertDigestImage,
  parseReleaseArgs,
  releaseTag,
  runtimeIdFromArn,
} from "../../scripts/release-demo.js";
import {
  capacityProviderIdFromArn,
  parseProductionReleaseArgs,
} from "../../scripts/release-production.js";

describe("demo release command", () => {
  it("parses safe defaults and explicit deployment options", () => {
    expect(parseReleaseArgs([], {})).toEqual({
      region: "us-east-1",
      repository: "agentx-worker-demo",
      allowDirty: false,
      skipChecks: false,
      dryRun: false,
    });
    expect(parseReleaseArgs([
      "--region", "us-west-2",
      "--profile", "deployer",
      "--repository", "worker",
      "--allow-dirty",
      "--skip-checks",
    ], {})).toMatchObject({
      region: "us-west-2",
      profile: "deployer",
      repository: "worker",
      allowDirty: true,
      skipChecks: true,
    });
    expect(() => parseReleaseArgs(["--region"], {})).toThrow(/requires a value/);
    expect(() => parseReleaseArgs(["--surprise"], {})).toThrow(/unknown option/);
  });

  it("creates immutable release tags and validates digest-scoped images", () => {
    expect(releaseTag(new Date("2026-09-23T17:50:35.123Z"), "4f885bb4a8eaffff"))
      .toBe("release-20260923T175035Z-4f885bb4a8ea");
    const repository = "944937319445.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-demo";
    const image = `${repository}@sha256:${"a".repeat(64)}`;
    expect(() => assertDigestImage(image, repository)).not.toThrow();
    expect(() => assertDigestImage(`${repository}:latest`, repository)).toThrow(/immutable/);
    expect(() => assertDigestImage(image, `${repository}-other`)).toThrow(/belong/);
  });

  it("extracts the runtime ID and rejects malformed ARNs", () => {
    expect(runtimeIdFromArn(
      "arn:aws:bedrock-agentcore:us-east-1:944937319445:runtime/agentx_demo_worker-E4dYCR6f45",
    )).toBe("agentx_demo_worker-E4dYCR6f45");
    expect(() => runtimeIdFromArn("not-an-arn")).toThrow(/invalid/);
  });

  it("bounds ECR growth for untagged, release, and legacy image tags", () => {
    const policy = JSON.parse(readFileSync("infra/ecr-lifecycle-policy.json", "utf8")) as {
      rules: Array<{ selection: { tagStatus: string; tagPrefixList?: string[]; countNumber: number } }>;
    };
    expect(policy.rules).toHaveLength(4);
    expect(policy.rules[0]?.selection).toMatchObject({ tagStatus: "untagged", countNumber: 7 });
    expect(policy.rules[1]?.selection).toMatchObject({
      tagStatus: "tagged",
      tagPrefixList: ["release-"],
      countNumber: 20,
    });
    expect(policy.rules.slice(2).map((rule) => rule.selection.tagPrefixList?.[0]))
      .toEqual(["demo-", "pr-create-"]);
  });
});

describe("production release command", () => {
  it("defaults to a distinct production ECR repository", () => {
    expect(parseProductionReleaseArgs([], {})).toMatchObject({
      region: "us-east-1",
      repository: "agentx-worker-production",
      dryRun: false,
    });
    expect(parseProductionReleaseArgs(["--repository", "custom"], {})).toMatchObject({
      repository: "custom",
    });
  });

  it("extracts a capacity provider ID and rejects malformed ARNs", () => {
    expect(capacityProviderIdFromArn(
      "arn:aws:bedrock-agentcore:us-east-1:944937319445:capacity-provider/agentx_production_capacity-1234567890",
    )).toBe("agentx_production_capacity-1234567890");
    expect(() => capacityProviderIdFromArn("not-an-arn")).toThrow(/invalid/i);
  });
});
