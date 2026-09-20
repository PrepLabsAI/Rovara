# Additive GitHub App Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing AgentX broker use the existing GitHub App for existing projects and the CharterArc Demo App for its explicitly assigned repository, without changing publication authority.

**Architecture:** Keep the existing GitHubAppCredentialProvider as the single-installation adapter. Add a validated, server-owned routing layer used by repository grants and all PR APIs. Keep the legacy path unchanged when no additional bindings are configured.

**Tech Stack:** Node 22.23.2, TypeScript, Zod, Vitest, AWS SDK v3, AWS CDK, GitHub App installation tokens.

**Spec:** `specs/004-charterarc-demo-onboarding/spec.md`, sections 1–2 and credential-related acceptance. The separate runtime/image/project-admission work in sections 3–4 is a following work package, not silently completed by this plan.

## Global Constraints

- Branch: `codex/charterarc-demo-setup`; base `925ad3859d502047c87df84cc2306523a65aed43`. No mainline merge or AWS deployment in this coding package.
- Objective MSDLC-OBJ-001@0.3; SHA-256 `bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843`.
- Keep legacy environment parameters valid. Additional registry absent/empty by default.
- New reference `github-charterarc-demo`; only `https://github.com/PrepLabsAI/charterarc-integration-demo.git`.
- App ID `5006456`; installation `163149623`; exact new secret ARN is deployment input, not a fabricated value.
- No fallback to the old app when the new app's scope or operation fails.
- Installation tokens remain repository/action scoped; PEM stays in the broker, not the worker.
- Preserve owner/membership/grant checks and all existing project/runtime resource identities.
- Candidate freeze and exact-approved publication remain issue #2; conversation continuity remains issue #1. This router alone fixes neither.

## Review Focus

1. Mixed-case and optional `.git` URLs must identify the same repository, not evade allowlists. Task 1 normalizes and tests aliases.
2. A wrong credential reference for an explicitly assigned repository must fail before any secret lookup. Task 2 tests zero provider calls.
3. PR read, update and reconciliation must route as consistently as clone/push. Task 2 tests all methods; Task 3 tests broker integration.
4. A rejected key lookup must not be cached forever or contaminate the other app. Task 2 tests retry and isolation.
5. Activating a binding must not replace the state table, bucket or existing runtime. Task 3 compares stable resources and reviews the deployment diff.

## Preflight and environment

Read the spec and repository constitution. Confirm the branch and a clean tracked tree. The owner has approved supporting both apps; the detailed execution plan still needs the writing-plans review gate. Use native execution in this session after that review; a new Codex task is unnecessary.

Local Node binary is installed from the producer archive with SHA-256
`61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`:

```sh
export PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH"
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test -- tests/contract/github-app.test.ts tests/contract/infrastructure.test.ts
```

Capture the baseline before changing runtime code. Never load AWS credentials or the actual PEM into unit tests.

### Task 1: Shared binding schema and canonical repository identity

**Files:**
- Create `packages/contracts/src/github-app-binding.ts`.
- Modify `packages/contracts/src/index.ts` to export it.
- Create `tests/contract/github-app-bindings.test.ts`.

**Interfaces:**
- Produces `GitHubAppBinding` with `credentialRef`, `account`, `appId`, `installationId`, `privateKeySecretArn`, `repositories: string[]`.
- Produces `canonicalGitHubRepository(value: string): string`, returning lowercase `https://github.com/owner/repo.git`.
- Produces `parseAdditionalGitHubAppBindings(value: unknown, legacyCredentialRef: string): GitHubAppBinding[]`.
- Both broker and CDK consume these definitions; no second permissive parser.

- [ ] Add table-driven failing tests. Use a synthetic secret ARN, never the actual PEM:

```ts
const binding = {
  credentialRef: "github-charterarc-demo", account: "PrepLabsAI",
  appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:charterarc/demo/github-app-private-key-AbCd12",
  repositories: ["https://github.com/PrepLabsAI/charterarc-integration-demo.git"],
};
it("normalizes aliases before detecting duplicate assignments", () => {
  expect(canonicalGitHubRepository("https://github.com/PrepLabsAI/charterarc-integration-demo"))
    .toBe("https://github.com/preplabsai/charterarc-integration-demo.git");
  expect(() => parseAdditionalGitHubAppBindings([
    binding, { ...binding, credentialRef: "another-app",
      repositories: ["https://github.com/preplabsai/charterarc-integration-demo"] },
  ], "github-agentx-sdlc")).toThrow();
});
it.each([
  { ...binding, appId: "0" },
  { ...binding, installationId: "NaN" },
  { ...binding, credentialRef: "github-agentx-sdlc" },
  { ...binding, repositories: [] },
  { ...binding, repositories: ["https://github.com/other/repo.git"] },
  { ...binding, repositories: ["https://token@github.com/PrepLabsAI/repo.git"] },
  { ...binding, repositories: ["https://github.com.evil.test/PrepLabsAI/repo.git"] },
  { ...binding, privateKeySecretArn: "*" },
])("rejects malformed or ambiguous binding", (bad) => {
  expect(() => parseAdditionalGitHubAppBindings([bad], "github-agentx-sdlc")).toThrow();
});
```

- [ ] Run `npm test -- tests/contract/github-app-bindings.test.ts`; require failure for the missing module, not an unrelated runner failure.
- [ ] Implement strict Zod fields and canonicalization. Reject userinfo, port, query, fragment, encoded path segments, empty/dot path segments, unsupported host/protocol, extra fields, repeated refs and repeated normalized repositories (including within one binding). Normalize before account matching. Accept only explicit Secrets Manager ARNs without `*` or `?`; messages must not echo configuration values. Wrap Zod/JSON errors in `agentXError("CONFIG_INVALID", "invalid GitHub App binding configuration")` rather than serializing raw input.

```ts
export interface GitHubAppBinding {
  credentialRef: string;
  account: string;
  appId: string;
  installationId: string;
  privateKeySecretArn: string;
  repositories: string[];
}
// The parser accepts already decoded JSON, never PEM text.
export function canonicalGitHubRepository(value: string): string {
  const url = new URL(value);
  const parts = url.pathname.split("/");
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
      url.port || url.username || url.password || url.search || url.hash ||
      parts.length !== 3 || parts[0] !== "" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[1] ?? "")) {
    throw agentXError("CONFIG_INVALID", "invalid GitHub repository identity");
  }
  const repo = (parts[2] ?? "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw agentXError("CONFIG_INVALID", "invalid GitHub repository identity");
  }
  return `https://github.com/${parts[1]!.toLowerCase()}/${repo.toLowerCase()}.git`;
}
```

The parser must reject raw dot-segment URLs before `new URL` normalizes them; add `https://github.com/x/../PrepLabsAI/repo` to the rejection cases. The snippet above is the canonicalization core, not a substitute for that raw-input test.
- [ ] Add valid-empty, valid-single, duplicate-ref, within-binding duplicate, malformed JSON boundary and error-redaction tests. Run the new file, `npm run build` and existing project contract tests.
- [ ] Commit only the task's files with `feat: validate additional GitHub App bindings`.

### Task 2: Route grants and all PR methods with isolated key caches

**Files:**
- Create `packages/broker/src/github-app-router.ts`.
- Create `tests/contract/github-app-router.test.ts`.
- Existing provider `packages/broker/src/github-app.ts` remains the installation adapter; change it only if a focused regression test justifies the change.

**Interfaces:**
- Consumes Task 1 bindings and the existing provider's `resolve`, `reconcilePullRequest`, `getPullRequest`, `updatePullRequest` methods.
- Produces `GitHubAppRouter`, with the same four public method signatures as `GitHubAppCredentialProvider`.
- Define `GitHubAppOperations = Pick<GitHubAppCredentialProvider, "resolve" | "reconcilePullRequest" | "getPullRequest" | "updatePullRequest">`. Constructor takes `{legacy: GitHubAppOperations, bindings: GitHubAppBinding[], createProvider: (binding: GitHubAppBinding) => GitHubAppOperations}`. Structural methods allow safe fake providers without class-private casts.
- Produces `cachedPrivateKeyLoader(load: () => Promise<string>): () => Promise<string>`; one instance per binding.

- [ ] Add failing tests using structural provider fakes (or real providers with mocked fetch). Pin these exact cases before implementation:

```ts
const demoUrl = "https://github.com/PrepLabsAI/charterarc-integration-demo.git";
const otherUrl = "https://github.com/PrepLabsAI/another-repository.git";
const binding = {
  credentialRef: "github-charterarc-demo", account: "PrepLabsAI",
  appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:charterarc/demo/github-app-private-key-AbCd12",
  repositories: [demoUrl],
};
const resolve = vi.fn().mockResolvedValue({ username: "x-access-token", password: "synthetic" });
const legacyResolve = vi.fn().mockResolvedValue({});
const additionalProvider = { resolve, reconcilePullRequest: vi.fn(),
  getPullRequest: vi.fn(), updatePullRequest: vi.fn() };
const legacy = { ...additionalProvider, resolve: legacyResolve };
const router = new GitHubAppRouter({ legacy, bindings: [binding],
  createProvider: () => additionalProvider });
await expect(router.resolve("wrong-ref", demoUrl, "clone")).rejects.toThrow();
expect(resolve).not.toHaveBeenCalled();
expect(legacyResolve).not.toHaveBeenCalled();
await router.resolve("github-charterarc-demo", demoUrl, "push");
expect(resolve).toHaveBeenCalledWith("github-charterarc-demo", demoUrl, "push");
await expect(router.resolve("github-charterarc-demo", otherUrl, "clone")).rejects.toThrow();
```

- [ ] Run `npm test -- tests/contract/github-app-router.test.ts` and observe the missing-router failure.
- [ ] Implement maps keyed by normalized repository and credentialRef. For explicitly assigned repos require the matching ref; for an additional ref require an assigned repo. For everything else delegate to the legacy provider to preserve existing public-repo behavior. For PR methods choose by trusted repository URL, otherwise legacy; never retry through another provider. Keep original URL when calling the provider so returned GitHub URL validation preserves existing owner casing.
- [ ] Implement the cache with rejection reset and a redacted failure:

```ts
export function cachedPrivateKeyLoader(load: () => Promise<string>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= Promise.resolve().then(load).catch(() => {
      pending = undefined;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App key could not be loaded");
    });
    return pending;
  };
}
```

- [ ] Add tests for concurrent same-key load once, retry after failure, independent other-key success, no fallback after HTTP/key failure, and all three PR methods selecting the new provider. Test absent bindings preserves legacy grant and PR calls. An unknown URL must not accidentally reach an additional app. Assert no error contains the synthetic secret sentinel.
- [ ] Run both new test files and `tests/contract/github-app.test.ts`; run `npm run build`.
- [ ] Commit `feat: route repository and PR operations across GitHub apps`.

### Task 3: Wire AWS broker and opt-in CDK settings; prove compatibility

**Files:**
- Modify `packages/broker/src/aws/broker.ts` (singleton construction only plus required imports).
- Modify `infra/lib/control-plane.ts` and `infra/bin/agentx.ts`.
- Modify `infra/package.json`, `infra/tsconfig.json`, and `package-lock.json` only to consume the shared contracts package correctly.
- Extend `tests/contract/infrastructure.test.ts` and create `tests/contract/github-app-aws-wiring.test.ts`.
- Add `specs/004-charterarc-demo-onboarding/credential-rollout.md`.

**Interfaces:**
- Environment `GITHUB_APP_ADDITIONAL_BINDINGS`: JSON array, absent by default.
- CDK `ControlPlaneStackProps extends StackProps` with `additionalGitHubApps?: GitHubAppBinding[]`.
- CDK context `agentxAdditionalGitHubApps`: decoded array or JSON string parsed and validated at entry, never a secret value.
- `createProvider` closes over one exact secret ARN and one isolated loader; `RepositoryGrantService` and `githubPullRequests` receive the same router.

- [ ] Add failing synthesis tests and compare protected resource definitions between default and additive stack configurations:

```ts
const app = new App();
const binding = {
  credentialRef: "github-charterarc-demo", account: "PrepLabsAI",
  appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:charterarc/demo/github-app-private-key-AbCd12",
  repositories: ["https://github.com/PrepLabsAI/charterarc-integration-demo.git"],
};
const base = Template.fromStack(new ControlPlaneStack(app, "Baseline"));
const extra = Template.fromStack(new ControlPlaneStack(app, "Additional", {
  additionalGitHubApps: [binding],
}));
expect(JSON.stringify(base.toJSON())).not.toContain("GITHUB_APP_ADDITIONAL_BINDINGS");
expect(JSON.stringify(extra.toJSON())).toContain(binding.privateKeySecretArn);
// Inspect every GetSecretValue statement: only the legacy Ref and binding ARN are allowed.
// Neither worker runtime nor dispatcher may gain access to the private key.
```

- [ ] Run the tests and observe the new property/wiring assertions fail.
- [ ] Preserve existing singleton parameters and logical IDs. Add optional broker environment only when configured. Cap the additional serialized registry at 2 KiB with a tested nonsecret error; because legacy values are deployment parameters, inspect the complete resolved environment before deployment rather than claiming synthesis proves the final 4-KiB limit. Add exact ARN GetSecretValue grants only to broker. Require new secret's account and region to match the explicit deployment environment; unsupported cross-account/KMS bindings fail rather than gaining broad grants.

```ts
if (additional.length > 0) {
  broker.addEnvironment("GITHUB_APP_ADDITIONAL_BINDINGS", JSON.stringify(additional));
  broker.addToRolePolicy(new iam.PolicyStatement({
    actions: ["secretsmanager:GetSecretValue"],
    resources: additional.map((binding) => binding.privateKeySecretArn),
  }));
}
```

- [ ] Wire the broker using `parseAdditionalGitHubAppBindings(JSON.parse(process.env.GITHUB_APP_ADDITIONAL_BINDINGS ?? "[]"), legacyRef)`. Catch malformed JSON with a stable error. Keep legacy provider and loader semantics when no additional config. An invalid registry must fail startup, not silently run legacy-only.
- [ ] Test the composition with injected Secrets Manager/fetch clients: clone and PR calls use the intended installation; wrong ref triggers no secret read; token-fetch failure does not load the other app's secret. Use existing broker handler tests to confirm server-side project/workspace authority remains required.
- [ ] Run `npm run build`, `npm run lint`, `npm test`, and `npm run infra:synth:demo`. Record all failures and compare to baseline; do not label unrelated failures green.
- [ ] Document deployment inputs, expected Lambda/IAM-only changes, exact source commit and artifact hashes, previous parameter retention, credential smoke checks and rollback. No live publication smoke test without naming the permitted candidate branch/action. Have the operator review the actual change set before applying it; reject state/runtime replacement.
- [ ] Commit `feat: wire optional multi-app credentials into AgentX broker infrastructure` and request whole-branch review. Push only the separate branch. Do not merge or deploy automatically.

## Delivery gates and follow-on work

| Gate | Required evidence | Not established by this gate |
|---|---|---|
| Local routing | Passing positive/negative contract and broker tests | AWS permission or private-clone success |
| Infrastructure review | Synthesized template and exact change set | Deployed behavior |
| Live credential activation | New secret receipt, deployed broker revision, both-app smoke checks | Complete candidate verification or safe publication |
| Team Tasks admission (next plan) | Separate pinned image/runtime, compatible tools, project registration and baseline | Independent CharterArc acceptance |

Sections 3–4 of the parent spec remain required. They need a separate runtime/project implementation plan with producer-verified toolchain pins and actual deployment inputs. Issues #1 and #2 can proceed independently on their own branches, with compatibility tests before combining.

## Postflight reporting

Report source commit/tree, test commands and results, exact changed resources, and whether any live deployment occurred. Keep executed-against objective v0.3 and the unchanged digest above. A successful credential routing test is not a completed Slack-to-reviewed-PR demo.
