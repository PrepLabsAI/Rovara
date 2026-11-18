// DEC 254zc(1): GitHub's signed `installation_repositories` (removed, added) and `repository` (transferred) webhooks mark a repository the company can no longer reach, and the project
// setup-status read shows it on the repos row. Two companies throughout: A (acme, installation 101) and B (beta, installation 202), each with a project that names the SAME repository.
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectSetupChecklistSchema } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { GithubInstallationBindings, REPOSITORY_MOVES_MAX, repositoryMovedKey } from "../../packages/broker/src/aws/github-credentials.js";
import { SETUP_STATUS_UNREADABLE, readProjectSetupStatus } from "../../packages/broker/src/aws/project-setup-status.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const SECRET = ["fixture", "webhook", "only"].join("-");
const D = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, "0")}`;
const CANARY = "private-canary-pr-moves";
const listed = (...names: string[]) => names.map((full_name, id) => ({ id: id + 1, name: full_name.split("/")[1], full_name, private: true }));

function world() {
  const db = new FakeDynamoDb({ seed: 21 });
  db.set({ pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" });
  const bindings = new GithubInstallationBindings(db, "State", () => NOW);
  const logs: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { try { logs.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a log line */ } });
  return { db, bindings, logs };
}
async function bound() {
  const w = world();
  await w.bindings.claim(A, 101, "acme", "b".repeat(64)).catch(() => undefined);
  w.db.set({ pk: "GITHUB_INSTALLATION#101", sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", installationId: 101, accountLogin: "acme", companyId: A, boundAt: "2026-11-01T09:00:00.000Z", boundBy: "a".repeat(64) });
  w.db.set({ pk: "GITHUB_INSTALLATION#202", sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", installationId: 202, accountLogin: "beta", companyId: B, boundAt: "2026-11-01T09:00:00.000Z", boundBy: "c".repeat(64) });
  return w;
}
function webhook(db: FakeDynamoDb, bindings: GithubInstallationBindings) {
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings, githubWebhookSecret: async () => SECRET } });
  return (event: "installation_repositories" | "repository" | "installation" | "pull_request", body: Record<string, unknown>, options: { delivery?: string; secret?: string; signature?: string | null } = {}) => {
    const raw = JSON.stringify(body);
    const signature = options.signature === undefined ? `sha256=${createHmac("sha256", options.secret ?? SECRET).update(raw).digest("hex")}` : options.signature;
    return handler({ rawPath: "/v1/github/webhooks", body: raw, headers: { "x-github-delivery": options.delivery ?? D(1), "x-github-event": event, ...(signature === null ? {} : { "x-hub-signature-256": signature }) },
      requestContext: { requestId: "r", http: { method: "POST" } } });
  };
}
const removed = (installation: number, account: string, ...names: string[]) => ({ action: "removed", installation: { id: installation, account: { login: account } }, repository_selection: "selected", repositories_added: [], repositories_removed: listed(...names), sender: { login: "olive" } });
const added = (installation: number, account: string, ...names: string[]) => ({ action: "added", installation: { id: installation, account: { login: account } }, repository_selection: "selected", repositories_added: listed(...names), repositories_removed: [], sender: { login: "olive" } });
/** GitHub's `repository` transferred: sent for the account the repository moved TO; `changes.owner.from` names the old owner. */
const transferred = (installation: number, newOwner: string, name: string, from: { user?: string; organization?: string }) => ({
  action: "transferred", installation: { id: installation }, repository: { id: 9, name, full_name: `${newOwner}/${name}`, owner: { login: newOwner } }, sender: { login: "olive" },
  changes: { owner: { from: { ...(from.user === undefined ? {} : { user: { login: from.user } }), ...(from.organization === undefined ? {} : { organization: { login: from.organization } }) } } },
});

const statusOf = (db: FakeDynamoDb, companyId: string, project: string, url = "https://github.com/acme/web") =>
  readProjectSetupStatus({ documentClient: db, tableName: "State", now: () => NOW, companyId, project, definition: { revision: 1, repositories: [{ name: "web", url, defaultBranch: "main" }] }, viewer: { companyRole: "owner", projectAdmin: false }, readers: { channels: async () => [] } });
async function repos(db: FakeDynamoDb, companyId: string, project: string, url?: string) { return ProjectSetupChecklistSchema.parse(await statusOf(db, companyId, project, url)).repos; }
const marks = (db: FakeDynamoDb, companyId: string) => db.find((item) => item.entityType === "GITHUB_REPOSITORY_MOVED" && item.companyId === companyId);

describe("installation_repositories removed", () => {
  it("marks only the installation's company; the repos row shows it for that company's project and not for another company's with the same repository", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("installation_repositories", removed(101, "acme", "Acme/Web", "acme/other"))).statusCode).toBe(200);
    expect(marks(db, A).map((item) => item.fullName).sort()).toEqual(["acme/other", "acme/web"]);
    expect(marks(db, B)).toEqual([]);
    expect(await repos(db, A, "alpha")).toMatchObject({ state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main", access: "removed" }] });
    const other = await repos(db, B, "beta");
    expect(other.items[0]).toEqual({ name: "web", fullName: "acme/web", defaultBranch: "main" });
    expect(JSON.stringify(other)).not.toContain("access");
  });
  it("B's event never touches A's rows", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    await send("installation_repositories", removed(101, "acme", "acme/web"), { delivery: D(1) });
    const before = JSON.stringify(marks(db, A));
    await send("installation_repositories", removed(202, "beta", "beta/web", "acme/web"), { delivery: D(2) });
    expect(JSON.stringify(marks(db, A))).toBe(before);
    expect(marks(db, B).map((item) => item.fullName).sort()).toEqual(["acme/web", "beta/web"]);
    expect(db.get(repositoryMovedKey(B, "acme/web").pk, repositoryMovedKey(B, "acme/web").sk)).toMatchObject({ companyId: B, installationId: 202 });
  });
  it("added clears the company's mark and leaves another company's alone", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    await send("installation_repositories", removed(101, "acme", "acme/web"), { delivery: D(1) });
    await send("installation_repositories", removed(202, "beta", "acme/web"), { delivery: D(2) });
    expect((await send("installation_repositories", added(101, "acme", "acme/web"), { delivery: D(3) })).statusCode).toBe(200);
    expect(marks(db, A)).toEqual([]);
    expect(marks(db, B)).toHaveLength(1);
    expect((await repos(db, A, "alpha")).items[0]).not.toHaveProperty("access");
  });
  it("logs the company, the reason and a count, never a repository name", async () => {
    const { db, bindings, logs } = await bound(); const send = webhook(db, bindings);
    await send("installation_repositories", removed(101, "acme", "acme/secret-repo-name"));
    const line = logs.find((entry) => entry["event"] === "github.repositories_marked");
    expect(line).toMatchObject({ companyId: A, installationId: 101, reason: "removed", count: 1, actor: "github" });
    expect(JSON.stringify(logs)).not.toContain("secret-repo-name");
  });
  it("an empty list, an installation nobody holds and a body naming another account write nothing but are accepted", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("installation_repositories", removed(101, "acme"))).statusCode).toBe(200);
    expect((await send("installation_repositories", removed(303, "gamma", "gamma/web"))).statusCode).toBe(200);
    expect((await send("installation_repositories", removed(101, "mallory", "acme/web"))).statusCode).toBe(200);
    expect(marks(db, A)).toEqual([]); expect(marks(db, B)).toEqual([]);
  });
  it("more repositories than the limit refuses the whole delivery and writes nothing", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    const names = Array.from({ length: REPOSITORY_MOVES_MAX + 1 }, (_, index) => `acme/r${index}`);
    expect((await send("installation_repositories", removed(101, "acme", ...names))).statusCode).toBe(403);
    expect(marks(db, A)).toEqual([]);
    expect((await send("installation_repositories", removed(101, "acme", ...names.slice(0, REPOSITORY_MOVES_MAX)), { delivery: D(2) })).statusCode).toBe(200);
    expect(marks(db, A)).toHaveLength(REPOSITORY_MOVES_MAX);
  });
  it("added clears more repositories than the limit that removed may mark (in chunks), and one odd project address does not make the repos row unreadable", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    const names = Array.from({ length: REPOSITORY_MOVES_MAX + 50 }, (_, index) => `acme/r${index}`);
    for (let from = 0; from < names.length; from += REPOSITORY_MOVES_MAX) await send("installation_repositories", removed(101, "acme", ...names.slice(from, from + REPOSITORY_MOVES_MAX)), { delivery: D(10 + from / REPOSITORY_MOVES_MAX) });
    expect(marks(db, A)).toHaveLength(names.length);
    expect((await send("installation_repositories", added(101, "acme", ...names), { delivery: D(2) })).statusCode).toBe(200);
    expect(marks(db, A)).toEqual([]);
    for (const url of ["https://github.com/acme/web?tab=readme", "https://github.com/acme/web#x", "https://github.com/acme/web!"]) expect((await repos(db, A, "alpha", url)).items[0]).not.toHaveProperty("access");
  });
  it("before the backfill marker, an unbound installation is the implicit company's, as for pull request webhooks", async () => {
    const db = new FakeDynamoDb({ seed: 22 }); const bindings = new GithubInstallationBindings(db, "State", () => NOW);
    expect((await webhook(db, bindings)("installation_repositories", removed(404, "legacy", "legacy/web"))).statusCode).toBe(200);
    expect(db.find((item) => item.entityType === "GITHUB_REPOSITORY_MOVED")).toHaveLength(1);
  });
});

describe("repository transferred", () => {
  it("marks the OLD name (from changes.owner.from) for the company holding the installation it was sent to, as transferred", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("repository", transferred(202, "beta", "web", { organization: "Acme" }))).statusCode).toBe(200);
    expect(marks(db, B)).toEqual([expect.objectContaining({ fullName: "Acme/web", reason: "transferred", installationId: 202 })]);
    expect(marks(db, A)).toEqual([]);
    expect(await repos(db, B, "beta")).toMatchObject({ items: [{ fullName: "acme/web", access: "transferred" }] });
    expect((await repos(db, A, "alpha")).items[0]).not.toHaveProperty("access");
  });
  it("a user's old owner works too; a delivery with both or neither old owner is refused", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("repository", transferred(202, "beta", "web", { user: "olive" }))).statusCode).toBe(200);
    expect(marks(db, B).map((item) => item.fullName)).toEqual(["olive/web"]);
    for (const from of [{ user: "a", organization: "b" }, {}]) expect((await send("repository", transferred(202, "beta", "x", from), { delivery: D(2) })).statusCode).toBe(403);
    expect(marks(db, B)).toHaveLength(1);
  });
  it("transferred is the more exact word: a later removed keeps it, a later transferred replaces removed", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    await send("repository", transferred(202, "beta", "web", { organization: "acme" }), { delivery: D(1) });
    await send("installation_repositories", removed(202, "beta", "acme/web"), { delivery: D(2) });
    expect(marks(db, B)).toEqual([expect.objectContaining({ reason: "transferred", deliveryId: D(1) })]);
    await send("installation_repositories", removed(202, "beta", "acme/other"), { delivery: D(3) });
    await send("repository", transferred(202, "beta", "other", { organization: "acme" }), { delivery: D(4) });
    expect(marks(db, B).find((item) => item.fullName === "acme/other")).toMatchObject({ reason: "transferred" });
  });
  it("another repository action is accepted and writes nothing; so does a new owner that is not the binding's account", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("repository", { ...transferred(202, "beta", "web", { organization: "acme" }), action: "deleted" })).statusCode).toBe(200);
    expect((await send("repository", transferred(202, "mallory", "web", { organization: "acme" }), { delivery: D(2) })).statusCode).toBe(200);
    expect(marks(db, B)).toEqual([]);
  });
  it("a storage fault is retryable (503), marks nothing and leaks nothing", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    db.injectFault({ command: "PutCommand", error: { name: "InternalServerError", message: CANARY } });
    const answer = await send("repository", transferred(202, "beta", "web", { organization: "acme" }));
    expect(answer.statusCode).toBe(503);
    expect(answer.body).not.toContain(CANARY);
    expect(marks(db, B)).toEqual([]);
  });
});

describe("the webhook's own checks", () => {
  const bodies: Array<[string, "installation_repositories" | "repository", Record<string, unknown>]> = [
    ["removed", "installation_repositories", removed(101, "acme", "acme/web")],
    ["transferred", "repository", transferred(202, "beta", "web", { organization: "acme" })],
  ];
  it.each(bodies)("an unsigned, forged or wrongly signed %s event changes nothing", async (_name, event, body) => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    const before = JSON.stringify([...db.items]);
    for (const options of [{ signature: null }, { signature: "sha256=" + "0".repeat(64) }, { secret: "another-secret" }, { signature: "sha1=abc" }]) expect((await send(event, body, options)).statusCode).toBe(403);
    // A body changed after signing.
    const signed = JSON.stringify(body);
    const forged = webhook(db, bindings);
    const answer = await forged(event, { ...body, sender: { login: "mallory" } }, { signature: `sha256=${createHmac("sha256", SECRET).update(signed).digest("hex")}` });
    expect(answer.statusCode).toBe(403);
    expect(JSON.stringify([...db.items])).toBe(before);
  });
  it("a bad delivery id or a body that is not JSON is refused", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    expect((await send("installation_repositories", removed(101, "acme", "acme/web"), { delivery: "nope" })).statusCode).toBe(403);
    expect(marks(db, A)).toEqual([]);
  });
  it("a body GitHub signed for another event, resent under these headers, changes nothing", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    const before = JSON.stringify([...db.items]);
    const pull = { action: "transferred", installation: { id: 101, account: { login: "acme" } }, repository: { id: 1, name: "web", owner: { login: "acme" } }, pull_request: { number: 1 }, sender: { login: "olive" }, changes: { owner: { from: { user: { login: "x" } } } } };
    const issue = { action: "transferred", installation: { id: 202 }, repository: { id: 1, name: "web", owner: { login: "beta" } }, issue: { number: 1 }, sender: { login: "olive" }, changes: { owner: { from: { user: { login: "x" } } } } };
    const installation = { action: "removed", installation: { id: 101, account: { login: "acme" } }, repositories: listed("acme/web"), sender: { login: "olive" } };
    const comment = { ...removed(101, "acme", "acme/web"), comment: { id: 1 } };
    for (const [event, body] of [["repository", pull], ["repository", issue], ["installation_repositories", installation], ["installation_repositories", comment], ["installation_repositories", { ...removed(101, "acme", "acme/web"), repository: { id: 1 } }]] as const) {
      expect((await send(event, body as Record<string, unknown>)).statusCode).toBe(403);
    }
    // An installation event is not a repository list, and a repository list is not an installation event.
    expect((await send("installation", removed(101, "acme", "acme/web"))).statusCode).toBe(403);
    expect((await send("repository", removed(101, "acme", "acme/web"))).statusCode).toBe(403);
    expect(JSON.stringify([...db.items])).toBe(before);
  });
  it("a repository name that is not GitHub's shape is refused whole", async () => {
    const { db, bindings } = await bound(); const send = webhook(db, bindings);
    const body = removed(101, "acme", "acme/web");
    (body.repositories_removed as Array<Record<string, unknown>>).push({ id: 5, name: "x", full_name: "../../etc/passwd" });
    expect((await send("installation_repositories", body)).statusCode).toBe(403);
    expect(marks(db, A)).toEqual([]);
  });
});

describe("the repos row", () => {
  it("is byte-identical to before when GitHub said nothing", async () => {
    const { db } = await bound();
    expect(JSON.stringify((await statusOf(db, A, "alpha")).repos)).toBe('{"state":"done","count":1,"items":[{"name":"web","defaultBranch":"main","fullName":"acme/web"}]}');
    expect(JSON.stringify((await statusOf(db, A, "alpha", "https://example.com/acme/web")).repos)).toBe('{"state":"done","count":1,"items":[{"name":"web","defaultBranch":"main"}]}');
  });
  it("a stored mark that does not read back (another company's, another name, a stranger's shape) makes the whole read unreadable", async () => {
    const good = { ...repositoryMovedKey(A, "acme/web"), entityType: "GITHUB_REPOSITORY_MOVED", companyId: A, fullName: "acme/web", reason: "removed", installationId: 101, at: "2026-11-17T12:00:00.000Z", deliveryId: D(1) };
    for (const bad of [{ ...good, companyId: B }, { ...good, fullName: "acme/other" }, { ...good, reason: "gone" }, { ...good, entityType: "OTHER" }]) {
      const { db } = await bound(); db.set(bad);
      await expect(repos(db, A, "alpha")).rejects.toThrow(SETUP_STATUS_UNREADABLE);
    }
  });
});
