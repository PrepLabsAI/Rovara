// L4-DR (DEC 254z c, setup-upkeep-plan.md 2.1): the SETUP SNAPSHOT and the drift check. PURE: no clock, no store, no network, no model.
//
// When a project's setup is approved, Rovara saves what the setup was approved against: the files that decide whether the setup still works (lockfiles, compose files, Dockerfiles, the dev container, `.env.example`,
// test configs, version files, CI workflows and the marker files a repository is recognised by), each by PATH and CONTENT ID (the code host's own object id for the file), at the approved commit of each repository, and
// the outside websites the setup allows. At the start of a task the broker lists the same files at the task's base commit through the code host and compares: nothing that was approved moves unseen.
//
// Only paths and content ids are kept. A file's CONTENT is never read, so no secret value (an `.env` entry, a token in a lockfile URL) can be in the snapshot, and nothing here ever goes to a model.
// A path is shown to a person only as a fixed class word (`SETUP_WATCH_WORDS`), never as text: a repository's file names are not echoed.
//
// UNKNOWN IS NEVER "NO DRIFT": a listing the host cut short, a repository that could not be read, a snapshot taken for other repositories, or a stored snapshot that does not parse is `unknown`, and the caller re-checks.
import { z } from "zod";
import { SETUP_MARKER_FILES } from "./setup-recipe.js";

/** The kinds of file the snapshot watches. A closed list: a new detector is added here, in the matcher and in the words, and a test per class proves each. */
export const SETUP_WATCH_CLASSES = ["marker", "lockfile", "compose", "dockerfile", "devcontainer", "env_example", "version", "test_config", "ci"] as const;
export type SetupWatchClass = (typeof SETUP_WATCH_CLASSES)[number];
/** What changed, as a person reads it: a watch class, or the outside websites the setup allows. */
export type SetupDriftClass = SetupWatchClass | "websites";

export const SETUP_WATCH_WORDS: Readonly<Record<SetupDriftClass, string>> = Object.freeze({
  marker: "the project's package files",
  lockfile: "dependency files",
  compose: "a compose file",
  dockerfile: "a Dockerfile",
  devcontainer: "the dev container",
  env_example: "the example environment file",
  version: "a language version file",
  test_config: "a test configuration",
  ci: "a CI workflow",
  websites: "the allowed addresses",
});

/** Paths under these folders are installed or vendored code, never the project's own setup inputs. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", "vendor", "third_party", ".git"]);
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "poetry.lock", "pdm.lock", "uv.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock",
  "composer.lock", "gradle.lockfile", "packages.lock.json", "mix.lock", "pubspec.lock",
]);
const VERSION_FILES: ReadonlySet<string> = new Set([".nvmrc", ".node-version", ".tool-versions", ".python-version", ".ruby-version", ".java-version", ".go-version", "runtime.txt", "rust-toolchain", "rust-toolchain.toml", ".terraform-version"]);
const TEST_CONFIG = /^(?:vitest|jest|playwright|cypress|karma|vite-test|wdio)\.config\.[cm]?[jt]s$|^(?:pytest\.ini|tox\.ini|noxfile\.py|phpunit\.xml(?:\.dist)?|\.mocharc\.(?:json|ya?ml|[cm]?js)|jest\.config\.json|\.rspec)$/u;
const COMPOSE = /^(?:docker-compose|compose)(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/u;
const ENV_EXAMPLE = /^(?:\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template|dist)|(?:example|sample)\.env)$/u;
const MARKERS: ReadonlySet<string> = new Set(SETUP_MARKER_FILES);

/** The longest path the snapshot keeps. A longer one is not skipped silently: the listing is reported incomplete, so the answer is `unknown`. */
export const SETUP_WATCH_PATH_MAX = 240;
/** The most watched files one repository, and all repositories together, may hold. More is `incomplete`, so `unknown`. */
export const SETUP_WATCH_MAX_PER_REPOSITORY = 300;
export const SETUP_WATCH_MAX_TOTAL = 600;
export const SETUP_SNAPSHOT_MAX_REPOSITORIES = 8;
export const SETUP_SNAPSHOT_MAX_HOSTS = 100;

/** The watch class of a path (`/` between names, no leading slash), or undefined when the file is not one the setup depends on. Anything installed or vendored is not. */
export function setupWatchClassOf(path: string): SetupWatchClass | undefined {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || IGNORED_SEGMENTS.has(segment))) return undefined;
  const name = segments.at(-1)!;
  const folder = segments.slice(0, -1);
  if (folder.length >= 2 && folder.at(-2) === ".github" && folder.at(-1) === "workflows" && /\.ya?ml$/u.test(name)) return "ci";
  if (folder.length === 0 && (name === ".gitlab-ci.yml" || name === ".gitlab-ci.yaml" || name === "Jenkinsfile" || name === ".travis.yml" || name === "azure-pipelines.yml" || name === "bitbucket-pipelines.yml")) return "ci";
  if (folder.includes(".circleci") && /\.ya?ml$/u.test(name)) return "ci";
  if (name === "devcontainer.json" || name === ".devcontainer.json" || folder.at(-1) === ".devcontainer") return "devcontainer";
  if (name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".dockerfile") || name.endsWith(".Dockerfile")) return "dockerfile";
  if (COMPOSE.test(name)) return "compose";
  if (ENV_EXAMPLE.test(name)) return "env_example";
  if (LOCKFILES.has(name)) return "lockfile";
  if (VERSION_FILES.has(name)) return "version";
  if (TEST_CONFIG.test(name)) return "test_config";
  if (MARKERS.has(name)) return "marker";
  return undefined;
}

/** Whether the code host's tree listing should keep this path (the adapter's filter). Never a path that would not classify. */
export const isSetupWatchedPath = (path: string): boolean => path.length <= SETUP_WATCH_PATH_MAX && setupWatchClassOf(path) !== undefined;

const Path = z.string().min(1).max(SETUP_WATCH_PATH_MAX).refine((value) => setupWatchClassOf(value) !== undefined, "a path the snapshot watches");
const ContentId = z.string().regex(/^[a-f0-9]{40,128}$/u);
const Commit = z.string().regex(/^[a-f0-9]{40,128}$/u);
const Host = z.string().min(1).max(253);
const RepositoryName = z.string().min(1).max(100);

export const SetupSnapshotFileSchema = z.object({ path: Path, id: ContentId }).strict();
export type SetupSnapshotFile = z.infer<typeof SetupSnapshotFileSchema>;

export const SetupSnapshotRepositorySchema = z.object({
  /** The project's own name for the repository. */
  name: RepositoryName,
  /** The commit the files were read at. */
  commit: Commit,
  /** Every watched file at the commit, sorted by path. */
  files: z.array(SetupSnapshotFileSchema).max(SETUP_WATCH_MAX_PER_REPOSITORY),
}).strict();
export type SetupSnapshotRepository = z.infer<typeof SetupSnapshotRepositorySchema>;

export const SetupSnapshotSchema = z.object({
  /** The project revision whose setup this snapshot belongs to (bookkeeping: files are compared whatever the revision). */
  setupRevision: z.number().int().min(1),
  takenAt: z.string().min(10).max(40),
  repositories: z.array(SetupSnapshotRepositorySchema).min(1).max(SETUP_SNAPSHOT_MAX_REPOSITORIES),
  /** The outside websites the setup allows, lower case, sorted. */
  hosts: z.array(Host).max(SETUP_SNAPSHOT_MAX_HOSTS),
}).strict().superRefine((snapshot, context) => {
  const names = snapshot.repositories.map((repository) => repository.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["repositories"], message: "a repository appears once" });
  if (snapshot.repositories.reduce((total, repository) => total + repository.files.length, 0) > SETUP_WATCH_MAX_TOTAL) context.addIssue({ code: "custom", path: ["repositories"], message: "too many watched files" });
});
export type SetupSnapshot = z.infer<typeof SetupSnapshotSchema>;

/** What the broker read now, per repository: its commit and watched files, or that it could not be read whole. */
export type CurrentSetupRepository = { name: string; commit: string; files: ReadonlyArray<{ path: string; id: string }> } | { name: string; unreadable: true; /** The commit that was listed, when it is known (a re-check is pinned to it even when its listing was cut). */ commit?: string };

/** The allowed websites as the snapshot keeps them: lower case, de-duplicated, sorted. */
export const normalisedHosts = (hosts: readonly string[] | undefined): string[] => [...new Set((hosts ?? []).map((host) => host.toLowerCase()))].sort();

export type SetupDrift =
  /** Nothing the setup was approved against has moved. */
  | { drift: "none" }
  /** Something has. `classes` are the kinds of file (and "websites"), in the fixed list's order, once each. */
  | { drift: "changed"; classes: SetupDriftClass[] }
  /** It cannot be told. The caller re-checks; this is never read as `none`. */
  | { drift: "unknown"; reason: "no_snapshot" | "snapshot_unreadable" | "unreadable_repository" | "repositories_differ" };

const ORDER: readonly SetupDriftClass[] = [...SETUP_WATCH_CLASSES, "websites"];

/**
 * Compares the approved snapshot with what is there now. A file whose id differs, a watched file that is new, and one that is gone each count as a change of its class; so does a different set of allowed websites.
 * Any input that does not fit its schema is `unknown`, and a repository the broker could not read is `unknown`, even if another repository changed (the change is reported only when everything was readable: an
 * `unknown` answer already re-checks).
 */
export function compareSetupSnapshot(snapshotInput: unknown, current: ReadonlyArray<CurrentSetupRepository>, hostsNow: readonly string[]): SetupDrift {
  if (snapshotInput === undefined) return { drift: "unknown", reason: "no_snapshot" };
  const parsed = SetupSnapshotSchema.safeParse(snapshotInput);
  if (!parsed.success) return { drift: "unknown", reason: "snapshot_unreadable" };
  const snapshot = parsed.data;
  if (current.some((repository) => "unreadable" in repository)) return { drift: "unknown", reason: "unreadable_repository" };
  const names = (list: ReadonlyArray<{ name: string }>): string => list.map((repository) => repository.name).sort().join("\0");
  if (names(snapshot.repositories) !== names(current)) return { drift: "unknown", reason: "repositories_differ" };
  const changed = new Set<SetupDriftClass>();
  for (const repository of snapshot.repositories) {
    const now = current.find((entry) => entry.name === repository.name) as Extract<CurrentSetupRepository, { commit: string }>;
    const before = new Map(repository.files.map((file) => [file.path, file.id] as const));
    const after = new Map<string, string>();
    for (const file of now.files) {
      // A path the snapshot would not watch cannot be compared: it is a change in what is watched, so the repository reads as unknown.
      if (setupWatchClassOf(file.path) === undefined) return { drift: "unknown", reason: "snapshot_unreadable" };
      after.set(file.path, file.id);
    }
    for (const [path, id] of after) if (before.get(path) !== id) changed.add(setupWatchClassOf(path)!);
    for (const path of before.keys()) if (!after.has(path)) changed.add(setupWatchClassOf(path)!);
  }
  if (normalisedHosts(snapshot.hosts).join("\0") !== normalisedHosts(hostsNow).join("\0")) changed.add("websites");
  return changed.size === 0 ? { drift: "none" } : { drift: "changed", classes: ORDER.filter((entry) => changed.has(entry)) };
}

/** "dependency files and a Dockerfile" from the classes, in the fixed order. Fixed words only. */
export function setupDriftWords(classes: readonly SetupDriftClass[]): string {
  const words = ORDER.filter((entry) => classes.includes(entry)).map((entry) => SETUP_WATCH_WORDS[entry]);
  if (words.length === 0) return "the project";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`;
}
