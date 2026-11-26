// Core webhook wiring on the HOSTED broker. The deployed host (buildBrokerHandler) never sets a top-level `githubBindings`; it gives the client project routes their bindings in
// `clientProjects.bindings` (same class, same State table). The W0 tests injected `githubBindings` directly, so they passed while the core branch of POST /v1/github/webhooks and the
// installation lifecycle events were never reached in production (every delivery fell to the legacy handler: `not_linked` for a core task). Every broker below is built the way the host
// builds it: NO `githubBindings`, bindings only inside `clientProjects`, through the real createAwsBrokerHandler.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, prHeadKey, projectRevisionKey } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { LINKED_CHANGE_REQUEST_ENTITY, linkedChangeRequestKey } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { coreTaskMarkItem } from "../../packages/broker/src/core-host/core-task-mark.js";
import { recoveryRowKey, taskRecordKey } from "../../packages/broker/src/core/merge/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const SECRET = "fixture-only-webhook-secret-".padEnd(40, "x");
const TASK = "11111111-1111-4111-8111-111111111111";
const DIGEST = "d".repeat(64);
const SHA = "a".repeat(40);
const REPO_URL = "https://github.com/example/demo";
const PR_URL = `${REPO_URL}/pull/7`;
const BOUND = 77;
const LEGACY_PR_URL = `${REPO_URL}/pull/1`;

interface WorldOptions { bindInstallation?: string | false; marker?: boolean }

/** The staging shape: the backfill marker is written, installation 77 is bound to one company, and the broker input has no top-level githubBindings. */
async function hostedWorld(options: WorldOptions = {}) {
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  if (options.marker !== false) await bindings.backfill(async () => []);
  if (options.bindInstallation !== false) await bindings.claim(options.bindInstallation ?? ORG, BOUND, "acct-a", "operator");
  // A core task (stamped core) with its neutral change-request link, head row, pinned repository and tracking row: what the core flow writes when it publishes.
  db.set({ ...taskRecordKey(TASK), companyId: ORG, project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "demo", number: 7, url: PR_URL, candidateDigest: DIGEST }] } });
  db.set(coreTaskMarkItem(ORG, TASK, { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "fixture", stampedAt: "2026-11-22T00:00:00.000Z" }).item);
  db.set({ ...linkedChangeRequestKey("github", REPO_URL, "7")!, entityType: LINKED_CHANGE_REQUEST_ENTITY, hostKind: "github", repositoryKey: "example/demo", changeRequestId: "7", repositoryId: "demo",
    number: 7, url: PR_URL, taskId: TASK, workspaceId: "workspace", candidateDigest: DIGEST, createdAt: "2026-11-22T00:00:00.000Z" });
  db.set({ ...projectRevisionKey(ORG, "demo", 1), definition: { repositories: [{ name: "demo", url: `${REPO_URL}.git` }] } });
  db.set({ ...prHeadKey(ORG, "example/demo", SHA), entityType: "PR_HEAD", orgId: ORG, taskId: TASK, repositoryId: "demo", number: 7 });
  db.set({ ...recoveryRowKey(TASK), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK, nextAttemptAt: Date.now() + 600_000, attempts: 0, quiet: 4 });
  // A legacy task (no engine stamp, the built-in company) with the old GITHUB_PR# link, for pull request 1.
  db.set({ pk: "GITHUB_PR#example/demo", sk: "PR#0000000001", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 1, url: LEGACY_PR_URL, taskId: "legacy-task", workspaceId: "w", candidateDigest: DIGEST });
  db.set({ pk: "DEVTASK#legacy-task", sk: "META", project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "demo", number: 1, url: LEGACY_PR_URL, candidateDigest: DIGEST }] } });
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", definition: { repositories: [{ name: "demo", url: `${REPO_URL}.git` }] } });
  const clientProjects = {
    credentialRef: "github-app", repositories: async () => [], repositoryDefaults: async () => ({ owner: "example", name: "demo", defaultBranch: "main" }),
    repositoryInstallation: async () => ({ installationId: BOUND, suspended: false }), workerBinding: async () => ({}), bindings,
  };
  // The deployed root's shape: documentClient, clientProjects.bindings, the webhook secret; NO githubBindings.
  const extra = { documentClient: db, clientProjects, githubWebhookSecret: async () => SECRET, githubPullRequests: { verifyWebhookRepository: async () => true } };
  expect(Object.hasOwn(extra, "githubBindings")).toBe(false);
  const { handler } = createBroker({ extra });
  const after = db.commandNames().length;
  let counter = 0;
  const invoke = (event: string, payload: Record<string, unknown>, options: { signWith?: string } = {}) => {
    const body = JSON.stringify(payload);
    counter += 1;
    return handler({
      rawPath: "/v1/github/webhooks", body,
      headers: { "x-github-delivery": `550e8400-e29b-41d4-a716-${String(counter).padStart(12, "0")}`, "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", options.signWith ?? SECRET).update(body).digest("hex")}` },
      requestContext: { requestId: "hosted-webhook", http: { method: "POST" } },
    });
  };
  const deliveryRow = (n: number) => db.get(`GITHUB_DELIVERY#550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`, "META");
  return { db, bindings, invoke, deliveryRow, sentSince: () => db.commandNames().slice(after), tracking: () => db.get(recoveryRowKey(TASK).pk, recoveryRowKey(TASK).sk)! };
}

const base = { installation: { id: BOUND }, repository: { id: 42, full_name: "example/demo" } };
const issueComment = (number: number) => ({ ...base, action: "created", issue: { number, pull_request: { url: "https://api.github.com/x" } }, comment: { id: 1 } });
const review = (number: number) => ({ ...base, action: "submitted", pull_request: { number }, review: { id: 5 } });
const answerOf = (answer: { statusCode: number; body: string }) => ({ status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> });

describe("the core branch is live on the host-shaped broker (clientProjects.bindings only)", () => {
  it("a plain conversation comment on a core-linked pull request is ACCEPTED and wakes the tracking row", async () => {
    const w = await hostedWorld();
    const answer = answerOf(await w.invoke("issue_comment", issueComment(7)));
    expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.tracking()).toMatchObject({ quiet: 0, lastHintKind: "comment" });
    expect(w.tracking()["feedbackDueAt"] as number).toBeLessThanOrEqual(Date.now());
    expect(w.tracking()["nextAttemptAt"] as number).toBeLessThanOrEqual(Date.now());
    // The core branch's own delivery row, not the legacy one.
    expect(w.deliveryRow(1)).toMatchObject({ core: true, status: "COMPLETED", companyId: ORG });
  });

  it("a review on a core-linked pull request is ACCEPTED with a feedback wake", async () => {
    const w = await hostedWorld();
    expect(answerOf(await w.invoke("pull_request_review", review(7)))).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.tracking()).toMatchObject({ quiet: 0, lastHintKind: "review" });
  });

  it("a check run on a core task's head commit is ACCEPTED with a checks wake (found through the company's head index)", async () => {
    const w = await hostedWorld();
    const answer = answerOf(await w.invoke("check_run", { ...base, action: "completed", check_run: { head_sha: SHA } }));
    expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.tracking()).toMatchObject({ lastHintKind: "checks" });
  });

  it("a signed delivery for a pull request nothing links is 202 IGNORED and writes nothing", async () => {
    const w = await hostedWorld();
    const answer = answerOf(await w.invoke("issue_comment", issueComment(99)));
    expect(answer).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.sentSince().filter((name) => name !== "GetCommand")).toEqual([]);
  });

  it("an installation nobody bound is ignored with 202 (the old workflow's handler that used to take it is deleted, D1-2) and wakes nothing", async () => {
    const w = await hostedWorld({ bindInstallation: false });
    expect(answerOf(await w.invoke("issue_comment", issueComment(7)))).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.tracking()["lastHintKind"]).toBeUndefined();
  });

  it("a bad signature is 403 and not one table request is made", async () => {
    const w = await hostedWorld();
    expect((await w.invoke("issue_comment", issueComment(7), { signWith: "another-secret-".padEnd(40, "y") })).statusCode).toBe(403);
    expect(w.sentSince()).toEqual([]);
  });
});

// D1-2: the old workflow's webhook handler is deleted. A pull request nothing on the core links is answered 202 IGNORED whatever the old link rows say, on every kind of installation,
// with no delivery row reserved and the core not woken.
describe("a pull request event the core does not take is ignored on the same broker", () => {
  const cases: Array<[string, Parameters<typeof hostedWorld>[0]]> = [
    ["a binding of the built-in company", { bindInstallation: IMPLICIT_COMPANY_ID }],
    ["an installation with no binding row (no backfill yet)", { bindInstallation: false, marker: false }],
    ["an installation bound to a NAMED company", {}],
    ["an installation with no binding row after the backfill marker", { bindInstallation: false }],
  ];
  it.each(cases)("%s: 202 IGNORED, no delivery row, no wake", async (_name, options) => {
    const w = await hostedWorld(options);
    const answer = answerOf(await w.invoke("pull_request", { ...base, action: "opened", pull_request: { number: 1 } }));
    expect(answer).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.deliveryRow(1)).toBeUndefined();
    expect(w.tracking()["lastHintKind"]).toBeUndefined();
  });
});

describe("the installation lifecycle events are live on the host-shaped broker", () => {
  const lifecycle = (action: string) => ({ action, installation: { id: BOUND, account: { login: "acct-a" } }, sender: { login: "someone" } });

  it("a signed suspend then unsuspend marks the binding and is ACCEPTED", async () => {
    const w = await hostedWorld();
    expect(answerOf(await w.invoke("installation", lifecycle("suspend")))).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(await w.bindings.ownerAndState(BOUND)).toMatchObject({ owner: ORG, state: "suspended" });
    expect(answerOf(await w.invoke("installation", lifecycle("unsuspend"))).status).toBe(200);
    expect(await w.bindings.ownerAndState(BOUND)).toMatchObject({ owner: ORG, state: "active" });
    expect(answerOf(await w.invoke("installation", lifecycle("deleted"))).status).toBe(200);
    expect(await w.bindings.ownerAndState(BOUND)).toMatchObject({ state: "uninstalled" });
  });

  it("an unsigned (wrongly signed) installation event changes nothing", async () => {
    const w = await hostedWorld();
    expect((await w.invoke("installation", lifecycle("suspend"), { signWith: "another-secret-".padEnd(40, "y") })).statusCode).toBe(403);
    expect(w.sentSince()).toEqual([]);
    expect(await w.bindings.ownerAndState(BOUND)).toMatchObject({ state: "active" });
  });

  it("once suspended, the core branch answers 202 IGNORED for that installation", async () => {
    const w = await hostedWorld();
    await w.invoke("installation", lifecycle("suspend"));
    expect(answerOf(await w.invoke("issue_comment", issueComment(7))).status).toBe(202);
    expect(w.tracking()["lastHintKind"]).toBeUndefined();
  });
});

it("the host's own composition is the shape these tests build: bindings only inside clientProjects, no top-level githubBindings", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const host = source.slice(source.indexOf("return createAwsBrokerHandler({\n    core: coreRoot,"), source.indexOf("projectSetupSource: { capture:"));
  expect(host.length).toBeGreaterThan(500);
  expect(host).toMatch(/clientProjects: \{[\s\S]*bindings: new GithubInstallationBindings\(documentClient/u);
  expect(host).not.toMatch(/^\s+githubBindings\b/mu);
});
