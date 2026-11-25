// Review of lane L1 (Opus, 2026-11-24): the Code Preflight's port-guard step and the Code release's CODE_RELEASE skip, run as real shell instead of read as text.
// Fake tools only (a fake `node` that names the script it was given); no network, no AWS.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTX_BETA_RELEASE_PROJECT_NAME, AGENTX_RELEASE_PROJECT_NAME, ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { commitFile, fakeBin, git, preflightBuild, runShell, scratch } from "../support/release-pipeline-shell.js";

describe("L1 review: the port-guard step runs the previously released commit's guard scripts", () => {
  it("on a merge commit, runs the guard as it was on mainline before the merge, never the merged branch's edit of it", () => {
    const dir = scratch();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "mainline");
    commitFile(repo, "scripts/port-guard-pipeline.ts", "// TRUSTED guard\n", "mainline guard");
    const released = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "lane");
    commitFile(repo, "scripts/port-guard-pipeline.ts", "// EDITED guard (would print the list)\n", "lane edits the guard");
    git(repo, "checkout", "-q", "mainline");
    git(repo, "-c", "user.name=t", "merge", "-q", "--no-ff", "-m", "promote", "lane");
    const log = join(dir, "log");
    const bin = fakeBin(dir, log, ["node", "aws"]);
    const result = runShell(repo, preflightBuild(join(dir, "trusted")), { PATH: `${bin}:${process.env.PATH}`, PORT_GUARD_NAMES_PARAMETER: "/test/names", FAKE_RELEASED_SHA: released });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("// TRUSTED guard");
    expect(result.stdout).not.toContain("EDITED");
    // The range the trusted guard judges is exactly parent..merge, so the lane's edit is in it (and is judged by the old guard).
    expect(readFileSync(log, "utf8")).toContain("node scripts/port-guard-pipeline.ts --range HEAD..release-tip --allow-guard-edits");
  });

  it("fails (no skip) when the first parent has no pipeline guard script, which is the first run until L14 is on mainline before the released commit", () => {
    const dir = scratch();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "mainline");
    commitFile(repo, "README", "x\n", "before L14");
    const released = git(repo, "rev-parse", "HEAD");
    commitFile(repo, "scripts/port-guard-pipeline.ts", "// guard arrives in this commit\n", "L14 and L1 together");
    const log = join(dir, "log");
    // A real-ish node: fails on a missing file like node does.
    const bin = fakeBin(dir, log, ["aws"]);
    writeFileSync(join(bin, "node"), `#!/bin/bash\necho "node $*" >> "${log}"\ntest -f "$1" || { echo "Cannot find module $1" >&2; exit 1; }\n`);
    chmodSync(join(bin, "node"), 0o755);
    const result = runShell(repo, preflightBuild(join(dir, "trusted")), { PATH: `${bin}:${process.env.PATH}`, PORT_GUARD_NAMES_PARAMETER: "/test/names", FAKE_RELEASED_SHA: released });
    expect(result.status).not.toBe(0);
  });

  it("refuses before running any script when the parameter name is empty", () => {
    const dir = scratch();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "mainline");
    commitFile(repo, "scripts/port-guard-pipeline.ts", "// guard\n", "one");
    const released = git(repo, "rev-parse", "HEAD");
    commitFile(repo, "README", "x\n", "two");
    const log = join(dir, "log");
    const bin = fakeBin(dir, log, ["node", "aws"]);
    const result = runShell(repo, preflightBuild(join(dir, "trusted")), { PATH: `${bin}:${process.env.PATH}`, PORT_GUARD_NAMES_PARAMETER: "", FAKE_RELEASED_SHA: released });
    expect(result.status).toBe(2);
    expect(readFileSync(log, "utf8")).not.toContain("node ");
  });
});

describe("L1 review: CODE_RELEASE in the Code release builds, run as shell", () => {
  const template = Template.fromStack(new ReleasePipelineStack(new App(), "ReviewReleasePipeline", { env: { region: "us-east-1" } })).toJSON() as {
    Resources: Record<string, { Type: string; Properties: { Name?: string; Source?: { BuildSpec?: unknown } } }>;
  };
  const specOf = (name: string) => {
    const raw = Object.values(template.Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === name)?.Properties.Source?.BuildSpec;
    const text = typeof raw === "string" ? raw : ((raw as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "TOKEN")).join(""));
    return JSON.parse(text) as { phases: Record<string, { commands: string[] }> };
  };
  const TOOLS = ["curl", "node", "npm", "aws", "unzip", "tar", "gitleaks", "docker", "sha256sum"] as const;

  for (const name of [AGENTX_RELEASE_PROJECT_NAME, AGENTX_BETA_RELEASE_PROJECT_NAME]) {
    it(`${name}: skip runs no tool and no release, and leaves only the manifest`, () => {
      const dir = scratch();
      const log = join(dir, "log");
      const bin = fakeBin(dir, log, TOOLS);
      const spec = specOf(name);
      const commands = [...spec.phases.install!.commands, ...spec.phases.pre_build!.commands, ...spec.phases.build!.commands];
      const result = runShell(dir, ["set -e", ...commands], { PATH: `${bin}:/usr/bin:/bin`, CODE_RELEASE: "skip", HOME: dir });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
      expect(readFileSync(join(dir, "cdk.out/agentx-production-release.json"), "utf8")).toBe('{"codeRelease":"skip"}\n');
    });

    it(`${name}: any value but run or skip stops the build at its first command`, () => {
      const spec = specOf(name);
      for (const value of ["", "Skip", "SKIP", "off", "run ", "skip;true", "no"]) {
        const dir = scratch();
        const log = join(dir, "log");
        const bin = fakeBin(dir, log, TOOLS);
        const result = runShell(dir, ["set -e", ...spec.phases.install!.commands], { PATH: `${bin}:/usr/bin:/bin`, CODE_RELEASE: value, HOME: dir });
        expect(result.status, JSON.stringify(value)).toBe(1);
        expect(existsSync(log), JSON.stringify(value)).toBe(false);
      }
    });

  }
});
