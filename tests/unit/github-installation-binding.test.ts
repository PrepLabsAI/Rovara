import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = "2026-11-14T12:00:00.000Z";
const setup = () => {
  const db = new FakeDynamoDb();
  const store = new GithubInstallationBindings(db, "state", () => Date.parse(NOW));
  return { db, store };
};
const listed = (n: number) => Array.from({ length: n }, (_, i) => ({ installationId: i + 1, accountLogin: "shared-account" }));
const refusal = async (work: Promise<unknown>) => work.catch((error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
it("keeps old installations implicit until a complete, idempotent backfill", async () => {
  const { db, store } = setup();
  expect(await store.ownerOf(1)).toBe(IMPLICIT_COMPANY_ID);
  await expect(store.claim(A, 1, "shared-account", "operator")).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  expect(await store.backfill(async () => listed(2))).toEqual({ more: false });
  expect(await store.ownerOf(1)).toBe(IMPLICIT_COMPANY_ID);
  expect(await store.ownerOf(3)).toBeUndefined();
  const before = JSON.stringify([...db.items]);
  await store.backfill(async () => { throw new Error("must not relist after completion"); });
  expect(JSON.stringify([...db.items])).toBe(before);
});
it("has byte-identical fixed refusals for unknown, other company, unreadable and invalid inputs", async () => {
  const { db, store } = setup();
  await store.backfill(async () => []);
  await store.claim(A, 1, "shared-account", "operator");
  db.set({ pk: "GITHUB_INSTALLATION#2", sk: "BINDING", entityType: "broken", companyId: A, installationId: 2 });
  const answers = await Promise.all([store.requireBound(B, 1), store.requireBound(A, 3), store.requireBound(A, 2), store.requireBound("bad", 1), store.claim(B, 1, "shared-account", "operator")].map(refusal));
  for (const answer of answers) expect(answer).toEqual(answers[0]);
  expect(JSON.stringify(answers)).not.toMatch(/shared-account|org_|operator|installationId/);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "77", null, undefined]) {
    expect(await refusal(store.requireBound(A, id as number))).toEqual(answers[0]);
    expect(await refusal(store.ownerOf(id as number))).toEqual(answers[0]);
  }
});
it("makes same-company claims write-free and atomically refuses concurrent other-company claims", async () => {
  const { db, store } = setup();
  await store.backfill(async () => []);
  const results = await Promise.allSettled([store.claim(A, 1, "shared-account", "operator"), store.claim(B, 1, "shared-account", "operator")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const owner = await store.ownerOf(1);
  const before = JSON.stringify([...db.items]);
  await store.claim(owner!, 1, "other-account", "other-operator");
  expect(JSON.stringify([...db.items])).toBe(before);
});
it("refuses malformed stored metadata and storage failures without leaking causes", async () => {
  for (const changes of [{ companyId: "bad" }, { installationId: 2 }, { entityType: "bad" }, { accountLogin: null }, { boundAt: "bad" }, { boundBy: "" }]) {
    const { db, store } = setup();
    await store.claim(IMPLICIT_COMPANY_ID, 1, "shared-account", "operator");
    db.set({ ...db.get("GITHUB_INSTALLATION#1", "BINDING")!, ...changes });
    await expect(store.ownerOf(1)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  }
  const { db, store } = setup();
  db.injectFault({ command: "GetCommand", error: { name: "Failure", message: "private-canary" } });
  expect(JSON.stringify(await refusal(store.ownerOf(1)))).not.toContain("private-canary");
  db.set({ pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL", complete: "wrong" });
  await expect(store.ownerOf(1)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
});
it("handles 100 installations in bounded time, and reports truncation without opening claims", async () => {
  const { store } = setup();
  const started = performance.now();
  expect(await store.backfill(async () => listed(100))).toEqual({ more: false });
  expect(performance.now() - started).toBeLessThan(10_000);
  const other = setup();
  expect(await other.store.backfill(async () => listed(101))).toEqual({ more: true });
  expect(other.db.get("GITHUB_INSTALLATION_BINDING", "BACKFILL")).toBeUndefined();
  await expect(other.store.claim(A, 101, "shared-account", "operator")).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
});
it("validates the whole bounded input before writing and refuses duplicate ids", async () => {
  for (const input of [[...listed(1), { installationId: 2, accountLogin: null }], [listed(1)[0], listed(1)[0]], null, {}]) {
    const { db, store } = setup();
    await expect(store.backfill(async () => input as never)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(db.items.size).toBe(0);
  }
});
it("enforces a total elapsed budget without detached writers", async () => {
  const db = new FakeDynamoDb();
  let clock = Date.parse(NOW);
  const store = new GithubInstallationBindings(db, "state", () => clock);
  await expect(store.backfill(async () => { clock += 10_001; return listed(1); })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  expect(db.items.size).toBe(0);
});

import { generateKeyPairSync } from "node:crypto";
import { FakeHostModel } from "@agentx/broker/fakes";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubClientChecks, RecordingNetwork, TenantBinding, type GitHubClientWorld } from "../support/ports/github-client-conformance.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi } from "../support/ports/github-fixture-api.js";
const GITHUB_NOW = Date.parse(NOW);
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function githubModel() { return new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" }); }
function conformanceWorld(): GitHubClientWorld {
  const db = new FakeDynamoDb();
  const store = new GithubInstallationBindings(db, "state");
  const model = githubModel();
  const api = new GitHubFixtureApi(model);
  const net = new RecordingNetwork(api.fetch);
  const binding = new class extends TenantBinding {
    override refuse(_orgId: string): void {
      void _orgId;
      db.set({ ...db.get("GITHUB_INSTALLATION#77", "BINDING")!, companyId: B });
    }
  }();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetchImplementation: net.fetch,
    now: () => GITHUB_NOW, requireInstallationBound: async (org, id, repo) => { await binding.hook(org, id, repo); await store.requireBound(org, id, repo); },
  });
  return {
    client, net, binding, repositoryUrl: GITHUB_REPO_URL, strangerUrl: GITHUB_OTHER_URL, credentialRef: "github", scope: GITHUB_ORG_SCOPE, otherScope: { orgId: "org_bbbbbbbbbbbbbbbbbbbb" },
    installationId: 77, repositoryId: 4242,
    async prepare() {
      await store.backfill(async () => []);
      await store.claim(GITHUB_ORG_SCOPE.orgId, 77, "shared-account", "operator");
      const headSha = model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n", "src/big.txt": "x".repeat(4_000) });
      model.setAccount("priya", "write");
      const { cr } = model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a", draft: true });
      const comment = model.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
      let fresh = 100;
      return {
        number: Number(cr.id), headSha, commentId: comment.id, largeFile: "src/big.txt",
        freshBranch: () => { fresh += 1; const branch = `agentx/00000000-0000-4000-8000-${String(fresh).padStart(12, "0")}`; model.commit(branch, { [`src/${String(fresh)}.ts`]: "export const b = 1;\n" }); return branch; },
      };
    },
  };
}

for (const prefix of ["tenant: every call", "tenant: a refused binding"]) {
  it(`real binding store conformance: ${prefix}`, async () => {
    await githubClientChecks.find(check => check.name.startsWith(prefix))!.run(conformanceWorld());
  });
}

it("the legacy installation seam uses the existing cache and uninstalled refusal", async () => {
  const { GitHubAppCredentialProvider: LegacyProvider } = await import("../../packages/broker/src/github-app.js");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let calls = 0;
  const provider = new LegacyProvider({ credentialRef: "github", appId: "1", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetchImplementation: async (input) => { calls++; return (input instanceof Request ? input.url : input.toString()).includes("missing") ? new Response("", { status: 404 }) : Response.json({ id: 77, account: { login: "acme" } }); } });
  expect(await provider.installationIdFor("https://github.com/acme/app.git")).toBe(77);
  expect(await provider.installationIdFor("https://github.com/acme/app.git")).toBe(77);
  expect(calls).toBe(1);
  const unknown = await refusal(provider.installationIdFor("https://github.com/missing/app.git"));
  expect(unknown).toEqual(await refusal(provider.checkRepository({ credentialRef: "github", url: "https://github.com/missing/app.git" })));
});

it("bounds total bytes read, even when an otherwise valid binding has oversized extra fields", async () => {
  const { db, store } = setup();
  await store.claim(IMPLICIT_COMPANY_ID, 1, "shared-account", "operator");
  const client = { send: async () => ({ Item: { ...db.get("GITHUB_INSTALLATION#1", "BINDING")!, padding: "x".repeat(1_000_001) } }) };
  await expect(new GithubInstallationBindings(client, "state").ownerOf(1)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
});

it("filters whole runtime-validated lists within one total budget, preserving order", async () => {
  const module = await import("../../packages/broker/src/aws/github-credentials.js");
  const filter = (module as unknown as { filterInstallationsFor: (company: string, listed: unknown, bindings: unknown) => Promise<unknown> }).filterInstallationsFor;
  expect(filter).toBeTypeOf("function");
  const row = (id: number) => ({ installationId: id, accountLogin: "example", accountType: "Organization", repositorySelection: "all", status: "active", repositories: [{ fullName: "example/demo", githubRepositoryId: 42, private: true, defaultBranch: "main" }] });
  const db = new FakeDynamoDb(); const bindings = new module.GithubInstallationBindings(db, "state");
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const list = Array.from({ length: 100 }, (_, i) => ({ ...row(i + 1), repositories: Array.from({ length: 100 }, () => row(1).repositories[0]) }));
  expect(await filter(IMPLICIT_COMPANY_ID, list, bindings)).toEqual(list);
  for (const bad of [null, {}, [row(1), { ...row(2), status: "private-canary" }], [row(1), { ...row(2), repositories: null }], [row(1), row(1)], [...list, row(101)], [{ ...row(1), repositories: Array.from({ length: 101 }, () => row(1).repositories[0]) }], [{ ...row(1), installationId: 0 }], [{ ...row(1), accountLogin: "x".repeat(8_000_001) }]]) {
    await expect(filter(IMPLICIT_COMPANY_ID, bad, bindings)).rejects.toThrow(/^GITHUB_NOT_CONNECTED: the GitHub installation is not connected$/);
  }
  await expect(filter("private-canary", [row(1)], bindings)).rejects.toThrow(/^GITHUB_NOT_CONNECTED: the GitHub installation is not connected$/);
  await bindings.backfill(async () => []);
  expect(await filter(IMPLICIT_COMPANY_ID, [row(1)], bindings)).toEqual([]);
});

it("reads the shared marker once and applies a total deadline to list filtering", async () => {
  const { filterInstallationsFor } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { boundedCompanyReads } = await import("../../packages/broker/src/aws/company-check.js");
  const db = new FakeDynamoDb(); let markers = 0; let now = 0;
  const bindings = new GithubInstallationBindings({ send: async (command: unknown) => {
    const key = (command as { input: { Key?: { sk?: string } } }).input.Key;
    if (key?.sk === "BACKFILL") markers++;
    now += 200;
    return db.send(command as never);
  } }, "state");
  const rows = Array.from({ length: 100 }, (_, index) => ({ installationId: index + 1, accountLogin: "example", accountType: "Organization" as const, repositorySelection: "all" as const, status: "active" as const, repositories: [] }));
  expect(await filterInstallationsFor(IMPLICIT_COMPANY_ID, rows, bindings)).toHaveLength(100);
  expect(markers).toBe(1);
  const budget = boundedCompanyReads(db, () => now);
  await expect(filterInstallationsFor(IMPLICIT_COMPANY_ID, rows, bindings, budget)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
});

it("bounds aggregate list bytes even when each installation and repository is individually valid", async () => {
  const { filterInstallationsFor } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { store } = setup();
  const rows = Array.from({ length: 100 }, (_, index) => ({ installationId: index + 1, accountLogin: "example", accountType: "Organization" as const, repositorySelection: "all" as const, status: "active" as const,
    repositories: Array.from({ length: 100 }, () => ({ fullName: "r".repeat(201), githubRepositoryId: 42, private: true, defaultBranch: "b".repeat(256) })) }));
  await expect(filterInstallationsFor(IMPLICIT_COMPANY_ID, rows, store)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
});
