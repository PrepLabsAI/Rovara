// Guided onboarding PR 3: the GitHub installation's life after connect, through the real developer dispatcher, the real binding store, the broker's webhook route and the
// real App client's mint check. Two companies throughout: A (acme, installation 101) and B (beta, installation 202).
import { createHmac, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentXError, GITHUB_DISCONNECTED_MESSAGE, ON_THE_WEBSITE_MESSAGE, orgProjectCatalogKey, type OrgId } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { CONNECTION_NOT_FOUND, DISCONNECT_OWNER_ONLY, DISCONNECT_UNAVAILABLE, githubInUseMessage } from "../../packages/broker/src/aws/github-connect-routes.js";
import { PROJECT_SCAN_MAX, repositoryUsesInstallation } from "../../packages/broker/src/aws/github-lifecycle.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
import { namedCompany, revisionKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64), OTHER = "e".repeat(64);
const SESSIONS: Record<string, string> = { [OWNER]: "s-owner", [ADMIN]: "s-admin", [MEMBER]: "s-member", [OTHER]: "s-other" };
const SECRET = ["fixture", "webhook", "only"].join("-");
const D1 = "550e8400-e29b-41d4-a716-446655440011";
const D2 = "550e8400-e29b-41d4-a716-446655440012";

function project(db: FakeDynamoDb, name: string, companyId: string | undefined, repositories: unknown[]) {
  // DEC 254zzz80: a named company's project lives in its own partition (its catalog and revisions); the built-in company's and an unstamped one in the install's.
  db.set(namedCompany(companyId) !== undefined ? { ...orgProjectCatalogKey(companyId as OrgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 2 } : { pk: "PROJECT_CATALOG", sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: 2 });
  db.set(companyProjectRow(companyId, name, 1, { repositories: [] }));
  db.set(companyProjectRow(companyId, name, 2, { repositories }));
}
const repo = (url: string, installationId?: number) => ({ name: "r", url, path: "r", defaultBranch: "main", credentialRef: "github-app", ...(installationId === undefined ? {} : { installationId }) });

async function world() {
  const db = new FakeDynamoDb({ seed: 11 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: OWNER, sid: "s-owner", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
  for (const [id, name] of [[OWNER, "Olive"], [ADMIN, "Ada"], [MEMBER, "Max"], [OTHER, "Bea"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  join(OWNER, A, "owner"); join(ADMIN, A, "admin"); join(MEMBER, A, "member"); join(OTHER, B, "owner");
  db.set({ pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" });
  const bindings = new GithubInstallationBindings(db, "State", () => NOW);
  expect(await bindings.claimPerson(A, { installationId: 101, accountLogin: "acme" }, OWNER, { accountType: "Organization" })).toBe("bound");
  expect(await bindings.claimPerson(B, { installationId: 202, accountLogin: "beta" }, OTHER)).toBe("bound");
  const logs: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      githubConnect: { bindings, log: (entry) => logs.push(entry),
        github: { appSlug: async () => "rovara-test", oauthClient: async () => undefined, userControlledInstallations: async () => { throw new Error("not in these tests"); } } },
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r" };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string) => { claims.sub = id; claims.sid = SESSIONS[id]; };
  const disconnect = (id: number | string) => call("DELETE", `/v1/dev/company/github/${id}`);
  const read = () => call("GET", "/v1/dev/company/github");
  return { db, bindings, logs, deps, claims, call, as, disconnect, read };
}
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const binding = (db: FakeDynamoDb, id: number) => db.get(`GITHUB_INSTALLATION#${id}`, "BINDING");

describe("the connections read", () => {
  it("shows each installation's status from GitHub's marks, only the company's own", async () => {
    const h = await world();
    let answer = await h.read();
    expect((answer.body["installations"] as unknown[])).toEqual([expect.objectContaining({ installationId: 101, accountLogin: "acme", status: "active", accountType: "Organization" })]);
    await h.bindings.markLifecycle(101, "suspend", D1);
    answer = await h.read();
    expect((answer.body["installations"] as Array<Record<string, unknown>>)[0]).toMatchObject({ installationId: 101, status: "suspended" });
    await h.bindings.markLifecycle(202, "deleted", D2);
    expect(JSON.stringify((await h.read()).body)).not.toMatch(/beta|"installationId":202/);
    h.as(OTHER);
    expect((await h.read()).body["installations"]).toEqual([expect.objectContaining({ installationId: 202, status: "uninstalled" })]);
  });
});

describe("disconnect", () => {
  it("a User installation's page is the person's own settings", async () => {
    const h = await world(); h.as(OTHER);
    expect((await h.disconnect(202)).body["uninstallUrl"]).toBe("https://github.com/settings/installations/202");
  });
  it("owner DEC 254zzz99: the owner's CLI (or AI-tool) token, with no web-app client, is refused with the website words; nothing changes", async () => {
    const h = await world();
    // The Rovara CLI's own token: no client (azp), the developer audience, and a session no client started.
    const cli = (id: string) => {
      h.as(id); delete h.claims.azp; Object.assign(h.claims, { iss: "https://signin.example.test", aud: "agentx-developer" });
      h.db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
    };
    cli(OWNER);
    expect(await h.disconnect(101)).toEqual(refusal(403, "FORBIDDEN", ON_THE_WEBSITE_MESSAGE));
    expect(binding(h.db, 101)).toMatchObject({ companyId: A });
    // An admin's CLI token is refused for the role first (the owner rule comes before the website rule).
    cli(ADMIN);
    expect(await h.disconnect(101)).toEqual(refusal(403, "FORBIDDEN", DISCONNECT_OWNER_ONLY));
    expect(binding(h.db, 101)).toBeDefined();
  });
  it("another company's installation, an unknown one and a malformed id get the same 404, and change nothing", async () => {
    const h = await world();
    const before = JSON.stringify([...h.db.items]);
    const answers = [await h.disconnect(202), await h.disconnect(999), await h.disconnect("0"), await h.disconnect("12abc"), await h.disconnect("9".repeat(20))];
    for (const answer of answers) expect(answer).toEqual(refusal(404, "NOT_FOUND", CONNECTION_NOT_FOUND));
    expect(JSON.stringify([...h.db.items])).toBe(before);
  });
  it("is refused while projects of the company use a repository on it, naming only those projects", async () => {
    const h = await world();
    project(h.db, "web", A, [repo("https://github.com/acme/web", 101)]);
    project(h.db, "api", A, [repo("https://github.com/other/thing"), repo("https://github.com/Acme/api")]);
    project(h.db, "docs", A, [repo("https://github.com/acme/docs", 777)]);
    project(h.db, "beta-secret", B, [repo("https://github.com/acme/web", 101)]);
    project(h.db, "legacy", undefined, [repo("https://github.com/acme/legacy", 101)]);
    const answer = await h.disconnect(101);
    expect(answer).toEqual(refusal(409, "GITHUB_IN_USE", githubInUseMessage(["api", "web"])));
    expect(JSON.stringify(answer)).not.toMatch(/beta-secret|legacy|docs/);
    expect(binding(h.db, 101)).toBeDefined();
  });
  it("an unreadable project counts as using it; too many projects to check refuses", async () => {
    const h = await world();
    project(h.db, "odd", A, [repo("https://github.com/acme/x")]);
    h.db.set({ ...h.db.get(revisionKeyFor(A, "odd", 2).pk, "REV#000000000002")!, definition: { name: "odd", revision: 2 } });
    expect((await h.disconnect(101)).status).toBe(409);
    // Arch rule 9: a catalogue that names a revision row that is not there counts as using it too (the refusal of the unreadable current revision is caught here and counted, never an error and never the older revision's answer).
    const dangling = await world();
    project(dangling.db, "gone", A, [repo("https://github.com/acme/other")]);
    dangling.db.set({ ...orgProjectCatalogKey(A, "gone"), entityType: "PROJECT_CATALOG", latestRevision: 9 });
    const refused = await dangling.disconnect(101);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("gone");
    const many = await world();
    for (let i = 0; i <= PROJECT_SCAN_MAX; i++) many.db.set({ ...orgProjectCatalogKey(A, `p${i}`), entityType: "PROJECT_CATALOG", latestRevision: 1 });
    expect(await many.disconnect(101)).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE));
    expect(binding(many.db, 101)).toBeDefined();
  });
  it("unpinned repositories of an account the company also reaches through another active installation do not block the old one", async () => {
    const h = await world();
    await h.bindings.markLifecycle(101, "deleted", D1);
    expect(await h.bindings.claimPerson(A, { installationId: 103, accountLogin: "acme" }, OWNER)).toBe("bound");
    project(h.db, "web", A, [repo("https://github.com/acme/web")]);
    expect((await h.disconnect(101)).status).toBe(200);
    expect((await h.disconnect(103)).status).toBe(409);
  });
  it("repository matching: pins decide; other code hosts never count; unreadable entries do", () => {
    const install = { installationId: 101, accountLogin: "acme" };
    expect(repositoryUsesInstallation(repo("https://github.com/acme/a", 101), install)).toBe(true);
    expect(repositoryUsesInstallation(repo("https://github.com/acme/a", 102), install)).toBe(false);
    expect(repositoryUsesInstallation({ ...repo("https://github.com/x/a"), host: { kind: "github", installationId: 101 } }, install)).toBe(true);
    expect(repositoryUsesInstallation({ ...repo("https://gitlab.com/acme/a"), host: { kind: "gitlab", ref: "x" } }, install)).toBe(false);
    expect(repositoryUsesInstallation({ ...repo("https://github.com/acme/a"), host: { kind: "github-company", provider: "github" } }, install)).toBe(true);
    expect(repositoryUsesInstallation(repo("https://github.com/other/a"), install)).toBe(false);
    for (const bad of [null, "x", [], { url: 7 }, { url: "not a url" }, { url: "https://github.com/acme/a", host: "github" }]) expect(repositoryUsesInstallation(bad, install)).toBe(true);
  });
  it("is unknown for any other method on an installation's path, and for any path below it", async () => {
    const h = await world();
    for (const [method, path] of [["GET", "/v1/dev/company/github/101"], ["POST", "/v1/dev/company/github/101"], ["DELETE", "/v1/dev/company/github/101/x"], ["DELETE", "/v1/dev/company/github/connect"]] as const) {
      expect((await h.call(method, path)).status).toBe(404);
    }
    expect(binding(h.db, 101)).toBeDefined();
  });
});

function webhook(db: FakeDynamoDb, bindings: GithubInstallationBindings) {
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings, githubWebhookSecret: async () => SECRET } });
  return (body: Record<string, unknown>, options: { delivery?: string; secret?: string; signature?: string | null; event?: string } = {}) => {
    const raw = JSON.stringify(body);
    const signature = options.signature === undefined ? `sha256=${createHmac("sha256", options.secret ?? SECRET).update(raw).digest("hex")}` : options.signature;
    return handler({ rawPath: "/v1/github/webhooks", body: raw,
      headers: { "x-github-delivery": options.delivery ?? D1, "x-github-event": options.event ?? "installation", ...(signature === null ? {} : { "x-hub-signature-256": signature }) },
      requestContext: { requestId: "r", http: { method: "POST" } } });
  };
}

describe("GitHub's installation webhook", () => {
  it("a signed deleted/suspend/unsuspend marks only that installation's binding; A's rows are untouched by B's events", async () => {
    const h = await world();
    const send = webhook(h.db, h.bindings);
    const aRows = () => JSON.stringify(h.db.find((item) => JSON.stringify(item).includes(A)));
    const before = aRows();
    expect((await send({ action: "suspend", installation: { id: 202, account: { login: "beta" } }, sender: { login: "bea" } }, { delivery: D1 })).statusCode).toBe(200);
    expect(binding(h.db, 202)).toMatchObject({ state: "suspended" });
    expect((await send({ action: "deleted", installation: { id: 202, account: { login: "beta" } }, sender: { login: "bea" } }, { delivery: D2 })).statusCode).toBe(200);
    expect(binding(h.db, 202)).toMatchObject({ state: "uninstalled", companyId: B });
    expect(aRows()).toBe(before);
    // An unsuspend never brings an uninstalled binding back; neither does "created".
    expect((await send({ action: "unsuspend", installation: { id: 202, account: { login: "beta" } }, sender: { login: "bea" } }, { delivery: "550e8400-e29b-41d4-a716-446655440013" })).statusCode).toBe(200);
    expect((await send({ action: "created", installation: { id: 202, account: { login: "beta" } }, sender: { login: "bea" } }, { delivery: "550e8400-e29b-41d4-a716-446655440014" })).statusCode).toBe(200);
    expect(binding(h.db, 202)).toMatchObject({ state: "uninstalled" });
  });
  it("an unsigned, forged or wrongly signed event changes nothing", async () => {
    const h = await world();
    const send = webhook(h.db, h.bindings);
    const before = JSON.stringify([...h.db.items]);
    for (const options of [{ signature: null }, { signature: "sha256=" + "0".repeat(64) }, { secret: "another-secret" }, { signature: "sha1=abc" }]) {
      const answer = await send({ action: "deleted", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" } }, options);
      expect(answer.statusCode).toBe(403);
    }
    // A body changed after signing.
    const { handler } = createBroker({ extra: { documentClient: h.db, githubBindings: h.bindings, githubWebhookSecret: async () => SECRET } });
    const signed = JSON.stringify({ action: "suspend", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" } });
    const forged = JSON.stringify({ action: "deleted", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" } });
    const answer = await handler({ rawPath: "/v1/github/webhooks", body: forged, headers: { "x-github-delivery": D1, "x-github-event": "installation", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(signed).digest("hex")}` },
      requestContext: { requestId: "r", http: { method: "POST" } } });
    expect(answer.statusCode).toBe(403);
    expect(JSON.stringify([...h.db.items])).toBe(before);
  });
  it("a body GitHub signed for another event, resent under the installation header, changes nothing; so does one naming another account", async () => {
    const h = await world();
    const send = webhook(h.db, h.bindings);
    const before = JSON.stringify([...h.db.items]);
    const comment = { action: "deleted", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" }, comment: { id: 1 }, issue: { number: 1 }, repository: { id: 42 } };
    expect((await send(comment)).statusCode).toBe(202);
    expect((await send({ action: "deleted", installation: { id: 101 }, sender: { login: "olive" } })).statusCode).toBe(202);
    expect((await send({ action: "deleted", installation: { id: 101, account: { login: "mallory" } }, sender: { login: "olive" } })).statusCode).toBe(200);
    expect(JSON.stringify([...h.db.items])).toBe(before);
  });
  it("a malformed payload or delivery id is refused; a storage fault is retryable (503) and marks nothing", async () => {
    const h = await world();
    const send = webhook(h.db, h.bindings);
    expect((await send({ action: "deleted" })).statusCode).toBe(202);
    expect((await send({ action: "deleted", installation: { id: "101" } })).statusCode).toBe(202);
    expect((await send({ action: "deleted", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" } }, { delivery: "nope" })).statusCode).toBe(403);
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError", message: "private-canary" } });
    const answer = await send({ action: "deleted", installation: { id: 101, account: { login: "acme" } }, sender: { login: "olive" } });
    expect(answer.statusCode).toBe(503);
    expect(answer.body).not.toContain("private-canary");
    expect(binding(h.db, 101)).not.toHaveProperty("state");
  });
});

describe("tasks stop cleanly", () => {
  function client(bindings: GithubInstallationBindings, github: { uninstalled: boolean }, withDisconnected = true) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.github.com/repos/acme/web/installation") {
        return github.uninstalled ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) : new Response(JSON.stringify({ id: 101, account: { login: "acme" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });
    const app = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "4242", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      requireInstallationBound: bindings.requireBound, ...(withDisconnected ? { disconnectedFor: (orgId: string, owner: string) => bindings.disconnectedFor(orgId, owner) } : {}), fetchImplementation: fetch, now: () => NOW });
    return { app, fetch };
  }
  const mint = (app: GitHubAppCredentialProvider, orgId: typeof A) => app.createAgentInstallationToken("https://github.com/acme/web", { contents: "read" }, { orgId })
    .then(() => "minted", (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
  const DISCONNECTED = { code: "GITHUB_NOT_CONNECTED", message: `GITHUB_NOT_CONNECTED: ${GITHUB_DISCONNECTED_MESSAGE}` };
  it("a suspended installation: the fixed sentence before any token is asked for", async () => {
    const h = await world();
    await h.bindings.markLifecycle(101, "suspend", D1);
    const { app, fetch } = client(h.bindings, { uninstalled: false });
    expect(await mint(app, A)).toEqual(DISCONNECTED);
    expect(fetch.mock.calls.some(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes("/access_tokens"))).toBe(false);
    // Company B asking for A's repository learns nothing of A's state.
    const other = await mint(app, B);
    expect(other).not.toEqual(DISCONNECTED);
    expect(JSON.stringify(other)).not.toContain("Reconnect");
  });
  it("an uninstalled installation (GitHub no longer finds the App): the fixed sentence, not the install hint; not for another company", async () => {
    const h = await world();
    await h.bindings.markLifecycle(101, "deleted", D1);
    const { app } = client(h.bindings, { uninstalled: true });
    expect(await mint(app, A)).toEqual(DISCONNECTED);
    const other = await mint(app, B);
    expect(other).toEqual({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: the GitHub App cannot access acme/web; install it on acme with access to that repository" });
    // Without the hook (a single-company install), the refusal is as before.
    const plain = client(h.bindings, { uninstalled: true }, false);
    expect(await mint(plain.app, A)).toEqual(other);
  });
  it("the worker's repository credentials say the same (the broker's grant exchange), suspended or uninstalled; never for another company", async () => {
    const { RepositoryGrantService } = await import("../../packages/broker/src/repository-access.js");
    const workspaceId = "550e8400-e29b-41d4-a716-446655440010";
    const operationId = "550e8400-e29b-41d4-a716-446655440011";
    const ISO = new Date(NOW).toISOString();
    for (const [mark, lookup] of [["suspend", "found"], ["deleted", "gone"]] as const) {
      const h = await world();
      await h.bindings.markLifecycle(101, mark, D1);
      let minted = 0;
      const grants = new RepositoryGrantService(Buffer.alloc(32, 1), async () => { minted++; return { username: "fixture" }; });
      const repository = { credentialRef: "github", repositoryUrl: "https://github.com/acme/web.git", access: "clone" as const };
      const grant = grants.issue({ ownerKey: "owner".repeat(8), projectName: "web", workspaceId, operationId, repositories: [repository] });
      const installationIdFor = async () => { if (lookup === "gone") throw new AgentXError("CONFIG_INVALID", "the GitHub App cannot access acme/web", 400); return 101; };
      const { handler } = createBroker({ extra: { documentClient: h.db, githubBindings: h.bindings, repositoryGrants: grants, githubPullRequests: { installationIdFor } } });
      h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey: "owner".repeat(8), projectName: "web", projectRevision: 1,
        environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: ISO, updatedAt: ISO });
      h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, id: operationId, workspaceId, kind: "prepare" });
      const seed = (companyId: string) => h.db.set({ pk: "PROJECT#web", sk: "REV#000000000001", companyId, definition: { name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", credentialRef: "github" }] } });
      const invoke = () => handler({ rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/repository-credentials`, body: JSON.stringify(repository),
        headers: { "x-agentx-repository-grant": grant }, requestContext: { requestId: "mint", http: { method: "POST" } } });
      seed(A);
      expect((JSON.parse((await invoke()).body) as { error: unknown }).error).toEqual({ code: "GITHUB_NOT_CONNECTED", message: GITHUB_DISCONNECTED_MESSAGE });
      seed(B);
      expect((JSON.parse((await invoke()).body) as { error: unknown }).error).toEqual({ code: "GITHUB_NOT_CONNECTED", message: "the GitHub installation is not connected" });
      expect(minted).toBe(0);
    }
  });
});
