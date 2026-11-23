import { expect, it } from "vitest";
import { CheckRunFactsSchema, type CodeBuildCheckResult } from "@agentx/contracts";
import { codeBuildCheckRunner } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";

it("exposes only the resolved revision read from provider status, for a bound run", async () => {
  const commit = "a".repeat(40);
  const result: CodeBuildCheckResult = { gate: "unit", projectName: "unit-project", buildId: "unit-project:123", requestedSourceVersion: commit, resolvedSourceVersion: commit, status: "SUCCEEDED" };
  const runner = codeBuildCheckRunner({ allowedRepositories: ["https://github.com/example/demo.git"], gateway: { start: async () => result, status: async () => result } });
  const target = { kind: "run" as const, repository: { url: "https://github.com/example/demo.git" }, revision: commit, run: { runner: "codebuild", id: result.buildId }, gate: "unit", project: "unit-project" };
  const check = await runner.getRun!(target, { orgId: "org_corehost00000000000a" });
  expect(await runner.runFacts?.(target, check, { orgId: "org_corehost00000000000a" })).toMatchObject({ resolvedRevision: commit });
  expect(CheckRunFactsSchema.parse({ resolvedRevision: commit })).toEqual({ resolvedRevision: commit });
  delete result.resolvedSourceVersion;
  expect(await runner.runFacts?.(target, check, { orgId: "org_corehost00000000000a" })).not.toHaveProperty("resolvedRevision");
  await expect(runner.runFacts!( { ...target, repository: { url: "https://github.com/other/demo.git" } }, check, { orgId: "org_corehost00000000000a" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});
