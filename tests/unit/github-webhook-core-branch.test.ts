// Webhook lane W0: the core branch of POST /v1/github/webhooks. The route verifies the HMAC over the raw body first, then maps the delivery (reads only) to a core task and makes that task's tracking row due sooner.
// Every guard has a test here and a mutant in the lane's MUTANTS.md that this file kills.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, prHeadKey, projectRevisionKey } from "@agentx/contracts";
import { adaptHttpApiEvent } from "../../packages/broker/src/aws/lambda.js";
import { handleGithubWebhookRoute, GITHUB_WEBHOOK_MAX_BYTES } from "../../packages/broker/src/aws/github-webhook-route.js";
import { GITHUB_DELIVERY_TTL_SECONDS, GITHUB_WEBHOOK_PER_MINUTE, hintTrackingRow, resetGithubWebhookWindows } from "../../packages/broker/src/aws/github-core-webhooks.js";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { handleGithubWebhook, listDueGithubWebhookDeliveries, reserveGithubWebhookDelivery } from "../../packages/broker/src/aws/github-webhooks.js";
import { stampItem } from "../../packages/broker/src/core-host/engine-stamp.js";
import { recoveryRowKey, taskRecordKey } from "../../packages/broker/src/core/merge/store.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// The constant-time compare is observed, not replaced: the mutant that swaps it for `===` has the same answers, so only a call count tells.
const compare = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const original = actual.timingSafeEqual as (a: Uint8Array, b: Uint8Array) => boolean;
  return { ...actual, timingSafeEqual: (a: Uint8Array, b: Uint8Array) => { compare.calls += 1; return original(a, b); } };
});

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SECRET = "fixture-only-webhook-secret-".padEnd(40, "x");
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const DIGEST = "d".repeat(64);
const SHA = "a".repeat(40);
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]);

interface Seed { taskId: string; company: string; number: number; sha?: string; engine?: "core" | "workflow" | undefined; repo?: string; pinned?: string; tracking?: Record<string, unknown> | null; ended?: boolean }

function seed(db: FakeDynamoDb, input: Seed): void {
  const repo = input.repo ?? "example/demo";
  const url = `https://github.com/${repo}/pull/${input.number}`;
  db.set({ ...taskRecordKey(input.taskId), companyId: input.company, project: "demo", startingRevision: 1, ...(input.ended === true ? { closedAt: "2026-11-22T00:00:00.000Z" } : {}),
    workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "demo", number: input.number, url, candidateDigest: DIGEST }] } });
  if (input.engine !== undefined) db.set(stampItem(input.company, input.taskId, { engine: input.engine, areas: { flow: input.engine, build: input.engine, merge: input.engine }, flags: "fixture", stampedAt: "2026-11-22T00:00:00.000Z" }).item);
  db.set({ ...githubWorkflowPullRequestKey(repo, input.number), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: repo, repositoryId: "demo", number: input.number, url, taskId: input.taskId, workspaceId: "workspace", candidateDigest: DIGEST });
  db.set({ ...projectRevisionKey(input.company, "demo", 1), definition: { repositories: [{ name: "demo", url: `https://github.com/${input.pinned ?? repo}.git` }] } });
  if (input.sha !== undefined) db.set({ ...prHeadKey(input.company, repo, input.sha), entityType: "PR_HEAD", orgId: input.company, taskId: input.taskId, repositoryId: "demo", number: input.number });
  if (input.tracking !== null) db.set({ ...recoveryRowKey(input.taskId), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: input.taskId, nextAttemptAt: NOW + 240_000, attempts: 0, quiet: 3, ...input.tracking });
}

async function world(options: { perMinute?: number; legacyUnscoped?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(ORG_A, 77, "acct-a", "operator");
  await bindings.claim(ORG_B, 78, "acct-b", "operator");
  seed(db, { taskId: TASK_A, company: ORG_A, number: 7, sha: SHA, engine: "core" });
  const logs: Array<Record<string, unknown>> = [];
  const secretCalls: Array<{ refresh?: boolean } | undefined> = [];
  const legacy = vi.fn(async () => ({ status: "ACCEPTED" as const, deliveryId: "legacy" }));
  const state = { now: NOW, sequence: 0 };
  const secret = async (options?: { refresh?: boolean }): Promise<string> => { secretCalls.push(options); return SECRET; };
  const post = (event: string, payload: unknown, extra: { secret?: string; deliveryId?: string; headers?: Record<string, string | undefined>; raw?: string; signWith?: string; core?: boolean } = {}) => {
    const raw = extra.raw ?? JSON.stringify(payload);
    state.sequence += 1;
    const headers = { "x-github-event": event, "x-github-delivery": extra.deliveryId ?? `550e8400-e29b-41d4-a716-${String(state.sequence).padStart(12, "0")}`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", extra.signWith ?? extra.secret ?? SECRET).update(raw).digest("hex")}`, ...extra.headers };
    return handleGithubWebhookRoute({ headers, body: raw, secret, isSecretMissing: () => false, now: () => state.now, log: (entry) => logs.push(entry), legacy,
      ...(extra.core === false ? {} : { core: { documentClient: db, tableName: "state", bindings, ...(options.perMinute === undefined ? {} : { perMinute: options.perMinute }), ...(options.legacyUnscoped === true ? { legacyUnscoped: true } : {}) } }) });
  };
  const row = (taskId = TASK_A) => db.get(recoveryRowKey(taskId).pk, recoveryRowKey(taskId).sk)!;
  const snapshot = () => JSON.stringify(db.find(() => true).sort((x, y) => `${String(x.pk)}|${String(x.sk)}`.localeCompare(`${String(y.pk)}|${String(y.sk)}`)));
  const sentAfterSetup = db.commandNames().length;
  const sentSince = () => db.commandNames().slice(sentAfterSetup);
  const writesSince = () => sentSince().filter((name) => WRITES.has(name));
  return { db, bindings, logs, secretCalls, legacy, state, post, row, snapshot, writesSince, sentSince };
}

const comment = (overrides: Record<string, unknown> = {}) => ({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, issue: { number: 7, pull_request: { url: "https://api.github.com/x" } }, comment: { id: 1 }, ...overrides });
const pullRequest = (action: string, overrides: Record<string, unknown> = {}) => ({ action, installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 7 }, ...overrides });
const checkSuite = (action: string, sha = SHA, overrides: Record<string, unknown> = {}) => ({ action, installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, check_suite: { head_sha: sha }, ...overrides });

beforeEach(() => { compare.calls = 0; vi.restoreAllMocks(); resetGithubWebhookWindows(); });

describe("the signature is checked on the raw body, before any work", () => {
  it.each([
    ["a missing header", undefined],
    ["a malformed header", "sha256=zz"],
    ["a truncated header", `sha256=${"a".repeat(63)}`],
    ["the sha1 form", `sha1=${"a".repeat(40)}`],
    ["an upper-case prefix", `SHA256=${"a".repeat(64)}`],
    ["upper-case hex", `sha256=${"A".repeat(64)}`],
    ["an empty header", ""],
  ])("%s: 403, no secret read, no parse, no write, no legacy call", async (_name, header) => {
    const w = await world();
    const parse = vi.spyOn(JSON, "parse");
    const answer = await w.post("issue_comment", comment(), { headers: { "x-hub-signature-256": header } });
    expect(answer.status).toBe(403);
    expect(w.secretCalls).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect(w.writesSince()).toEqual([]);
    expect(w.legacy).not.toHaveBeenCalled();
    expect(compare.calls).toBe(0);
  });

  it("a wrong secret, or a body signed for another body: 403 before any parse, mapping, read or write", async () => {
    for (const mode of ["wrong secret", "other body"] as const) {
      const w = await world();
      const parse = vi.spyOn(JSON, "parse");
      const answer = mode === "wrong secret"
        ? await w.post("issue_comment", comment(), { signWith: "another-secret-".padEnd(40, "y") })
        : await w.post("issue_comment", comment(), { headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(JSON.stringify({ other: 1 })).digest("hex")}` } });
      expect(answer.status, mode).toBe(403);
      expect(parse, mode).not.toHaveBeenCalled();
      // Not even a read of the table: nothing of the installation, the link or the task was looked at.
      expect(w.sentSince(), mode).toEqual([]);
      expect(w.legacy).not.toHaveBeenCalled();
      parse.mockRestore();
    }
  });

  it("compares in constant time: the HMAC check goes through timingSafeEqual (observed, valid and invalid)", async () => {
    const w = await world();
    await w.post("issue_comment", comment());
    expect(compare.calls).toBeGreaterThan(0);
    const before = compare.calls;
    await w.post("issue_comment", comment(), { signWith: "another-secret-".padEnd(40, "y") });
    expect(compare.calls).toBeGreaterThan(before);
  });

  it("checks the HMAC over the raw bytes as received, not over a re-serialised body", async () => {
    const w = await world();
    // Different spacing and key order than JSON.stringify would write: only the raw text matches the signature.
    const raw = `{ "repository" : {"full_name":"example/demo","id":42},\n "installation":{"id":77}, "issue":{"pull_request":{"url":"https://api.github.com/x"},"number":7}, "action":"created","comment":{"id":1} }`;
    expect(raw).not.toBe(JSON.stringify(JSON.parse(raw)));
    expect((await w.post("issue_comment", undefined, { raw })).status).toBe(200);
    expect(w.row().lastHintKind).toBe("comment");
  });

  it("answers a ping only after a valid signature, and a signed ping writes nothing", async () => {
    const w = await world();
    expect((await w.post("ping", { zen: "x" }, { headers: { "x-hub-signature-256": undefined } })).status).toBe(403);
    expect((await w.post("ping", { zen: "x" }, { signWith: "forged-".padEnd(40, "f") })).status).toBe(403);
    const answer = await w.post("ping", { zen: "Keep it logically awesome." });
    expect(answer).toEqual({ status: 200, body: { delivery: "PONG" } });
    expect(w.writesSince()).toEqual([]);
  });

  it("refuses a body over 1 MiB before any secret read, and accepts exactly 1 MiB", async () => {
    const w = await world();
    const exact = JSON.stringify(comment()) + " ".repeat(GITHUB_WEBHOOK_MAX_BYTES - Buffer.byteLength(JSON.stringify(comment())));
    expect(Buffer.byteLength(exact)).toBe(GITHUB_WEBHOOK_MAX_BYTES);
    const big = await w.post("issue_comment", undefined, { raw: exact + " " });
    expect(big.status).toBe(413);
    expect(w.secretCalls).toEqual([]);
    expect(compare.calls).toBe(0);
    expect((await w.post("issue_comment", undefined, { raw: exact })).status).toBe(200);
  });

  it("answers a bad delivery id or a missing event name before any secret read", async () => {
    const w = await world();
    expect((await w.post("issue_comment", comment(), { deliveryId: "not-a-uuid" })).status).toBe(403);
    expect((await w.post("push", { ref: "x" }, { deliveryId: "not-a-uuid" })).status).toBe(403);
    expect((await w.post("issue_comment", comment(), { headers: { "x-github-event": undefined } })).status).toBe(403);
    expect((await w.post("issue_comment", comment(), { headers: { "x-github-event": "" } })).status).toBe(403);
    expect(w.secretCalls).toEqual([]);
  });

  it.each(["push", "workflow_run", "workflow_job", "create", "delete", "star", "made_up_event"])("a VALID signature on an unhandled event (%s): 202 ignored, one info log with the event and delivery id, no table touch, no legacy call", async (event) => {
    const w = await world();
    const parse = vi.spyOn(JSON, "parse");
    const deliveryId = "550e8400-e29b-41d4-a716-0000000000e1";
    const before = w.snapshot();
    const answer = await w.post(event, { ref: "refs/heads/main", secretLookingValue: "do-not-log-me" }, { deliveryId });
    expect(answer).toEqual({ status: 202, body: { ignored: true } });
    expect(w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", reason: "unhandled_event", hook: event, deliveryId }]);
    expect(JSON.stringify(w.logs)).not.toContain("do-not-log-me");
    expect(w.sentSince()).toEqual([]);
    expect(w.snapshot()).toBe(before);
    expect(w.legacy).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(w.logs.some((entry) => entry.event === "github_webhook.rejected")).toBe(false);
  });

  it("an unhandled event with a BAD signature stays 403 (no unsigned probing of event handling), and logs the signature word, not the ignored one", async () => {
    for (const mode of ["wrong secret", "malformed", "missing"] as const) {
      const w = await world();
      const answer = await w.post("push", { ref: "x" }, mode === "wrong secret" ? { signWith: "forged-".padEnd(40, "f") } : { headers: { "x-hub-signature-256": mode === "missing" ? undefined : "nonsense" } });
      expect(answer.status, mode).toBe(403);
      expect(w.logs.map((entry) => entry.event), mode).toEqual(["github_webhook.signature_invalid"]);
      expect(w.sentSince(), mode).toEqual([]);
    }
  });

  it("an unhandled event with a malformed delivery id stays a 403 rejection even when the signature is valid", async () => {
    const w = await world();
    const answer = await w.post("push", { ref: "x" }, { deliveryId: "not-a-uuid" });
    expect(answer.status).toBe(403);
    expect(w.logs).toEqual([{ event: "github_webhook.rejected", reason: "header" }]);
  });

  it.each([
    ["a real GitHub version-1 (time-based) delivery id", "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe"],
    ["a version-4 id", "550e8400-e29b-41d4-a716-446655440000"],
    ["an upper-case version-1 id", "C95A50D8-E79B-11F1-9A76-3CDC2BDCB8FE"],
  ])("%s on a handled issue_comment: accepted and processed, not a header rejection", async (_name, deliveryId) => {
    const w = await world();
    const answer = await w.post("issue_comment", comment(), { deliveryId });
    expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.logs.some((entry) => entry.event === "github_webhook.rejected")).toBe(false);
    expect(w.row().lastHintKind).toBe("comment");
  });

  it.each([
    ["too short", "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8f"],
    ["too long", "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe0"],
    ["non-hex", "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fg"],
    ["extra characters around it", " c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe"],
    ["a trailing newline", "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe\n"],
    ["no dashes", "c95a50d8e79b11f19a763cdc2bdcb8fe"],
    ["empty", ""],
  ])("a malformed delivery id (%s) is a 403 header rejection even with a valid signature", async (_name, deliveryId) => {
    const w = await world();
    expect((await w.post("issue_comment", comment(), { deliveryId })).status).toBe(403);
    expect(w.logs).toEqual([{ event: "github_webhook.rejected", reason: "header" }]);
    expect(w.secretCalls).toEqual([]);
    expect(w.sentSince()).toEqual([]);
  });

  describe("through the real API Gateway event shapes (the adapter lower-cases the header names)", () => {
    const REAL_DELIVERY = "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe";
    const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    // A REST (v1) proxy event: mixed-case names plus multiValueHeaders. An HTTP (v2) event: lower-case names, `cookies`, requestContext.http.
    const eventOf = (shape: "rest-v1" | "http-v2", event: string, raw: string, signature: string) => shape === "rest-v1"
      ? { rawPath: "/v1/github/webhooks", body: raw, requestContext: { http: { method: "POST" }, requestId: "r1" },
        headers: { "X-GitHub-Delivery": REAL_DELIVERY, "X-GitHub-Event": event, "X-Hub-Signature-256": signature, "Content-Type": "application/json" },
        multiValueHeaders: { "X-GitHub-Delivery": [REAL_DELIVERY], "X-GitHub-Event": [event], "X-Hub-Signature-256": [signature] } }
      : { rawPath: "/v1/github/webhooks", body: raw, requestContext: { http: { method: "POST" }, requestId: "r2" }, cookies: [],
        headers: { "x-github-delivery": REAL_DELIVERY, "x-github-event": event, "x-hub-signature-256": signature, "content-type": "application/json" } };
    const route = async (shape: "rest-v1" | "http-v2", event: string, payload: unknown, signWith = SECRET) => {
      const w = await world();
      const raw = JSON.stringify(payload);
      const request = adaptHttpApiEvent(eventOf(shape, event, raw, sign(raw, signWith)));
      const answer = await handleGithubWebhookRoute({ headers: request.headers, body: request.body, secret: async () => SECRET, isSecretMissing: () => false, now: () => NOW, log: (entry) => w.logs.push(entry), legacy: w.legacy,
        core: { documentClient: w.db, tableName: "state", bindings: w.bindings } });
      return { answer, w };
    };
    it.each(["rest-v1", "http-v2"] as const)("%s: a valid signature on issue_comment with the real v1 delivery id is processed", async (shape) => {
      const { answer, w } = await route(shape, "issue_comment", comment());
      expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED", deliveryId: REAL_DELIVERY } });
      expect(w.logs.some((entry) => entry.event === "github_webhook.rejected")).toBe(false);
    });
    it.each(["rest-v1", "http-v2"] as const)("%s: the same delivery with a bad signature is 403", async (shape) => {
      const { answer, w } = await route(shape, "issue_comment", comment(), "forged-".padEnd(40, "f"));
      expect(answer.status).toBe(403);
      expect(w.logs.map((entry) => entry.event)).toEqual(["github_webhook.signature_invalid"]);
    });
    it.each(["rest-v1", "http-v2"] as const)("%s: a signed push is still 202 ignored", async (shape) => {
      const { answer, w } = await route(shape, "push", { ref: "x" });
      expect(answer).toEqual({ status: 202, body: { ignored: true } });
      expect(w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", reason: "unhandled_event", hook: "push", deliveryId: REAL_DELIVERY }]);
    });
  });

  describe("signed deliveries the legacy handler refuses: ignored (202), conflict (409) or rejected (403), every one logged (HTTP v2 event shape)", () => {
    const D = "c95a50d8-e79b-11f1-9a76-3cdc2bdcb8fe";
    const prComment = (overrides: Record<string, unknown> = {}) => ({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, issue: { number: 7, pull_request: { url: "https://api.github.com/x" } },
      comment: { id: 1, body: "private words", html_url: "https://github.com/example/demo/pull/7#issuecomment-1", updated_at: "2026-11-23T12:00:00Z", user: { login: "reviewer" } }, ...overrides });
    // No core bindings: the delivery goes to the legacy handler (real handleGithubWebhook over the fake table), as on an install without them.
    const legacyRoute = async (event: string, payload: unknown, options: { signWith?: string; deliveryId?: string; raw?: string; authorize?: boolean | "not_linked"; world?: Awaited<ReturnType<typeof world>> } = {}) => {
      const w = options.world ?? await world();
      const raw = options.raw ?? JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", options.signWith ?? SECRET).update(raw).digest("hex")}`;
      const request = adaptHttpApiEvent({ rawPath: "/v1/github/webhooks", body: raw, requestContext: { http: { method: "POST" }, requestId: "v2" },
        headers: { "x-github-delivery": options.deliveryId ?? D, "x-github-event": event, "x-hub-signature-256": signature } });
      const answer = await handleGithubWebhookRoute({ headers: request.headers, body: request.body, secret: async () => SECRET, isSecretMissing: () => false, now: () => NOW, log: (entry) => w.logs.push(entry),
        legacy: (secret) => handleGithubWebhook({ documentClient: w.db, tableName: "state", rawBody: raw, headers: request.headers, secret, now: () => new Date(NOW).toISOString(),
          authorizeRepository: async () => options.authorize ?? true, process: async () => undefined }) });
      return { answer, w };
    };
    const noDeliveryRow = (w: Awaited<ReturnType<typeof world>>) => expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#"))).toEqual([]);

    it("(a) a comment on a PLAIN ISSUE (not a pull request) is 202 ignored with an info line, and writes nothing", async () => {
      const { answer, w } = await legacyRoute("issue_comment", prComment({ issue: { number: 7 } }));
      expect(answer).toEqual({ status: 202, body: { ignored: true, reason: "payload_unsupported" } });
      expect(w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", hook: "issue_comment", action: "created", reason: "payload_unsupported", deliveryId: D }]);
      expect(JSON.stringify(w.logs)).not.toContain("private words");
      expect(w.writesSince()).toEqual([]);
      noDeliveryRow(w);
    });

    it("(a) a payload that does not parse, and an event the legacy path does not take, are 202 ignored too", async () => {
      const bad = await legacyRoute("pull_request", { nonsense: true });
      expect(bad.answer).toEqual({ status: 202, body: { ignored: true, reason: "payload_unsupported" } });
      expect(bad.w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", hook: "pull_request", reason: "payload_unsupported", deliveryId: D }]);
      const unsupported = await legacyRoute("check_suite", checkSuite("completed"));
      expect(unsupported.answer).toEqual({ status: 202, body: { ignored: true, reason: "event_unsupported" } });
      expect(unsupported.w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", hook: "check_suite", reason: "event_unsupported", deliveryId: D }]);
      expect(unsupported.w.writesSince()).toEqual([]);
    });

    it("(b) a signed delivery for a repository or pull request NO Rovara task tracks is 202 ignored (not_linked) with an info line, and writes nothing", async () => {
      const { answer, w } = await legacyRoute("issue_comment", prComment(), { authorize: "not_linked" });
      expect(answer).toEqual({ status: 202, body: { ignored: true, reason: "not_linked" } });
      expect(w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", hook: "issue_comment", action: "created", reason: "not_linked", deliveryId: D }]);
      expect(w.writesSince()).toEqual([]);
      noDeliveryRow(w);
    });

    it("(b) a link that exists but disagrees with the live scope is a real violation: 403 with a warn line, nothing written", async () => {
      const { answer, w } = await legacyRoute("issue_comment", prComment(), { authorize: false });
      expect(answer.status).toBe(403);
      expect(JSON.stringify(answer.body)).toContain("outside the registered installation and repository scope");
      expect(w.logs).toEqual([{ event: "github_webhook.refused", level: "warn", hook: "issue_comment", action: "created", reason: "scope_mismatch", deliveryId: D }]);
      expect(w.writesSince()).toEqual([]);
      noDeliveryRow(w);
    });

    it.each([["check_run", { action: "completed" }], ["check_suite", checkSuite("completed")], ["status", { state: "success" }]])("%s on the legacy path says event unsupported (202 ignored), never the scope text", async (event, payload) => {
      const { answer, w } = await legacyRoute(event, payload, { authorize: false });
      expect(answer).toEqual({ status: 202, body: { ignored: true, reason: "event_unsupported" } });
      expect(JSON.stringify(answer)).not.toContain("scope");
      expect(w.logs).toEqual([{ event: "github_webhook.ignored", level: "info", hook: event, reason: "event_unsupported", deliveryId: D }]);
    });

    it("(c) a REUSED delivery id with DIFFERENT content is 409 with a warn line; the same content again is still a duplicate", async () => {
      const w = await world();
      expect((await legacyRoute("issue_comment", prComment(), { world: w })).answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
      expect((await legacyRoute("issue_comment", prComment(), { world: w })).answer).toMatchObject({ status: 200, body: { delivery: "DUPLICATE" } });
      w.logs.length = 0;
      const other = await legacyRoute("issue_comment", prComment({ comment: { id: 2, body: "changed", html_url: "https://github.com/example/demo/pull/7#issuecomment-2", user: { login: "reviewer" } } }), { world: w });
      expect(other.answer.status).toBe(409);
      expect(other.answer.body).toMatchObject({ error: { code: "CONFLICT" } });
      expect(w.logs).toEqual([{ event: "github_webhook.conflict", level: "warn", hook: "issue_comment", action: "created", reason: "delivery_id_reused", deliveryId: D }]);
    });

    it("(d) a refusal that stays a rejection (a signed body that is not JSON) is a logged 403", async () => {
      const { answer, w } = await legacyRoute("issue_comment", undefined, { raw: "not json" });
      expect(answer.status).toBe(403);
      expect(w.logs).toEqual([{ event: "github_webhook.refused", level: "warn", hook: "issue_comment", reason: "refused", deliveryId: D }]);
      expect(w.writesSince()).toEqual([]);
    });

    it("a BAD signature is 403 before any of this, whatever the payload (no unsigned probing of the scope or payload checks)", async () => {
      for (const [event, payload, authorize] of [["issue_comment", prComment({ issue: { number: 7 } }), true], ["issue_comment", prComment(), false], ["issue_comment", prComment(), "not_linked"], ["issue_comment", prComment(), true]] as const) {
        const { answer, w } = await legacyRoute(event, payload, { signWith: "forged-".padEnd(40, "f"), authorize });
        expect(answer.status).toBe(403);
        expect(w.logs).toEqual([{ event: "github_webhook.signature_invalid" }]);
        expect(w.writesSince()).toEqual([]);
      }
    });

    it("a handled, mappable delivery is unchanged: ACCEPTED and one delivery row", async () => {
      const { answer, w } = await legacyRoute("issue_comment", prComment());
      expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED", deliveryId: D } });
      expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#"))).toHaveLength(1);
      expect(w.logs.some((entry) => entry.event === "github_webhook.ignored" || entry.event === "github_webhook.refused")).toBe(false);
    });
  });

  it("a missing event header with a valid signature is still a 403 rejection", async () => {
    const w = await world();
    const answer = await w.post("issue_comment", comment(), { headers: { "x-github-event": undefined } });
    expect(answer.status).toBe(403);
    expect(w.logs).toEqual([{ event: "github_webhook.rejected", reason: "header" }]);
  });

  it("a handled event is unchanged by the unhandled-event path: ACCEPTED with its hint, never the ignored-unhandled answer", async () => {
    const w = await world();
    const answer = await w.post("issue_comment", comment());
    expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.logs.some((entry) => entry.reason === "unhandled_event")).toBe(false);
    expect(w.row().lastHintKind).toBe("comment");
  });

  it("makes no Secrets Manager read per forged request: malformed ones read none, well-formed forged ones force at most one re-read per interval", async () => {
    const w = await world();
    for (let n = 0; n < 100; n += 1) await w.post("issue_comment", comment(), { headers: { "x-hub-signature-256": "nonsense" } });
    expect(w.secretCalls).toEqual([]);
    for (let n = 0; n < 100; n += 1) await w.post("issue_comment", comment(), { signWith: "forged-".padEnd(40, "f") });
    expect(w.secretCalls.filter((call) => call?.refresh === true)).toHaveLength(1);
    w.state.now += 31_000;
    await w.post("issue_comment", comment(), { signWith: "forged-".padEnd(40, "f") });
    expect(w.secretCalls.filter((call) => call?.refresh === true)).toHaveLength(2);
    expect(w.writesSince()).toEqual([]);
  });

  it("answers 503 and does no work while the secret is not configured, without asking the legacy path", async () => {
    const w = await world();
    const answer = await handleGithubWebhookRoute({ headers: { "x-github-event": "issue_comment", "x-github-delivery": "550e8400-e29b-41d4-a716-000000000001", "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: "{}", secret: async () => { throw new Error("missing"); }, isSecretMissing: () => true, now: () => NOW, log: () => undefined, legacy: w.legacy });
    expect(answer.status).toBe(503);
    expect(w.legacy).not.toHaveBeenCalled();
  });
});

describe("replay protection and the delivery rows", () => {
  it("the same delivery id twice has one effect; the second is DUPLICATE", async () => {
    const w = await world();
    const first = await w.post("issue_comment", comment(), { deliveryId: "550e8400-e29b-41d4-a716-0000000000aa" });
    expect(first).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    const hinted = w.row().lastHintAt;
    const second = await w.post("issue_comment", comment(), { deliveryId: "550e8400-e29b-41d4-a716-0000000000aa" });
    expect(second).toMatchObject({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.row().lastHintAt).toBe(hinted);
  });

  it("the same body under a FRESH delivery id is a duplicate with no effect", async () => {
    const w = await world();
    const raw = JSON.stringify(comment());
    await w.post("issue_comment", undefined, { raw });
    const hinted = w.row().lastHintAt;
    w.state.now += 5_000;
    const replay = await w.post("issue_comment", undefined, { raw });
    expect(replay).toMatchObject({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.row().lastHintAt).toBe(hinted);
  });

  it("the same delivery id with a different body is refused", async () => {
    const w = await world();
    await w.post("issue_comment", comment(), { deliveryId: "550e8400-e29b-41d4-a716-0000000000bb" });
    const other = await w.post("issue_comment", comment({ comment: { id: 2 } }), { deliveryId: "550e8400-e29b-41d4-a716-0000000000bb" });
    expect(other.status).toBe(409);
    expect(w.logs.at(-1)).toEqual({ event: "github_webhook.conflict", level: "warn", hook: "issue_comment", reason: "delivery_id_reused", deliveryId: "550e8400-e29b-41d4-a716-0000000000bb" });
  });

  it("binds the event name into the replay identity: a body signed for one event is not a duplicate of another", async () => {
    const w = await world();
    const raw = JSON.stringify({ ...comment(), pull_request: { number: 7 } });
    await w.post("issue_comment", undefined, { raw });
    const other = await w.post("pull_request_review_comment", undefined, { raw });
    expect(other).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
  });

  it("every delivery, body and counter row carries a NUMERIC expiry in epoch seconds, about 7 days out", async () => {
    const w = await world();
    await w.post("issue_comment", comment());
    const expected = Math.floor(NOW / 1000) + GITHUB_DELIVERY_TTL_SECONDS;
    const rows = w.db.find((item) => /^GITHUB_(DELIVERY|BODY|RL)#/.test(String(item.pk)));
    expect(rows.map((item) => String(item.pk).split("#")[0]).sort()).toEqual(["GITHUB_BODY", "GITHUB_DELIVERY", "GITHUB_RL"]);
    for (const item of rows) expect(typeof item[INDEX_EXPIRY_ATTRIBUTE], String(item.pk)).toBe("number");
    for (const item of rows.filter((entry) => !String(entry.pk).startsWith("GITHUB_RL"))) expect(item[INDEX_EXPIRY_ATTRIBUTE]).toBe(expected);
    const counter = rows.find((item) => String(item.pk).startsWith("GITHUB_RL"))!;
    expect(counter[INDEX_EXPIRY_ATTRIBUTE] as number).toBeGreaterThan(Math.floor(NOW / 1000));
    expect(counter[INDEX_EXPIRY_ATTRIBUTE] as number).toBeLessThan(Math.floor(NOW / 1000) + 3_600);
  });

  it("the legacy delivery row gets the same numeric 7-day expiry, and a completion refreshes it", async () => {
    const db = new FakeDynamoDb();
    const id = "550e8400-e29b-41d4-a716-0000000000cc";
    const base = { documentClient: db, tableName: "state", deliveryId: id, installationId: 77, repositoryId: 42, eventHash: "e".repeat(64), now: "2026-11-23T12:00:00.000Z",
      event: { kind: "PR_COMMENT" as const, action: "created", installationId: 77, repositoryId: 42, fullName: "example/demo", number: 7 } };
    expect(await reserveGithubWebhookDelivery(base)).toBe("reserved");
    expect(db.get(`GITHUB_DELIVERY#${id}`, "META")![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(Date.parse(base.now) / 1000) + GITHUB_DELIVERY_TTL_SECONDS);
  });

  it("a core delivery row is COMPLETED at once, holds no event body, and never enters the legacy recovery index", async () => {
    const w = await world();
    const id = "550e8400-e29b-41d4-a716-0000000000dd";
    await w.post("issue_comment", comment({ comment: { id: 9, body: "secret words" } }), { deliveryId: id });
    const stored = w.db.get(`GITHUB_DELIVERY#${id}`, "META")!;
    expect(stored).toMatchObject({ status: "COMPLETED", core: true, companyId: ORG_A });
    for (const field of ["event", "webhookRecoveryPk", "webhookRecoverySk", "nextAttemptAt", "leaseToken"]) expect(stored[field], field).toBeUndefined();
    expect(JSON.stringify(w.db.find(() => true))).not.toContain("secret words");
    expect(await listDueGithubWebhookDeliveries({ documentClient: w.db, tableName: "state", now: "2026-12-30T00:00:00.000Z", limit: 100 })).toEqual([]);
  });

  it("a wake that fails releases the reservation, so GitHub's redelivery is processed, not taken for a duplicate", async () => {
    const w = await world();
    const id = "550e8400-e29b-41d4-a716-0000000000ee";
    w.db.injectFault({ command: "UpdateCommand", match: (input) => (input.Key as { pk: string }).pk === "WORKFLOW_MERGE_RECOVERY", error: { name: "InternalServerError" } });
    await expect(w.post("issue_comment", comment(), { deliveryId: id })).rejects.toThrow();
    expect(w.db.get(`GITHUB_DELIVERY#${id}`, "META")).toBeUndefined();
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_BODY#"))).toEqual([]);
    expect(await w.post("issue_comment", comment(), { deliveryId: id })).toMatchObject({ body: { delivery: "ACCEPTED" } });
  });
});

describe("a signed delivery that maps to nothing is 202 IGNORED with zero writes", () => {
  type World = Awaited<ReturnType<typeof world>>;
  const status = (extra: Record<string, unknown> = {}) => ({ sha: SHA, state: "pending", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, ...extra });
  const cases: Array<[string, (w: World) => unknown, string, () => unknown, string]> = [
    ["an unknown installation", () => undefined, "issue_comment", () => comment({ installation: { id: 999 } }), "unknown_installation"],
    ["an unknown repository", () => undefined, "issue_comment", () => comment({ repository: { id: 42, full_name: "example/other" } }), "no_link"],
    ["an unknown pull request", () => undefined, "issue_comment", () => comment({ issue: { number: 99, pull_request: { url: "https://api.github.com/x" } } }), "no_link"],
    ["a comment on an issue (not a pull request)", () => undefined, "issue_comment", () => comment({ issue: { number: 7 } }), "unsupported_action"],
    ["an action the sweep does not care about", () => undefined, "pull_request", () => pullRequest("labeled"), "unsupported_action"],
    ["a malformed payload", () => undefined, "issue_comment", () => ({ action: "created", installation: { id: "77" } }), "malformed"],
    ["a pull request event with no pull request", () => undefined, "pull_request", () => comment({ issue: undefined }), "malformed"],
    ["a review thread event with an action that changes nothing", () => undefined, "pull_request_review_thread", () => pullRequest("edited"), "unsupported_action"],
    ["a review thread event with no pull request", () => undefined, "pull_request_review_thread", () => comment({ issue: undefined }), "malformed"],
    ["a check run that was only created", () => undefined, "check_run", () => ({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, check_run: { head_sha: SHA } }), "unsupported_action"],
    ["a check run of a head Rovara has no task for", () => undefined, "check_run", () => ({ action: "completed", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, check_run: { head_sha: "f".repeat(40) } }), "no_head"],
    ["a check suite that was only requested", () => undefined, "check_suite", () => checkSuite("requested"), "unsupported_action"],
    ["a pending commit status", () => undefined, "status", () => status(), "unsupported_action"],
    ["a head the company has no index for", () => undefined, "check_suite", () => checkSuite("completed", "b".repeat(40)), "no_head"],
    ["a suspended installation", async (w: World) => { await w.bindings.markLifecycle(77, "suspend", "550e8400-e29b-41d4-a716-0000000000f1"); }, "issue_comment", () => comment(), "installation_inactive"],
    ["a closed task", (w: World) => seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, sha: SHA, engine: "core", ended: true }), "issue_comment", () => comment(), "task_ended"],
    ["a task with no tracking row yet", (w: World) => w.db.delete(recoveryRowKey(TASK_A).pk, recoveryRowKey(TASK_A).sk), "issue_comment", () => comment(), "no_row"],
    ["a project that pins another repository", (w: World) => seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, sha: SHA, engine: "core", pinned: "example/elsewhere" }), "issue_comment", () => comment(), "repository_mismatch"],
    ["a workflow that no longer holds the linked pull request", (w: World) => w.db.set({ ...taskRecordKey(TASK_A), companyId: ORG_A, project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", pullRequests: [] } }), "issue_comment", () => comment(), "workflow_mismatch"],
  ];
  it.each(cases)("%s", async (_name, arrange, event, payload, reason) => {
    const w = await world();
    await arrange(w);
    const before = w.snapshot();
    const writesBefore = w.writesSince().length;
    const answer = await w.post(event, payload());
    expect(answer).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.writesSince().length).toBe(writesBefore);
    expect(w.logs.filter((entry) => entry.event === "github_webhook.ignored")).toMatchObject([{ reason }]);
    expect(w.legacy).not.toHaveBeenCalled();
  });

  it("the answer to GitHub says nothing about why", async () => {
    const w = await world();
    const known = await w.post("issue_comment", comment({ installation: { id: 999 } }));
    const unknown = await w.post("issue_comment", comment({ repository: { id: 42, full_name: "example/other" } }));
    expect(known).toEqual(unknown);
  });
});

describe("the mapping is exact and never crosses a company", () => {
  it("a delivery under another company's installation wakes nothing, in both directions", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_B, company: ORG_B, number: 7, repo: "example/b-repo", engine: "core" });
    const before = w.snapshot();
    // Company B's installation names company A's repository and pull request.
    expect(await w.post("issue_comment", comment({ installation: { id: 78 } }))).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ event: "github_webhook.ignored", reason: "company_mismatch" });
    // And company A's installation names company B's.
    expect(await w.post("issue_comment", comment({ repository: { id: 43, full_name: "example/b-repo" } }))).toMatchObject({ status: 202 });
    expect(w.snapshot()).toBe(before);
  });

  it("another company's LEGACY task is ignored too, never handed to the legacy path", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_B, company: ORG_B, number: 9, repo: "example/b-repo", engine: "workflow" });
    const before = w.snapshot();
    const answer = await w.post("issue_comment", comment({ repository: { id: 43, full_name: "example/b-repo" }, issue: { number: 9, pull_request: { url: "https://api.github.com/x" } } }));
    expect(answer).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.legacy).not.toHaveBeenCalled();
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ reason: "company_mismatch" });
  });

  it("a core task with no company stamp is not the installation's, even for the install's implicit company", async () => {
    const w = await world();
    await w.bindings.claim(IMPLICIT_COMPANY_ID, 79, "acct-implicit", "operator");
    seed(w.db, { taskId: TASK_B, company: IMPLICIT_COMPANY_ID, number: 9, repo: "example/i-repo", engine: "core" });
    const task = w.db.get(taskRecordKey(TASK_B).pk, taskRecordKey(TASK_B).sk)!;
    delete task["companyId"];
    const before = w.snapshot();
    const answer = await w.post("issue_comment", comment({ installation: { id: 79 }, repository: { id: 44, full_name: "example/i-repo" }, issue: { number: 9, pull_request: { url: "https://api.github.com/x" } } }));
    expect(answer).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ reason: "company_mismatch" });
  });

  it("a head-index item that names another company is not believed, even inside this company's partition", async () => {
    const w = await world();
    w.db.set({ ...prHeadKey(ORG_A, "example/demo", "e".repeat(40)), entityType: "PR_HEAD", orgId: ORG_B, taskId: TASK_A, repositoryId: "demo", number: 7 });
    const before = w.snapshot();
    expect(await w.post("check_suite", checkSuite("completed", "e".repeat(40)))).toMatchObject({ status: 202 });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ reason: "no_head" });
  });

  it("a check event is resolved only through the delivering company's own head index", async () => {
    const w = await world();
    const before = w.snapshot();
    expect(await w.post("check_suite", checkSuite("completed", SHA, { installation: { id: 78 } }))).toMatchObject({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ reason: "no_head" });
    expect(await w.post("check_suite", checkSuite("completed"))).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.row()).toMatchObject({ lastHintKind: "checks" });
  });

  it("wakes only the row of the task the delivery names", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_B, company: ORG_A, number: 8, sha: "c".repeat(40), repo: "example/demo", engine: "core" });
    const other = JSON.stringify(w.row(TASK_B));
    await w.post("issue_comment", comment());
    expect(w.row()).toMatchObject({ nextAttemptAt: NOW, quiet: 0, lastHintKind: "comment", feedbackDueAt: NOW });
    expect(JSON.stringify(w.row(TASK_B))).toBe(other);
  });

  it("leaves a legacy task to the legacy path, with the secret that verified", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, engine: "workflow" });
    expect((await w.post("issue_comment", comment())).status).toBe(200);
    expect(w.legacy).toHaveBeenCalledTimes(1);
    expect(w.legacy).toHaveBeenCalledWith(SECRET);
    expect(w.writesSince()).toEqual([]);
  });

  it("an installation with no binding row (the install's old single company) is the legacy path's, not a core wake", async () => {
    const db = new FakeDynamoDb();
    const bindings = new GithubInstallationBindings(db, "state");
    seed(db, { taskId: TASK_A, company: IMPLICIT_COMPANY_ID, number: 7, engine: "core" });
    const legacy = vi.fn(async () => ({ status: "ACCEPTED" as const, deliveryId: "x" }));
    const raw = JSON.stringify(comment());
    const answer = await handleGithubWebhookRoute({ headers: { "x-github-event": "issue_comment", "x-github-delivery": "550e8400-e29b-41d4-a716-0000000000a1", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` },
      body: raw, secret: async () => SECRET, isSecretMissing: () => false, now: () => NOW, log: () => undefined, legacy, core: { documentClient: db, tableName: "state", bindings } });
    expect(answer.status).toBe(200);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(db.get(recoveryRowKey(TASK_A).pk, recoveryRowKey(TASK_A).sk)!["lastHintAt"]).toBeUndefined();
  });

  it("where the legacy handler is unscoped (hosted), an installation with no binding row AFTER the backfill marker is the legacy path's, never a core 202", async () => {
    const w = await world({ legacyUnscoped: true });
    expect((await w.post("issue_comment", comment({ installation: { id: 999 } }))).status).toBe(200);
    expect(w.legacy).toHaveBeenCalledTimes(1);
    expect(w.writesSince()).toEqual([]);
  });

  it("where the legacy handler is unscoped, a legacy task with NO companyId on an installation bound to a named company is the legacy path's, not company_mismatch", async () => {
    const w = await world({ legacyUnscoped: true });
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, engine: "workflow" });
    const record = w.db.get(taskRecordKey(TASK_A).pk, taskRecordKey(TASK_A).sk)!;
    delete record["companyId"];
    w.db.set(record);
    expect((await w.post("issue_comment", comment())).status).toBe(200);
    expect(w.legacy).toHaveBeenCalledTimes(1);
  });

  it("an unscoped legacy never hands over another company's task: a legacy task of an explicit other company is still IGNORED", async () => {
    const w = await world({ legacyUnscoped: true });
    seed(w.db, { taskId: TASK_A, company: ORG_B, number: 7, engine: "workflow" });
    expect(await w.post("issue_comment", comment())).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.legacy).not.toHaveBeenCalled();
  });

  it("review R5: where the legacy handler is unscoped, a CORE task with no companyId stays the core's (company_mismatch, 202 IGNORED): legacyUnscoped only hands over legacy-owned tasks", async () => {
    const w = await world({ legacyUnscoped: true });
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, engine: "core" });
    const record = w.db.get(taskRecordKey(TASK_A).pk, taskRecordKey(TASK_A).sk)!;
    delete record["companyId"];
    w.db.set(record);
    expect(await w.post("issue_comment", comment())).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.legacy).not.toHaveBeenCalled();
    expect(w.writesSince()).toEqual([]);
  });

  it("review R6: where the legacy handler is unscoped, a CORE-stamped task with no record at all is never handed to the legacy path", async () => {
    const w = await world({ legacyUnscoped: true });
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, engine: "core" });
    w.db.delete(taskRecordKey(TASK_A).pk, taskRecordKey(TASK_A).sk);
    expect(await w.post("issue_comment", comment())).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.legacy).not.toHaveBeenCalled();
  });

  it("review R7: where the legacy handler IS scoped (default), a legacy task with no companyId on a named company's installation keeps the W0 answer (202 IGNORED, legacy not called)", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, engine: "workflow" });
    const record = w.db.get(taskRecordKey(TASK_A).pk, taskRecordKey(TASK_A).sk)!;
    delete record["companyId"];
    w.db.set(record);
    expect(await w.post("issue_comment", comment())).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.legacy).not.toHaveBeenCalled();
  });

  it("without installation bindings there is no core branch: every delivery goes to the legacy path", async () => {
    const w = await world();
    expect((await w.post("issue_comment", comment(), { core: false })).status).toBe(200);
    expect(w.legacy).toHaveBeenCalledTimes(1);
  });
});

describe("what each event does to the tracking row", () => {
  it.each([
    ["pull_request closed", "pull_request", () => pullRequest("closed"), "pull_request", []],
    ["pull_request synchronize", "pull_request", () => pullRequest("synchronize"), "pull_request", ["checksDueAt"]],
    ["pull_request_review submitted", "pull_request_review", () => pullRequest("submitted", { review: { id: 1 } }), "review", ["feedbackDueAt"]],
    ["pull_request_review_thread resolved", "pull_request_review_thread", () => pullRequest("resolved", { thread: { node_id: "t" } }), "comment", ["feedbackDueAt"]],
    ["pull_request_review_thread unresolved", "pull_request_review_thread", () => pullRequest("unresolved", { thread: { node_id: "t" } }), "comment", ["feedbackDueAt"]],
    ["pull_request_review_comment created", "pull_request_review_comment", () => pullRequest("created", { comment: { id: 1 } }), "comment", ["feedbackDueAt"]],
    ["issue_comment edited", "issue_comment", () => comment({ action: "edited" }), "comment", ["feedbackDueAt"]],
    ["check_suite completed", "check_suite", () => checkSuite("completed"), "checks", ["checksDueAt"]],
    ["check_run completed", "check_run", () => ({ action: "completed", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, check_run: { head_sha: SHA } }), "checks", ["checksDueAt"]],
    ["status success", "status", () => ({ sha: SHA, state: "success", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" } }), "checks", ["checksDueAt"]],
  ] as const)("%s", async (_name, event, payload, kind, due) => {
    const w = await world();
    const answer = await w.post(event, payload());
    expect(answer).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    const row = w.row();
    expect(row).toMatchObject({ nextAttemptAt: NOW, quiet: 0, lastHintKind: kind, attempts: 0 });
    for (const field of ["feedbackDueAt", "checksDueAt"]) expect(row[field] !== undefined, field).toBe((due as readonly string[]).includes(field));
    // Nothing of the delivery is stored but numbers and one fixed word.
    expect(Object.keys(row).sort()).toEqual(["attempts", "entityType", "kind", "lastHintAt", "lastHintKind", "nextAttemptAt", "pk", "quiet", "sk", "taskId", ...due].sort());
  });

  it("makes no GitHub call: the receiver has none to make", async () => {
    // The route's inputs hold no GitHub client at all; the legacy path (which has one) is never reached for a core task.
    const w = await world();
    await w.post("issue_comment", comment());
    expect(w.legacy).not.toHaveBeenCalled();
  });
});

describe("hints are monotonic, coalesced and never dropped", () => {
  it("a hint never moves a row's times backwards, and each is at least a millisecond after the last (a pass that read the row earlier keeps it)", async () => {
    const w = await world();
    for (let n = 0; n < 5; n += 1) await w.post("issue_comment", comment({ comment: { id: n } }));
    expect(w.row().lastHintAt).toBe(NOW + 4);
    w.state.now -= 60_000;
    await w.post("issue_comment", comment({ comment: { id: 99 } }));
    expect(w.row().lastHintAt).toBe(NOW + 5);
    expect(w.row().feedbackDueAt).toBe(NOW);
    expect(w.row().nextAttemptAt).toBe(NOW - 60_000);
  });

  it("a second comment within 20 seconds of the first is recorded, not dropped", async () => {
    const w = await world();
    await w.post("issue_comment", comment({ comment: { id: 1 } }));
    const first = w.row();
    w.state.now += 5_000;
    await w.post("issue_comment", comment({ comment: { id: 2 } }));
    expect(w.row().lastHintAt).toBeGreaterThan(first.lastHintAt as number);
    expect(w.row().feedbackDueAt).toBe(NOW + 5_000);
  });

  it("any order of the same events leaves the same row (idempotent, out-of-order safe)", async () => {
    const events: Array<[string, unknown]> = [["pull_request", pullRequest("closed")], ["pull_request", pullRequest("synchronize")], ["issue_comment", comment()], ["check_suite", checkSuite("completed")]];
    const permutations = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
    const finals: string[] = [];
    for (const order of permutations) {
      const w = await world();
      for (const index of order) { const [event, payload] = events[index]!; await w.post(event, payload); }
      const { lastHintAt, ...others } = w.row() as Record<string, unknown>;
      const { lastHintKind, ...rest } = others;
      expect(lastHintKind).toBeDefined();
      expect(lastHintAt).toBe(NOW + 3);
      finals.push(JSON.stringify(Object.entries(rest).sort(([x], [y]) => x.localeCompare(y))));
    }
    expect(new Set(finals).size).toBe(1);
  });

  it("a burst of 50 events on one task leaves one awake row and does not touch its failure count", async () => {
    const w = await world();
    for (let n = 0; n < 50; n += 1) await w.post("issue_comment", comment({ comment: { id: n } }));
    expect(w.row()).toMatchObject({ attempts: 0, nextAttemptAt: NOW, lastHintAt: NOW + 49 });
  });

  it("a hint does not skip a failing row's backoff, and still records its time", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, sha: SHA, engine: "core", tracking: { attempts: 3, lastAttemptAt: NOW - 10_000, nextAttemptAt: NOW + 170_000 } });
    await w.post("issue_comment", comment());
    // 3 failures: a 180 s wait from the last attempt, 170 s from now: the hint leaves the row at its own time.
    expect(w.row()).toMatchObject({ nextAttemptAt: NOW + 170_000, attempts: 3, lastHintAt: NOW, quiet: 0 });
    // A failing row whose wait is over is made due now; one far in the future is lowered only to its wait.
    seed(w.db, { taskId: TASK_A, company: ORG_A, number: 7, sha: SHA, engine: "core", tracking: { attempts: 3, lastAttemptAt: NOW - 400_000, nextAttemptAt: NOW + 900_000 } });
    await w.post("issue_comment", comment({ comment: { id: 2 } }));
    expect(w.row().nextAttemptAt).toBe(NOW);
  });

  it("two hints that land at once both land: a lost compare-and-set is retried", async () => {
    const w = await world();
    w.db.injectFault({ command: "UpdateCommand", match: (input) => (input.Key as { pk: string }).pk === "WORKFLOW_MERGE_RECOVERY", error: { name: "ConditionalCheckFailedException" }, times: 2 });
    expect(await hintTrackingRow({ documentClient: w.db, tableName: "state" }, TASK_A, NOW, { kind: "comment", due: ["feedbackDueAt"] })).toBe("woken");
    expect(w.row()).toMatchObject({ lastHintAt: NOW, feedbackDueAt: NOW });
  });

  it("a row that was woken by a concurrent hint every round reports coalesced, never an error", async () => {
    const w = await world();
    w.db.injectFault({ command: "UpdateCommand", match: (input) => (input.Key as { pk: string }).pk === "WORKFLOW_MERGE_RECOVERY", error: { name: "ConditionalCheckFailedException" }, times: 50 });
    expect(await hintTrackingRow({ documentClient: w.db, tableName: "state" }, TASK_A, NOW, { kind: "comment", due: [] })).toBe("coalesced");
  });

  it("a row of another kind, or none, is never written", async () => {
    const w = await world();
    w.db.set({ ...recoveryRowKey(TASK_B), kind: "other", taskId: TASK_B });
    const before = w.snapshot();
    expect(await hintTrackingRow({ documentClient: w.db, tableName: "state" }, TASK_B, NOW, { kind: "comment", due: [] })).toBe("no_row");
    expect(await hintTrackingRow({ documentClient: w.db, tableName: "state" }, "33333333-3333-4333-8333-333333333333", NOW, { kind: "comment", due: [] })).toBe("no_row");
    expect(w.snapshot()).toBe(before);
  });
});

describe("one tenant's flood cannot starve the others", () => {
  it("an installation over its minute is THROTTLED with no effect, and another installation is not affected", async () => {
    const w = await world({ perMinute: 3 });
    seed(w.db, { taskId: TASK_B, company: ORG_B, number: 7, repo: "example/b-repo", engine: "core" });
    for (let n = 0; n < 3; n += 1) expect((await w.post("issue_comment", comment({ comment: { id: n } }))).body).toMatchObject({ delivery: "ACCEPTED" });
    const hinted = w.row().lastHintAt;
    const over = await w.post("issue_comment", comment({ comment: { id: 10 } }));
    expect(over).toEqual({ status: 202, body: { delivery: "THROTTLED" } });
    expect(w.row().lastHintAt).toBe(hinted);
    // Another container (no memory of the minute) is held by the table's own count.
    resetGithubWebhookWindows();
    expect(await w.post("issue_comment", comment({ comment: { id: 12 } }))).toEqual({ status: 202, body: { delivery: "THROTTLED" } });
    expect(w.row().lastHintAt).toBe(hinted);
    expect(w.logs.filter((entry) => entry.event === "github_webhook.rate_limited").map((entry) => entry.where)).toEqual(["memory", "table"]);
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#")).length).toBe(3);
    const other = await w.post("issue_comment", comment({ installation: { id: 78 }, repository: { id: 43, full_name: "example/b-repo" } }));
    expect(other).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    // The next minute starts clean.
    w.state.now += 61_000;
    expect((await w.post("issue_comment", comment({ comment: { id: 11 } }))).body).toMatchObject({ delivery: "ACCEPTED" });
  });

  it("the default allowance is generous (600 a minute) and forged traffic creates no counter rows", async () => {
    expect(GITHUB_WEBHOOK_PER_MINUTE).toBe(600);
    const w = await world();
    for (let n = 0; n < 20; n += 1) await w.post("issue_comment", comment(), { signWith: "forged-".padEnd(40, "f") });
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_RL#"))).toEqual([]);
  });
});

describe("logs carry fixed words only", () => {
  it("no line names the secret, a signature, a repository, a company or a person's words", async () => {
    const w = await world();
    const raw = JSON.stringify(comment({ comment: { id: 5, body: "private words of a reviewer" } }));
    await w.post("issue_comment", undefined, { raw });
    await w.post("issue_comment", undefined, { raw: raw.replace("private", "other"), signWith: "forged-".padEnd(40, "f") });
    await w.post("issue_comment", comment({ installation: { id: 999 } }));
    const text = JSON.stringify(w.logs);
    for (const forbidden of [SECRET, "sha256=", "example/demo", ORG_A, ORG_B, "private words", "acct-a"]) expect(text).not.toContain(forbidden);
    expect(w.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["github_webhook.accepted", "github_webhook.signature_invalid", "github_webhook.ignored"]));
  });
});

// Opus review (W0, b903585c3): three guards no test above failed without.
describe("Opus review tests", () => {
  it("one installation's flood in a container does not use up another installation's minute in that same container (the memory window is per installation)", async () => {
    const w = await world({ perMinute: 3 });
    seed(w.db, { taskId: TASK_B, company: ORG_B, number: 7, repo: "example/b-repo", engine: "core" });
    for (let n = 0; n < 6; n += 1) await w.post("issue_comment", comment({ comment: { id: n } }));
    expect(w.logs.filter((entry) => entry.event === "github_webhook.rate_limited").map((entry) => entry.where)).toEqual(["memory", "memory", "memory"]);
    // No reset of the windows: the same container now serves the other installation.
    const other = await w.post("issue_comment", comment({ installation: { id: 78 }, repository: { id: 43, full_name: "example/b-repo" } }));
    expect(other).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect(w.row(TASK_B)).toMatchObject({ lastHintKind: "comment" });
  });

  it("a check event whose head names one task while the pull request's link names another wakes nothing", async () => {
    const w = await world();
    seed(w.db, { taskId: TASK_B, company: ORG_A, number: 8, repo: "example/demo", engine: "core" });
    // The company's own head index says pull request 7 belongs to TASK_B, but pull request 7's link names TASK_A.
    w.db.set({ ...prHeadKey(ORG_A, "example/demo", "e".repeat(40)), entityType: "PR_HEAD", orgId: ORG_A, taskId: TASK_B, repositoryId: "demo", number: 7 });
    const before = w.snapshot();
    expect(await w.post("check_suite", checkSuite("completed", "e".repeat(40)))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ event: "github_webhook.ignored", reason: "no_head" });
  });

  it("a released task is ended: IGNORED with zero writes", async () => {
    const w = await world();
    w.db.set({ ...w.db.get(taskRecordKey(TASK_A).pk, taskRecordKey(TASK_A).sk)!, releasedAt: "2026-11-22T00:00:00.000Z" });
    const before = w.snapshot();
    expect(await w.post("issue_comment", comment())).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.snapshot()).toBe(before);
    expect(w.logs.at(-1)).toMatchObject({ reason: "task_ended" });
  });
});
