// Publishes the committed (HEAD) orders web fixture to a GitHub repository as a single seed commit on main.
// Owner-run. It uses the owner's existing gh authentication through git's credential helper, so no token ever
// appears in an argument, environment variable or log line.
//
// Variants: "starter" (default) publishes tests/fixtures/orders-web-starter as it is. "m14" publishes the M1.4 live
// baseline, which is generated from the committed local Linux fixture tests/fixtures/orders-web-m14 (see FIXTURE_VARIANTS).
//
// Usage: npx tsx scripts/fixtures/publish-web-fixture.ts --repo <owner/name> [--variant starter|m14] [--dry-run] [--force-reseed]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STARTER_DIRECTORY = "tests/fixtures/orders-web-starter";
export const M14_DIRECTORY = "tests/fixtures/orders-web-m14";
export const DEFAULT_VARIANT = "starter";
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

export interface FixtureEdit {
  file: string;
  /** Text that must occur exactly once in the file. */
  from: string;
  to: string;
}

export interface FixtureVariant {
  /** The committed directory the variant is generated from. */
  directory: string;
  /** Files of the directory that the variant does not publish. */
  exclude: readonly string[];
  /** Exact-once text edits applied to the published files. */
  edits: readonly FixtureEdit[];
}

const LOCAL_ONLY_BEGIN = "fixture-variant:local-only:begin";
const LOCAL_ONLY_END = "fixture-variant:local-only:end";

/**
 * The publishable variants. "m14" is the live baseline: the M1.3 reference state after its demo (viewer refusal, tenant isolation and the
 * inventory column are in place) with the owner button still `export-csv` / "Export CSV" and no `download-invoices` decoy. The local Linux
 * fixture (the directory itself) has the renamed button and the decoy, and is never published.
 */
export const FIXTURE_VARIANTS: Readonly<Record<string, FixtureVariant>> = {
  [DEFAULT_VARIANT]: { directory: STARTER_DIRECTORY, exclude: [], edits: [] },
  m14: {
    directory: M14_DIRECTORY,
    exclude: ["test/invoices.test.mjs"],
    edits: [
      { file: "public/index.html", from: 'data-testid="download-orders"', to: 'data-testid="export-csv"' },
      { file: "public/index.html", from: ">Download orders</button>", to: ">Export CSV</button>" },
      {
        file: "public/index.html",
        from: '<button data-testid="download-invoices" data-download="/api/invoices.csv" data-filename="invoices.csv" data-done="Invoices exported" type="button" hidden>Download invoices</button>',
        to: "",
      },
    ],
  },
};

function variantDefinition(name: string): FixtureVariant {
  const definition = Object.hasOwn(FIXTURE_VARIANTS, name) ? FIXTURE_VARIANTS[name] : undefined;
  if (definition === undefined) throw new Error(`unknown variant "${name}"; expected one of ${Object.keys(FIXTURE_VARIANTS).join(", ")}`);
  return definition;
}

/** Removes every line from a local-only begin marker through its end marker (inclusive). Unbalanced markers are refused. */
function removeLocalOnlyBlocks(file: string, text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.includes(LOCAL_ONLY_BEGIN)) {
      if (inside) throw new Error(`${file} has a nested ${LOCAL_ONLY_BEGIN} marker`);
      inside = true;
    } else if (line.includes(LOCAL_ONLY_END)) {
      if (!inside) throw new Error(`${file} has a ${LOCAL_ONLY_END} marker without a begin`);
      inside = false;
    } else if (!inside) kept.push(line);
  }
  if (inside) throw new Error(`${file} has a ${LOCAL_ONLY_BEGIN} marker without an end`);
  return kept.join("\n");
}

/**
 * The files a variant publishes, from the files of its directory (relative POSIX path to text): the excluded files are dropped, the local-only
 * blocks removed and every edit applied. An edit whose text does not occur exactly once is an error, so a baseline can never drift silently.
 */
export function renderFixtureVariant(name: string, files: ReadonlyMap<string, string>): Map<string, string> {
  const variant = variantDefinition(name);
  const rendered = new Map<string, string>();
  for (const [file, text] of files) {
    if (variant.exclude.includes(file)) continue;
    rendered.set(file, name === DEFAULT_VARIANT ? text : removeLocalOnlyBlocks(file, text));
  }
  for (const edit of variant.edits) {
    const text = rendered.get(edit.file);
    const occurrences = text === undefined ? 0 : text.split(edit.from).length - 1;
    if (text === undefined || occurrences !== 1) {
      throw new Error(`variant ${name}: the edit of ${edit.file} must match exactly once, found ${occurrences}`);
    }
    rendered.set(edit.file, text.replace(edit.from, () => edit.to));
  }
  return rendered;
}

const GIT_SAFETY = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

/** git in the source repository, returning raw bytes. */
function sourceGit(repositoryRoot: string, args: readonly string[]): Buffer {
  return execFileSync("git", [...GIT_SAFETY, ...args], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
}

function isPublishable(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return !segments.slice(0, -1).some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))
    && !EXCLUDED_FILE_NAMES.has(segments[segments.length - 1] ?? "");
}

/**
 * Relative POSIX paths (inside the starter directory) of the files committed at HEAD under it, sorted. Only committed
 * files are listed, so untracked or gitignored local files (a seed, an .env) can never be published.
 */
export function listStarterFiles(repositoryRoot: string, starterDirectory: string = STARTER_DIRECTORY): string[] {
  const listed = sourceGit(repositoryRoot, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", starterDirectory]).toString("utf8");
  return listed.split("\0").filter((path) => path !== "")
    .map((path) => posix.relative(starterDirectory, path))
    .filter(isPublishable)
    .sort();
}

/** Refuses a starter directory with uncommitted, staged or untracked changes, so what is published is what is committed. */
export function assertStarterClean(repositoryRoot: string, starterDirectory: string = STARTER_DIRECTORY): void {
  const status = sourceGit(repositoryRoot, ["status", "--porcelain", "--", starterDirectory]).toString("utf8").trim();
  if (status !== "") {
    throw new Error(`${starterDirectory} has uncommitted or untracked changes; commit or remove them before publishing:\n${status}`);
  }
}

/** The committed files a variant publishes, sorted: the directory's committed files minus the variant's exclusions. */
export function listVariantFiles(repositoryRoot: string, name: string): string[] {
  const variant = variantDefinition(name);
  return listStarterFiles(repositoryRoot, variant.directory).filter((file) => !variant.exclude.includes(file));
}

/** The committed (HEAD) contents of every file the variant publishes, rendered. */
export function readVariantFiles(repositoryRoot: string, name: string): Map<string, string> {
  const variant = variantDefinition(name);
  const committed = new Map<string, string>();
  for (const file of listStarterFiles(repositoryRoot, variant.directory)) {
    committed.set(file, sourceGit(repositoryRoot, ["show", `HEAD:${posix.join(variant.directory, file)}`]).toString("utf8"));
  }
  return renderFixtureVariant(name, committed);
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

export interface PublishArguments { repo: string; dryRun: boolean; forceReseed: boolean; variant?: string }

export function parsePublishArguments(argv: readonly string[]): PublishArguments {
  let repo: string | undefined;
  let dryRun = false;
  let forceReseed = false;
  let variant: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      repo = argv[index + 1];
      index += 1;
    } else if (argument === "--variant") {
      variant = argv[index + 1];
      index += 1;
      if (variant === undefined || variant.startsWith("--")) throw new Error("--variant <starter|m14> requires a name");
      variantDefinition(variant);
    } else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--force-reseed") forceReseed = true;
    else throw new Error(`unknown argument "${String(argument)}"`);
  }
  if (repo === undefined || repo.startsWith("--")) throw new Error("--repo <owner/name> is required");
  return variant === undefined ? { repo, dryRun, forceReseed } : { repo, dryRun, forceReseed, variant };
}

/** git with gh as the credential helper, so the owner's gh login authorizes the push. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...GIT_SAFETY, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function publish(args: PublishArguments, files: ReadonlyMap<string, string>): PublishPlan {
  const work = mkdtempSync(join(tmpdir(), "rovara-web-fixture-"));
  try {
    git(work, ["init", "--quiet", "-b", FIXTURE_BRANCH]);
    git(work, ["remote", "add", "origin", `https://github.com/${args.repo}.git`]);
    const remoteHeads = git(work, ["ls-remote", "--heads", "origin"]).trim();
    const remoteHasCommits = remoteHeads !== "";
    const plan = buildPublishPlan({ repo: args.repo, files: [...files.keys()].sort(), remoteHasCommits, forceReseed: args.forceReseed, dryRun: false });
    if (remoteHasCommits) {
      if (!remoteHeads.split("\n").some((line) => line.endsWith(`\trefs/heads/${FIXTURE_BRANCH}`))) {
        throw new Error(`${args.repo} has commits but no ${FIXTURE_BRANCH} branch; refusing to publish`);
      }
      git(work, ["fetch", "--quiet", "origin", FIXTURE_BRANCH]);
      git(work, ["checkout", "--quiet", "-B", FIXTURE_BRANCH, `origin/${FIXTURE_BRANCH}`]);
      for (const entry of readdirSync(work)) if (entry !== ".git") rmSync(join(work, entry), { recursive: true, force: true });
    }
    for (const [file, text] of files) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
    }
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "--allow-empty", "-m", FIXTURE_COMMIT_MESSAGE]);
    git(work, ["push", "origin", `${FIXTURE_BRANCH}:${FIXTURE_BRANCH}`]);
    return plan;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function run(argv: readonly string[], log: (line: string) => void = console.log, repositoryRoot: string = DEFAULT_REPOSITORY_ROOT): number {
  const args = parsePublishArguments(argv);
  const name = args.variant ?? DEFAULT_VARIANT;
  const directory = variantDefinition(name).directory;
  assertStarterClean(repositoryRoot, directory);
  // Rendering fails here, before anything is pushed, if a variant edit no longer matches.
  const rendered = readVariantFiles(repositoryRoot, name);
  const files = [...rendered.keys()].sort();
  if (args.dryRun) {
    const plan = buildPublishPlan({ repo: args.repo, files, remoteHasCommits: null, forceReseed: args.forceReseed, dryRun: true });
    log(`dry run: would push ${plan.files.length} files from ${directory} (variant ${name}) to https://github.com/${plan.repo} (${plan.branch}), commit "${plan.commitMessage}"`);
    for (const file of plan.files) log(`  ${file}`);
    return 0;
  }
  const plan = publish(args, rendered);
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
