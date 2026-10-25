// Publishes the committed (HEAD) orders web fixture to a GitHub repository as a single seed commit on main.
// Owner-run. It uses the owner's existing gh authentication through git's credential helper, so no token ever
// appears in an argument, environment variable or log line.
//
// Variants: "starter" (default) publishes tests/fixtures/orders-web-starter as it is. "m13" publishes the M1.3 live baseline,
// tests/fixtures/orders-web-m13 as it is. "m14" publishes the M1.4 live baseline, which is generated from the committed local Linux
// fixture tests/fixtures/orders-web-m14 (see FIXTURE_VARIANTS).
//
// Usage: npx tsx scripts/fixtures/publish-web-fixture.ts --repo <owner/name> [--variant starter|m13|m14] [--dry-run] [--force-reseed]
//
// A real publish onto a remote that already has commits needs --force-reseed. Before it adds the new seed commit it saves the current main
// as the branch backup/pre-<variant>-<UTC timestamp>, and it stops without touching main if that branch cannot be created.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STARTER_DIRECTORY = "tests/fixtures/orders-web-starter";
export const M13_DIRECTORY = "tests/fixtures/orders-web-m13";
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
  /** Files of the directory that the variant does not publish. Each one must exist. */
  exclude: readonly string[];
  /** Files published under another name (source to target), replacing any file at the target. The source must exist and is not published as itself. */
  renames: Readonly<Record<string, string>>;
  /** How many local-only blocks the render must remove in total; null when the variant does no block removal. */
  localOnlyBlocks: number | null;
  /** Exact-once text edits applied to the published files. */
  edits: readonly FixtureEdit[];
  /** Strings that must not remain in any published file after the render. */
  forbidden: readonly string[];
}

const LOCAL_ONLY_BEGIN = "fixture-variant:local-only:begin";
const LOCAL_ONLY_END = "fixture-variant:local-only:end";

/**
/**
 * The publishable variants. "m13" is the live baseline of Rovara M1.3: the orders application with the accounts seed and form login, the export
 * button and route open to every signed-in account, no inventory column, and the inventory service described by a contract and a mock. The
 * directory is published as it is: it has no local-only parts, and a leftover variant marker is refused.
 *
 * "m14" is the live baseline of M1.4: the M1.3 reference state after its demo (viewer refusal, tenant isolation and the inventory column are in
 * place) with the owner button still `export-csv` / "Export CSV" and no `download-invoices` decoy. The local Linux fixture (the directory itself)
 * has the renamed button and the decoy, and is never published. It is the m13 directory plus tests/fixtures/orders-web-m13-to-m14.patch
 * (a contract test checks that), so the live baseline is the M1.3 fixture after its demo.
 */
export const FIXTURE_VARIANTS: Readonly<Record<string, FixtureVariant>> = {
  m13: { directory: M13_DIRECTORY, exclude: [], renames: {}, localOnlyBlocks: null, edits: [], forbidden: [LOCAL_ONLY_BEGIN, LOCAL_ONLY_END] },
  [DEFAULT_VARIANT]: { directory: STARTER_DIRECTORY, exclude: [], renames: {}, localOnlyBlocks: null, edits: [], forbidden: [] },
  m14: {
    directory: M14_DIRECTORY,
    exclude: ["test/invoices.test.mjs"],
    // The published repository gets its own README, with nothing about the local fixture, the decoy or this publisher.
    renames: { "README.baseline.md": "README.md" },
    localOnlyBlocks: 1,
    forbidden: ["download-invoices", "Download invoices", "/api/invoices.csv", "invoices.csv"],
    // The page is rendered by server.mjs, so the buttons are edited there. The decoy is the second line of the owner's button list.
    edits: [
      { file: "server.mjs", from: 'data-testid="download-orders"', to: 'data-testid="export-csv"' },
      { file: "server.mjs", from: ">Download orders</button>", to: ">Export CSV</button>" },
      {
        file: "server.mjs",
        from: `\n          + '<button data-testid="download-invoices" data-download="/api/invoices.csv" data-filename="invoices.csv" data-done="Invoices exported" type="button">Download invoices</button>'`,
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

/** Removes every line from a local-only begin marker through its end marker (inclusive), and counts the blocks. Unbalanced markers are refused. */
function removeLocalOnlyBlocks(file: string, text: string): { text: string; blocks: number } {
  const kept: string[] = [];
  let inside = false;
  let blocks = 0;
  for (const line of text.split("\n")) {
    if (line.includes(LOCAL_ONLY_BEGIN)) {
      if (inside) throw new Error(`${file} has a nested ${LOCAL_ONLY_BEGIN} marker`);
      inside = true;
      blocks += 1;
    } else if (line.includes(LOCAL_ONLY_END)) {
      if (!inside) throw new Error(`${file} has a ${LOCAL_ONLY_END} marker without a begin`);
      inside = false;
    } else if (!inside) kept.push(line);
  }
  if (inside) throw new Error(`${file} has a ${LOCAL_ONLY_BEGIN} marker without an end`);
  return { text: kept.join("\n"), blocks };
}

/**
 * The files a variant publishes, from the files of its directory (relative POSIX path to text): the excluded files are dropped, renamed files
 * move to their target, the local-only blocks are removed and every edit applied. Anything unexpected is an error, so a baseline can never drift
 * silently: an excluded or renamed file that does not exist, an edit whose text does not occur exactly once, a number of local-only blocks other
 * than the variant declares, or a forbidden (decoy) string left in any published file.
 */
export function renderFixtureVariant(name: string, files: ReadonlyMap<string, string>): Map<string, string> {
  const variant = variantDefinition(name);
  for (const file of variant.exclude) {
    if (!files.has(file)) throw new Error(`variant ${name}: the excluded file ${file} does not exist`);
  }
  for (const source of Object.keys(variant.renames)) {
    if (!files.has(source)) throw new Error(`variant ${name}: the renamed file ${source} does not exist`);
  }
  const rendered = new Map<string, string>();
  let blocks = 0;
  const take = (file: string, text: string): string => {
    if (variant.localOnlyBlocks === null) return text;
    const result = removeLocalOnlyBlocks(file, text);
    blocks += result.blocks;
    return result.text;
  };
  for (const [file, text] of files) {
    if (variant.exclude.includes(file) || Object.hasOwn(variant.renames, file)) continue;
    rendered.set(file, take(file, text));
  }
  for (const [source, target] of Object.entries(variant.renames)) rendered.set(target, take(source, files.get(source)!));
  if (variant.localOnlyBlocks !== null && blocks !== variant.localOnlyBlocks) {
    throw new Error(`variant ${name}: the render must contain exactly one local-only block (${variant.localOnlyBlocks} expected), removed ${blocks}`);
  }
  for (const edit of variant.edits) {
    const text = rendered.get(edit.file);
    const occurrences = text === undefined ? 0 : text.split(edit.from).length - 1;
    if (text === undefined || occurrences !== 1) {
      throw new Error(`variant ${name}: the edit of ${edit.file} must match exactly once, found ${occurrences}`);
    }
    rendered.set(edit.file, text.replace(edit.from, () => edit.to));
  }
  for (const [file, text] of rendered) {
    for (const forbidden of variant.forbidden) {
      if (text.includes(forbidden)) throw new Error(`variant ${name}: the decoy string "${forbidden}" remains in ${file}`);
    }
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
      if (variant === undefined || variant.startsWith("--")) throw new Error("--variant <starter|m13|m14> requires a name");
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

/** The branch that keeps the previous main before a force-reseed: backup/pre-<variant>-<UTC timestamp, e.g. 20261021T153045Z>. */
export function backupBranchName(variant: string, now: Date): string {
  return `backup/pre-${variant}-${now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "")}`;
}

export interface PublishOptions {
  /** The remote to push to; the repository's GitHub address when omitted. A test points it at a local bare repository. */
  remoteUrl?: string;
  /** The clock used to name the backup branch. */
  now?: () => Date;
}

export type PublishResult = PublishPlan & { backupBranch: string | null };

/**
 * Pushes the rendered files as one new commit on main. When the remote already has commits (--force-reseed), the current main is first saved as
 * a backup branch and the push of the new commit happens only once that branch is on the remote at exactly the old main. History is never rewritten.
 */
export function publish(args: PublishArguments, files: ReadonlyMap<string, string>, options: PublishOptions = {}): PublishResult {
  const work = mkdtempSync(join(tmpdir(), "rovara-web-fixture-"));
  try {
    git(work, ["init", "--quiet", "-b", FIXTURE_BRANCH]);
    git(work, ["remote", "add", "origin", options.remoteUrl ?? `https://github.com/${args.repo}.git`]);
    const remoteHeads = git(work, ["ls-remote", "--heads", "origin"]).trim();
    const remoteHasCommits = remoteHeads !== "";
    const plan = buildPublishPlan({ repo: args.repo, files: [...files.keys()].sort(), remoteHasCommits, forceReseed: args.forceReseed, dryRun: false });
    let backupBranch: string | null = null;
    if (remoteHasCommits) {
      if (!remoteHeads.split("\n").some((line) => line.endsWith(`\trefs/heads/${FIXTURE_BRANCH}`))) {
        throw new Error(`${args.repo} has commits but no ${FIXTURE_BRANCH} branch; refusing to publish`);
      }
      git(work, ["fetch", "--quiet", "origin", FIXTURE_BRANCH]);
      git(work, ["checkout", "--quiet", "-B", FIXTURE_BRANCH, `origin/${FIXTURE_BRANCH}`]);
      const previous = git(work, ["rev-parse", `refs/remotes/origin/${FIXTURE_BRANCH}`]).trim();
      backupBranch = backupBranchName(args.variant ?? DEFAULT_VARIANT, (options.now ?? (() => new Date()))());
      // An existing branch of that name is never moved: a push could fast-forward it, so the name must be free.
      if (git(work, ["ls-remote", "--heads", "origin", `refs/heads/${backupBranch}`]).trim() !== "") throw new Error(`the backup branch ${backupBranch} already exists; nothing was published`);
      git(work, ["push", "--quiet", "origin", `refs/remotes/origin/${FIXTURE_BRANCH}:refs/heads/${backupBranch}`]);
      const saved = git(work, ["ls-remote", "--heads", "origin", `refs/heads/${backupBranch}`]).trim().split(/\s+/)[0];
      if (saved !== previous) throw new Error(`the backup branch ${backupBranch} is not at the current ${FIXTURE_BRANCH}; nothing was published`);
      for (const entry of readdirSync(work)) if (entry !== ".git") rmSync(join(work, entry), { recursive: true, force: true });
    }
    for (const [file, text] of files) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
    }
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "--allow-empty", "-m", FIXTURE_COMMIT_MESSAGE]);
    git(work, ["push", "origin", `${FIXTURE_BRANCH}:${FIXTURE_BRANCH}`]);
    return { ...plan, backupBranch };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function run(argv: readonly string[], log: (line: string) => void = console.log, repositoryRoot: string = DEFAULT_REPOSITORY_ROOT, options: PublishOptions = {}): number {
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
    // A dry run never reaches the remote, so it cannot know whether main has commits; it says what a force-reseed would do first.
    if (args.forceReseed) log(`with --force-reseed on a remote that has commits, the current ${plan.branch} is first saved as ${backupBranchName(name, new Date()).replace(/\d{8}T\d{6}Z$/, "<UTC timestamp>")}`);
    return 0;
  }
  const plan = publish(args, rendered, options);
  log(`published ${plan.files.length} files to https://github.com/${plan.repo} (${plan.branch}, ${plan.mode})`);
  if (plan.backupBranch !== null) log(`the previous ${plan.branch} is kept as ${plan.backupBranch}`);
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
