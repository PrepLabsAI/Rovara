// Webhook lane W0: the real broker's POST /v1/github/webhooks with the core branch wired (installation bindings present): the order of work, base64 bodies, and one signed delivery end to end.
import { createHmac } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { prHeadKey, projectRevisionKey } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { stampItem } from "../../packages/broker/src/core-host/engine-stamp.js";
import { recoveryRowKey, taskRecordKey } from "../../packages/broker/src/core/merge/store.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const SECRET = "fixture-only-webhook-secret-".padEnd(40, "x");
const TASK = "11111111-1111-4111-8111-111111111111";
const DIGEST = "d".repeat(64);
const SHA = "a".repeat(40);
const URL = "https://github.com/example/demo/pull/7";

async function world() {
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(ORG, 77, "acct-a", "operator");
  db.set({ ...taskRecordKey(TASK), companyId: ORG, project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "demo", number: 7, url: URL, candidateDigest: DIGEST }] } });
  db.set(stampItem(ORG, TASK, { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "fixture", stampedAt: "2026-11-22T00:00:00.000Z" }).item);
  db.set({ ...githubWorkflowPullRequestKey("example/demo", 7), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 7, url: URL, taskId: TASK, workspaceId: "workspace", candidateDigest: DIGEST });
  db.set({ ...projectRevisionKey(ORG, "demo", 1), definition: { repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }] } });
  db.set({ ...prHeadKey(ORG, "example/demo", SHA), entityType: "PR_HEAD", orgId: ORG, taskId: TASK, repositoryId: "demo", number: 7 });
  db.set({ ...recoveryRowKey(TASK), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK, nextAttemptAt: Date.now() + 600_000, attempts: 0, quiet: 4 });
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings, githubWebhookSecret: async () => SECRET, githubPullRequests: { verifyWebhookRepository: async () => { throw new Error("no GitHub call"); } } } });
  const after = db.commandNames().length;
  const invoke = (body: string, options: { signWith?: string; event?: string; base64?: boolean; signature?: string } = {}) => handler({
    rawPath: "/v1/github/webhooks", body: options.base64 === true ? Buffer.from(body, "utf8").toString("base64") : body, ...(options.base64 === true ? { isBase64Encoded: true } : {}),
    headers: { "x-github-delivery": `550e8400-e29b-41d4-a716-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`, "x-github-event": options.event ?? "issue_comment",
      "x-hub-signature-256": options.signature ?? `sha256=${createHmac("sha256", options.signWith ?? SECRET).update(body).digest("hex")}` },
    requestContext: { requestId: "core-route", http: { method: "POST" } },
  });
  return { db, invoke, sentSince: () => db.commandNames().slice(after) };
}

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, issue: { number: 7, pull_request: { url: "https://api.github.com/x" } }, comment: { id: 1 }, ...extra });

it("a signed comment on a core task's pull request wakes its tracking row through the real broker, with no GitHub call", async () => {
  const w = await world();
  const answer = await w.invoke(body());
  expect(answer.statusCode).toBe(200);
  expect(JSON.parse(answer.body)).toMatchObject({ delivery: "ACCEPTED" });
  const row = w.db.get(recoveryRowKey(TASK).pk, recoveryRowKey(TASK).sk)!;
  expect(row).toMatchObject({ quiet: 0, lastHintKind: "comment" });
  expect(row["nextAttemptAt"] as number).toBeLessThanOrEqual(Date.now());
});

it("a body that API Gateway base64-encodes is checked over its decoded text, as GitHub signed it", async () => {
  const w = await world();
  expect((await w.invoke(body(), { base64: true })).statusCode).toBe(200);
  // A signature over the base64 text is not GitHub's.
  const raw = body({ comment: { id: 2 } });
  const wrong = `sha256=${createHmac("sha256", SECRET).update(Buffer.from(raw, "utf8").toString("base64")).digest("hex")}`;
  expect((await w.invoke(raw, { base64: true, signature: wrong })).statusCode).toBe(403);
});

it("a bad signature touches nothing: not one request to the table, and the legacy path is never reached", async () => {
  const w = await world();
  for (const signWith of ["another-secret-".padEnd(40, "y")]) expect((await w.invoke(body(), { signWith })).statusCode).toBe(403);
  expect((await w.invoke(body(), { signature: "sha256=nothex" })).statusCode).toBe(403);
  expect(w.sentSince()).toEqual([]);
});

it("an unlinked pull request is 202 IGNORED with zero writes (it was a red 403 delivery before)", async () => {
  const w = await world();
  const answer = await w.invoke(body({ issue: { number: 99, pull_request: { url: "https://api.github.com/x" } } }));
  expect(answer.statusCode).toBe(202);
  expect(JSON.parse(answer.body)).toMatchObject({ delivery: "IGNORED" });
  expect(w.sentSince().filter((name) => name !== "GetCommand")).toEqual([]);
});
