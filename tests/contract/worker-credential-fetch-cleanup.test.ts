import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProjectDefinition, WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";

// MAINTAIN-TOKEN-CLEANUP. Every place the worker fetches a repository credential, and whether the cleanup (every container
// but the worker's own removed, every leftover process stopped: publish.ts containWorkspace) runs first.
//
//   publish   publish.ts fetchCredential (the base fetch, the push)     push token  cleanup runs first (fetchContainedCredential)
//   maintain  maintain-pull-request.ts: a read of the head and base BEFORE the checks (a push-access token, dropped at once), and the token that pushes AFTER the checks; both through fetchContainedCredential
//   prepare   prepare.ts askCredential (clone, meta clone, clone retry)  read token  no cleanup (see the test below)
//   rebuild   saved-env/rebuild.ts rememberCredentials                   wraps prepare's provider; fetches nothing of its own
//
// A new fetch fails the first test until it is listed here with its answer.

const SRC = join(__dirname, "../../packages/worker/src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith(".ts") ? [path] : [];
  });
}

/** Lines that call a repository credential provider (a call, not a type or a parameter name; the package registries' providers take a registry name and are another credential). */
function providerCalls(): string[] {
  return sourceFiles(SRC).flatMap((path) => readFileSync(path, "utf8").split("\n")
    .flatMap((line) => /\b(credentialProvider\??\.?|provider)\(\s*(repository|input\.repository)\b|\bcredentialProvider\??\.\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/=>\s*Promise<|function |: RepositoryCredentialProvider|createRepositoryCredentialProvider|createRegistryCredentialProvider/.test(line)
      ? [`${relative(SRC, path)}: ${line.trim()}`] : []));
}


/** Every non-comment line of the worker's source that names the repository credential provider (its name, its type or its factory), the contained fetch or the broker's credential endpoint, per file, in source order. */
function credentialLines(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const path of sourceFiles(SRC).sort()) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (/\bcredentialProvider\b|\/repository-credentials\b|\bfetchContainedCredential\b|\b(?:create)?RepositoryCredentialProvider\b/.test(line)) (found[relative(SRC, path)] ??= []).push(line.trim());
    }
  }
  return found;
}

describe("worker repository credential fetches and the cleanup before them", () => {
  it("pins every line that names the provider, the contained fetch or the credential endpoint: any new or reshaped call fails until it is classified here", () => {
    // Not a call shape to match but the whole set of lines: another argument name, bracket access, destructuring, a helper that takes `options`, or a direct request of the endpoint adds or changes a line.
    // A line added here needs its answer: does the cleanup (publish.ts containWorkspace) run before it, and is its token push or read.
  const PINNED: Record<string, readonly string[]> = {
    // re-export only
    "index.ts": [
      "export * from \"./repository-credentials.js\";",
    ],
    // the three providers: prepare's (wrapped by rememberCredentials), publish's, maintain's
    "main.ts": [
      "import { createRepositoryCredentialProvider } from \"./repository-credentials.js\";",
      "const cloneCredentials = rememberCredentials(createRepositoryCredentialProvider({ controlPlaneUrl, invocation }));",
      "credentialProvider: cloneCredentials.provider,",
      "credentialProvider: createRepositoryCredentialProvider({ controlPlaneUrl, invocation }),",
      "credentialProvider: createRepositoryCredentialProvider({ controlPlaneUrl, invocation }),",
    ],
    // types, and the only two fetches: the read of the head and base (before the checks) and the push token (after them), both through the helper
    "maintain-pull-request.ts": [
      "import type { RepositoryCredentialProvider } from \"./repository-credentials.js\";",
      "import { fetchContainedCredential, runReadinessChecks, temporaryIndexTree, type OtherOperationWait } from \"./publish.js\";",
      "credentialProvider: RepositoryCredentialProvider;",
      "], await fetchContainedCredential({ ...options, rootPath, repository }), \"Git fetch failed\", { mode: \"write\", refs: true });",
      "const pushCredential = () => fetchContainedCredential({ ...options, rootPath, repository });",
      "credential: Awaited<ReturnType<RepositoryCredentialProvider>>,",
      "async function push(directory: string, url: string, branch: string, credential: Awaited<ReturnType<RepositoryCredentialProvider>>) {",
      "async function remoteBranchHead(directory: string, url: string, branch: string, credential: Awaited<ReturnType<RepositoryCredentialProvider>>): Promise<string | undefined> {",
    ],
    // read-only clone token (prepare asks access: clone); the two askCredential calls are the clone and the meta clone, the clone retry reuses askCredential
    "prepare.ts": [
      "RepositoryCredentialProvider,",
      "} from \"./repository-credentials.js\";",
      "credentialProvider?: RepositoryCredentialProvider;",
      "const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};",
      "const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};",
    ],
    // the helper (the one place the provider is called, after containWorkspace) and publication's fetchCredential
    "publish.ts": [
      "import type { RepositoryCredentialProvider } from \"./repository-credentials.js\";",
      "credentialProvider: RepositoryCredentialProvider;",
      "export async function fetchContainedCredential(",
      "repository: Parameters<RepositoryCredentialProvider>[0];",
      "credentialProvider: RepositoryCredentialProvider;",
      "): ReturnType<RepositoryCredentialProvider> {",
      "return input.credentialProvider(input.repository);",
      "const fetchCredential = () => fetchContainedCredential({ ...options, rootPath, repository });",
      "credential: Awaited<ReturnType<RepositoryCredentialProvider>>;",
      "credential: Awaited<ReturnType<RepositoryCredentialProvider>>;",
      "credential: Awaited<ReturnType<RepositoryCredentialProvider>>;",
    ],
    // the provider's type, its factory, and the one request to the broker's /repository-credentials endpoint
    "repository-credentials.ts": [
      "export type RepositoryCredentialProvider = (",
      "export function createRepositoryCredentialProvider(input: {",
      "}): RepositoryCredentialProvider {",
      "const endpoint = `${base}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/repository-credentials`;",
    ],
    // the wrapper rememberCredentials fetches nothing of its own (its call of the wrapped provider is checked by the call list below)
    "saved-env/rebuild.ts": [
      "import type { RepositoryCredentialProvider } from \"../repository-credentials.js\";",
      "export function rememberCredentials(provider: RepositoryCredentialProvider): { provider: RepositoryCredentialProvider; values(): readonly string[] } {",
    ],
  };
    expect(credentialLines()).toEqual(PINNED);
  });

  it("lists every call of a repository credential provider in the worker: publish and maintain go through the cleanup, prepare is read-only", () => {
    expect(providerCalls()).toEqual([
      "prepare.ts: const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};",
      "prepare.ts: const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};",
      "publish.ts: return input.credentialProvider(input.repository);",
      "saved-env/rebuild.ts: const credential = await provider(repository);",
    ]);
  });

  it("publish and maintain take their push credential only through fetchContainedCredential, which runs the cleanup first", () => {
    const helper = readFileSync(join(SRC, "publish.ts"), "utf8");
    const body = helper.slice(helper.indexOf("export async function fetchContainedCredential"), helper.indexOf("export async function publishWorkspace"));
    expect(body.indexOf("await containWorkspace(")).toBeGreaterThan(-1);
    expect(body.indexOf("await containWorkspace(")).toBeLessThan(body.indexOf("input.credentialProvider(input.repository)"));
    expect(helper.match(/fetchContainedCredential\(/g)?.length).toBe(2); // the definition and publishWorkspace's fetchCredential
    expect(helper).toContain("const fetchCredential = () => fetchContainedCredential(");
    const maintain = readFileSync(join(SRC, "maintain-pull-request.ts"), "utf8");
    // The read of the head and the base (before the checks) and the push token (after them): both through the helper, no other token.
    expect(maintain.match(/fetchContainedCredential\(/g)?.length).toBe(2);
    expect(maintain.match(/await pushCredential\(\)/g)?.length).toBe(2);
    expect(maintain.indexOf("await runReadinessChecks(")).toBeLessThan(maintain.indexOf("await pushCredential()"));
    expect(maintain.lastIndexOf("await runReadinessChecks(")).toBeLessThan(maintain.lastIndexOf("await pushCredential()"));
    expect(maintain).not.toMatch(/options\.credentialProvider\(/);
    expect(maintain).not.toMatch(/if \(invocation\.payload\.workflow\w+ !== undefined[^)]*\) \{\s*await containWorkspace/);
  });

  it("the main process hands a push provider only to publish and maintain, and the preparation's own provider to prepare", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(main.match(/createRepositoryCredentialProvider\(/g)?.length).toBe(3);
    const prepare = main.slice(main.indexOf('invocation.kind === "prepare"'), main.indexOf('invocation.kind === "publish"'));
    expect(prepare).toContain("rememberCredentials(createRepositoryCredentialProvider(");
    const publish = main.slice(main.indexOf('invocation.kind === "publish"'), main.indexOf('invocation.kind === "maintain"'));
    expect(publish).toContain("credentialProvider: createRepositoryCredentialProvider(");
    expect(publish).toContain("publishWorkspace(");
    const maintain = main.slice(main.indexOf('invocation.kind === "maintain"'), main.indexOf('invocation.kind === "cancel"'));
    expect(maintain).toContain("maintainPullRequest(");
  });

  it("prepare asks for a read-only clone credential and every other invocation for a push credential", async () => {
    const accesses: string[] = [];
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { access: string };
      accesses.push(body.access);
      return new Response(JSON.stringify({ credential: { username: "x-access-token", password: "installation-token" } }), { status: 200 });
    });
    for (const kind of ["prepare", "publish", "maintain"] as const) {
      const invocation = { protocolVersion: 1, kind, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { project: project(), repositoryGrant: "signed.grant" } } as unknown as Extract<WorkerInvocation, { kind: "prepare" | "publish" | "maintain" }>;
      await createRepositoryCredentialProvider({ controlPlaneUrl: "https://agentx.example.test", invocation, fetchImplementation })(project().repositories[0]!);
    }
    // Prepare's token is contents:read of a repository the agent has not yet run in (the preparation is the first step of a workspace and runs before any agent turn), and it is never held while the project's own commands run,
    // so no cleanup is needed there; the push token is the one that needs it.
    expect(accesses).toEqual(["clone", "push", "push"]);
  });
});

function project(): ProjectDefinition {
  return {
    name: "demo", revision: 1, setup: [], readiness: [], allowedWebsites: [],
    repositories: [{ name: "demo", path: "repo/demo", url: "https://github.com/example/demo.git", defaultBranch: "main", credentialRef: "github-app" }],
  } as unknown as ProjectDefinition;
}
