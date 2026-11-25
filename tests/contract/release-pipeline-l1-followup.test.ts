// L1 follow-up after the Opus review (R2, R3, R4): the port-guard step's trust anchor (the previously released Code commit) and the record of it, run as real shell with
// fake tools; the pipeline's mode variable and expected-account variable, read from the rendered template.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTX_BETA_RELEASE_PROJECT_NAME, AGENTX_RELEASE_PROJECT_NAME, CODE_RELEASED_PARAMETER, PIPELINE_MODE_NOTE, ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { commitFile, fakeBin, git, preflightBuild, runShell, scratch } from "../support/release-pipeline-shell.js";

const GUARD = "scripts/port-guard-pipeline.ts";
const env = (bin: string, released: string, extra: Record<string, string> = {}) => ({
  PATH: `${bin}:${process.env.PATH}`,
  PORT_GUARD_NAMES_PARAMETER: "/test/names",
  FAKE_RELEASED_SHA: released,
  ...extra,
});
const newRepo = (dir: string): string => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "mainline");
  commitFile(repo, GUARD, "// TRUSTED guard (released)\n", "released");
  return repo;
};
const head = (repo: string): string => git(repo, "rev-parse", "HEAD");
const merge = (repo: string, branch: string, message: string): void => {
  git(repo, "merge", "-q", "--no-ff", "-m", message, branch);
};
/** A lane branch from the current mainline tip with one commit editing the guard, merged back as a merge commit. */
const mergeGuardEdit = (repo: string, label: string): void => {
  git(repo, "checkout", "-q", "-b", label);
  commitFile(repo, GUARD, `// EDITED guard ${label} (would print the list)\n`, `${label} edits the guard`);
  git(repo, "checkout", "-q", "mainline");
  merge(repo, label, `merge ${label}`);
};
const run = (dir: string, repo: string, released: string, extra: Record<string, string> = {}) => {
  const log = join(dir, "log");
  const bin = fakeBin(dir, log, ["node", "aws"]);
  const result = runShell(repo, preflightBuild(join(dir, "trusted")), env(bin, released, extra));
  return { result, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
};
const refusedBeforeAnyGuard = (outcome: { result: { status: number | null; stderr: string }; log: string }, why: RegExp): void => {
  expect(outcome.result.status, outcome.result.stderr).toBe(2);
  expect(outcome.result.stderr).toMatch(why);
  expect(outcome.log).not.toContain("node ");
};

describe("L1 follow-up R4: the port-guard step is anchored on the previously released Code commit", () => {
  it("a queue group of merges: the guard that runs is the RELEASED commit's, over everything since, never an edit merged earlier in the same landing", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const released = head(repo);
    mergeGuardEdit(repo, "pr-one");
    mergeGuardEdit(repo, "pr-two");
    const { result, log } = run(dir, repo, released);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("// TRUSTED guard (released)");
    expect(result.stdout).not.toContain("EDITED");
    // The whole range since the released commit, in one run (not one first-parent step).
    expect(log).toContain("node scripts/port-guard-pipeline.ts --range HEAD..release-tip --allow-guard-edits");
    expect(git(repo, "rev-parse", "release-tip")).toBe(head(repo));
    expect(git(join(dir, "trusted"), "rev-parse", "HEAD")).toBe(released);
    expect(git(repo, "rev-list", "--count", `${released}..release-tip`)).toBe("4");
  });

  it("a squash landing (one commit directly on the released commit) is accepted, and judged by the released guard", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const released = head(repo);
    commitFile(repo, GUARD, "// EDITED guard in the squash\n", "squash");
    const { result, log } = run(dir, repo, released);
    expect(result.status, result.stderr).toBe(0);
    expect(log).toContain("--range HEAD..release-tip --allow-guard-edits");
    expect(git(join(dir, "trusted"), "rev-parse", "HEAD")).toBe(released);
    expect(git(repo, "rev-list", "--count", `${released}..release-tip`)).toBe("1");
    expect(result.stdout).toContain("TRUSTED");
    expect(result.stdout).not.toContain("EDITED");
  });

  it("a run with no new Code (the released commit itself, a Cloud tag run) scans an empty range with the released guard", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const { result, log } = run(dir, repo, head(repo));
    expect(result.status, result.stderr).toBe(0);
    expect(log).toContain("--range HEAD..release-tip");
  });

  it("refuses a LINEAR landing of 5 commits (a rebase-merged queue group), one of them editing the guard, with a message that says what happened and what to do", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const released = head(repo);
    commitFile(repo, "a.txt", "1\n", "pr 1");
    commitFile(repo, GUARD, "// EDITED guard (pr 2, would print the list)\n", "pr 2 edits the guard");
    commitFile(repo, "c.txt", "3\n", "pr 3");
    commitFile(repo, "d.txt", "4\n", "pr 4");
    commitFile(repo, "e.txt", "5\n", "pr 5");
    const outcome = run(dir, repo, released);
    refusedBeforeAnyGuard(outcome, /this landing has 5 commits on the last released commit that were not merged as one change, so this run does not release them/u);
    // Only what happened and what to do: no claim about what a guard would do.
    expect(outcome.result.stderr).not.toMatch(/cannot trust|would run|private name list/u);
    expect(outcome.result.stderr).toMatch(/next normal merge \(a merge commit on top of them\) releases them/u);
    expect(outcome.result.stderr).toMatch(/re-land the change as one squash or one merge/u);
    // Nothing ran: no worktree, no guard, no ref for the tip.
    expect(existsSync(join(dir, "trusted"))).toBe(false);
    expect(outcome.log).not.toContain("node ");
    expect(() => git(repo, "rev-parse", "--verify", "release-tip")).toThrow();
  });

  it("refuses an OCTOPUS merge, even one whose first parent is the released commit, with its own message", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const released = head(repo);
    for (const name of ["one", "two"]) {
      git(repo, "checkout", "-q", "-b", name, "mainline");
      commitFile(repo, `${name}.txt`, `${name}\n`, name);
    }
    git(repo, "checkout", "-q", "mainline");
    git(repo, "merge", "-q", "--no-ff", "-m", "octopus", "one", "two");
    expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(4);
    expect(git(repo, "rev-parse", "HEAD^1")).toBe(released);
    const outcome = run(dir, repo, released);
    refusedBeforeAnyGuard(outcome, /this commit is an octopus merge \(3 parents\), which the release does not accept\. Re-land the change as a normal two-parent merge or as one squash/u);
    expect(outcome.result.stderr).not.toMatch(/not merged as one change/u);
    expect(existsSync(join(dir, "trusted"))).toBe(false);
  });

  it("releases those 5 linear commits with the next normal merge: released guard, the FULL range of 6 commits, nothing skipped", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const released = head(repo);
    commitFile(repo, GUARD, "// EDITED guard (linear, would print the list)\n", "linear 1 edits the guard");
    for (const n of [2, 3, 4, 5]) commitFile(repo, `f${n}.txt`, `${n}\n`, `linear ${n}`);
    git(repo, "checkout", "-q", "-b", "next-pr");
    commitFile(repo, "g.txt", "6\n", "the next normal change");
    git(repo, "checkout", "-q", "mainline");
    merge(repo, "next-pr", "merge next-pr");
    const { result, log } = run(dir, repo, released);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("// TRUSTED guard (released)");
    expect(result.stdout).not.toContain("EDITED");
    expect(log).toContain("--range HEAD..release-tip --allow-guard-edits");
    // The range is released..HEAD whole: the trusted tree sits on the released commit, the tip is this commit, and all 7 commits lie between.
    expect(git(join(dir, "trusted"), "rev-parse", "HEAD")).toBe(released);
    expect(git(repo, "rev-parse", "release-tip")).toBe(head(repo));
    expect(git(repo, "rev-list", "--count", `${released}..release-tip`)).toBe("7");
  });

  it("refuses when the released commit is not an ancestor (another history, a rewritten mainline)", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    const other = head(repo);
    git(repo, "checkout", "-q", "--orphan", "other");
    git(repo, "rm", "-rf", "-q", ".");
    commitFile(repo, "README", "y\n", "unrelated root");
    refusedBeforeAnyGuard(run(dir, repo, other), /not an ancestor/u);
  });

  it("refuses a record that names a commit this clone does not have", () => {
    const dir = scratch();
    const repo = newRepo(dir);
    refusedBeforeAnyGuard(run(dir, repo, "0123456789abcdef0123456789abcdef01234567"), /not in this clone/u);
  });

  it("fails closed, with nothing run, when the record is missing, unreadable or not a commit id", () => {
    for (const [released, extra, why] of [
      ["", { FAKE_AWS_FAIL: "1" }, /could not be read/u],
      ["", {}, /not recorded/u],
      ["None", {}, /not recorded/u],
      ["HEAD", {}, /not recorded/u],
      ["ABCDEF0123456789ABCDEF0123456789ABCDEF01", {}, /not recorded/u],
    ] as const) {
      const dir = scratch();
      const repo = newRepo(dir);
      refusedBeforeAnyGuard(run(dir, repo, released, extra), why);
      expect(existsSync(join(dir, "trusted")), JSON.stringify(released)).toBe(false);
    }
  });

  it("reads the record of ITS stage: beta's Preflight reads beta's parameter, production's reads production's", () => {
    const template = Template.fromStack(new ReleasePipelineStack(new App(), "FollowUpPipeline", { env: { region: "us-east-1" } })).toJSON() as {
      Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
    };
    const specs = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::CodeBuild::Project" && String(resource.Properties.Name).startsWith("release-agentx-preflight-"));
    expect(specs).toHaveLength(2);
    for (const stage of ["beta", "production"] as const) {
      const project = specs.find((spec) => String(spec.Properties.Name).endsWith(`-${stage}`))!;
      const text = JSON.stringify((project.Properties.Source as { BuildSpec: unknown }).BuildSpec);
      expect(text).toContain(`aws ssm get-parameter --name ${CODE_RELEASED_PARAMETER[stage]} `);
      for (const other of Object.values(CODE_RELEASED_PARAMETER)) if (other !== CODE_RELEASED_PARAMETER[stage]) expect(text).not.toContain(other);
    }
  });
});

describe("L1 follow-up R4: the Code release records the commit it released, only after it finished", () => {
  const template = Template.fromStack(new ReleasePipelineStack(new App(), "FollowUpRelease", { env: { region: "us-east-1" } })).toJSON() as {
    Resources: Record<string, { Type: string; Properties: { Name?: string; Source?: { BuildSpec?: unknown } } }>;
  };
  const specOf = (name: string) => {
    const raw = Object.values(template.Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === name)?.Properties.Source?.BuildSpec;
    const text = typeof raw === "string" ? raw : ((raw as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "TOKEN")).join(""));
    return JSON.parse(text) as { phases: Record<string, { commands: string[] }> };
  };
  const stages = [[AGENTX_RELEASE_PROJECT_NAME, "production"], [AGENTX_BETA_RELEASE_PROJECT_NAME, "beta"]] as const;

  for (const [name, stage] of stages) {
    const buildAs = (releaseSucceeds: boolean, codeRelease: string, resolved?: string) => {
      const dir = scratch();
      const repo = join(dir, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "mainline");
      commitFile(repo, "README", "x\n", "tip");
      const log = join(dir, "log");
      const bin = fakeBin(dir, log, ["node", "aws", "docker"]);
      // npm stands for `npm run release:prod`: it fails when asked to.
      writeFileSync(join(bin, "npm"), `#!/bin/bash\necho "npm $*" >> "${log}"\n${releaseSucceeds ? "" : "exit 1\n"}`);
      chmodSync(join(bin, "npm"), 0o755);
      const result = runShell(repo, ["set -e", ...specOf(name).phases.build!.commands.map((command) => `(${command})`)], {
        PATH: `${bin}:/usr/bin:/bin`, CODE_RELEASE: codeRelease, HOME: dir, CODEBUILD_RESOLVED_SOURCE_VERSION: resolved ?? head(repo), AWS_REGION: "us-east-1", BETA_RELEASE_ROLE_ARN: "arn:aws:iam::123456789012:role/test",
      });
      return { result, log: existsSync(log) ? readFileSync(log, "utf8") : "", tip: head(repo) };
    };

    it(`${name}: after a finished release, the LAST command writes the commit to ${stage}'s record, with the build's own credentials`, () => {
      const { result, log, tip } = buildAs(true, "run");
      expect(result.status, result.stderr).toBe(0);
      const lines = log.trim().split("\n");
      expect(lines.at(-1)).toBe(`aws ssm put-parameter --name ${CODE_RELEASED_PARAMETER[stage]} --type String --overwrite --value ${tip}`);
      expect(lines.findIndex((line) => line.startsWith("npm run release:prod"))).toBeLessThan(lines.length - 1);
      expect(lines.at(-1)).not.toContain("--profile");
      // The record is written once; the release history (L9b) is the only other write, and comes before it.
      expect(lines.filter((line) => line.includes(`put-parameter --name ${CODE_RELEASED_PARAMETER[stage]} `))).toHaveLength(1);
      expect(lines.filter((line) => line.includes("put-parameter"))).toHaveLength(2);
    });

    it(`${name}: records CodeBuild's own source version, not what is checked out when the release ends`, () => {
      const other = "0123456789abcdef0123456789abcdef01234567";
      const { result, log } = buildAs(true, "run", other);
      expect(result.status, result.stderr).toBe(0);
      expect(log.trim().split("\n").at(-1)).toBe(`aws ssm put-parameter --name ${CODE_RELEASED_PARAMETER[stage]} --type String --overwrite --value ${other}`);
    });

    it(`${name}: an empty or non-commit source version stops the build and records nothing`, () => {
      for (const bad of ["", "HEAD", "ABCDEF0123456789ABCDEF0123456789ABCDEF01", "0123456789abcdef0123456789abcdef0123456", "0123456789abcdef0123456789abcdef01234567 "]) {
        const { result, log } = buildAs(true, "run", bad);
        expect(result.status, JSON.stringify(bad)).not.toBe(0);
        expect(result.stderr, JSON.stringify(bad)).toContain("not a commit id");
        expect(log, JSON.stringify(bad)).not.toContain("put-parameter");
      }
    });

    it(`${name}: a failed release writes no record, even with a valid source version in the environment`, () => {
      const { result, log } = buildAs(false, "run", "0123456789abcdef0123456789abcdef01234567");
      expect(result.status).not.toBe(0);
      expect(log).not.toContain("put-parameter");
    });

    it(`${name}: a CODE_RELEASE=skip run writes no record`, () => {
      const { result, log } = buildAs(true, "skip");
      expect(result.status, result.stderr).toBe(0);
      expect(log).not.toContain("put-parameter");
    });
  }
});

describe("L1 follow-up: the pipeline mode in the Code Preflight", () => {
  it("prints a note for release and adopt, and stops on anything else", () => {
    for (const [value, status] of [["release", 0], ["adopt", 0], ["", 1], ["Adopt", 1], ["adopt ", 1], ["release;true", 1], ["off", 1]] as const) {
      const dir = scratch();
      const result = runShell(dir, [PIPELINE_MODE_NOTE], { PIPELINE_MODE: value });
      expect(result.status, JSON.stringify(value)).toBe(status);
      if (status === 0) expect(result.stdout).toBe(`NOTE: pipeline mode is ${value}\n`);
    }
  });
});
