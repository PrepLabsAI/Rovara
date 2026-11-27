// L9b: a Code rollback through the pipeline. The per-stage release history (written by the same finished-release step as the released record), the rollback run in the Code
// Preflight (a target must be in the history; the CURRENT released commit's guard judges target..released; nothing of the target runs while the private list is on disk), the
// release build that deploys the target and records it, and what the Preflight exports to the Cloud actions (one variable, CODE_CTX). Real shell with fake tools.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_RELEASE_PROJECT_NAME,
  AGENTX_RELEASE_PROJECT_NAME,
  CODE_HISTORY_LIMIT,
  CODE_HISTORY_PARAMETER,
  CODE_RELEASED_PARAMETER,
  PIPELINE_MODE_NOTE,
  RELEASE_TOOL_INSTALL_COMMANDS,
  ROLLBACK_TARGET_CHECK,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { commitFile, fakeBin, git, preflightBuild, runShell, scratch } from "../support/release-pipeline-shell.js";

const GUARD = "scripts/port-guard-pipeline.ts";
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const list = (...shas: string[]): string => JSON.stringify(shas);

/** mainline: c1 (target), c2, c3 (released), c4 (unreleased tip); each commit's guard says which commit it is. */
const newRepo = (dir: string) => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "mainline");
  const commits: string[] = [];
  for (const [n, label] of [[1, "TARGET v1"], [2, "v2"], [3, "RELEASED v3"], [4, "UNRELEASED v4"]] as const) {
    writeFileSync(join(repo, ".node-version"), `22.${n}.0\n`);
    commitFile(repo, GUARD, `// guard ${label}\n`, `commit ${n}`);
    git(repo, "add", ".node-version");
    git(repo, "commit", "-q", "--amend", "--no-edit");
    commits.push(git(repo, "rev-parse", "HEAD"));
  }
  return { repo, c1: commits[0]!, c2: commits[1]!, c3: commits[2]!, c4: commits[3]! };
};

const preflight = (
  dir: string,
  repo: string,
  env: Record<string, string>,
  options: { closesGate?: boolean; tail?: string } = {},
) => {
  const log = join(dir, "log");
  const bin = fakeBin(dir, log, ["node", "aws"]);
  const commands = [...preflightBuild(join(dir, "trusted"), options.closesGate ?? false), ...(options.tail === undefined ? [] : [options.tail])];
  const result = runShell(repo, commands, { PATH: `${bin}:${process.env.PATH}`, PORT_GUARD_NAMES_PARAMETER: "/test/names", ...env });
  return { result, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
};
const rollbackEnv = (released: string, target: string, history: string, extra: Record<string, string> = {}) => ({
  PIPELINE_MODE: "rollback",
  CODE_ROLLBACK_TARGET: target,
  FAKE_RELEASED_SHA: released,
  FAKE_HISTORY: history,
  ...extra,
});
const refusedBeforeAnyGuard = (outcome: { result: { status: number | null; stderr: string }; log: string }, why: RegExp, dir: string): void => {
  expect(outcome.result.status, outcome.result.stderr).toBe(2);
  expect(outcome.result.stderr).toMatch(why);
  expect(outcome.log).not.toContain("node ");
  expect(existsSync(join(dir, "trusted"))).toBe(false);
};

describe("L9b Preflight: a rollback target must be in the stage's release history, and the CURRENT released guard judges it", () => {
  it("a rollback to a recorded sha passes: the guard is the released commit's, over target..released, and nothing of the target or of this run's commit runs", () => {
    const dir = scratch();
    const { repo, c1, c3 } = newRepo(dir);
    const { result, log } = preflight(dir, repo, rollbackEnv(c3, c1, list(c3, sha(9), c1)));
    expect(result.status, result.stderr).toBe(0);
    // The guard script that ran is the released commit's (the fake node prints the first line of the script it was given), never the target's or the tip's.
    expect(result.stdout).toContain("// guard RELEASED v3");
    expect(result.stdout).not.toMatch(/TARGET v1|UNRELEASED v4/u);
    expect(git(join(dir, "trusted"), "rev-parse", "HEAD")).toBe(c3);
    // The second range is what the rollback takes away, between the target and the released commit; the first (this run's commit) is empty because the clone sits on the released commit.
    expect(log).toContain("node scripts/port-guard-pipeline.ts --range rollback-target..release-tip --allow-guard-edits");
    expect(git(repo, "rev-parse", "rollback-target")).toBe(c1);
    expect(git(repo, "rev-parse", "release-tip")).toBe(c3);
    expect(git(repo, "rev-list", "--count", "rollback-target..release-tip")).toBe("2");
    expect(git(repo, "rev-parse", "HEAD")).toBe(c3);
  });

  it("reads the history of ITS stage", () => {
    const dir = scratch();
    const { repo, c1, c3 } = newRepo(dir);
    const { log } = preflight(dir, repo, rollbackEnv(c3, c1, list(c3, c1)));
    expect(log).toContain("aws ssm get-parameter --name /test/code-history ");
  });

  it("refuses an older sha that is NOT in the history, before any guard runs and before the worktree exists", () => {
    const dir = scratch();
    const { repo, c1, c2, c3 } = newRepo(dir);
    for (const history of [list(c3, c2), list(c3, sha(1)), list()]) {
      const outcome = preflight(scratch(), repo, rollbackEnv(c3, c1, history));
      expect(outcome.result.status, history).toBe(2);
      expect(outcome.result.stderr).toMatch(/the rollback target is not in this stage's Code release history; refusing to run the release/u);
      expect(outcome.log).not.toContain("node ");
    }
    const outcome = preflight(dir, repo, rollbackEnv(c3, c1, list(c3, c2)));
    refusedBeforeAnyGuard(outcome, /not in this stage's Code release history/u, dir);
    expect(() => git(repo, "rev-parse", "--verify", "rollback-target")).toThrow();
    expect(() => git(repo, "rev-parse", "--verify", "release-tip")).toThrow();
  });

  it("fails closed, with nothing run, when the history is missing, unreadable or garbled", () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["", { FAKE_HISTORY_MISSING: "1" }, /could not be read/u],
      ["", { FAKE_HISTORY_FAIL: "1" }, /could not be read/u],
      ["", {}, /not a list of commits/u],
      ["None", {}, /not a list of commits/u],
      ["not json", {}, /not a list of commits/u],
      ["{}", {}, /not a list of commits/u],
      ['["short"]', {}, /not a list of commits/u],
      ['[{"sha":"x"}]', {}, /not a list of commits/u],
      ["[", {}, /not a list of commits/u],
    ];
    for (const [history, extra, why] of cases) {
      const dir = scratch();
      const repo = newRepo(dir);
      refusedBeforeAnyGuard(preflight(dir, repo.repo, rollbackEnv(repo.c3, repo.c1, history, extra)), why, dir);
    }
    // A target named only inside something that is not a clean list does not count.
    const dir = scratch();
    const repo = newRepo(dir);
    refusedBeforeAnyGuard(preflight(dir, repo.repo, rollbackEnv(repo.c3, repo.c1, `junk "${repo.c1}" junk`)), /not a list of commits/u, dir);
    const second = scratch();
    const again = newRepo(second);
    refusedBeforeAnyGuard(preflight(second, again.repo, rollbackEnv(again.c3, again.c1, `[${JSON.stringify(again.c3)}, "x${again.c1}"]`)), /not a list of commits/u, second);
  });

  it("reads the list tolerantly: whitespace, line breaks and more entries than the limit are fine", () => {
    const dir = scratch();
    const { repo, c1, c3 } = newRepo(dir);
    const history = `[\n  "${c3}",\n  ${Array.from({ length: 14 }, (_, n) => `"${sha(n + 100)}"`).join(",\n  ")},\n  "${c1}"\n]\n`;
    const { result } = preflight(dir, repo, rollbackEnv(c3, c1, history));
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses the commit already released, a target this clone does not have, and a target that is not older than the released commit", () => {
    for (const [pick, why] of [
      [(r: ReturnType<typeof newRepo>) => ({ released: r.c3, target: r.c3, history: list(r.c3, r.c2) }), /the rollback target is the commit already released/u],
      [(r: ReturnType<typeof newRepo>) => ({ released: r.c3, target: sha(7), history: list(r.c3, sha(7)) }), /the rollback target is not in this clone/u],
      // c4 is in the history (an earlier release that was rolled back) but is newer than the released c2: that is a forward run, not a rollback.
      [(r: ReturnType<typeof newRepo>) => ({ released: r.c2, target: r.c4, history: list(r.c2, r.c4) }), /the rollback target is not older than the last released commit/u],
    ] as const) {
      const dir = scratch();
      const r = newRepo(dir);
      const { released, target, history } = pick(r);
      refusedBeforeAnyGuard(preflight(dir, r.repo, rollbackEnv(released, target, history)), why, dir);
    }
  });

  it("a forward run is unchanged: the history is never read, so a missing or garbled list cannot stop it", () => {
    for (const extra of [{}, { FAKE_HISTORY_MISSING: "1" }, { FAKE_HISTORY_FAIL: "1" }, { FAKE_HISTORY: "garbage" }]) {
      const dir = scratch();
      const { repo, c3 } = newRepo(dir);
      // c4 is a single commit directly on the released c3.
      const { result, log } = preflight(dir, repo, { FAKE_RELEASED_SHA: c3, ...extra });
      expect(result.status, result.stderr).toBe(0);
      expect(log).toContain("node scripts/port-guard-pipeline.ts --range HEAD..release-tip --allow-guard-edits");
      expect(log).not.toContain("rollback-target");
      expect(log).not.toContain("code-history");
      expect(result.stdout).toContain("// guard RELEASED v3");
      expect(git(repo, "rev-list", "--count", `${c3}..release-tip`)).toBe("1");
    }
  });

  it("a rollback run with target none (Cloud only) is judged like a forward run", () => {
    const dir = scratch();
    const { repo, c3 } = newRepo(dir);
    const { result, log } = preflight(dir, repo, { PIPELINE_MODE: "rollback", CODE_ROLLBACK_TARGET: "none", FAKE_RELEASED_SHA: c3 });
    expect(result.status, result.stderr).toBe(0);
    expect(log).not.toContain("code-history");
    expect(log).not.toContain("rollback-target");
  });

  it("states the mode and the target together in the build, and refuses a mismatch at the first command", () => {
    const check = (mode: string, target: string) => {
      const dir = scratch();
      return runShell(dir, [PIPELINE_MODE_NOTE, ROLLBACK_TARGET_CHECK], { PIPELINE_MODE: mode, CODE_ROLLBACK_TARGET: target });
    };
    for (const [mode, target, status] of [
      ["rollback", sha(5), 0],
      ["rollback", "none", 0],
      ["release", "none", 0],
      ["adopt", "none", 0],
      ["rollback", sha(5).slice(1), 1],
      ["rollback", sha(0xabcdef).toUpperCase(), 1],
      ["rollback", "HEAD", 1],
      ["rollback", "", 1],
      ["rollback", `${sha(5)} `, 1],
      ["release", sha(5), 1],
      ["adopt", sha(5), 1],
      ["Rollback", "none", 1],
    ] as const) {
      expect(check(mode, target).status, `${mode} ${JSON.stringify(target)}`).toBe(status);
    }
    expect(check("rollback", sha(5)).stdout).toContain(`NOTE: Code rollback target is ${sha(5)}`);
    expect(check("release", sha(5)).stderr).toMatch(/only for PIPELINE_MODE=rollback/u);
  });
});

describe("L9b Preflight: exports CODE_LIVE_SHA and notes superseded waiting runs", () => {
  const exported = 'echo "LIVE=$CODE_LIVE_SHA"';
  const uuid = "0a1b2c3d-1111-2222-3333-44445555666a";
  const liveSha = (stdout: string): string => /^LIVE=([0-9a-f]{40})$/mu.exec(stdout)![1]!;

  it("exports the stage's released commit as CODE_LIVE_SHA in both rollback and forward runs", () => {
    const dir = scratch();
    const { repo, c1, c3 } = newRepo(dir);
    const rollback = preflight(dir, repo, rollbackEnv(c3, c1, list(c3, c1)), { tail: exported });
    expect(rollback.result.status, rollback.result.stderr).toBe(0);
    expect(liveSha(rollback.result.stdout)).toBe(c3);
    const forward = scratch();
    const again = newRepo(forward);
    const run = preflight(forward, again.repo, { FAKE_RELEASED_SHA: again.c3 }, { tail: exported });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(liveSha(run.result.stdout)).toBe(again.c3);
  });

  it("notes the execution waiting in front of Production and its Code commit (Beta)", () => {
    const dir = scratch();
    const { repo, c3 } = newRepo(dir);
    const { result, log } = preflight(dir, repo, { FAKE_RELEASED_SHA: c3, FAKE_WAITING_EXEC: uuid, FAKE_WAITING_SHA: sha(42), EXEC_ID: "99999999-1111-2222-3333-44445555666b" }, { tail: exported });
    expect(result.status, result.stderr).toBe(0);
    expect(liveSha(result.stdout)).toBe(c3);
    expect(result.stdout).toContain(`NOTE: this run replaces the execution ${uuid} (Code ${sha(42)})`);
    expect(log).toContain("aws codepipeline get-pipeline-state --name AgentXProductionRelease ");
    expect(log).toContain(`aws codepipeline get-pipeline-execution --pipeline-name AgentXProductionRelease --pipeline-execution-id ${uuid} `);
  });

  it("does not fail when nothing waits, lookup fails, value is not an execution id, or it is this run's own", () => {
    for (const extra of [
      {},
      { FAKE_WAITING_EXEC: "None" },
      { FAKE_WAITING_EXEC: "not-an-id" },
      { FAKE_WAITING_EXEC: 'x"; echo pwned; "' },
      { FAKE_WAITING_EXEC: uuid, EXEC_ID: uuid },
      { FAKE_WAITING_EXEC: uuid, FAKE_CODEPIPELINE_FAIL: "1" },
    ]) {
      const dir = scratch();
      const { repo, c3 } = newRepo(dir);
      const { result } = preflight(dir, repo, { FAKE_RELEASED_SHA: c3, ...extra }, { tail: exported });
      expect(result.status, JSON.stringify(extra)).toBe(0);
      expect(liveSha(result.stdout)).toBe(c3);
      expect(result.stdout).not.toContain("replaces the execution");
      if ("FAKE_CODEPIPELINE_FAIL" in extra) expect(result.stderr).toContain("could not be read");
    }
  });

  it("Production's Preflight asks for no waiting run and still exports CODE_LIVE_SHA", () => {
    const dir = scratch();
    const { repo, c3 } = newRepo(dir);
    const { result, log } = preflight(dir, repo, { FAKE_RELEASED_SHA: c3, FAKE_WAITING_EXEC: uuid }, { closesGate: true, tail: exported });
    expect(result.status, result.stderr).toBe(0);
    expect(log).not.toContain("codepipeline");
    expect(liveSha(result.stdout)).toBe(c3);
  });
});

describe("L9b release build: the history, the rollback checkout, the record", () => {
  const template = Template.fromStack(new ReleasePipelineStack(new App(), "L9bReleasePipeline", { env: { region: "us-east-1" } })).toJSON() as {
    Resources: Record<string, { Type: string; Properties: { Name?: string; Source?: { BuildSpec?: unknown } } }>;
  };
  const specOf = (name: string) => {
    const raw = Object.values(template.Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === name)?.Properties.Source?.BuildSpec;
    const text = typeof raw === "string" ? raw : ((raw as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "TOKEN")).join(""));
    return JSON.parse(text) as { phases: Record<string, { commands: string[] }>; env: { variables: Record<string, string> } };
  };
  const stages = [[AGENTX_RELEASE_PROJECT_NAME, "production"], [AGENTX_BETA_RELEASE_PROJECT_NAME, "beta"]] as const;

  type Repo = ReturnType<typeof newRepo>;
  /** A value that may depend on the build's own repository (commit ids differ per repository). */
  type Of<T> = T | ((repo: Repo) => T);
  const of = <T,>(value: Of<T>, repo: Repo): T => (typeof value === "function" ? (value as (repo: Repo) => T)(repo) : value);
  interface Options {
    mode?: string;
    target?: Of<string>;
    codeRelease?: string;
    resolved?: Of<string>;
    releaseSucceeds?: boolean;
    history?: Of<Record<string, string>>;
  }
  const build = (name: string, options: Options = {}) => {
    const dir = scratch();
    const r = newRepo(dir);
    git(r.repo, "checkout", "-q", "--detach", r.c4);
    const log = join(dir, "log");
    const bin = fakeBin(dir, log, ["node", "aws", "docker"]);
    // npm stands for `npm run release:prod`: it names the commit that is checked out when it runs, and fails when asked to.
    writeFileSync(join(bin, "npm"), `#!/bin/bash\necho "npm $* at $(git rev-parse HEAD)" >> "${log}"\n${options.releaseSucceeds === false ? "exit 1\n" : ""}`);
    chmodSync(join(bin, "npm"), 0o755);
    const spec = specOf(name);
    // The install commands that are about the run (the mode and target checks, the history checks, the rollback checkout); the tool downloads stay out.
    // They run in ONE shell, as in CodeBuild (the history checks hand variables to each other).
    const install = spec.phases.install!.commands.filter(
      (command) =>
        !RELEASE_TOOL_INSTALL_COMMANDS.some((tool) => command.includes(tool)) &&
        (command.includes("CODE_ROLLBACK_TARGET") || command.includes("PIPELINE_MODE")),
    );
    const result = runShell(r.repo, ["set -e", ...install, ...spec.phases.build!.commands.map((command) => `(${command})`)], {
      PATH: `${bin}:/usr/bin:/bin`,
      CODE_RELEASE: options.codeRelease ?? "run",
      HOME: dir,
      AWS_REGION: "us-east-1",
      BETA_RELEASE_ROLE_ARN: "arn:aws:iam::123456789012:role/test",
      CODEBUILD_RESOLVED_SOURCE_VERSION: options.resolved === undefined ? r.c4 : of(options.resolved, r),
      ...(options.mode === undefined ? {} : { PIPELINE_MODE: options.mode }),
      ...(options.target === undefined ? {} : { CODE_ROLLBACK_TARGET: of(options.target, r) }),
      ...(options.history === undefined ? { FAKE_HISTORY_MISSING: "1" } : of(options.history, r)),
    });
    return { result, log: existsSync(log) ? readFileSync(log, "utf8") : "", ...r };
  };
  const writes = (log: string, parameter: string): string[] =>
    log.split("\n").filter((line) => line.startsWith(`aws ssm put-parameter --name ${parameter} `)).map((line) => line.split(" --value ")[1]!);

  for (const [name, stage] of stages) {
    it(`${name}: after a finished release, the history gets the commit first and the record is still the LAST command; both name the same commit`, () => {
      const { result, log, c4 } = build(name);
      expect(result.status, result.stderr).toBe(0);
      expect(writes(log, CODE_HISTORY_PARAMETER[stage])).toEqual([list(c4)]);
      expect(writes(log, CODE_RELEASED_PARAMETER[stage])).toEqual([c4]);
      const lines = log.trim().split("\n");
      expect(lines.at(-1)).toBe(`aws ssm put-parameter --name ${CODE_RELEASED_PARAMETER[stage]} --type String --overwrite --value ${c4}`);
      expect(lines.findIndex((line) => line.includes(CODE_HISTORY_PARAMETER[stage]) && line.includes("put-parameter"))).toBeLessThan(lines.length - 1);
      // Only this stage's parameters are touched.
      for (const other of [...Object.values(CODE_HISTORY_PARAMETER), ...Object.values(CODE_RELEASED_PARAMETER)]) {
        if (other !== CODE_HISTORY_PARAMETER[stage] && other !== CODE_RELEASED_PARAMETER[stage]) expect(log).not.toContain(other);
      }
      // The record and the history are written with the build's own credentials, never the beta profile.
      expect(log.split("\n").filter((line) => line.startsWith("aws ssm put-parameter")).join("\n")).not.toContain("--profile");
    });

    it(`${name}: the same braced step: a failed release writes neither the history nor the record, a skipped one neither`, () => {
      for (const options of [{ releaseSucceeds: false }, { codeRelease: "skip" }] as const) {
        const { log } = build(name, options);
        expect(log, JSON.stringify(options)).not.toContain("put-parameter");
      }
      // Nor a build whose source version is not a commit id.
      const { result, log } = build(name, { resolved: "" });
      expect(result.status).not.toBe(0);
      expect(log).not.toContain("put-parameter");
    });

    it(`${name}: prepends the commit, drops a repeat, keeps the newest ${CODE_HISTORY_LIMIT}`, () => {
      const old = Array.from({ length: CODE_HISTORY_LIMIT }, (_, n) => sha(n + 1));
      const fresh = build(name, { history: { FAKE_HISTORY: JSON.stringify(old) } });
      const [written] = writes(fresh.log, CODE_HISTORY_PARAMETER[stage]);
      expect(JSON.parse(written!)).toEqual([fresh.c4, ...old.slice(0, CODE_HISTORY_LIMIT - 1)]);
      // A commit already in the list moves to the front instead of appearing twice.
      const repeat = build(name, { history: { FAKE_HISTORY: JSON.stringify([sha(1), sha(2), "__C4__"]).replace("__C4__", sha(3)) }, resolved: sha(2) });
      expect(JSON.parse(writes(repeat.log, CODE_HISTORY_PARAMETER[stage])[0]!)).toEqual([sha(2), sha(1), sha(3)]);
    });

    it(`${name}: a garbled or missing list starts again from what is valid, and never stops a forward release`, () => {
      const c = (n: number) => sha(n + 50);
      for (const [value, expected] of [
        ["garbage", []],
        ["", []],
        ["{}", []],
        // Any quoted 40-hex string is taken, whatever holds it; what is not one is dropped.
        [`["short", "${c(1)}", 7, {"sha": "${c(2)}"}, "${c(3)}", "${c(3)}x"]`, [c(1), c(2), c(3)]],
        [`  [ "${c(4)}" ,\n "${c(5)}" ]  `, [c(4), c(5)]],
      ] as const) {
        const { result, log, c4 } = build(name, { history: { FAKE_HISTORY: value } });
        expect(result.status, JSON.stringify(value)).toBe(0);
        expect(JSON.parse(writes(log, CODE_HISTORY_PARAMETER[stage])[0]!), JSON.stringify(value)).toEqual([c4, ...expected]);
      }
      expect(build(name, { history: { FAKE_HISTORY_MISSING: "1" } }).result.status).toBe(0);
    });

    it(`${name}: a history read that fails for any other reason stops the build before anything is written (a list it could not read is never overwritten)`, () => {
      const { result, log } = build(name, { history: { FAKE_HISTORY_FAIL: "1" } });
      expect(result.status).not.toBe(0);
      expect(log).not.toContain("put-parameter");
    });

    it(`${name}: a rollback deploys the TARGET (checked out before the release) and records it as the released commit and the history head, not this run's source version`, () => {
      const { result, log, c1, c2, c3, c4 } = build(name, {
        mode: "rollback",
        target: (r) => r.c1,
        resolved: (r) => r.c4,
        history: (r) => ({ FAKE_HISTORY: list(r.c3, r.c2, r.c1) }),
      });
      expect(result.status, result.stderr).toBe(0);
      // The release ran on the target's tree.
      expect(log).toMatch(new RegExp(`^npm run release:prod .* at ${c1}$`, "mu"));
      expect(log).not.toContain(c4);
      expect(writes(log, CODE_RELEASED_PARAMETER[stage])).toEqual([c1]);
      const [history] = writes(log, CODE_HISTORY_PARAMETER[stage]);
      // The target moves to the head of the history (it was the oldest entry); nothing else changes.
      expect(JSON.parse(history!)).toEqual([c1, c3, c2]);
      expect(log.trim().split("\n").at(-1)).toBe(`aws ssm put-parameter --name ${CODE_RELEASED_PARAMETER[stage]} --type String --overwrite --value ${c1}`);
    });

    it(`${name}: a rollback whose release fails records nothing, and a target that is not in the clone cannot be deployed`, () => {
      const failed = build(name, { mode: "rollback", target: (r) => r.c1, history: (r) => ({ FAKE_HISTORY: list(r.c3, r.c1) }), releaseSucceeds: false });
      expect(failed.result.status).not.toBe(0);
      expect(failed.log).not.toContain("put-parameter");
      const missing = build(name, { mode: "rollback", target: sha(77), history: { FAKE_HISTORY: list(sha(77)) } });
      expect(missing.result.status).not.toBe(0);
      expect(missing.log).not.toContain("npm run release:prod");
      expect(missing.log).not.toContain("put-parameter");
    });

    it(`${name}: repeats the Preflight's checks on the target before the checkout: not in the history, an unreadable or garbled history, not an ancestor of this run's commit`, () => {
      const sibling = (r: Repo): string => {
        // A commit in the clone that is not an ancestor of this run's commit (c4), and is in the history.
        git(r.repo, "checkout", "-q", "-b", "side", r.c1);
        commitFile(r.repo, "side.txt", "x\n", "side");
        const side = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "--detach", r.c4);
        return side;
      };
      const cases: Array<[string, Options, RegExp]> = [
        ["not in the history", { mode: "rollback", target: (r) => r.c1, history: (r) => ({ FAKE_HISTORY: list(r.c3, r.c2) }) }, /not in this stage's Code release history; Code is not rolled back/u],
        ["an empty history", { mode: "rollback", target: (r) => r.c1, history: { FAKE_HISTORY: "[]" } }, /not in this stage's Code release history/u],
        ["a garbled history", { mode: "rollback", target: (r) => r.c1, history: (r) => ({ FAKE_HISTORY: `junk "${r.c1}"` }) }, /not a list of commits/u],
        ["a missing history", { mode: "rollback", target: (r) => r.c1, history: { FAKE_HISTORY_MISSING: "1" } }, /could not be read/u],
        ["an unreadable history", { mode: "rollback", target: (r) => r.c1, history: { FAKE_HISTORY_FAIL: "1" } }, /could not be read/u],
        ["a target not in the clone", { mode: "rollback", target: sha(77), history: { FAKE_HISTORY: list(sha(77)) } }, /not in this clone/u],
      ];
      for (const [label, options, why] of cases) {
        const { result, log, repo, c4 } = build(name, options);
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toMatch(why);
        // Nothing was checked out, released or recorded.
        expect(git(repo, "rev-parse", "HEAD"), label).toBe(c4);
        expect(log, label).not.toContain("npm run release:prod");
        expect(log, label).not.toContain("put-parameter");
      }
      // The ancestor check on its own: the sibling IS in the history.
      const ancestor = build(name, {
        mode: "rollback",
        target: sibling,
        history: (r) => ({ FAKE_HISTORY: list(r.c3, git(r.repo, "rev-parse", "side")) }),
      });
      expect(ancestor.result.status).toBe(1);
      expect(ancestor.result.stderr).toMatch(/not an ancestor of this run's commit; Code is not rolled back/u);
      expect(git(ancestor.repo, "rev-parse", "HEAD")).toBe(ancestor.c4);
      expect(ancestor.log).not.toContain("npm run release:prod");
    });

    it(`${name}: stops at its first commands when the mode, the target and CODE_RELEASE do not agree, whatever the history says`, () => {
      const agree = (target: string) => ({ mode: "rollback", target, history: (r: Repo) => ({ FAKE_HISTORY: list(r.c3, r.c1) }) });
      const cases: Array<[string, Options, RegExp]> = [
        ["a rollback target but CODE_RELEASE=skip", { ...agree("__c1__"), codeRelease: "skip" }, /Code would not be rolled back/u],
        ["a rollback with no target but CODE_RELEASE=run", { mode: "rollback", target: "none", codeRelease: "run" }, /does not release Code/u],
        ["a target in a release run", { mode: "release", target: (r: Repo) => r.c1 }, /only for PIPELINE_MODE=rollback/u],
        ["a target in an adoption run", { mode: "adopt", target: (r: Repo) => r.c1, codeRelease: "skip" }, /only for PIPELINE_MODE=rollback/u],
        ["a target that is not a full commit id", { mode: "rollback", target: "HEAD" }, /40-character commit id/u],
        ["an unknown mode", { mode: "undo", target: "none" }, /must be release, adopt or rollback/u],
      ];
      for (const [label, options, why] of cases) {
        const withTarget = options.target === "__c1__" ? { ...options, target: (r: Repo) => r.c1 } : options;
        const { result, log } = build(name, withTarget);
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toMatch(why);
        expect(log, label).not.toContain("npm run release:prod");
        expect(log, label).not.toContain("put-parameter");
      }
    });

    it(`${name}: a rollback run with no target and CODE_RELEASE=skip releases nothing and records nothing`, () => {
      const { result, log } = build(name, { mode: "rollback", target: "none", codeRelease: "skip" });
      expect(result.status, result.stderr).toBe(0);
      expect(log).toBe("");
    });
  }
});

describe("L9b: headroom under CodePipeline's 1000-character limit on every action configuration value", () => {
  it("leaves at least 100 characters on every action (account ids filled in), so the Cloud lane can still add a variable", () => {
    const pipeline = Object.values(
      Template.fromStack(new ReleasePipelineStack(new App(), "L9bHeadroom", { env: { region: "us-east-1" } })).toJSON().Resources as Record<string, { Type: string; Properties: { Stages: Array<{ Name: string; Actions: Array<{ Name: string; Configuration?: Record<string, unknown> }> }> } }>,
    ).find((resource) => resource.Type === "AWS::CodePipeline::Pipeline")!;
    const lengths: Array<[string, number]> = [];
    for (const stage of pipeline.Properties.Stages) {
      for (const action of stage.Actions) {
        for (const [key, value] of Object.entries(action.Configuration ?? {})) {
          const text = typeof value === "string" ? value : (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"]?.[1].map((part) => (typeof part === "string" ? part : "123456789012")).join("") ?? JSON.stringify(value);
          lengths.push([`${stage.Name}/${action.Name}/${key}`, text.length]);
        }
      }
    }
    expect(lengths.filter(([, length]) => length > 900)).toEqual([]);
    expect(lengths.length).toBeGreaterThan(20);
  });
});
