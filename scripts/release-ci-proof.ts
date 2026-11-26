// #1145, #1559: may the release skip its own typecheck, lint and tests because GitHub CI already passed on exactly this code?
//
// The release pipeline runs on a mainline merge commit; CI ran on the pull request's head (or the merge-queue commit). They are the same code only when their
// file trees are identical, which holds whenever the pull request was up to date with mainline when it merged. So the proof is:
//   1. a candidate commit whose tree is byte-for-byte the release commit's tree: the release commit itself, or its second parent
//      (the pull request's head, for a merge commit);
//   2. that candidate's latest `local` check run (CI's gate job, scripts/ci-gate.ts) completed with success, reported by GitHub Actions —
//      or, when `--ignore-linux-runtime` is passed (used by `.github/workflows/release.yml`, which does not run `linux-runtime`), its latest `local`
//      failed solely because `linux-runtime` failed/timed out while every full-run non-Linux check in that same check suite succeeded.
// Anything else (a pull request that was behind mainline, CI failed or still running, GitHub unreachable or rate limited, no git
// history) is "not proven", and the release runs every check as before. A failure to prove never fails the release.
import { spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { writeFileSync } from "node:fs";

export const CI_GATE_CHECK = "local";
const GITHUB_ACTIONS = "github-actions";
const SHA = /^[0-9a-f]{40}$/u;

/** Checks that must all succeed in a full CI check suite for `--ignore-linux-runtime` to prove a commit whose `local` failed on `linux-runtime`. */
export const REQUIRED_FULL_NON_LINUX_CHECKS: readonly string[] = [
  "plan",
  "quick",
  "typecheck",
  "build",
  "ci-mode (full)",
  "release-check",
  "test (1/8)",
  "test (2/8)",
  "test (3/8)",
  "test (4/8)",
  "test (5/8)",
  "test (6/8)",
  "test (7/8)",
  "test (8/8)",
];
const IGNORED_SUITE_CHECKS = new Set<string>([CI_GATE_CHECK, "linux-runtime", "device-runtime"]);

export const RELEASE_FALLBACK_JOBS = ["typecheck", "lint", "test-shards"] as const;

export interface CheckRun {
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  id: number;
  name?: string;
  app?: { slug?: string } | null;
  check_suite?: { id?: number } | null;
}
export interface ProofInput {
  repository: string;
  commit: string;
  git: (...args: string[]) => string | undefined;
  checkRuns: (sha: string) => Promise<CheckRun[] | undefined>;
  suiteCheckRuns?: (suiteId: number) => Promise<CheckRun[] | undefined>;
}
export type Proof = { proven: true; candidate: string; reason: string } | { proven: false; reason: string };
export interface ReleaseGateVerdict { ok: boolean; path: "proof" | "full" | "failed"; reason: string }

/** The latest run of CI's gate check on one commit, among GitHub Actions' own runs (a rerun makes a newer one). */
export function latestGateRun(runs: readonly CheckRun[]): CheckRun | undefined {
  return runs.filter((run) => run.app?.slug === GITHUB_ACTIONS).sort((a, b) => b.id - a.id)[0];
}

const isCompletedWith = (check: CheckRun | undefined, conclusions: readonly string[]): boolean =>
  check?.status === "completed" && check.conclusion !== null && conclusions.includes(check.conclusion);

function latestSuiteRunsByName(runs: readonly CheckRun[]): Map<string, CheckRun> {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    if (run.app?.slug !== GITHUB_ACTIONS || typeof run.name !== "string") continue;
    const previous = latest.get(run.name);
    if (previous === undefined || run.id > previous.id) latest.set(run.name, run);
  }
  return latest;
}

/** True when a check suite's `local` failed solely on `linux-runtime` while every full-run non-Linux check succeeded. */
export function fullNonLinuxSuitePassed(runs: readonly CheckRun[]): boolean {
  const byName = latestSuiteRunsByName(runs);
  if (!isCompletedWith(byName.get("linux-runtime"), ["failure", "timed_out"])) return false;
  if (!REQUIRED_FULL_NON_LINUX_CHECKS.every((name) => isCompletedWith(byName.get(name), ["success"]))) return false;
  for (const [name, check] of byName) {
    if (!IGNORED_SUITE_CHECKS.has(name) && !isCompletedWith(check, ["success", "skipped"])) return false;
  }
  return true;
}

async function evaluateCandidate(commit: string, tree: string, candidate: string, input: ProofInput): Promise<Proof | string> {
  if (input.git("rev-parse", `${candidate}^{tree}`) !== tree) return `${candidate.slice(0, 9)}: different code (it was behind mainline)`;
  const runs = await input.checkRuns(candidate);
  if (runs === undefined) return `${candidate.slice(0, 9)}: GitHub's check runs could not be read`;
  const gate = latestGateRun(runs);
  if (gate === undefined) return `${candidate.slice(0, 9)}: no CI gate run`;
  if (isCompletedWith(gate, ["success"])) {
    return { proven: true, candidate, reason: `${commit.slice(0, 9)} has the same code as ${candidate.slice(0, 9)}, whose CI gate passed at ${gate.completed_at ?? "?"}` };
  }
  const suiteId = gate.check_suite?.id;
  if (isCompletedWith(gate, ["failure"]) && input.suiteCheckRuns !== undefined && typeof suiteId === "number") {
    const suiteRuns = await input.suiteCheckRuns(suiteId);
    if (suiteRuns !== undefined && fullNonLinuxSuitePassed(suiteRuns)) {
      return { proven: true, candidate, reason: `${commit.slice(0, 9)} has the same code as ${candidate.slice(0, 9)}, whose full CI suite passed all non-Linux checks (local failed only on linux-runtime) at ${gate.completed_at ?? "?"}` };
    }
  }
  return `${candidate.slice(0, 9)}: CI gate ${gate.status}/${gate.conclusion ?? "none"}`;
}

export async function ciProof(input: ProofInput): Promise<Proof> {
  const commit = input.git("rev-parse", "--verify", `${input.commit}^{commit}`);
  if (commit === undefined || !SHA.test(commit)) return { proven: false, reason: `no commit ${input.commit} in this checkout` };
  const tree = input.git("rev-parse", `${commit}^{tree}`);
  const parents = input.git("rev-list", "--parents", "-n", "1", commit)?.split(" ").slice(1) ?? [];
  if (tree === undefined) return { proven: false, reason: "the commit's tree could not be read" };
  // The pull request's head first: CI never runs on mainline's own merge commits.
  const candidates = [...(parents.length === 2 ? [parents[1]!] : []), commit];
  const looked: string[] = [];
  for (const candidate of candidates) {
    if (!SHA.test(candidate)) continue;
    const outcome = await evaluateCandidate(commit, tree, candidate, input);
    if (typeof outcome !== "string") return outcome;
    looked.push(outcome);
  }
  return { proven: false, reason: looked.length === 0 ? "no candidate commit" : looked.join("; ") };
}

interface GateNeed { result?: unknown; outputs?: Record<string, unknown> }

const formatResult = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "missing");

function parseNeedsJson(needsJson: string): Record<string, GateNeed> | undefined {
  try {
    const parsed: unknown = JSON.parse(needsJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, GateNeed> : undefined;
  } catch { return undefined; }
}

/** Evaluates `.github/workflows/release.yml`'s `test` gate job from `toJSON(needs)`, failing closed on any unexpected state. */
export function releaseGateVerdict(needsJson: string): ReleaseGateVerdict {
  const needs = parseNeedsJson(needsJson);
  if (needs === undefined) return { ok: false, path: "failed", reason: "the needs context is not a JSON object" };
  const prepare = needs.prepare;
  if (prepare?.result !== "success") return { ok: false, path: "failed", reason: `prepare was ${formatResult(prepare?.result)}, not success` };
  const proven = prepare.outputs?.proven;
  const candidate = prepare.outputs?.candidate;
  if (proven === "true") {
    if (typeof candidate !== "string" || !SHA.test(candidate)) return { ok: false, path: "failed", reason: `prepare reported proven=true with invalid candidate ${JSON.stringify(candidate)}` };
    const bad = RELEASE_FALLBACK_JOBS.find((job) => needs[job]?.result !== "skipped" && needs[job]?.result !== "success");
    if (bad !== undefined) return { ok: false, path: "failed", reason: `${bad} was ${formatResult(needs[bad]?.result)}, expected skipped or success` };
    return { ok: true, path: "proof", reason: `CI proof reused (candidate commit ${candidate}); build and infra:synth passed` };
  }
  if (proven !== "false") return { ok: false, path: "failed", reason: `prepare reported unexpected proven=${JSON.stringify(proven)}` };
  const bad = RELEASE_FALLBACK_JOBS.find((job) => needs[job]?.result !== "success");
  if (bad !== undefined) return { ok: false, path: "failed", reason: `${bad} was ${formatResult(needs[bad]?.result)}, not success` };
  return { ok: true, path: "full", reason: "full checks (prepare, typecheck, lint, 8 test shards) succeeded" };
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "user-agent": "rovara-release", "x-github-api-version": "2022-11-28" } as const;

/**
 * #1166: the check-runs read without a token shares GitHub's 60-an-hour limit per address with every other caller on CodeBuild's shared AWS addresses, and was
 * refused there (2 of 9 reads on 2026-11-19). With the install's own GitHub App it is authenticated (its own 5,000-an-hour budget): an installation token for
 * this one repository with `metadata: read` only (a public repository's check runs need nothing more). Any failure answers undefined, and the read goes
 * unauthenticated as before, so a missing App never fails a release. The key and the token are never printed.
 */
export async function githubAppInstallationToken(input: { appId: string; privateKey: string; repository: string; fetch?: typeof fetch; now?: () => number }): Promise<string | undefined> {
  const fetchImplementation = input.fetch ?? fetch;
  const [owner, name] = input.repository.split("/");
  if (!/^[0-9]{1,12}$/u.test(input.appId) || owner === undefined || name === undefined) return undefined;
  try {
    const seconds = Math.floor((input.now ?? Date.now)() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - 60, exp: seconds + 300, iss: input.appId })}`;
    const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(input.privateKey).toString("base64url")}`;
    const asApp = { ...GITHUB_HEADERS, authorization: `Bearer ${jwt}` };
    const installation = await fetchImplementation(`https://api.github.com/repos/${owner}/${name}/installation`, { headers: asApp, signal: AbortSignal.timeout(10_000) });
    if (!installation.ok) return undefined;
    const id = (await installation.json() as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
    const minted = await fetchImplementation(`https://api.github.com/app/installations/${id}/access_tokens`, {
      method: "POST", headers: { ...asApp, "content-type": "application/json" }, body: JSON.stringify({ repositories: [name], permissions: { metadata: "read" } }), signal: AbortSignal.timeout(10_000),
    });
    if (!minted.ok) return undefined;
    const token = (await minted.json() as { token?: unknown }).token;
    // GitHub's installation tokens are `ghs_` plus, since late 2026, a longer signed form (`ghs_<app>_<jwt>`, with dots and dashes): any bounded URL-safe token.
    return typeof token === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{19,4095}$/u.test(token) ? token : undefined;
  } catch { return undefined; }
}

/** #1166: the App's id and private key, from the control plane stack's parameters (GitHubAppId, GitHubAppPrivateKeySecretArn) and that secret. Undefined on any failure. */
export async function githubAppFromStack(stackName: string, region: string): Promise<{ appId: string; privateKey: string } | undefined> {
  try {
    // The stack's parameters through the AWS CLI, as release-production.ts reads its stacks: a public script imports only the four public adapters' SDKs (port guard, cloud-aws).
    const described = spawnSync("aws", ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0].Parameters", "--output", "json"], { encoding: "utf8", timeout: 20_000 });
    if (described.status !== 0) return undefined;
    const rows = JSON.parse(described.stdout) as Array<{ ParameterKey?: string; ParameterValue?: string }> | null;
    const parameter = (key: string) => rows?.find((row) => row.ParameterKey === key)?.ParameterValue;
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const appId = parameter("GitHubAppId"); const secretArn = parameter("GitHubAppPrivateKeySecretArn");
    if (appId === undefined || secretArn === undefined || !secretArn.startsWith("arn:")) return undefined;
    const text = (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? "";
    let privateKey = text;
    try { const parsed = JSON.parse(text) as { privateKey?: unknown }; if (typeof parsed.privateKey === "string") privateKey = parsed.privateKey; } catch { /* a bare PEM */ }
    return privateKey.includes("PRIVATE KEY") ? { appId, privateKey } : undefined;
  } catch { return undefined; }
}

async function fetchCheckRuns(url: string, fetchImplementation: typeof fetch, token?: string): Promise<CheckRun[] | undefined> {
  try {
    const response = await fetchImplementation(url, {
      headers: { ...GITHUB_HEADERS, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { check_runs?: unknown };
    return Array.isArray(body.check_runs) ? body.check_runs as CheckRun[] : undefined;
  } catch { return undefined; }
}

/** GitHub's REST API, with the App's installation token (or GH_TOKEN) when there is one (#1166), else without (the repository is public). Ten seconds, then "unknown". */
export function githubCheckRuns(repository: string, fetchImplementation: typeof fetch = fetch, token?: string): (sha: string) => Promise<CheckRun[] | undefined> {
  return (sha) => fetchCheckRuns(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?check_name=${CI_GATE_CHECK}&per_page=100`, fetchImplementation, token);
}

/** GitHub's REST API for every check run in one check suite (#1559: used only when `--ignore-linux-runtime` inspects a failed `local` gate). */
export function githubSuiteCheckRuns(repository: string, fetchImplementation: typeof fetch = fetch, token?: string): (suiteId: number) => Promise<CheckRun[] | undefined> {
  return (suiteId) => fetchCheckRuns(`https://api.github.com/repos/${repository}/check-suites/${String(suiteId)}/check-runs?per_page=100`, fetchImplementation, token);
}

const git = (...args: string[]): string | undefined => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

async function resolveCliToken(repository: string, appStack: string | undefined, region: string | undefined): Promise<{ token: string | undefined; label: string }> {
  const app = appStack === undefined || region === undefined ? undefined : await githubAppFromStack(appStack, region);
  const appToken = app === undefined ? undefined : await githubAppInstallationToken({ ...app, repository });
  if (appToken !== undefined) return { token: appToken, label: "as the GitHub App" };
  const envToken = process.env["GH_TOKEN"]?.trim();
  if (envToken !== undefined && envToken.length > 0) return { token: envToken, label: "with GH_TOKEN" };
  return { token: undefined, label: "unauthenticated" };
}

async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--gate")) {
    const verdict = releaseGateVerdict(process.env["NEEDS"] ?? "");
    process.stdout.write(`release test gate ${verdict.ok ? "PASSED" : "FAILED"} (${verdict.path}): ${verdict.reason}\n`);
    return verdict.ok ? 0 : 1;
  }
  const at = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const repository = at("--repository");
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    process.stderr.write("usage: node scripts/release-ci-proof.ts --repository OWNER/NAME [--commit REV] [--github-app-stack STACK --region REGION] [--ignore-linux-runtime] [--out FILE]\n");
    return 2;
  }
  const { token, label } = await resolveCliToken(repository, at("--github-app-stack"), at("--region") ?? process.env["AWS_REGION"]);
  const ignoreLinux = argv.includes("--ignore-linux-runtime");
  const proof = await ciProof({
    repository,
    commit: at("--commit") ?? "HEAD",
    git,
    checkRuns: githubCheckRuns(repository, fetch, token),
    ...(ignoreLinux ? { suiteCheckRuns: githubSuiteCheckRuns(repository, fetch, token) } : {}),
  });
  const outPath = at("--out");
  if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(proof)}\n`, "utf8");
  process.stdout.write(`release CI proof (${label}): ${proof.proven ? "PROVEN" : "not proven"}: ${proof.reason}\n`);
  // Exit 0 only when proven: callers then skip checks; any other exit runs every check.
  return proof.proven ? 0 : 1;
}

if (process.argv[1]?.endsWith("release-ci-proof.ts")) {
  process.exit(await runCli(process.argv.slice(2)));
}
