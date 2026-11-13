// Rovara Code (Plan 6 Task 13): the risk level of a pull request's code. It comes from defined inputs only: the paths and size of the change, the checks' report, the review findings the owner
// accepted and the code reviewer's own level (one of three words). No free model text decides it. The highest matching rule wins and every match adds its (fixed) reason.
//
// At launch this is deliberately simple. Later (owner, 2026-10-22) it should also weigh how often each file changes, how far a change reaches, each project's own sensitive-path settings
// and what past reverts of Rovara's merged pull requests teach.
import { RISK_LARGE_CHANGE_LINES, RiskAssessmentSchema, type RiskAssessment, type VerificationReport } from "@agentx/contracts";
import type { EvidenceRiskSignal } from "./evidence-risk.js";
import { inertLine } from "./inert-text.js";
import { TEST_CONFIG_PATH_PATTERNS, isInstructionFilePath } from "./weakening-paths.js";

export type RiskLevel = RiskAssessment["level"];

/**
 * The paths that make a change high risk. Each pattern is tested against the whole path, lower-cased and written with `/`, so a directory name must be a whole path segment
 * (`src/author.ts` and `src/diamond.ts` are not `auth` or `iam`). Directory names: migrations, auth, authn, authz, security, oauth, saml, sso, jwt, crypto, permissions, credentials, payments, billing, secrets, iam, infra, terraform, cdk and
 * `.github/workflows`. File patterns: `*.sql`, `*.tf` and `Dockerfile`.
 */
export const RISK_SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(migrations|auth|authn|authz|security|oauth|saml|sso|jwt|crypto|permissions|credentials|payments|billing|secrets|iam|infra|terraform|cdk)(\/|$)/,
  /(^|\/)\.github\/workflows(\/|$)/,
  // Who must approve and how a branch is protected: a change to them changes the rules every later merge follows.
  /(^|\/)codeowners$/,
  // How the project works (the playbook file) and what its meta repository configures: a merged change to them changes what every later task is told, and design review's cost and approvers.
  /(^|\/)\.rovara\/(playbook|project)\.(ya?ml|json)$/,
  /(^|\/)\.github\/(settings\.ya?ml|rulesets?(\/|$)|branch[-_]protection[^/]*)$/,
  /\.(sql|tf)$/,
  /(^|\/)dockerfile$/,
];

/**
 * The paths of continuous-integration configuration (GitHub workflows, CircleCI, GitLab, Jenkins, Azure, Buildkite, Travis, Bitbucket, AppVeyor, Drone). A fix that changes one may have made CI pass by changing
 * what CI checks, so it is high risk (Plan 6 Task 16). Matched on the whole path, lower-cased and written with `/`.
 */
export const CI_CONFIG_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/(workflows|actions)(\/|$)/,
  /(^|\/)\.gitlab(\/|$)/,
  // What decides which tests CI runs: the test runners' own configuration.
  /(^|\/)(vitest|jest|playwright|karma|cypress)\.(config|workspace)\.[cm]?[jt]s(on)?$/,
  /(^|\/)\.github\/(dependabot|renovate)\.(ya?ml|json)$/,
  /^(makefile|turbo\.json)$/,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|\.mocharc(\.[\w]+)?|karma\.conf\.[cm]?js)$/,
  /(^|\/)\.(circleci|buildkite|drone)(\/|$)/,
  /(^|\/)(\.gitlab-ci\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|appveyor\.ya?ml|\.drone\.ya?ml|buildkite\.ya?ml)$/,
];

/**
 * Whether a path is a file a CI run executes: CI configuration (the high-risk patterns above) or test and coverage configuration, a Makefile or a conftest.py (`TEST_CONFIG_PATH_PATTERNS`). Used for the flag only: the
 * high-risk rule keeps `CI_CONFIG_PATH_PATTERNS` alone, so a test setup file or a coverage config is flagged and not made high (high needs the strong sign-in at merge).
 */
export function isCiExecutedPath(path: string): boolean {
  const value = normalized(path);
  return CI_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(value)) || TEST_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

/** The lock files and manifests whose change is at least medium (matched on the file name). */
const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "cargo.toml", "cargo.lock", "go.mod", "go.sum", "pipfile", "pipfile.lock", "poetry.lock", "pyproject.toml", "uv.lock",
  "gemfile", "gemfile.lock", "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "gradle.lockfile",
  "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock", "packages.lock.json",
]);
const MANIFEST_PATTERNS: readonly RegExp[] = [/^requirements[\w.-]*\.txt$/, /\.csproj$/];

const PATHS_LISTED = 3;
const REASON_MAX = 200;
const REASONS_MAX = 8;
const PATH_SHOWN_MAX = 60;

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").toLowerCase();
}

/** The words that make a file sensitive when its name is one, or is made of one joined to others by `-`, `_` or `.` (`jwt.ts`, `user-auth.ts`, `oauth_client.py`); `author.ts` and `secretsanta.ts` are not. */
const SENSITIVE_NAME_WORDS: ReadonlySet<string> = new Set(["auth", "authn", "authz", "security", "oauth", "saml", "sso", "jwt", "crypto", "permissions", "credentials", "secrets", "iam"]);
/** Documents about a topic are not code for it. */
const DOCUMENT_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/u;

/** Whether a path has a segment (or the workflows folder, or a file name) that makes it sensitive. */
export function isSensitivePath(path: string): boolean {
  const value = normalized(path);
  if (RISK_SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(value))) return true;
  const name = value.split("/").at(-1) ?? "";
  return !DOCUMENT_EXTENSIONS.test(name) && name.split(/[-_.]/u).some((word) => SENSITIVE_NAME_WORDS.has(word));
}

function isManifestPath(path: string): boolean {
  const name = normalized(path).split("/").at(-1) ?? "";
  return MANIFEST_NAMES.has(name) || MANIFEST_PATTERNS.some((pattern) => pattern.test(name));
}

/** A changed file as the task's diff lists it; the line counts are the diff's when it has them (a new unstaged file or a binary patch has none, and none is not 0). */
export interface RiskFile {
  repository: string;
  path: string;
  /** The old name of a renamed file: a file moved out of a sensitive folder is still a change to it. */
  renamedFrom?: string | undefined;
  added?: number | undefined;
  removed?: number | undefined;
  /** The change deletes this test file, or only takes lines out of it. */
  testsRemoved?: true | undefined;
  /** A line the change adds skips a test in this file. */
  testsSkipped?: true | undefined;
  /** package.json: the change adds or removes a line of the `test` scripts. */
  testCommandChanged?: true | undefined;
  /** TE-B3: package.json: the change adds or removes a line of another script CI runs (`pretest`, `posttest`, `ci`, `coverage`, `verify`, `check`). A flag, medium at most. */
  ciScriptChanged?: true | undefined;
  /** TE-B3: a line the change adds takes tests or coverage out of a run (a config ignore or exclude option, a coverage pragma). */
  testsExcluded?: true | undefined;
  /** TE-B3: the file is a snapshot or golden file. */
  snapshotChanged?: true | undefined;
  /** TE-B3: the file is a fixture, mock or recorded-answer file. */
  fixtureChanged?: true | undefined;
  /** The diff changes a route declaration, a response model or a schema file (read from the diff, never from a model). */
  apiShapeChanged?: true | undefined;
}

export interface RiskInput {
  /** True while the change is a fix to a pull request that is open (for CI, a conflict or review comments): it may not hide what it was asked to fix. */
  fix?: boolean | undefined;
  /** The files the change touches. */
  changedFiles: readonly RiskFile[];
  /** False when the list may be missing files (it could not be read, or was cut): the level is then never low. */
  changedFilesComplete: boolean;
  /** What the checks said about this code (Task 12). */
  report: VerificationReport;
  /** The review findings the owner accepted for this code. */
  acceptedFindings: ReadonlyArray<{ role: "CRITIC" | "SECURITY" }>;
  /** The security findings the review introduced on this code, accepted or not (the accepted list is bounded, so this is a second source). */
  securityFindings: number;
  /** The code reviewer's own level for this code, when it gave one. */
  reviewerRisk?: RiskLevel | undefined;
  candidateDigest: string;
  /** Proof and evidence P4: a security scan's new high or critical findings on this code, from the evidence pack (only while the proof switch is on). Absent: the level is what it was before evidence existed. */
  evidence?: EvidenceRiskSignal | undefined;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function shown(paths: readonly string[]): string {
  const listed = paths.slice(0, PATHS_LISTED).map((path) => inertLine(path, PATH_SHOWN_MAX));
  const more = paths.length - listed.length;
  return `${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The risk of the change: the highest matching rule wins, and each match adds its reason (at most 8, each at most 200 characters). */
export function assessRisk(input: RiskInput): RiskAssessment {
  const high: string[] = [];
  const medium: string[] = [];
  // A renamed file counts under both names: the new one and the one it left.
  const named = (file: RiskFile) => [file.path, ...(file.renamedFrom === undefined ? [] : [file.renamedFrom])];
  const sensitive = [...new Set(input.changedFiles.flatMap((file) => named(file).filter(isSensitivePath)))];
  if (sensitive.length > 0) high.push(`Changes sensitive paths: ${shown(sensitive)}.`);
  if (input.fix === true) {
    // A fix that makes a failure go by taking out or switching off what shows it, or by changing CI itself, has hidden the failure rather than fixed it. Only the whole change since the task's base is
    // kept, so a test the task's first change removed is flagged on a later fix too: erring high costs a look; erring low costs a hidden failure.
    const hidden = [...new Set(input.changedFiles.filter((file) => file.testsRemoved === true || file.testsSkipped === true).map((file) => file.path))];
    if (hidden.length > 0) high.push(`A fix removes or skips tests (${shown(hidden)}), so a failure may be hidden rather than fixed.`);
    const ci = [...new Set(input.changedFiles.flatMap((file) => named(file).filter((path) => CI_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(normalized(path))))))];
    const command = [...new Set(input.changedFiles.filter((file) => file.testCommandChanged === true).map((file) => file.path))];
    if (command.length > 0) high.push(`A fix changes the command that runs the tests (${shown(command)}), so a check may pass because the tests no longer run.`);
    if (ci.length > 0) high.push(`A fix changes CI configuration (${shown(ci)}), so a check may pass because CI changed.`);
  }
  if (input.fix !== true) {
    // Owner decision 2026-10-27: the risk is shown next to Merge for every change, so CI configuration and the tests a change removes or skips are named for an ordinary change too (a fix has its own, stronger words above).
    const ci = [...new Set(input.changedFiles.flatMap((file) => named(file).filter((path) => CI_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(normalized(path))) && !isSensitivePath(path))))];
    if (ci.length > 0) high.push(`Changes CI configuration (${shown(ci)}), which decides what is checked before a merge.`);
    const hidden = [...new Set(input.changedFiles.filter((file) => file.testsRemoved === true || file.testsSkipped === true).map((file) => file.path))];
    if (hidden.length > 0) medium.push(`Removes or skips tests (${shown(hidden)}).`);
  }
  // TE-B3 (O39): flags for a reviewer, never approvals. The level moves no higher than medium for them; a path that is already a sensitive path is high above and not repeated.
  const flaggedNamed = (pick: (file: RiskFile) => boolean): string[] => [...new Set(input.changedFiles.filter(pick).flatMap(named))];
  const instruction = [...new Set(input.changedFiles.flatMap((file) => named(file).filter((path) => isInstructionFilePath(path) && !isSensitivePath(path))))];
  if (instruction.length > 0) medium.push(`Changes Rovara instruction files (${shown(instruction)}), which tell Rovara how to work in this repository; read the change.`);
  const snapshots = flaggedNamed((file) => file.snapshotChanged === true);
  if (snapshots.length > 0) medium.push(`Changes snapshot files (${shown(snapshots)}), the expected output that tests compare with.`);
  const fixtures = flaggedNamed((file) => file.fixtureChanged === true);
  if (fixtures.length > 0) medium.push(`Changes test fixtures or recorded answers (${shown(fixtures)}).`);
  const excluded = [...new Set(input.changedFiles.filter((file) => file.testsExcluded === true).map((file) => file.path))];
  if (excluded.length > 0) medium.push(`Takes tests or code out of a test or coverage run (${shown(excluded)}).`);
  // The `test` script is high in a fix (above); every other script CI runs is a flag at medium, and the `test` script too in an ordinary change.
  const scripts = [...new Set(input.changedFiles.filter((file) => file.ciScriptChanged === true || (input.fix !== true && file.testCommandChanged === true)).map((file) => file.path))];
  if (scripts.length > 0) medium.push(`Changes the scripts that CI runs (${shown(scripts)}), which decide what is checked before a merge.`);
  if (input.acceptedFindings.some((finding) => finding.role === "SECURITY")) high.push("The owner accepted a security review finding.");
  else if (input.securityFindings > 0) high.push("The security review reported a problem with this change.");
  if (input.reviewerRisk === "high") high.push("The code review rated this change high risk.");
  // A new high or critical finding from a security scan: high, whatever the files and the reviewer said (a fixed sentence; the tool's own words are not used).
  if (input.evidence !== undefined && input.evidence.highNewFindings > 0) high.push(`A security scan found ${plural(input.evidence.highNewFindings, "new high or critical finding", "new high or critical findings")}.`);

  const lines = input.changedFiles.reduce((total, file) => total + (file.added ?? 0) + (file.removed ?? 0), 0);
  if (lines > RISK_LARGE_CHANGE_LINES) medium.push(`Changes ${lines} lines, more than ${RISK_LARGE_CHANGE_LINES}.`);
  // A file with no line count (new and not staged, binary, or only moved) may be large: the size of the change is unknown, not small.
  const uncounted = input.changedFiles.filter((file) => file.added === undefined || file.removed === undefined).length;
  if (uncounted > 0) medium.push(`${uncounted} ${uncounted === 1 ? "file has" : "files have"} no line count (new or binary), so Rovara can't tell how large the change is.`);
  if (!input.changedFilesComplete) medium.push("Rovara couldn't list every changed file.");
  // A route or a response schema changed: whoever calls it today may get a different answer. Read from the diff, so it is said whatever the plan or the reviewer thought.
  const api = [...new Set(input.changedFiles.filter((file) => file.apiShapeChanged === true).map((file) => file.path))];
  if (api.length > 0) medium.push(`Changes a public API route or response shape (${shown(api)}), so existing callers may get a different response; check that they still work.`);
  const manifests = [...new Set(input.changedFiles.flatMap((file) => named(file).filter(isManifestPath)))];
  if (manifests.length > 0) medium.push(`Changes dependencies or build files: ${shown(manifests)}.`);
  if (input.report.reviewOnly) medium.push("No automated check applied, so this change was checked by review only.");
  if (input.report.failed.length > 0) medium.push(`${plural(input.report.failed.length, "check", "checks")} failed on the latest code.`);
  if (input.report.notChecked.length > 0 && !input.report.reviewOnly) medium.push(`${plural(input.report.notChecked.length, "check", "checks")} could not be run.`);
  if (input.acceptedFindings.some((finding) => finding.role === "CRITIC")) medium.push("The owner accepted a code review finding.");
  if (input.reviewerRisk === "medium") medium.push("The code review rated this change medium risk.");
  // A security scan reported high findings that could not be compared with the original code (no baseline ran, or it could not be trusted): at least medium ("needs review"), never silently low.
  if (input.evidence !== undefined && (input.evidence.unverifiedHighFindings ?? 0) > 0) medium.push(`A security scan reported ${plural(input.evidence.unverifiedHighFindings!, "high or critical finding", "high or critical findings")} that could not be compared with the original code, so it needs review.`);

  // A security check was expected but no pack for this code could be read (EV-2): a scan could not be checked, so never silently low. A fixed sentence.
  if (input.evidence?.evidenceUnavailable === true) medium.push("The proof evidence for this code was not available, so a security scan could not be checked, and it needs review.");

  const level: RiskLevel = high.length > 0 ? "high" : medium.length > 0 ? "medium" : "low";
  const reasons = [...high, ...medium].map((reason) => reason.slice(0, REASON_MAX));
  if (reasons.length === 0) reasons.push("A small change with no sensitive paths, dependency changes or open concerns.");
  return RiskAssessmentSchema.parse({ level, reasons: reasons.slice(0, REASONS_MAX), candidateDigest: input.candidateDigest });
}

export function riskHeading(level: RiskLevel): "Low" | "Medium" | "High" {
  return level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
}
