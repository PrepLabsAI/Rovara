import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SWEBENCH_DATASETS, SwebenchInstanceIdSchema, SwebenchRunResultSchema, parseSwebenchCommand, swebenchAgentLimits, swebenchFamily, swebenchInstanceIdFits } from "@agentx/contracts";

const IDS = readFileSync(new URL("../fixtures/secbench-eval-instance-ids.txt", import.meta.url), "utf8").trim().split("\n");
const USAGE = "eval secbench patch <instance-id> [model <name>]";

describe("the eval secbench command (spec 045 FR-001)", () => {
  it("reads the patch task, one instance and an optional model", () => {
    expect(parseSwebenchCommand("<@U123ABC> eval secbench patch njs.cve-2022-32414")).toEqual({ kind: "run", dataset: "secbench-patch", instanceId: "njs.cve-2022-32414" });
    expect(parseSwebenchCommand("eval SECBENCH Patch libxml2.ossfuzz-417247563 model Claude Sonnet 4.6.")).toEqual({
      kind: "run", dataset: "secbench-patch", instanceId: "libxml2.ossfuzz-417247563", modelSelector: "Claude Sonnet 4.6",
    });
  });

  it.each([
    ["eval secbench", /which task/],
    ["eval secbench poc njs.cve-2022-32414", /not available yet/],
    ["eval secbench njs.cve-2022-32414", /Unknown task/],
    ["eval secbench patch", /which instance/],
    ["eval secbench patch django__django-11099", /not a SEC-bench instance ID/],
    ["eval secbench patch njs.cve-2022-32414 njs.cve-2022-28049", /exactly one instance/],
    ["eval secbench patch njs.cve-2022-32414 model", /which model/],
  ])("explains what is wrong with %j", (text, message) => {
    const command = parseSwebenchCommand(text);
    expect(command?.kind).toBe("invalid");
    const reply = command?.kind === "invalid" ? command.message : "";
    expect(reply).toMatch(message);
    expect(reply).toContain(USAGE);
  });

  it("refuses an ID no eval family writes, in wording that names no one benchmark", () => {
    const parsed = SwebenchInstanceIdSchema.safeParse("not-an-instance");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("not an eval instance ID");
    expect(SwebenchInstanceIdSchema.safeParse("njs.cve-2022-32414").success).toBe(true);
  });

  it("leaves eval swebench and other messages as they were", () => {
    expect(parseSwebenchCommand("eval swebench verified django__django-11099")).toMatchObject({ dataset: "verified" });
    expect(parseSwebenchCommand("eval swebench secbench-patch njs.cve-2022-32414")?.kind).toBe("invalid");
    expect(parseSwebenchCommand("eval secbenchmark results")).toBeUndefined();
  });

  it("accepts all 300 IDs of the eval split, for its own family only", () => {
    expect(IDS).toHaveLength(300);
    expect(IDS.filter((id) => !swebenchInstanceIdFits("secbench-patch", id))).toEqual([]);
    expect(swebenchInstanceIdFits("verified", IDS[0]!)).toBe(false);
    expect(swebenchInstanceIdFits("secbench-patch", "django__django-11099")).toBe(false);
  });

  it("reads the eval split with Verified's limits (FR-003, FR-006)", () => {
    expect(SWEBENCH_DATASETS["secbench-patch"]).toEqual({ name: "SEC-bench/SEC-bench", config: "default", split: "eval", family: "secbench" });
    expect(SWEBENCH_DATASETS.verified.split).toBe("test");
    expect(swebenchFamily("secbench-patch")).toBe("secbench");
    expect(swebenchAgentLimits("secbench-patch")).toEqual({ timeLimitSeconds: 3_600, toolCallLimit: 200 });
  });
});

describe("a graded SEC-bench result (FR-010)", () => {
  const graded = {
    outcome: "GRADED", resolved: true, stopReason: "finished", patchBytes: 120, agentSeconds: 300,
    imageDigest: `hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414@sha256:${"a".repeat(64)}`,
    usage: {
      schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", cacheRetention: "short",
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cacheReadRatio: 0, costUsd: 0.3,
    },
    artifactsPrefix: "evals/00000000-0000-0000-0000-000000000000/",
  };
  const verdict = { strict: true, medium: true, generous: true, pocExitCode: 0, sanitizerReport: false, timedOut: false };

  it("carries the verdict in place of test counts", () => {
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: verdict }).success).toBe(true);
  });

  it("refuses an unknown failed step or an extra field", () => {
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: { ...verdict, failedStep: "link" } }).success).toBe(false);
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: { ...verdict, extra: 1 } }).success).toBe(false);
  });
});
