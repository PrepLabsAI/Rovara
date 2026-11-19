// #1145: may the release skip its own typecheck, lint and tests because GitHub CI already passed on exactly this code?
//
// The release pipeline runs on a mainline merge commit; CI ran on the pull request's head. They are the same code only when their
// file trees are identical, which holds whenever the pull request was up to date with mainline when it merged. So the proof is:
//   1. a candidate commit whose tree is byte-for-byte the release commit's tree: the release commit itself, or its second parent
//      (the pull request's head, for a merge commit);
//   2. that candidate's latest `local` check run (CI's gate job, scripts/ci-gate.ts) completed with success, reported by GitHub Actions.
// Anything else (a pull request that was behind mainline, CI failed or still running, GitHub unreachable or rate limited, no git
// history) is "not proven", and the release runs every check as before. A failure to prove never fails the release.
import { spawnSync } from "node:child_process";
import { createSign } from "node:crypto";

export const CI_GATE_CHECK = "local";
const GITHUB_ACTIONS = "github-actions";
const SHA = /^[0-9a-f]{40}$/u;

export interface CheckRun { status: string; conclusion: string | null; completed_at: string | null; id: number; app?: { slug?: string } | null }
export interface ProofInput {
  repository: string;
  commit: string;
  git: (...args: string[]) => string | undefined;
  checkRuns: (sha: string) => Promise<CheckRun[] | undefined>;
}
export type Proof = { proven: true; candidate: string; reason: string } | { proven: false; reason: string };

/** The latest run of CI's gate check on one commit, among GitHub Actions' own runs (a rerun makes a newer one). */
export function latestGateRun(runs: readonly CheckRun[]): CheckRun | undefined {
  return runs.filter((run) => run.app?.slug === GITHUB_ACTIONS).sort((a, b) => b.id - a.id)[0];
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
    if (input.git("rev-parse", `${candidate}^{tree}`) !== tree) { looked.push(`${candidate.slice(0, 9)}: different code (it was behind mainline)`); continue; }
    const runs = await input.checkRuns(candidate);
    if (runs === undefined) { looked.push(`${candidate.slice(0, 9)}: GitHub's check runs could not be read`); continue; }
    const gate = latestGateRun(runs);
    if (gate === undefined) { looked.push(`${candidate.slice(0, 9)}: no CI gate run`); continue; }
    if (gate.status !== "completed" || gate.conclusion !== "success") { looked.push(`${candidate.slice(0, 9)}: CI gate ${gate.status}/${gate.conclusion ?? "none"}`); continue; }
    return { proven: true, candidate, reason: `${commit.slice(0, 9)} has the same code as ${candidate.slice(0, 9)}, whose CI gate passed at ${gate.completed_at ?? "?"}` };
  }
  return { proven: false, reason: looked.length === 0 ? "no candidate commit" : looked.join("; ") };
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
    const { CloudFormationClient, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    const parameter = (key: string) => stack?.Parameters?.find((row) => row.ParameterKey === key)?.ParameterValue;
    const appId = parameter("GitHubAppId"); const secretArn = parameter("GitHubAppPrivateKeySecretArn");
    if (appId === undefined || secretArn === undefined || !secretArn.startsWith("arn:")) return undefined;
    const text = (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? "";
    let privateKey = text;
    try { const parsed = JSON.parse(text) as { privateKey?: unknown }; if (typeof parsed.privateKey === "string") privateKey = parsed.privateKey; } catch { /* a bare PEM */ }
    return privateKey.includes("PRIVATE KEY") ? { appId, privateKey } : undefined;
  } catch { return undefined; }
}

/** GitHub's REST API, with the App's installation token when there is one (#1166), else without (the repository is public). Ten seconds, then "unknown". */
export function githubCheckRuns(repository: string, fetchImplementation: typeof fetch = fetch, token?: string): (sha: string) => Promise<CheckRun[] | undefined> {
  return async (sha) => {
    try {
      const response = await fetchImplementation(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?check_name=${CI_GATE_CHECK}&per_page=100`, {
        headers: { ...GITHUB_HEADERS, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { check_runs?: unknown };
      return Array.isArray(body.check_runs) ? body.check_runs as CheckRun[] : undefined;
    } catch { return undefined; }
  };
}

const git = (...args: string[]): string | undefined => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

if (process.argv[1]?.endsWith("release-ci-proof.ts")) {
  const at = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const repository = at("--repository");
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    process.stderr.write("usage: node scripts/release-ci-proof.ts --repository OWNER/NAME [--commit REV] [--github-app-stack STACK --region REGION]\n");
    process.exit(2);
  }
  const appStack = at("--github-app-stack"); const region = at("--region") ?? process.env["AWS_REGION"];
  const app = appStack === undefined || region === undefined ? undefined : await githubAppFromStack(appStack, region);
  const token = app === undefined ? undefined : await githubAppInstallationToken({ ...app, repository });
  const proof = await ciProof({ repository, commit: at("--commit") ?? "HEAD", git, checkRuns: githubCheckRuns(repository, fetch, token) });
  process.stdout.write(`release CI proof (${token === undefined ? "unauthenticated" : "as the GitHub App"}): ${proof.proven ? "PROVEN" : "not proven"}: ${proof.reason}\n`);
  // Exit 0 only when proven: the buildspec then passes --skip-checks; any other exit runs every check.
  process.exit(proof.proven ? 0 : 1);
}
