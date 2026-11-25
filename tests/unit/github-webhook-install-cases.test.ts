// G-G (D1-PLAN 5.3): the install and webhook cases of tests/integration/workflow-e2e/12-install-webhook.test.ts that survive the old engine, as unit tests on the route
// (`handleGithubWebhookRoute`, aws/github-webhook-route.ts) with the REAL secret loader (`createGitHubAppCredentials`, the broker's Secrets Manager reader) and the REAL core branch over a task row
// the core tracks; plus project registration under DynamoDB's map order [R2]. Only Secrets Manager is faked (a client with replies, as the loader's own test does) and time is the fake clock the
// loader and the route both read. What the old suite drove through a Slack-started task on the old engine is the route's and loader's behaviour here, asserted as it is TODAY.
// Already covered elsewhere and not repeated: the HMAC order and shape (github-webhook-core-branch.test.ts "the signature is checked on the raw body"), the loader's source rules and its 30 s cost cap
// (contract/github-webhook-secret-loader.test.ts), and a secret added after the container started (contract/github-webhook-signature.test.ts). Here: the same pieces TOGETHER, and the effect on the core task.
import { createHmac } from "node:crypto";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectRevisionKey, prHeadKey } from "@agentx/contracts";
import { handleGithubWebhookRoute } from "../../packages/broker/src/aws/github-webhook-route.js";
import { resetGithubWebhookWindows } from "../../packages/broker/src/aws/github-core-webhooks.js";
import { GithubInstallationBindings, createGitHubAppCredentials } from "../../packages/broker/src/aws/github-credentials.js";
import { isWebhookSecretMissing } from "../../packages/broker/src/github-app.js";
import { stampItem } from "../../packages/broker/src/core-host/engine-stamp.js";
import { recoveryRowKey, taskRecordKey } from "../../packages/broker/src/core/merge/store.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { call, createBroker, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const TASK = "11111111-1111-4111-8111-111111111111";
const APP_SECRET_ID = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/staging/github-app-AbCdEf";
const DEDICATED_ID = "agentx/staging/github-webhook-secret";
const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
const START = Date.parse("2026-11-23T12:00:00.000Z");
const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]);
const SHA = "a".repeat(40);
const DIGEST = "d".repeat(64);
const FIRST = "first-webhook-secret-".padEnd(48, "1");
const ROTATED = "rotated-webhook-secret-".padEnd(48, "2");

type Reply = { SecretString: string } | "empty";
/** The broker's own credentials reader over a Secrets Manager whose answers the test changes (the owner setting the secret, GitHub's secret rotating). */
function secretsWorld(replies: { app: Reply; dedicated: Reply }) {
  const state = { ...replies, reads: [] as string[] };
  const client = { send: vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    const id = (command as { input: { SecretId: string } }).input.SecretId;
    state.reads.push(id);
    const reply = id === DEDICATED_ID ? state.dedicated : state.app;
    if (reply === "empty") throw Object.assign(new Error(`Secrets Manager can't find the specified secret value for ${id}`), { name: "ResourceNotFoundException" });
    return { SecretString: reply.SecretString };
  }) };
  return { state, credentials: createGitHubAppCredentials(client as never) };
}
const appJson = (webhookSecret?: string): Reply => ({ SecretString: JSON.stringify({ appId: "12345", privateKey: PEM, ...(webhookSecret === undefined ? {} : { webhookSecret }) }) });

/** A core task waiting for its merge, tracked on the company's installation, its tracking row asleep for 4 minutes. */
async function trackedTask() {
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(ORG, 77, "acct-a", "operator");
  const url = "https://github.com/example/demo/pull/7";
  db.set({ ...taskRecordKey(TASK), companyId: ORG, project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "demo", number: 7, url, candidateDigest: DIGEST }] } });
  db.set(stampItem(ORG, TASK, { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "fixture", stampedAt: "2026-11-22T00:00:00.000Z" }).item);
  db.set({ ...githubWorkflowPullRequestKey("example/demo", 7), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 7, url, taskId: TASK, workspaceId: "workspace", candidateDigest: DIGEST });
  db.set({ ...projectRevisionKey(ORG, "demo", 1), definition: { repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }] } });
  db.set({ ...prHeadKey(ORG, "example/demo", SHA), entityType: "PR_HEAD", orgId: ORG, taskId: TASK, repositoryId: "demo", number: 7 });
  db.set({ ...recoveryRowKey(TASK), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK, nextAttemptAt: START + 240_000, attempts: 0, quiet: 3 });
  const asleep = db.get(recoveryRowKey(TASK).pk, recoveryRowKey(TASK).sk)!.nextAttemptAt;
  const sent = db.commandNames().length;
  return { db, bindings, row: () => db.get(recoveryRowKey(TASK).pk, recoveryRowKey(TASK).sk)!, asleep, writes: () => db.commandNames().slice(sent).filter((name) => WRITES.has(name)),
    deliveries: () => db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#")) };
}

let sequence = 0;
/** One GitHub delivery to the route, signed as GitHub signs it, read through the broker's own credentials reader. */
function deliver(task: Awaited<ReturnType<typeof trackedTask>>, secrets: ReturnType<typeof secretsWorld>, legacy: ReturnType<typeof vi.fn>, event: string, payload: unknown, signWith: string, logs: Array<Record<string, unknown>> = []) {
  const raw = JSON.stringify(payload);
  sequence += 1;
  return handleGithubWebhookRoute({
    headers: { "x-github-event": event, "x-github-delivery": `550e8400-e29b-41d4-a716-${String(sequence).padStart(12, "0")}`, "x-hub-signature-256": `sha256=${createHmac("sha256", signWith).update(raw).digest("hex")}` },
    body: raw, secret: secrets.credentials.webhookSecret, isSecretMissing: isWebhookSecretMissing, now: () => Date.now(), log: (entry) => logs.push(entry), legacy: legacy as never,
    core: { documentClient: task.db, tableName: "state", bindings: task.bindings } });
}
const merged = () => ({ action: "closed", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 7, merged: true } });
const conversationComment = (id = 1) => ({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, issue: { number: 7, pull_request: { url: "https://api.github.com/x" } }, comment: { id } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY_SECRET_ARN", APP_SECRET_ID);
  vi.stubEnv("GITHUB_APP_CREDENTIAL_REF", "github-app");
  vi.stubEnv("GITHUB_APP_ID", "12345");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET_ID", DEDICATED_ID);
  resetGithubWebhookWindows();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("an install with no webhook secret, and the webhook added after the pull request opened [LIVE-BUG B10]", () => {
  it("a delivery is 503 'not configured' with nothing kept and the task's tracking untouched; the owner adds the secret, and without a redeploy the next delivery after the loader's interval is accepted and wakes the task", async () => {
    const task = await trackedTask();
    const secrets = secretsWorld({ app: appJson(), dedicated: "empty" });
    const legacy = vi.fn();
    const logs: Array<Record<string, unknown>> = [];
    const early = await deliver(task, secrets, legacy, "pull_request", merged(), FIRST, logs);
    expect(early).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook handling is not configured" } } });
    expect(task.writes(), "no write").toEqual([]);
    expect(task.deliveries(), "no delivery row is kept").toEqual([]);
    expect(task.row().nextAttemptAt, "the tracking row still sleeps").toBe(task.asleep);
    expect(legacy).not.toHaveBeenCalled();
    // The admin runs agentx upgrade: the dedicated secret now holds GitHub's webhook secret. The running container remembers "missing" and reads Secrets Manager at most once per 30 seconds.
    secrets.state.dedicated = { SecretString: FIRST };
    const reads = secrets.state.reads.length;
    vi.advanceTimersByTime(10_000);
    expect((await deliver(task, secrets, legacy, "pull_request", merged(), FIRST, logs)).status, "inside the interval the answer is still 'not configured'").toBe(503);
    expect(secrets.state.reads.length, "and costs no read").toBe(reads);
    vi.advanceTimersByTime(21_000);
    const late = await deliver(task, secrets, legacy, "pull_request", merged(), FIRST, logs);
    expect(late).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(task.row(), "the merge webhook wakes the task's tracking row now").toMatchObject({ nextAttemptAt: Date.now(), quiet: 0, lastHintKind: "pull_request" });
    expect(task.row().nextAttemptAt).toBeLessThan(task.asleep as number);
    expect(JSON.stringify(logs), "no line names a secret").not.toContain(FIRST);
  });

  it("a Secrets Manager read that FAILS (throttled) is not 'not configured': the delivery is a logged retryable 503 that GitHub redelivers, and nothing is written", async () => {
    const task = await trackedTask();
    const failing = { send: vi.fn(async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); }) };
    const secrets = { state: { reads: [] as string[] }, credentials: createGitHubAppCredentials(failing as never) } as unknown as ReturnType<typeof secretsWorld>;
    const logs: Array<Record<string, unknown>> = [];
    const answer = await deliver(task, secrets, vi.fn(), "pull_request", merged(), FIRST, logs);
    expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook processing will be retried" } } });
    expect(logs).toContainEqual(expect.objectContaining({ event: "github_webhook.retry", reason: "retryable" }));
    expect(task.writes()).toEqual([]);
    expect(task.row().nextAttemptAt).toBe(task.asleep);
  });
});

describe("GitHub rotates the webhook secret [LIVE-BUG B11]", () => {
  it("the first delivery signed with the new secret after the loader's interval is accepted and wakes the task; the old secret is refused from then on; a second rotation inside the interval waits", async () => {
    const task = await trackedTask();
    const secrets = secretsWorld({ app: appJson(), dedicated: { SecretString: FIRST } });
    const legacy = vi.fn();
    expect((await deliver(task, secrets, legacy, "issue_comment", conversationComment(1), FIRST)).status, "the container reads and caches the first secret").toBe(200);
    // GitHub's secret changes while the container has the old one cached: inside the interval nothing re-reads, so the new signature is refused (a forged request costs no read).
    secrets.state.dedicated = { SecretString: ROTATED };
    const reads = secrets.state.reads.length;
    expect((await deliver(task, secrets, legacy, "issue_comment", conversationComment(2), ROTATED)).status).toBe(403);
    expect(secrets.state.reads.length).toBe(reads);
    // After the interval, the first bad signature forces one re-read and the delivery is accepted.
    vi.advanceTimersByTime(31_000);
    // The row has gone back to sleep since the first delivery woke it (the tracking pass ran).
    task.db.set({ ...recoveryRowKey(TASK), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK, nextAttemptAt: Date.now() + 240_000, attempts: 0, quiet: 3 });
    const rotated = await deliver(task, secrets, legacy, "issue_comment", conversationComment(2), ROTATED);
    expect(rotated).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(task.row(), "and wakes the row").toMatchObject({ nextAttemptAt: Date.now(), lastHintKind: "comment" });
    // From then on the old secret is no one's: 403, nothing written.
    const writes = task.writes().length;
    expect((await deliver(task, secrets, legacy, "issue_comment", conversationComment(3), FIRST)).status).toBe(403);
    expect(task.writes().length).toBe(writes);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("a delivery with a secret AgentX does not hold is 403 and keeps nothing; the same delivery id signed right is accepted", async () => {
    const task = await trackedTask();
    const secrets = secretsWorld({ app: appJson(), dedicated: { SecretString: FIRST } });
    const raw = conversationComment();
    const id = "71111111-2222-4333-8444-555555555555";
    const send = (signWith: string) => handleGithubWebhookRoute({ headers: { "x-github-event": "issue_comment", "x-github-delivery": id, "x-hub-signature-256": `sha256=${createHmac("sha256", signWith).update(JSON.stringify(raw)).digest("hex")}` },
      body: JSON.stringify(raw), secret: secrets.credentials.webhookSecret, isSecretMissing: isWebhookSecretMissing, now: () => Date.now(), log: () => undefined, legacy: vi.fn() as never, core: { documentClient: task.db, tableName: "state", bindings: task.bindings } });
    expect((await send("not-the-webhook-secret-0123456789abcdefgh")).status).toBe(403);
    expect(task.writes()).toEqual([]);
    expect(task.deliveries()).toEqual([]);
    expect(await send(FIRST)).toMatchObject({ status: 200, body: { delivery: "ACCEPTED", deliveryId: id } });
    expect(task.deliveries()).toHaveLength(1);
  });
});

describe("an event the App is not subscribed to", () => {
  it("a SIGNED event outside the allow-list (push, workflow_run) is 202 ignored with no write and no secret re-read; unsigned it stays 403; the events that do arrive still wake the task", async () => {
    const task = await trackedTask();
    const secrets = secretsWorld({ app: appJson(), dedicated: { SecretString: FIRST } });
    const legacy = vi.fn();
    const logs: Array<Record<string, unknown>> = [];
    await deliver(task, secrets, legacy, "ping", { zen: "x" }, FIRST);
    const reads = secrets.state.reads.length;
    for (const event of ["push", "workflow_run", "star"]) {
      expect(await deliver(task, secrets, legacy, event, { installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" } }, FIRST, logs), event).toEqual({ status: 202, body: { ignored: true } });
    }
    expect(task.writes(), "an ignored event writes nothing").toEqual([]);
    expect(secrets.state.reads.length).toBe(reads);
    expect(logs.filter((entry) => entry.event === "github_webhook.ignored")).toHaveLength(3);
    // Unsigned or forged: never the ignored answer (no probing of event handling).
    expect((await deliver(task, secrets, legacy, "push", {}, "forged-".padEnd(40, "f"))).status).toBe(403);
    // The App is not subscribed to inline review comments, so only the conversation comment arrives: that one delivery wakes the row (the merge tracking pass then reads every comment from the host:
    // tests/journeys/pr-feedback.test.ts reads a review comment with no webhook at all).
    expect(await deliver(task, secrets, legacy, "issue_comment", conversationComment(), FIRST)).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(task.row()).toMatchObject({ nextAttemptAt: Date.now(), lastHintKind: "comment" });
    expect(task.row().feedbackDueAt, "the feedback read is due now").toBeDefined();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("registering the same project revision again under DynamoDB's map order [R2]", () => {
  it("is a no-op that answers duplicate (the stored revision comes back with its maps in another order than they were written in), and the same revision with another definition is refused", async () => {
    vi.useRealTimers();
    await loadSlackBroker();
    const broker = createBroker();
    await registerSlackProject(broker.handler);
    const [project] = broker.db.find((item) => item.entityType === "PROJECT");
    expect(project).toBeDefined();
    const kind = `${String(project!.pk).split("#")[0]}#${String(project!.sk).split("#")[0]}`;
    const admin = { subject: "admin-subject", admin: true };
    const reorderedBefore = broker.db.readOrders.get(kind)?.reordered ?? 0;
    // The same definition and binding, sent again as a second `agentx project add` sends them.
    const again = await call(broker.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: { definition: project!.definition, runtimeBinding: project!.runtimeBinding } });
    expect(again.status).toBeLessThan(300);
    expect(again.body).toMatchObject({ duplicate: true });
    // Not vacuous: the table handed the stored revision back in an order of its own, and the comparison still found it equal.
    expect(broker.db.readOrders.get(kind)!.reordered).toBeGreaterThan(reorderedBefore);
    // The same revision with another definition is not a duplicate: refused, and the stored revision is unchanged.
    const stored = JSON.stringify(broker.db.get(String(project!.pk), String(project!.sk))!.definition);
    const changed = await call(broker.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      body: { definition: { ...(project!.definition as Record<string, unknown>), orchestratorInstructions: "A different instruction." }, runtimeBinding: project!.runtimeBinding } });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(broker.db.get(String(project!.pk), String(project!.sk))!.definition)).toBe(stored);
  });
});
