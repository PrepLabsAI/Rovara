// Publishes the committed orders web starter (tests/fixtures/orders-web-starter) to a GitHub repository
// as a single seed commit on main. Owner-run. It uses the owner's existing gh authentication through git's
// credential helper, so no token ever appears in an argument, environment variable or log line.
//
// Usage: npx tsx scripts/fixtures/publish-web-fixture.ts --repo <owner/name> [--dry-run] [--force-reseed]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STARTER_DIRECTORY = "tests/fixtures/orders-web-starter";
export const FIXTURE_BRANCH = "main";
export const FIXTURE_COMMIT_MESSAGE = "Seed Rovara orders web fixture";

const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["defects", "node_modules", ".git"]);
const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set([".DS_Store"]);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PublishPlanInput {
  repo: string;
  files: readonly string[];
  /** Whether the remote already has commits; null when it was not checked (dry run). */
  remoteHasCommits: boolean | null;
  forceReseed: boolean;
  dryRun: boolean;
}

export interface PublishPlan {
  repo: string;
  branch: string;
  commitMessage: string;
  files: readonly string[];
  dryRun: boolean;
  /** "seed" for an empty remote, "reseed" for a new commit on top of existing history, "unchecked" for a dry run. */
  mode: "seed" | "reseed" | "unchecked";
}

/** Relative POSIX paths of every regular file the starter publishes, sorted. */
export function listStarterFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (relativeDirectory: string): void => {
    for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) walk(relativePath);
      } else if (entry.isFile() && !EXCLUDED_FILE_NAMES.has(entry.name)) {
        found.push(relativePath);
      }
    }
  };
  walk("");
  return found.sort();
}

export function buildPublishPlan(input: PublishPlanInput): PublishPlan {
  if (!REPO_PATTERN.test(input.repo)) throw new Error(`--repo must look like <owner>/<name>, got "${input.repo}"`);
  if (input.files.length === 0) throw new Error("the starter has no files to publish");
  let mode: PublishPlan["mode"];
  if (input.remoteHasCommits === null) {
    if (!input.dryRun) throw new Error("the remote must be checked before a real publish");
    mode = "unchecked";
  } else if (input.remoteHasCommits) {
    if (!input.forceReseed) throw new Error(`${input.repo} already has commits; pass --force-reseed to add a new seed commit on top (history is never rewritten)`);
    mode = "reseed";
  } else {
    mode = "seed";
  }
  return { repo: input.repo, branch: FIXTURE_BRANCH, commitMessage: FIXTURE_COMMIT_MESSAGE, files: [...input.files], dryRun: input.dryRun, mode };
}

export interface PublishArguments { repo: string; dryRun: boolean; forceReseed: boolean }

export function parsePublishArguments(argv: readonly string[]): PublishArguments {
  let repo: string | undefined;
  let dryRun = false;
  let forceReseed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      repo = argv[index + 1];
      index += 1;
    } else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--force-reseed") forceReseed = true;
    else throw new Error(`unknown argument "${String(argument)}"`);
  }
  if (repo === undefined || repo.startsWith("--")) throw new Error("--repo <owner/name> is required");
  return { repo, dryRun, forceReseed };
}

/** git with gh as the credential helper, so the owner's gh login authorizes the push. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function publish(args: PublishArguments, starterRoot: string, files: readonly string[]): PublishPlan {
  const work = mkdtempSync(join(tmpdir(), "rovara-web-fixture-"));
  try {
    git(work, ["init", "--quiet", "-b", FIXTURE_BRANCH]);
    git(work, ["remote", "add", "origin", `https://github.com/${args.repo}.git`]);
    const remoteHeads = git(work, ["ls-remote", "--heads", "origin"]).trim();
    const remoteHasCommits = remoteHeads !== "";
    const plan = buildPublishPlan({ repo: args.repo, files, remoteHasCommits, forceReseed: args.forceReseed, dryRun: false });
    if (remoteHasCommits) {
      if (!remoteHeads.split("\n").some((line) => line.endsWith(`\trefs/heads/${FIXTURE_BRANCH}`))) {
        throw new Error(`${args.repo} has commits but no ${FIXTURE_BRANCH} branch; refusing to publish`);
      }
      git(work, ["fetch", "--quiet", "origin", FIXTURE_BRANCH]);
      git(work, ["checkout", "--quiet", "-B", FIXTURE_BRANCH, `origin/${FIXTURE_BRANCH}`]);
      for (const entry of readdirSync(work)) if (entry !== ".git") rmSync(join(work, entry), { recursive: true, force: true });
    }
    for (const file of files) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      cpSync(join(starterRoot, file), join(work, file));
    }
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "--allow-empty", "-m", FIXTURE_COMMIT_MESSAGE]);
    git(work, ["push", "origin", `${FIXTURE_BRANCH}:${FIXTURE_BRANCH}`]);
    return plan;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function run(argv: readonly string[], log: (line: string) => void = console.log): number {
  const args = parsePublishArguments(argv);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const starterRoot = join(repositoryRoot, STARTER_DIRECTORY);
  const files = listStarterFiles(starterRoot);
  if (args.dryRun) {
    const plan = buildPublishPlan({ repo: args.repo, files, remoteHasCommits: null, forceReseed: args.forceReseed, dryRun: true });
    log(`dry run: would push ${plan.files.length} files from ${STARTER_DIRECTORY} to https://github.com/${plan.repo} (${plan.branch}), commit "${plan.commitMessage}"`);
    for (const file of plan.files) log(`  ${file}`);
    return 0;
  }
  const plan = publish(args, starterRoot, files);
  log(`published ${plan.files.length} files to https://github.com/${plan.repo} (${plan.branch}, ${plan.mode})`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
