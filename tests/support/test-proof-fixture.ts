// TESTPROOF fixtures: a real git repository whose start commit and candidate differ, and a fake "test runner" that reads the files it
// finds in the workspace, so a run on the original code really sees the original code. Test support only.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyCheck, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const git = (directory: string, ...args: string[]): string =>
  execFileSync("git", ["-C", directory, ...args], { env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();

export const FAKE_TEST_COMMAND: ProjectCommand = { cwd: ".", executable: "npm", args: ["test"], timeoutSeconds: 60 };

async function writeAll(directory: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      execFileSync("git", ["-C", directory, "rm", "-q", "-f", path]);
      continue;
    }
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

/**
 * A repository with a start commit and a candidate commit on top of it (CHECKS runs on a committed candidate). `candidate` maps a path to its
 * new content, or null to delete it. macOS: the temp directory is canonicalised, as /var is a link to /private/var.
 */
export async function repositoryWithCandidate(
  start: Record<string, string>,
  candidate: Record<string, string | null>,
  /** Runs after the candidate's files are written (an executable bit, a symlink, a directory in place of a file) and before they are committed. */
  prepare?: (directory: string) => Promise<void>,
) {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "agentx-testproof-")));
  git(directory, "init", "-q", "-b", "main");
  await writeAll(directory, start);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "start");
  const startCommit = git(directory, "rev-parse", "HEAD");
  await writeAll(directory, candidate);
  await prepare?.(directory);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "candidate");
  return { directory, startCommit, candidateTreeSha: git(directory, "rev-parse", "HEAD^{tree}"), candidateCommit: git(directory, "rev-parse", "HEAD") };
}

/**
 * A fake test runner over `root`/<command.cwd>/src. A test file `src/<name>.test.ts` holds lines `import { <symbol> } from "./<name>.js";`
 * and `expect(<symbol>).toBe(<number>);`; the source file `src/<name>.ts` holds `export const <symbol> = <number>;`. It prints what vitest
 * prints for a missing export or a wrong value, and exits 1 for either, or 0 when every test passes.
 */
export function fakeTestRunner(root: string, calls: ProjectCommand[] = [], onRun?: () => void, fixedOutput?: string): CheckRunners {
  return {
    async runProjectCommand(command) {
      calls.push(command);
      onRun?.();
      const src = join(root, command.cwd, "src");
      const names = (await readdir(src).catch(() => [])).filter((name) => name.endsWith(".test.ts")).sort();
      const failures: string[] = [];
      for (const name of names) {
        const test = await readFile(join(src, name), "utf8");
        const source = await readFile(join(src, name.replace(".test.ts", ".ts")), "utf8").catch(() => "");
        for (const match of test.matchAll(/import \{ (\w+) \} from "\.\/(\w+)\.js";\s*expect\(\1\)\.toBe\((\d+)\);/g)) {
          const [, symbol, , expected] = match;
          const found = new RegExp(`export const ${symbol} = (\\d+);`).exec(source);
          if (found === null) failures.push(`SyntaxError: The requested module './${match[2]}.js' does not provide an export named '${symbol}' (${name})`);
          else if (found[1] !== expected) failures.push(`FAIL ${name}\nAssertionError: expected ${found[1]} to be ${expected} // Object.is equality`);
        }
      }
      return failures.length > 0
        ? { exitCode: 1, timedOut: false, stdout: failures.join("\n"), stderr: "" }
        : { exitCode: 0, timedOut: false, stdout: fixedOutput ?? `${names.length} test files passed\n`, stderr: "" };
    },
    async runAgentCommand() {
      throw new Error("no agent commands in a project-check proof");
    },
  };
}

export function passedEntry(id = "readiness:0", label = "npm test"): CheckEntry {
  return { id, label, source: "project", before: "unknown", after: "passed", class: classifyCheck("unknown", "passed"), output: "ok", durationMs: 5, exitCode: 0 };
}
