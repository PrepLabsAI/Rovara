// Go detector: go.mod (one module), go.work (a workspace) and the commands a Go repository's own files support. Generic: nothing here is specific to one customer or one build host.
// Every value is cited (file and line) or comes from the tool's own default (cited as `detector:go`). Only the top-level go.mod / go.work are read, plus the root go.sum, vendor/modules.txt and the file list.
// Nested modules are never guessed at: `./...` skips a directory that has its own go.mod, so a nested module with tests is a note and a question, not a command. A workspace gets one explicit pattern per `use` directory.
// Reports: `go test` writes no file by itself, and Rovara never wraps the customer's command in a shell, so a JUnit report is proposed only when the module already depends on gotestsum (go.mod names it),
// run with `go run` at the version go.mod pins. Coverage is a Go cover profile written by the proposed `-coverprofile` flag; the reader for it is in verification/changed-coverage.ts.
// No per-test selection is proposed: `go test` takes packages, the selection template (`{tests}`) is filled with test ids that are files, and a file argument makes `go test` build only those files, not the package.
import { awsClientCandidate, candidate, isOwnedElsewhere, mergeCandidates, normalizeAwsService, scanDrivers, type DriverRule } from "./dependency-candidates.js";
import { type DependencyCandidate, type Detection, type DetectedSource, type Detector, type DetectorContext, type RepositoryReader, findLine } from "./types.js";
import type { GoModuleRoot } from "../verification/changed-coverage.js";

const TIMEOUT = { test: 1_800, lint: 600, setup: 900 } as const;
const MAX_WORKSPACE_DIRS = 20;
const MAX_NESTED_SHOWN = 10;
const SAFE_DIR = /^[A-Za-z0-9_./-]{1,200}$/u;
const GO_VERSION = /^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?(?:rc\d{1,3}|beta\d{1,3})?$/u;
const TOOLCHAIN = /^go\d{1,2}\.\d{1,3}(?:\.\d{1,3})?(?:rc\d{1,3}|beta\d{1,3})?(?:-[A-Za-z0-9._+-]{1,40})?$/u;
const GOLANGCI_CONFIGS = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"] as const;
const GOTESTSUM = "gotest.tools/gotestsum";
export const GO_COVER_PROFILE = "coverage.out";
export const GO_JUNIT_REPORT = "gotestsum-junit.xml";

const cmd = (cwd: string, executable: string, args: string[], timeoutSeconds: number) => ({ cwd, executable, args, timeoutSeconds });
const unquote = (value: string): string => value.trim().replace(/^(["'`])(.*)\1$/u, "$2");

/** A repository path Go itself looks at: not under vendor, testdata, node_modules, or a directory starting with "." or "_" (Go ignores those). */
const liveGoPath = (path: string): boolean => !path.split("/").slice(0, -1).some((part) => part === "vendor" || part === "testdata" || part === "node_modules" || part.startsWith(".") || part.startsWith("_"));
const safeRelative = (value: string): string | undefined => {
  const trimmed = value.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === ".") return ".";
  return SAFE_DIR.test(trimmed) && !trimmed.startsWith("/") && !trimmed.split("/").some((part) => part === "" || part === "." || part === "..") ? trimmed : undefined;
};

interface Directive { value: string; line: number; indirect: boolean }

/** The values of one go.mod / go.work directive, in its single-line (`use ./a`) and block (`use (` ... `)`) forms, each with its line. Comments are dropped; `// indirect` is remembered. */
export function goDirectives(text: string, name: string): Directive[] {
  const found: Directive[] = [];
  const open = new RegExp(`^${name}\\s{0,120}\\($`, "u");
  const single = new RegExp(`^${name}\\s{1,40}(.+)$`, "u");
  let block = false;
  text.split("\n").forEach((raw, index) => {
    const comment = raw.indexOf("//");
    const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    const indirect = comment !== -1 && /\bindirect\b/u.test(raw.slice(comment));
    if (line === "") return;
    if (block) {
      if (line.startsWith(")")) block = false;
      else found.push({ value: line, line: index + 1, indirect });
      return;
    }
    if (open.test(line)) { block = true; return; }
    const match = single.exec(line);
    if (match !== null) found.push({ value: match[1]!.trim(), line: index + 1, indirect });
  });
  return found;
}

function versionNote(path: string, text: string): string[] {
  const notes: string[] = [];
  const go = goDirectives(text, "go")[0];
  const toolchain = goDirectives(text, "toolchain")[0];
  if (go !== undefined && GO_VERSION.test(go.value)) {
    const suggested = toolchain !== undefined && TOOLCHAIN.test(toolchain.value) ? `, and suggests the ${toolchain.value} toolchain (line ${String(toolchain.line)})` : "";
    notes.push(`The module asks for Go ${go.value} or newer (${path} line ${String(go.line)})${suggested}; the test environment must provide it.`);
  }
  return notes;
}

/** `replace` directives whose target is a directory outside the repository (or an absolute path): the build cannot find it in a fresh checkout. */
function outsideReplaces(path: string, text: string): string[] {
  const found: string[] = [];
  for (const directive of goDirectives(text, "replace")) {
    const target = /=>\s{0,40}(\S+)/u.exec(directive.value)?.[1];
    if (target !== undefined && (target.startsWith("/") || target.startsWith("../") || target === "..")) found.push(`${path} line ${String(directive.line)}`);
  }
  return found;
}

type Found = Partial<Detection> & { setupCommands: NonNullable<Detection["setupCommands"]>; checks: NonNullable<Detection["checks"]>; fullSuiteOn: NonNullable<Detection["fullSuiteOn"]>; notes: string[]; questions: string[] };

function nestedModules(paths: readonly string[]): string[] {
  return paths.filter((path) => path.endsWith("/go.mod") && liveGoPath(path)).map((path) => path.slice(0, -"/go.mod".length)).sort();
}

const nestedList = (dirs: string[]): string => `${dirs.slice(0, MAX_NESTED_SHOWN).join(", ")}${dirs.length > MAX_NESTED_SHOWN ? ` and ${String(dirs.length - MAX_NESTED_SHOWN)} more` : ""}`;

const detectGoBuild: Detector = async (context: DetectorContext) => {
  const { repo, cwd } = context;
  const hasMod = repo.paths.includes("go.mod");
  const hasWork = repo.paths.includes("go.work");
  const goFiles = repo.paths.filter((path) => path.endsWith(".go") && liveGoPath(path));
  const nested = nestedModules(repo.paths);
  if (!hasMod && !hasWork) {
    if (nested.length === 0 || goFiles.length === 0) return {};
    return {
      notes: ["Go module files were found only in subfolders, not at the top of the repository, so no Go command is proposed."],
      questions: ["Which folder is the Go module tested from? Its go.mod is in a subfolder, not at the top of the repository."],
    };
  }

  const modText = hasMod ? await repo.read("go.mod") : "";
  const workText = hasWork ? await repo.read("go.work") : "";
  if (modText === undefined || workText === undefined) return { notes: [`${modText === undefined ? "go.mod" : "go.work"} could not be read.`] };
  const notes: string[] = [];
  const questions: string[] = [];
  const marker = hasWork ? "go.work" : "go.mod";
  const markerText = hasWork ? workText : modText;
  const moduleLine = goDirectives(modText, "module")[0]?.line ?? findLine(markerText, /\S/u) ?? 1;
  const at: DetectedSource = { path: marker, line: hasWork ? (goDirectives(workText, "use")[0]?.line ?? 1) : moduleLine };

  const fullSuiteOn: Array<{ value: string; source: DetectedSource }> = [];
  for (const name of ["go.mod", "go.sum", "go.work", "go.work.sum"]) if (repo.paths.includes(name)) fullSuiteOn.push({ value: name, source: "detector:go" });
  if (repo.paths.some((path) => /\/testdata\//u.test(path) || path.startsWith("testdata/"))) fullSuiteOn.push({ value: "**/testdata/**", source: "detector:go" });
  const vendored = repo.paths.includes("vendor/modules.txt");
  if (vendored) fullSuiteOn.push({ value: "vendor/**", source: "detector:go" });
  if (nested.length > 0) for (const name of ["**/go.mod", "**/go.sum"]) fullSuiteOn.push({ value: name, source: "detector:go" });

  notes.push(...versionNote(hasMod ? "go.mod" : "go.work", hasMod ? modText : workText));
  const outside = [...(hasMod ? outsideReplaces("go.mod", modText) : []), ...(hasWork ? outsideReplaces("go.work", workText) : [])];
  if (outside.length > 0) {
    notes.push(`A replace directive points outside the repository (${outside.slice(0, 3).join(", ")}), so a fresh checkout cannot build it.`);
    questions.push("This Go module replaces a dependency with a directory outside the repository. Where does that code come from in the test environment?");
  }

  // The directories to build and test: `./...` for one module; one pattern per `use` directory in a workspace.
  let patterns: string[] = ["./..."];
  if (hasWork) {
    const dirs: string[] = [];
    const rejected: string[] = [];
    for (const directive of goDirectives(workText, "use")) {
      const dir = safeRelative(unquote(directive.value));
      if (dir === undefined) rejected.push(`line ${String(directive.line)}`);
      else if (!dirs.includes(dir)) dirs.push(dir);
    }
    if (dirs.length === 0 || rejected.length > 0 || dirs.length > MAX_WORKSPACE_DIRS) {
      const why = rejected.length > 0 ? `go.work uses a directory outside the repository or one Rovara cannot read safely (${rejected.slice(0, 3).join(", ")})` : dirs.length === 0 ? "go.work names no module directory Rovara can read" : `go.work uses more than ${String(MAX_WORKSPACE_DIRS)} modules`;
      return { notes: [...notes, `${why}, so no Go command is proposed.`], questions: [...questions, "Which Go modules of this workspace should be built and tested?"], fullSuiteOn };
    }
    const missing = dirs.filter((dir) => !repo.paths.includes(dir === "." ? "go.mod" : `${dir}/go.mod`));
    if (missing.length > 0) notes.push(`go.work uses ${nestedList(missing)} but no go.mod was found there.`);
    patterns = dirs.map((dir) => (dir === "." ? "./..." : `./${dir}/...`));
    notes.push(`The workspace has ${String(dirs.length)} module${dirs.length === 1 ? "" : "s"}: ${nestedList(dirs)}. Each is built and tested through its own pattern from the repository root.`);
  } else if (nested.length > 0) {
    const nestedWithTests = nested.filter((dir) => repo.paths.some((path) => path.startsWith(`${dir}/`) && path.endsWith("_test.go") && liveGoPath(path)));
    notes.push(`${String(nested.length)} nested module${nested.length === 1 ? "" : "s"} (${nestedList(nested)}) ${nested.length === 1 ? "has" : "have"} their own go.mod, which "./..." skips.`);
    if (nestedWithTests.length > 0) questions.push(`Which nested Go modules should be tested too? The command ./... skips ${nestedList(nestedWithTests)}, which ${nestedWithTests.length === 1 ? "has" : "have"} tests.`);
  }

  const found: Found = { setupCommands: [], checks: [], fullSuiteOn, notes, questions };
  if (hasWork) found.setupCommands.push({ value: cmd(cwd, "go", ["build", ...patterns], TIMEOUT.setup), source: at });
  else {
    if (vendored) notes.push("A vendor directory is present, so the build uses it and no dependency download is proposed.");
    else found.setupCommands.push({ value: cmd(cwd, "go", ["mod", "download"], TIMEOUT.setup), source: at });
    found.setupCommands.push({ value: cmd(cwd, "go", ["build", "./..."], TIMEOUT.setup), source: at });
  }

  const hasTests = repo.paths.some((path) => path.endsWith("_test.go") && liveGoPath(path) && (!hasWork || patterns.some((pattern) => pattern === "./..." || path.startsWith(`${pattern.slice(2, -4)}/`))));
  if (!hasTests) {
    notes.push("No Go test files were found, so no test command is proposed.");
    return found;
  }

  // gotestsum only when go.mod itself requires it (not as an indirect dependency): `go run` uses the version go.mod pins.
  const suiteLine = hasMod ? [...goDirectives(modText, "require"), ...goDirectives(modText, "tool")].find((item) => !item.indirect && item.value.split(/\s{1,40}/u)[0] === GOTESTSUM)?.line : undefined;
  const coverage = `-coverprofile=${GO_COVER_PROFILE}`;
  found.checks.push({
    value: suiteLine === undefined
      ? { id: "unit", label: "Unit tests (go test)", kind: "test", command: cmd(cwd, "go", ["test", coverage, ...patterns], TIMEOUT.test), coveragePath: GO_COVER_PROFILE, coverageSource: "detector:go" }
      : { id: "unit", label: "Unit tests (gotestsum)", kind: "test", command: cmd(cwd, "go", ["run", GOTESTSUM, "--junitfile", GO_JUNIT_REPORT, "--", coverage, ...patterns], TIMEOUT.test), reportPath: GO_JUNIT_REPORT, reportSource: { path: "go.mod", line: suiteLine }, coveragePath: GO_COVER_PROFILE, coverageSource: "detector:go" },
    source: suiteLine === undefined ? at : { path: "go.mod", line: suiteLine },
  });
  notes.push(suiteLine === undefined
    ? "go test writes no report file, so test counts come from the exit code. Add gotestsum to go.mod, or set a report path, to show test names and counts."
    : `JUnit XML is written to ${GO_JUNIT_REPORT} by gotestsum (go.mod line ${String(suiteLine)}); the Prove run checks that it is written.`);
  notes.push(`Coverage is written to ${GO_COVER_PROFILE} by the proposed -coverprofile flag, so changed-line coverage can be read from the Go cover profile. The maintainer approves the command.`);

  const lintConfig = GOLANGCI_CONFIGS.find((name) => repo.paths.includes(name));
  if (lintConfig !== undefined) {
    found.checks.push({ value: { id: "lint", label: "Lint (golangci-lint)", kind: "lint", command: cmd(cwd, "golangci-lint", ["run", ...patterns], TIMEOUT.lint) }, source: { path: lintConfig, line: 1 } });
    notes.push("golangci-lint is configured but not installed by Rovara; the test environment must provide it.");
  }
  notes.push("Rovara proposes no per-test selection for Go (go test takes packages, and the selection template is filled with test files), so every run is the whole suite.");
  return found;
};

const MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,300}$/u;

/**
 * The module paths and directories of the repository, as the cover-profile reader needs them to turn an import path into a repository path: the top-level go.mod's module, and every `use` directory of
 * a go.work. A module whose go.mod cannot be read or has no readable module path is left out (its coverage then reads as outside every module, never as another module's). Bounded: at most 21 files.
 */
export async function readGoModuleRoots(repo: RepositoryReader): Promise<GoModuleRoot[]> {
  const dirs: string[] = [];
  if (repo.paths.includes("go.work")) {
    const work = await repo.read("go.work");
    for (const directive of work === undefined ? [] : goDirectives(work, "use")) {
      const dir = safeRelative(unquote(directive.value));
      if (dir !== undefined && !dirs.includes(dir) && dirs.length < MAX_WORKSPACE_DIRS + 1) dirs.push(dir);
    }
  } else if (repo.paths.includes("go.mod")) dirs.push(".");
  const roots: GoModuleRoot[] = [];
  for (const dir of dirs) {
    const file = dir === "." ? "go.mod" : `${dir}/go.mod`;
    const text = repo.paths.includes(file) ? await repo.read(file) : undefined;
    const path = text === undefined ? undefined : unquote(goDirectives(text, "module")[0]?.value ?? "");
    if (path !== undefined && MODULE_PATH.test(path) && !roots.some((root) => root.path === path)) roots.push({ path, dir });
  }
  return roots;
}

// ---- dependencies (test services D4 manifests, D5 code)

const GO_MODULES: ReadonlyArray<[RegExp, string]> = [
  [/^github\.com\/(?:lib\/pq|jackc\/pgx(?:\/v\d+)?|jackc\/pgconn|uptrace\/bun\/driver\/pgdriver)$/u, "postgres"],
  [/^github\.com\/go-sql-driver\/mysql$/u, "mysql"],
  [/^github\.com\/(?:redis\/go-redis(?:\/v\d+)?|go-redis\/redis(?:\/v\d+)?|redis\/rueidis|gomodule\/redigo)$/u, "redis"],
  [/^go\.mongodb\.org\/mongo-driver(?:\/v2)?$/u, "mongodb"],
  [/^github\.com\/(?:segmentio\/kafka-go|IBM\/sarama|Shopify\/sarama|confluentinc\/confluent-kafka-go(?:\/v\d+)?|twmb\/franz-go)$/u, "kafka"],
  [/^github\.com\/(?:streadway\/amqp|rabbitmq\/amqp091-go)$/u, "rabbitmq"],
  [/^github\.com\/(?:elastic\/go-elasticsearch(?:\/v\d+)?|olivere\/elastic(?:\/v\d+)?)$/u, "elasticsearch"],
  [/^github\.com\/opensearch-project\/opensearch-go(?:\/v\d+)?$/u, "opensearch"],
  [/^github\.com\/bradfitz\/gomemcache$/u, "memcached"],
];
const AWS_GO_SERVICE = /^github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/([a-z0-9]+)(?:\/|$)/u;

function goModuleFamily(module: string): string | undefined {
  for (const [pattern, family] of GO_MODULES) if (pattern.test(module)) return family;
  const raw = AWS_GO_SERVICE.exec(module)?.[1];
  const id = raw === undefined ? undefined : normalizeAwsService(raw, "go");
  return id === undefined || isOwnedElsewhere(`aws:${id}`) ? undefined : `aws:${id}`;
}

/** Candidates for the drivers and AWS SDK service modules every go.mod lists. Strength `mentioned`. */
export async function goManifestCandidates(repo: RepositoryReader): Promise<DependencyCandidate[]> {
  const found: DependencyCandidate[] = [];
  for (const path of repo.paths.filter((candidatePath) => /(?:^|\/)go\.mod$/u.test(candidatePath)).slice(0, 20)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    // One line at a time, each cut at 300 characters, with a pattern whose parts cannot overlap: a hostile go.mod costs time in proportion to its size.
    text.split("\n").slice(0, 5_000).forEach((raw, index) => {
      const match = /^[ \t]*(?:require[ \t]+)?([A-Za-z0-9._~/-]{3,200})[ \t]+v[0-9]/u.exec(raw.slice(0, 300));
      if (match === null || !match[1]!.includes(".")) return;
      const family = goModuleFamily(match[1]!);
      if (family !== undefined) found.push(candidate(family, "mentioned", { path, line: index + 1 }, { seenBy: ["driver"] }));
    });
  }
  return mergeCandidates(found);
}

const GO_IMPORT = (paths: string): RegExp => new RegExp(`"(?:${paths})(?:/[^"]*)?"`, "u");
export const GO_DRIVERS: readonly DriverRule[] = [
  { family: "postgres", uses: GO_IMPORT("github\\.com/lib/pq|github\\.com/jackc/pgx(?:/v\\d+)?"), call: /\bsql\.Open\s{0,120}\(|\bpgx\.Connect\s{0,120}\(|\bpgxpool\.New\s{0,120}\(/u },
  { family: "mysql", uses: GO_IMPORT("github\\.com/go-sql-driver/mysql"), call: /\bsql\.Open\s{0,120}\(|\bmysql\.NewConnector\s{0,120}\(/u },
  { family: "redis", uses: GO_IMPORT("github\\.com/redis/go-redis(?:/v\\d+)?|github\\.com/go-redis/redis(?:/v\\d+)?|github\\.com/redis/rueidis"), call: /\bredis\.New(?:Client|ClusterClient|FailoverClient)\s{0,120}\(|\brueidis\.NewClient\s{0,120}\(/u },
  { family: "mongodb", uses: GO_IMPORT("go\\.mongodb\\.org/mongo-driver(?:/v2)?"), call: /\bApplyURI\s{0,120}\(|\bmongo\.Connect\s{0,120}\(/u },
  { family: "kafka", uses: GO_IMPORT("github\\.com/segmentio/kafka-go|github\\.com/IBM/sarama|github\\.com/Shopify/sarama|github\\.com/confluentinc/confluent-kafka-go(?:/v\\d+)?"), call: /\bkafka\.(?:NewWriter|NewReader|Dial|DialContext|NewProducer|NewConsumer)\s{0,120}\(|\bsarama\.New(?:SyncProducer|AsyncProducer|Consumer|Client)\s{0,120}\(/u },
  { family: "rabbitmq", uses: GO_IMPORT("github\\.com/streadway/amqp|github\\.com/rabbitmq/amqp091-go"), call: /\bamqp\.Dial(?:Config)?\s{0,120}\(/u },
  { family: "elasticsearch", uses: GO_IMPORT("github\\.com/elastic/go-elasticsearch(?:/v\\d+)?|github\\.com/olivere/elastic(?:/v\\d+)?"), call: /\belasticsearch\.NewClient\s{0,120}\(|\belastic\.NewClient\s{0,120}\(/u },
  { family: "opensearch", uses: GO_IMPORT("github\\.com/opensearch-project/opensearch-go(?:/v\\d+)?"), call: /\bopensearch\.NewClient\s{0,120}\(/u },
  { family: "memcached", uses: GO_IMPORT("github\\.com/bradfitz/gomemcache/memcache"), call: /\bmemcache\.New\s{0,120}\(/u },
];

/** AWS SDK clients (a service package imported) and drivers a Go file uses (test services D5). A `BaseEndpoint` / `Endpoint` written as a string is flagged for every AWS service the file imports. */
export function goCodeCandidates(path: string, text: string): DependencyCandidate[] {
  const found = scanDrivers(path, text, GO_DRIVERS);
  const explicit = /\b(?:BaseEndpoint|Endpoint)\s{0,40}[:=]\s{0,40}aws\.String\(\s{0,120}"/u.test(text);
  for (const match of text.matchAll(/"github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/([a-z0-9]+)(?:\/[^"]*)?"/gu)) {
    const item = awsClientCandidate(path, text, match.index, match[1]!, explicit, "go");
    if (item !== undefined) found.push(item);
  }
  return found;
}

export const detectGo: Detector = async (context) => {
  const found = await detectGoBuild(context);
  const dependencies = await goManifestCandidates(context.repo);
  return dependencies.length === 0 ? found : { ...found, dependencies };
};
