import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { ciProof, githubAppInstallationToken, githubCheckRuns, latestGateRun, type CheckRun } from "../../scripts/release-ci-proof.js";

// #1145: the release skips its own checks only when CI's gate passed on exactly the code it releases.
const MERGE = "a".repeat(40), BASE = "b".repeat(40), HEAD = "c".repeat(40);
const TREE = "1".repeat(40), OTHER_TREE = "2".repeat(40);

function gitOf(trees: Record<string, string>, parents: Record<string, string[]>) {
  return (...args: string[]): string | undefined => {
    if (args[0] === "rev-parse" && args[1] === "--verify") { const sha = args[2]!.replace("^{commit}", ""); return sha === "HEAD" ? MERGE : trees[sha] === undefined ? undefined : sha; }
    if (args[0] === "rev-parse") return trees[args[1]!.replace("^{tree}", "")];
    if (args[0] === "rev-list") return [args[4]!, ...(parents[args[4]!] ?? [])].join(" ");
    return undefined;
  };
}
const run = (over: Partial<CheckRun> = {}): CheckRun => ({ id: 10, status: "completed", conclusion: "success", completed_at: "2026-11-19T15:00:00Z", app: { slug: "github-actions" }, ...over });
const merge = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: TREE };

describe("the release's CI proof", () => {
  it("is proven for a merge whose tree is the pull request head's, when the head's latest gate run passed", async () => {
    const asked: string[] = [];
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async (sha) => { asked.push(sha); return [run()]; } });
    expect(proof).toMatchObject({ proven: true, candidate: HEAD });
    expect(asked).toEqual([HEAD]);
  });

  it("is not proven when the pull request was behind mainline (the merge's code differs from what CI ran)", async () => {
    const trees = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: OTHER_TREE };
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(trees, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [] });
    expect(proof.proven).toBe(false);
    expect(proof.reason).toContain("different code");
  });

  it("is not proven when the latest gate run failed, even if an older run passed", async () => {
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [run({ id: 1 }), run({ id: 2, conclusion: "failure" })] });
    expect(proof.proven).toBe(false);
    expect(proof.reason).toContain("completed/failure");
  });

  it("is not proven while the gate is still running, or when GitHub cannot be read", async () => {
    const git = gitOf(merge, { [MERGE]: [BASE, HEAD] });
    expect((await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async () => [run({ status: "in_progress", conclusion: null })] })).proven).toBe(false);
    expect((await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async () => undefined })).proven).toBe(false);
  });

  it("ignores a gate check reported by anything but GitHub Actions", async () => {
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [run({ app: { slug: "someone-else" } })] });
    expect(proof.proven).toBe(false);
  });

  it("can prove a commit CI ran on directly (no merge), and refuses a commit that is not in the checkout", async () => {
    const solo = { [MERGE]: TREE, [BASE]: OTHER_TREE };
    expect(await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(solo, { [MERGE]: [BASE] }), checkRuns: async () => [run()] })).toMatchObject({ proven: true, candidate: MERGE });
    expect((await ciProof({ repository: "o/r", commit: "d".repeat(40), git: gitOf(solo, {}), checkRuns: async () => [run()] })).proven).toBe(false);
  });

  // #1259: the merge queue merges a pull request onto the latest mainline in a commit of its own, runs CI on that commit, and fast-forwards mainline to it.
  // The pull request's head (its second parent) has other code when it was behind, so the proof stands on the queue commit's own gate run.
  it("is proven for a merge-queue commit by its own gate run, when the pull request's head was behind mainline", async () => {
    const trees = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: OTHER_TREE };
    const asked: string[] = [];
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(trees, { [MERGE]: [BASE, HEAD] }), checkRuns: async (sha) => { asked.push(sha); return sha === MERGE ? [run()] : []; } });
    expect(proof).toMatchObject({ proven: true, candidate: MERGE });
    expect(asked).toEqual([MERGE]);
  });

  // #1262: a merge-queue run of byte-identical code reuses the pull request's pass, so its own gate (local) passes without the suite running again. The release
  // stands on that gate run like any other, and a gate check from anything but GitHub Actions still doesn't count.
  it("is proven for a merge-queue commit whose own gate passed by reusing the pull request's run, and never by a gate check from another app", async () => {
    const trees = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: OTHER_TREE };
    const git = gitOf(trees, { [MERGE]: [BASE, HEAD] });
    expect(await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async (sha) => (sha === MERGE ? [run({ id: 77 })] : []) })).toMatchObject({ proven: true, candidate: MERGE });
    expect((await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async (sha) => (sha === MERGE ? [run({ app: { slug: "someone-else" } })] : []) })).proven).toBe(false);
  });

  it("takes the newest GitHub Actions run as the gate's result", () => {
    expect(latestGateRun([run({ id: 3, conclusion: "failure" }), run({ id: 7 }), run({ id: 9, app: { slug: "other" } })])?.id).toBe(7);
  });

  it("reads check runs from GitHub without a token, and answers unknown on an error status or a network failure", async () => {
    const urls: string[] = [];
    const ok = githubCheckRuns("o/r", (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ check_runs: [run()] }), { status: 200 }); }) as typeof fetch);
    expect(await ok(HEAD)).toHaveLength(1);
    expect(urls[0]).toBe(`https://api.github.com/repos/o/r/commits/${HEAD}/check-runs?check_name=local&per_page=100`);
    expect(await githubCheckRuns("o/r", (async () => new Response("rate limited", { status: 403 })))(HEAD)).toBeUndefined();
    expect(await githubCheckRuns("o/r", (async () => { throw new Error("offline"); }))(HEAD)).toBeUndefined();
  });
});

// #1166: the check-runs read as the install's own GitHub App (its own rate budget), never failing the release when the App can't be used.
describe("the release's CI proof as the GitHub App", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const TOKEN = "ghs_" + "a".repeat(36);

  it("mints an installation token for this one repository with metadata read only, signed with the App's key", async () => {
    const calls: Array<{ url: string; method: string; auth: string; body?: string }> = [];
    const fake = (async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", auth: headers.authorization ?? "", ...(typeof init.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/repos/o/r/installation")) return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      if (url.endsWith("/app/installations/42/access_tokens")) return new Response(JSON.stringify({ token: TOKEN }), { status: 201 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    expect(await githubAppInstallationToken({ appId: "5002502", privateKey, repository: "o/r", fetch: fake, now: () => 1_700_000_000_000 })).toBe(TOKEN);
    // GitHub's newer signed token form (seen 2026-11-19): ghs_<app id>_<header>.<payload>.<signature>.
    const signed = "ghs_5002502_eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJ4In0.sig-nature_part";
    const newer = (async (url: string) => (url.endsWith("/installation") ? new Response(JSON.stringify({ id: 42 })) : new Response(JSON.stringify({ token: signed }), { status: 201 }))) as typeof fetch;
    expect(await githubAppInstallationToken({ appId: "5002502", privateKey, repository: "o/r", fetch: newer })).toBe(signed);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.github.com/repos/o/r/installation", "POST https://api.github.com/app/installations/42/access_tokens"]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ repositories: ["r"], permissions: { metadata: "read" } });
    const jwt = calls[0]!.auth.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_300, iss: "5002502" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("answers no token when the App is not installed on the repository, GitHub refuses, or the answer doesn't read", async () => {
    const answer = (installation: Response, minted?: Response) => (async (url: string) => (url.endsWith("/installation") ? installation : minted ?? new Response("{}", { status: 500 }))) as typeof fetch;
    expect(await githubAppInstallationToken({ appId: "1", privateKey, repository: "o/r", fetch: answer(new Response("{}", { status: 404 })) })).toBeUndefined();
    expect(await githubAppInstallationToken({ appId: "1", privateKey, repository: "o/r", fetch: answer(new Response(JSON.stringify({ id: 7 }), { status: 200 }), new Response("{}", { status: 403 })) })).toBeUndefined();
    expect(await githubAppInstallationToken({ appId: "1", privateKey, repository: "o/r", fetch: answer(new Response(JSON.stringify({ id: 7 }), { status: 200 }), new Response(JSON.stringify({ token: "not a token!" }), { status: 201 })) })).toBeUndefined();
    expect(await githubAppInstallationToken({ appId: "not-a-number", privateKey, repository: "o/r", fetch: answer(new Response("{}")) })).toBeUndefined();
    expect(await githubAppInstallationToken({ appId: "1", privateKey: "not a key", repository: "o/r", fetch: answer(new Response("{}")) })).toBeUndefined();
  });

  it("sends the token on the check-runs read when it has one, and nothing when it doesn't", async () => {
    const seen: string[] = [];
    const fake = (async (_url: string, init: RequestInit = {}) => { seen.push((init.headers as Record<string, string>).authorization ?? "none"); return new Response(JSON.stringify({ check_runs: [] }), { status: 200 }); }) as typeof fetch;
    await githubCheckRuns("o/r", fake, TOKEN)(HEAD);
    await githubCheckRuns("o/r", fake)(HEAD);
    expect(seen).toEqual([`Bearer ${TOKEN}`, "none"]);
  });
});
