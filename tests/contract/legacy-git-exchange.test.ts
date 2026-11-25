// G1 (grant exchange binding): the LEGACY Git credential exchange (aws/broker.ts, for a workspace the core does not own) has the core's liveness, count and log line, and a push that has no candidate to check
// (a maintain, a publish without expectedTreeSha) now needs its operation to still hold its workspace and its pull request to be where it started.
import { tamperedGrant } from "../support/grant-tamper.js";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const WORKSPACE = "550e8400-e29b-41d4-a716-446655440010";
const OPERATION = "550e8400-e29b-41d4-a716-446655440011";
const URL_OF_REPOSITORY = "https://github.com/acme/web.git";
const TOKEN = "ghs_LEGACY_FIXTURE_TOKEN";
/** A grant id as the broker logs it: 12 hex characters. */
const GRANT_ID = expect.stringMatching(/^[0-9a-f]{12}$/u) as string;
const NOW = "2026-11-25T12:00:00.000Z";
beforeAll(loadSlackBroker);
afterEach(() => { vi.restoreAllMocks(); });

type Kind = "prepare" | "publish" | "maintain";
function legacyWorld(options: { kind?: Kind; status?: string; workspaceStatus?: string } = {}) {
  const kind = options.kind ?? "prepare";
  const minted = vi.fn(async () => ({ username: "x-access-token", password: TOKEN }));
  const grants = new RepositoryGrantService(Buffer.alloc(32, 3), minted);
  const { handler, db } = createBroker({ extra: { repositoryGrants: grants } });
  db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", deploymentMode: "ec2-ebs", id: WORKSPACE, ownerKey: "owner".repeat(8), projectName: "web", projectRevision: 1, environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`,
    rootPath: "/mnt/workspace", status: options.workspaceStatus ?? "BUSY", fence: 2, activeOperationId: OPERATION, createdAt: NOW, updatedAt: NOW });
  const base = { pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, id: OPERATION, workspaceId: WORKSPACE, kind, status: options.status ?? "RUNNING", fence: 2 };
  const operation = kind === "maintain" ? { ...base, maintenance: { action: "append", repository: "web", repositoryUrl: URL_OF_REPOSITORY, pullRequestNumber: 7, headBranch: "rovara/fix", baseBranch: "main", expectedHeadCommit: "a".repeat(40) } }
    : kind === "publish" ? { ...base, publication: { repository: "web", repositoryUrl: URL_OF_REPOSITORY, headBranch: "rovara/change", baseBranch: "main", title: "t", body: "b", draft: true } } : base;
  db.set(operation);
  db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#web#${"7".padStart(12, "0")}`, expectedHeadCommit: "a".repeat(40) });
  const logged: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { try { logged.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a log line of ours */ } });
  const scope = (access: "clone" | "push") => ({ credentialRef: "github", repositoryUrl: URL_OF_REPOSITORY, access });
  const grantFor = (urls: readonly string[] = [URL_OF_REPOSITORY]) => grants.issue({ ownerKey: "owner".repeat(8), projectName: "web", workspaceId: WORKSPACE, operationId: OPERATION, repositories: urls.flatMap((url) => [{ ...scope("clone"), repositoryUrl: url }, { ...scope("push"), repositoryUrl: url }]) });
  const post = async (grant: string, access: "clone" | "push", repositoryUrl = URL_OF_REPOSITORY) => {
    const answer = await handler({ rawPath: `/v1/internal/workspaces/${WORKSPACE}/operations/${OPERATION}/repository-credentials`, body: JSON.stringify({ ...scope(access), repositoryUrl }),
      headers: { "x-agentx-repository-grant": grant }, requestContext: { requestId: "mint", http: { method: "POST" } } });
    return { status: answer.statusCode, code: (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code };
  };
  const operationItem = () => db.get(`WORKSPACE#${WORKSPACE}`, `OPERATION#${OPERATION}`) as Record<string, unknown>;
  const lines = (event: string) => logged.filter((line) => line["event"] === event);
  return { db, grants, minted, grantFor, post, operationItem, lines, logged };
}

describe("legacy Git exchange: liveness, count and log", () => {
  it("a live operation gets its credential: counted, logged with the grant's id, and no secret in the line", async () => {
    const w = legacyWorld();
    const grant = w.grantFor();
    expect(await w.post(grant, "clone")).toEqual({ status: 200, code: undefined });
    expect(w.operationItem()["repositoryCredentialCount"]).toBe(1);
    const nonce = (JSON.parse(Buffer.from(grant.split(".")[0]!, "base64url").toString("utf8")) as { nonce: string }).nonce;
    expect(w.lines("repository.credential_issued")).toEqual([expect.objectContaining({ outcome: "issued", grantId: createHash("sha256").update(nonce).digest("hex").slice(0, 12), operationId: OPERATION, repository: "web.git".replace(/\.git$/u, ""), kind: "clone", count: 1, engine: "legacy" })]);
    const raw = JSON.stringify(w.logged);
    for (const secret of [TOKEN, grant, grant.split(".")[1]!, nonce]) expect(raw).not.toContain(secret);
  });

  it.each(["clone", "push"] as const)("a stopped (CANCEL_REQUESTED) operation gets no %s credential", async (access) => {
    const w = legacyWorld({ kind: "publish", status: "CANCEL_REQUESTED" });
    expect(await w.post(w.grantFor(), access)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.lines("repository.credential_refused")).toEqual([expect.objectContaining({ reason: "stopping", grantId: GRANT_ID })]);
  });

  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)("a %s operation gets nothing", async (status) => {
    const w = legacyWorld({ status });
    expect(await w.post(w.grantFor(), "clone")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "ended" });
  });

  it.each(["CLOSING", "CLOSED"] as const)("a %s workspace gets nothing", async (workspaceStatus) => {
    const w = legacyWorld({ workspaceStatus });
    expect(await w.post(w.grantFor(), "clone")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "closing" });
  });

  it("the fifth exchange for one repository is refused; a refused request is not counted", async () => {
    const w = legacyWorld();
    const grant = w.grantFor();
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await w.post(grant, "clone")).status).toBe(200);
    expect(await w.post(grant, "clone")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.minted).toHaveBeenCalledTimes(4);
    expect(w.operationItem()["repositoryCredentialCount"]).toBe(4);
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "limit" });
  });

  it("the cap is sized by the grant's repositories: a grant naming two repositories allows 8, a grant naming one allows 4", async () => {
    const w = legacyWorld();
    const two = w.grantFor([URL_OF_REPOSITORY, "https://github.com/acme/other.git"]);
    for (let attempt = 0; attempt < 8; attempt += 1) expect((await w.post(two, attempt % 2 === 0 ? "clone" : "push")).status, `exchange ${String(attempt + 1)}`).toBe(200);
    expect(await w.post(two, "clone")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.operationItem()["repositoryCredentialCount"]).toBe(8);
    expect(w.minted).toHaveBeenCalledTimes(8);
  });

  it("a mint that fails gives its slot back; the host's error text is in no line", async () => {
    const w = legacyWorld();
    const grant = w.grantFor();
    w.minted.mockRejectedValueOnce(new Error("GitHub 502 https://user:HOSTSECRET@host"));
    expect(await w.post(grant, "clone")).toEqual({ status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect(w.operationItem()["repositoryCredentialCount"]).toBe(0);
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "mint" });
    expect(JSON.stringify(w.logged)).not.toContain("HOSTSECRET");
    expect((await w.post(grant, "clone")).status).toBe(200);
  });

  it("the line names the repository from the verified grant: an address with user information, or one the grant does not name, logs none", async () => {
    const w = legacyWorld();
    const grant = w.grantFor();
    expect(await w.post(grant, "clone", "https://user:HOSTILESECRET@evil.example.test")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "not-covered", grantId: GRANT_ID });
    expect(w.lines("repository.credential_refused")[0]).not.toHaveProperty("repository");
    expect(await w.post(tamperedGrant(grant), "clone", "https://user:HOSTILESECRET@evil.example.test")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(JSON.stringify(w.logged)).not.toContain("HOSTILESECRET");
    expect((await w.post(grant, "clone")).status).toBe(200);
    expect(w.lines("repository.credential_issued")[0]).toMatchObject({ repository: "web" });
  });

  it.each([["a newer fence", { fence: 3 }], ["another active operation", { activeOperationId: "550e8400-e29b-41d4-a716-446655440099" }]] as const)("a CLONE is refused too with %s on the workspace (the same fence check as a push)", async (_name, changes) => {
    const w = legacyWorld();
    w.db.set({ ...(w.db.get(`WORKSPACE#${WORKSPACE}`, "META") as Record<string, unknown>), ...changes });
    expect(await w.post(w.grantFor(), "clone")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "authority" });
  });

  it("a request the grant does not name is refused before it is counted", async () => {
    const w = legacyWorld();
    const cloneOnly = w.grants.issue({ ownerKey: "owner".repeat(8), projectName: "web", workspaceId: WORKSPACE, operationId: OPERATION, repositories: [{ credentialRef: "github", repositoryUrl: URL_OF_REPOSITORY, access: "clone" }] });
    expect(await w.post(cloneOnly, "push")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.operationItem()["repositoryCredentialCount"]).toBeUndefined();
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "not-covered", grantId: GRANT_ID });
  });

  it("a stop that lands between the check and the count takes no slot", async () => {
    const w = legacyWorld();
    const grant = w.grantFor();
    const send = w.db.send.bind(w.db) as (command: unknown, options?: unknown) => Promise<unknown>;
    let stopped = false;
    vi.spyOn(w.db, "send").mockImplementation(async (command: { constructor: { name: string } }, options?: unknown) => {
      if (command.constructor.name === "UpdateCommand" && !stopped) { stopped = true; w.db.set({ ...w.operationItem(), status: "CANCEL_REQUESTED" }); }
      return send(command, options);
    });
    expect((await w.post(grant, "clone")).status).toBe(403);
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.operationItem()["repositoryCredentialCount"]).toBeUndefined();
  });
});

describe("legacy Git exchange: a push with no candidate to check needs its authority", () => {
  it("a maintain push that still holds its workspace and its pull request's head is given", async () => {
    const w = legacyWorld({ kind: "maintain" });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 200, code: undefined });
  });
  it("a maintain push is refused once the operation is no longer its workspace's active one", async () => {
    const w = legacyWorld({ kind: "maintain" });
    w.db.set({ ...(w.db.get(`WORKSPACE#${WORKSPACE}`, "META") as Record<string, unknown>), activeOperationId: "550e8400-e29b-41d4-a716-446655440099" });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
    expect(w.lines("repository.credential_refused")[0]).toMatchObject({ reason: "authority" });
  });
  it("a maintain push is refused once the workspace has a newer fence", async () => {
    const w = legacyWorld({ kind: "maintain" });
    w.db.set({ ...(w.db.get(`WORKSPACE#${WORKSPACE}`, "META") as Record<string, unknown>), fence: 3 });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
  });
  it("a maintain push is refused once the pull request's recorded head moved", async () => {
    const w = legacyWorld({ kind: "maintain" });
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#web#${"7".padStart(12, "0")}`, expectedHeadCommit: "b".repeat(40) });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
  });
  it("a maintain push is refused once its task was closed, and a clone of the same operation is not held to that", async () => {
    const w = legacyWorld({ kind: "maintain" });
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: "task-1" });
    w.db.set({ pk: "DEVTASK#task-1", sk: "META", taskId: "task-1", workspaceId: WORKSPACE, closedAt: NOW });
    const grant = w.grantFor();
    expect(await w.post(grant, "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect((await w.post(grant, "clone")).status).toBe(200);
  });
  it("a maintain push for a reviewed fix is refused once the workflow's candidate is not the one it started for", async () => {
    const w = legacyWorld({ kind: "maintain" });
    const op = w.operationItem() as { maintenance: Record<string, unknown> };
    w.db.set({ ...op, maintenance: { ...op.maintenance, workflowCandidate: { candidateDigest: "c".repeat(64), treeSha: "d".repeat(40), baseCommitSha: "e".repeat(40) } } });
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: "task-1" });
    w.db.set({ pk: "DEVTASK#task-1", sk: "META", taskId: "task-1", workspaceId: WORKSPACE, workflow: { stage: "PULL_REQUEST", state: "RUNNING", candidate: { digest: "f".repeat(64) } } });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    w.db.set({ pk: "DEVTASK#task-1", sk: "META", taskId: "task-1", workspaceId: WORKSPACE, workflow: { stage: "PULL_REQUEST", state: "RUNNING", candidate: { digest: "c".repeat(64) } } });
    expect((await w.post(w.grantFor(), "push")).status).toBe(200);
  });
  it("a publish without a candidate is refused once its task was closed", async () => {
    const w = legacyWorld({ kind: "publish" });
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: "task-1" });
    w.db.set({ pk: "DEVTASK#task-1", sk: "META", taskId: "task-1", workspaceId: WORKSPACE, closedAt: NOW });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).not.toHaveBeenCalled();
  });
  it("a publish without a candidate is given while it holds its workspace, and refused after it does not", async () => {
    const w = legacyWorld({ kind: "publish" });
    expect((await w.post(w.grantFor(), "push")).status).toBe(200);
    w.db.set({ ...(w.db.get(`WORKSPACE#${WORKSPACE}`, "META") as Record<string, unknown>), activeOperationId: null });
    expect(await w.post(w.grantFor(), "push")).toEqual({ status: 409, code: "CALLBACK_FORBIDDEN" });
    expect(w.minted).toHaveBeenCalledTimes(1);
  });
});
