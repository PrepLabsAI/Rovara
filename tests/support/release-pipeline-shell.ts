// Real-shell helpers for the release pipeline's buildspec tests (L1 review and follow-up): a scratch directory per test, fake tools on the PATH, throwaway git repos.
// Fake tools only (a fake `node` that names the script it was given, a fake `aws` that answers `ssm get-parameter`); no network, no AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { codePreflightBuildSpec } from "../../infra/lib/release-pipeline.js";

const dirs: string[] = [];
export const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "l1-review-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const fakeBin = (dir: string, log: string, names: readonly string[]): string => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    // The fake node prints the first line of the script it runs, so a test can tell WHICH tree's script ran.
    // The fake aws answers `ssm get-parameter` with FAKE_RELEASED_SHA (the record of the last released Code commit), or fails when FAKE_AWS_FAIL is set.
    const body = name === "node"
      ? `#!/bin/bash\necho "node $*" >> "${log}"\nhead -1 "$1"\n`
      : name === "aws"
        ? [
            "#!/bin/bash",
            `echo "aws $*" >> "${log}"`,
            // The release history parameter (a read or a write): FAKE_HISTORY is its value; FAKE_HISTORY_MISSING answers like a parameter that does not exist, FAKE_HISTORY_FAIL like any other failure.
            'if [[ "$*" == *code-history* && "$*" == *get-parameter* ]]; then',
            '  [ -z "$FAKE_HISTORY_FAIL" ] || { echo "An error occurred (AccessDeniedException)" >&2; exit 254; }',
            '  [ -z "$FAKE_HISTORY_MISSING" ] || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; }',
            '  echo "$FAKE_HISTORY"; exit 0',
            "fi",
            // The waiting execution lookups (Beta's Preflight): FAKE_WAITING_EXEC, FAKE_WAITING_SHA; FAKE_CODEPIPELINE_FAIL fails both.
            'if [[ "$1" == codepipeline ]]; then',
            '  [ -z "$FAKE_CODEPIPELINE_FAIL" ] || exit 254',
            '  [[ "$2" == get-pipeline-state ]] && echo "${FAKE_WAITING_EXEC:-None}"',
            // Which source started the run (Beta's Preflight, triggerCommands): FAKE_TRIGGER_TYPE answers the trigger type, FAKE_SOURCES (tab-separated lines, \\n and \\t spelled out) the two source actions.
            '  [[ "$2" == get-pipeline-execution && "$*" == *trigger.triggerType* ]] && { echo "${FAKE_TRIGGER_TYPE:-None}"; exit 0; }',
            '  [[ "$2" == list-action-executions ]] && { [ -z "$FAKE_SOURCES_FAIL" ] || exit 254; printf "%b\\n" "${FAKE_SOURCES:-}"; exit 0; }',
            '  [[ "$2" == get-pipeline-execution ]] && echo "${FAKE_WAITING_SHA:-None}"',
            "  exit 0",
            "fi",
            '[ -z "$FAKE_AWS_FAIL" ] || exit 254',
            'echo "$FAKE_RELEASED_SHA"',
            "",
          ].join("\n")
        : `#!/bin/bash\necho "${name} $*" >> "${log}"\n`;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};

export const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
export const commitFile = (repo: string, path: string, content: string, message: string): void => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", message);
};

/** The Code Preflight's build phase, as the buildspec has it, with only the worktree directory moved into the test's scratch. */
export const preflightBuild = (trustedDir: string, closesGate = false): string[] => {
  // BuildSpec.fromObject keeps the object as `spec` (toBuildSpec() returns a lazy token outside a stack).
  const spec = (codePreflightBuildSpec(closesGate, "/test/names", "/test/released", "/test/code-history") as unknown as { spec: { phases: { build: { commands: string[] } } } }).spec;
  // CodeBuild stops a phase at its first failing command; the shell does so only with errexit.
  return ["set -e", ...spec.phases.build.commands.map((command) => command.replaceAll("/tmp/port-guard-trusted", trustedDir))];
};
/** The buildspecs' own variable defaults (a CodeBuild build has them before its first command); a test's env overrides them. */
export const BUILDSPEC_DEFAULTS = { PIPELINE_MODE: "release", CODE_ROLLBACK_TARGET: "none" } as const;
export const runShell = (cwd: string, commands: readonly string[], env: Record<string, string>) =>
  spawnSync("bash", ["-c", commands.join("\n")], { cwd, encoding: "utf8", env: { ...process.env, ...BUILDSPEC_DEFAULTS, ...env } });

