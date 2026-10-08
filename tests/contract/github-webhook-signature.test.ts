import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow.js";
import { claimGithubWebhookDelivery, completeGithubWebhookDelivery, findLinkedGithubWorkflowPullRequest, listDueGithubWebhookDeliveries, processGithubWebhookDelivery, receiveGithubWebhook, reconcileTaskPullRequestFeedback, reserveGithubWebhookDelivery, verifyGithubWebhookSignature } from "../../packages/broker/src/aws/github-webhooks.js";
import type { ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";
import type { GitHubPullRequestFeedback } from "../../packages/broker/src/github-app.js";

function commandInput(command: unknown): { constructor: { name: string }; input: Record<string, unknown> } {
  return command as { constructor: { name: string }; input: Record<string, unknown> };
}

function objectInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

describe("GitHub webhook signature verification", () => {
  it("resolves only PRs already linked to a workflow task", async () => {
    const record = {
      pk: "GITHUB_PR#example/demo", sk: "PR#0000000042", entityType: "GITHUB_WORKFLOW_PR",
      repositoryFullName: "Example/Demo", repositoryId: "demo", number: 42,
      url: "https://github.com/Example/Demo/pull/42", taskId: "task-1", workspaceId: "workspace-1",
      candidateDigest: "a".repeat(64), createdAt: "2026-10-05T12:00:00.000Z",
    };
    const documentClient = { send: async () => ({ Item: record }) };
    await expect(findLinkedGithubWorkflowPullRequest({ documentClient, tableName: "state", repositoryFullName: "example/demo", number: 42 })).resolves.toEqual(record);
    await expect(findLinkedGithubWorkflowPullRequest({ documentClient, tableName: "state", repositoryFullName: "other/demo", number: 42 })).resolves.toBeUndefined();
    await expect(findLinkedGithubWorkflowPullRequest({ documentClient, tableName: "state", repositoryFullName: "example/demo", number: 43 })).resolves.toBeUndefined();
  });

  it("accepts only the exact body signed with the configured secret", () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
    const secret = "fixture-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

    expect(verifyGithubWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyGithubWebhookSignature(body, signature, "different-secret")).toBe(false);
  });

  it("rejects malformed or missing signatures", () => {
    expect(verifyGithubWebhookSignature("{}", undefined, "secret")).toBe(false);
    expect(verifyGithubWebhookSignature("{}", "sha1=abc", "secret")).toBe(false);
    expect(verifyGithubWebhookSignature("{}", `sha256=${"z".repeat(64)}`, "secret")).toBe(false);
  });

  it("checks registered installation and repository scope for a pull-request event", async () => {
    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 777 },
      repository: { id: 1234, full_name: "acme/payments" },
      pull_request: { number: 9, state: "open", merged: false },
    });
    const signature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(payload).digest("hex")}`;
    const headers = { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440000", "x-github-event": "pull_request" };
    const reserve = async () => "reserved" as const;

    const accepted = await receiveGithubWebhook({
      rawBody: payload, headers, secret: "fixture-webhook-secret",
      authorizeRepository: async ({ installationId, repositoryId, fullName, pullRequestNumber }) => installationId === 777 && repositoryId === 1234 && fullName === "acme/payments" && pullRequestNumber === 9,
      reserveDelivery: reserve,
    });
    expect(accepted).toMatchObject({ delivery: "ACCEPTED", event: { kind: "PULL_REQUEST", number: 9 } });

    await expect(receiveGithubWebhook({
      rawBody: payload, headers, secret: "fixture-webhook-secret",
      authorizeRepository: async () => false,
      reserveDelivery: reserve,
    })).rejects.toThrow(/registered installation and repository/);
    const duplicate = await receiveGithubWebhook({
      rawBody: payload, headers, secret: "fixture-webhook-secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "duplicate",
    });
    expect(duplicate.delivery).toBe("DUPLICATE");
  });

  it("rejects GitHub issue events so they cannot start or update AgentX work", async () => {
    const payload = JSON.stringify({ action: "opened", installation: { id: 777 }, repository: { id: 1234, full_name: "acme/payments" }, issue: { number: 9, title: "Fix it" } });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    await expect(receiveGithubWebhook({
      rawBody: payload,
      headers: { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440000", "x-github-event": "issues" },
      secret: "secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "reserved",
    })).rejects.toThrow(/unsupported/);
  });

  it("accepts PR review comments as untrusted owner-review input", async () => {
    const payload = JSON.stringify({
      action: "created",
      installation: { id: 777 },
      repository: { id: 1234, full_name: "acme/payments" },
      pull_request: { number: 9, state: "open", merged: false },
      comment: { id: 4321, body: "Please handle this edge case", html_url: "https://github.com/acme/payments/pull/9#discussion_r4321", user: { login: "reviewer" } },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    const received = await receiveGithubWebhook({
      rawBody: payload,
      headers: { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440001", "x-github-event": "pull_request_review_comment" },
      secret: "secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "reserved",
    });
    expect(received.event).toMatchObject({
      kind: "PR_COMMENT", action: "created", number: 9,
      comment: { id: 4321, body: "Please handle this edge case", url: "https://github.com/acme/payments/pull/9#discussion_r4321", author: "reviewer", source: "review_comment" },
    });
  });

  it("accepts discussion comments only when the issue is a pull request", async () => {
    const payload = JSON.stringify({
      action: "created",
      installation: { id: 777 },
      repository: { id: 1234, full_name: "acme/payments" },
      issue: { number: 9, pull_request: { url: "https://api.github.com/repos/acme/payments/pulls/9" } },
      comment: { id: 4322, body: "What about retries?", html_url: "https://github.com/acme/payments/pull/9#issuecomment-4322", user: { login: "reviewer" } },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    const received = await receiveGithubWebhook({
      rawBody: payload,
      headers: { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440002", "x-github-event": "issue_comment" },
      secret: "secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "reserved",
    });
    expect(received.event).toMatchObject({ kind: "PR_COMMENT", number: 9, comment: { id: 4322, source: "pr_discussion" } });
  });

  it("rejects issue discussion comments even when the repository is registered", async () => {
    const payload = JSON.stringify({ action: "created", installation: { id: 777 }, repository: { id: 1234, full_name: "acme/payments" }, issue: { number: 9 }, comment: { id: 4322, body: "ordinary issue comment", user: { login: "reviewer" } } });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    await expect(receiveGithubWebhook({
      rawBody: payload,
      headers: { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440003", "x-github-event": "issue_comment" },
      secret: "secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "reserved",
    })).rejects.toThrow(/unsupported/);
  });

  it("rejects a delivery ID reused for different signed content", async () => {
    const payload = JSON.stringify({ action: "opened", installation: { id: 777 }, repository: { id: 1234, full_name: "acme/payments" }, pull_request: { number: 9, state: "open" } });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    await expect(receiveGithubWebhook({
      rawBody: payload,
      headers: { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440000", "x-github-event": "pull_request" },
      secret: "secret",
      authorizeRepository: async () => true,
      reserveDelivery: async () => "conflict",
    })).rejects.toThrow(/delivery ID was reused/);
  });

  it("binds the unsigned GitHub event header to the durable delivery identity", async () => {
    const payload = JSON.stringify({ action: "created", installation: { id: 777 }, repository: { id: 1234, full_name: "acme/payments" }, pull_request: { number: 9, state: "open" }, issue: { number: 9, pull_request: { url: "https://api.github.com/repos/acme/payments/pulls/9" } }, comment: { id: 43, body: "review", html_url: "https://github.com/acme/payments/pull/9#issuecomment-43", user: { login: "reviewer" } } });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    const hashes = new Map<string, string>();
    const reserveDelivery = async (delivery: { deliveryId: string; eventHash: string }) => {
      const prior = hashes.get(delivery.deliveryId);
      if (prior === undefined) { hashes.set(delivery.deliveryId, delivery.eventHash); return "reserved" as const; }
      return prior === delivery.eventHash ? "retry" as const : "conflict" as const;
    };
    const common = { "x-hub-signature-256": signature, "x-github-delivery": "550e8400-e29b-41d4-a716-446655440011" };
    const input = { rawBody: payload, secret: "secret", authorizeRepository: async () => true, reserveDelivery };
    await receiveGithubWebhook({ ...input, headers: { ...common, "x-github-event": "pull_request_review_comment" } });
    await expect(receiveGithubWebhook({ ...input, headers: { ...common, "x-github-event": "issue_comment" } })).rejects.toThrow(/delivery ID was reused/);
  });

  it("durably reserves each GitHub delivery once and detects content conflicts", async () => {
    const records = new Map<string, Record<string, unknown>>();
    const documentClient = {
      async send(command: unknown) {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        const keyData = objectInput(value.input.Key);
        const itemData = objectInput(value.input.Item);
        const key = `${stringField(keyData.pk ?? itemData.pk)}/${stringField(keyData.sk ?? itemData.sk)}`;
        if (value.constructor.name === "PutCommand") {
          if (records.has(key)) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          records.set(key, itemData);
          return {};
        }
        if (value.constructor.name === "UpdateCommand") {
          const record = records.get(key);
          if (!record) throw new Error("missing record");
          const values = objectInput(value.input.ExpressionAttributeValues);
          if (values[":completed"] === undefined) {
            if (record.status !== "RECEIVED" && record.status !== "RETRYABLE") throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
            record.status = "PROCESSING";
            record.leaseToken = values[":leaseToken"];
          } else {
            if (record.status !== "PROCESSING" || record.leaseToken !== values[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
            record.status = values[":completed"];
          }
          return { Attributes: record };
        }
        return { Item: records.get(key) };
      },
    };
    const delivery = {
      documentClient,
      tableName: "state",
      deliveryId: "550e8400-e29b-41d4-a716-446655440000",
      installationId: 777,
      repositoryId: 1234,
      eventHash: "a".repeat(64),
      event: { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 },
      now: "2026-10-05T12:00:00.000Z",
    };
    expect(await reserveGithubWebhookDelivery(delivery)).toBe("reserved");
    expect(await reserveGithubWebhookDelivery(delivery)).toBe("retry");
    const leaseToken = "550e8400-e29b-41d4-a716-446655440005";
    expect(await claimGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId: delivery.deliveryId, leaseToken, now: "2026-10-05T12:00:30.000Z" })).toBe(true);
    expect(await claimGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId: delivery.deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440006", now: "2026-10-05T12:00:31.000Z" })).toBe(false);
    await completeGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId: delivery.deliveryId, leaseToken, now: "2026-10-05T12:01:00.000Z" });
    expect(await reserveGithubWebhookDelivery(delivery)).toBe("duplicate");
    expect(await reserveGithubWebhookDelivery({ ...delivery, eventHash: "b".repeat(64) })).toBe("conflict");
  });

  it("marks a delivery complete after processing and leaves failed work retryable", async () => {
    const records = new Map<string, Record<string, unknown>>();
    const documentClient = {
      async send(command: unknown) {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        if (value.constructor.name === "QueryCommand") {
          const queryValues = objectInput(value.input.ExpressionAttributeValues);
          const dueAt = stringField(queryValues[":sk"]);
          return { Items: [...records.values()].filter(record => record.status === "RETRYABLE"
            && typeof record.webhookRecoverySk === "string" && record.webhookRecoverySk <= dueAt) };
        }
        const keyData = objectInput(value.input.Key);
        const itemData = objectInput(value.input.Item);
        const key = `${stringField(keyData.pk ?? itemData.pk)}/${stringField(keyData.sk ?? itemData.sk)}`;
        if (value.constructor.name === "PutCommand") {
          if (records.has(key)) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          records.set(key, itemData);
          return {};
        }
        const record = records.get(key);
        if (!record) throw new Error("missing record");
        if (value.constructor.name === "GetCommand") return { Item: record };
        const values = objectInput(value.input.ExpressionAttributeValues);
        if (values[":completed"] !== undefined) {
          if (record.status !== "PROCESSING" || record.leaseToken !== values[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "COMPLETED";
        } else if (values[":one"] === undefined && values[":retryable"] !== undefined) {
          if (record.status !== "PROCESSING" || record.leaseToken !== values[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "RETRYABLE";
          record.nextAttemptAt = values[":nextAttemptAt"];
          record.webhookRecoveryPk = values[":recoveryPk"];
          record.webhookRecoverySk = values[":recoverySk"];
        } else {
          if (record.status !== "RECEIVED" && record.status !== "RETRYABLE") throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "PROCESSING";
          record.leaseToken = values[":leaseToken"];
          delete record.nextAttemptAt;
        }
        return { Attributes: record };
      },
    };
    const deliveryId = "550e8400-e29b-41d4-a716-446655440010";
    const event = { delivery: "ACCEPTED" as const, deliveryId, event: { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 } };
    await reserveGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, installationId: 777, repositoryId: 1234, eventHash: "d".repeat(64), event: event.event, now: "2026-10-05T12:00:00.000Z" });
    let attempts = 0;
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: event, now: () => "2026-10-05T12:00:01.000Z",
      process: async () => { attempts += 1; throw new Error("transient GitHub API failure"); },
    })).rejects.toThrow(/transient/);
    const restartedClient = { send: documentClient.send.bind(documentClient) };
    await expect(listDueGithubWebhookDeliveries({ documentClient: restartedClient, tableName: "state", now: "2026-10-05T12:01:02.000Z" }))
      .resolves.toEqual([{ deliveryId, event: event.event }]);
    await expect(processGithubWebhookDelivery({
      documentClient: restartedClient, tableName: "state", received: event, now: () => "2026-10-05T12:01:02.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("PROCESSED");
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: { ...event, delivery: "DUPLICATE" }, now: () => "2026-10-05T12:00:03.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("DUPLICATE");
    expect(attempts).toBe(2);
  });

  it("lists persisted webhook events when their retry due time arrives", async () => {
    const event = { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 };
    let queryInput: Record<string, unknown> | undefined;
    const documentClient = { async send(command: unknown) {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> };
      if (value.constructor.name === "QueryCommand") { queryInput = value.input; return { Items: [{ deliveryId: "550e8400-e29b-41d4-a716-446655440010", status: "RETRYABLE", event }] }; }
      return {};
    } };
    await expect(listDueGithubWebhookDeliveries({ documentClient, tableName: "state", now: "2026-10-05T12:02:00.000Z" })).resolves.toEqual([
      { deliveryId: "550e8400-e29b-41d4-a716-446655440010", event },
    ]);
    expect(queryInput).toMatchObject({ IndexName: "github-webhook-recovery", Limit: 25 });
  });

  it("lets only an administrator requeue a failed delivery after checking its linked PR scope", async () => {
    await (await import("../support/slack-broker.js")).loadSlackBroker();
    const broker = await import("../../packages/broker/src/aws/broker.js");
    const deliveryId = "550e8400-e29b-41d4-a716-446655440030";
    const taskId = "550e8400-e29b-41d4-a716-446655440031";
    const workspaceId = "550e8400-e29b-41d4-a716-446655440032";
    const event = { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 };
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const url = "https://github.com/acme/payments/pull/9";
    const task = { project: "test", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE", candidate,
      pullRequests: [{ repositoryId: "payments", number: 9, url, candidateDigest: candidate.digest }] } };
    let transaction: Record<string, unknown> | undefined;
    const dependencies = {
      tableName: "state",
      documentClient: { async send(command: unknown) {
        const value = commandInput(command);
        if (value.constructor.name === "TransactWriteCommand") { transaction = value.input; return {}; }
        const key = objectInput(value.input.Key);
        if (key.pk === `GITHUB_DELIVERY#${deliveryId}`) return { Item: { deliveryId, status: "DEAD", event } };
        if (key.pk === "GITHUB_PR#acme/payments") return { Item: { entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/payments",
          repositoryId: "payments", number: 9, url, taskId, workspaceId, candidateDigest: candidate.digest } };
        if (key.pk === `DEVTASK#${taskId}`) return { Item: task };
        if (key.pk === "PROJECT#test") return { Item: { definition: { repositories: [
          { name: "payments", url: "https://github.com/acme/payments.git" },
        ] } } };
        return {};
      } },
      githubPullRequests: { verifyWebhookRepository: async () => true },
    };
    const administrator = { isAdministrator: true, subject: "operator-1" };
    const member = { isAdministrator: false, subject: "member-1" };
    await expect(broker.retryGithubWebhookAsAdministrator(dependencies as never, member as never, deliveryId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(broker.retryGithubWebhookAsAdministrator(dependencies as never, administrator as never, deliveryId))
      .resolves.toEqual({ deliveryId, status: "RETRY_QUEUED" });
    expect(transaction?.TransactItems).toMatchObject([
      { Update: { ConditionExpression: "#status = :retryable OR #status = :dead" } },
      { Put: { Item: { actor: "operator-1", deliveryId } } },
    ]);
  });

});

describe("task-wide current PR feedback reconciliation", () => {
  async function fixture() {
    const module = {
      reconcileTaskPullRequestFeedback: (input: ReconcileTaskPullRequestFeedbackInput) => reconcileTaskPullRequestFeedback(input),
    };
    const taskId = "550e8400-e29b-41d4-a716-446655440012";
    const now = "2026-10-05T12:00:00.000Z";
    const candidate = createCandidateManifest(["api", "ui"].map(repositoryId => ({ repositoryId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) })));
    let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), candidate,
      stage: "WAIT_FOR_MERGE", state: "WAITING", verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: ["api", "ui"].map((repositoryId, i) => ({ repositoryId, number: i + 1, url: `https://github.com/acme/${repositoryId}/pull/${i + 1}`, headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: i ? "UNKNOWN" : "OPEN" })) });
    const rows = new Map(["api", "ui"].map((repositoryId, i) => [`GITHUB_PR#acme/${repositoryId}`, { entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${repositoryId}`, repositoryId, number: i + 1, url: `https://github.com/acme/${repositoryId}/pull/${i + 1}`, taskId, workspaceId: "workspace", candidateDigest: candidate.digest }]));
    let currentBody = "current authoritative body";
    let inlineIds = ["review_comment:4"];
    let resolved = true;
    let publishedHeadSha = "a".repeat(40);
    let publishedHeadTreeSha = "b".repeat(40);
    let publishedState: "open" | "merged" = "open";
    let conflict = false;
    let wrongScope = false;
    const reads: string[] = [];
    const input: ReconcileTaskPullRequestFeedbackInput = {
      documentClient: { send: async (command: unknown) => {
        const key = objectInput(commandInput(command).input.Key);
        return { Item: rows.get(typeof key.pk === "string" ? key.pk : "") };
      } }, tableName: "state", repositoryFullName: "acme/api", number: 1, deliveryId: "delivery-1",
      loadTask: async () => ({ project: "fixture", startingRevision: 1, workflow }),
      repositoryUrl: async (_project: string, _revision: number, repositoryId: string) => `https://github.com/acme/${repositoryId}.git`,
      getCurrentFeedback: async (url: string, number: number) => {
        reads.push(url);
        const repo = number === 1 ? "api" : "ui";
        const comment = (id: string): GitHubPullRequestFeedback["comments"][number] => ({ id, kind: id.startsWith("review_comment") ? "REVIEW_COMMENT" : id.startsWith("review:") ? "REVIEW" : "DISCUSSION", author: "reviewer", url: `https://github.com/acme/${repo}/pull/${number}#comment`, updatedAt: now, body: currentBody, ...(id.startsWith("review_comment") ? { threadId: "thread-1" } : {}) });
        return { pullRequest: { number, url: `https://github.com/${wrongScope ? "other" : "acme"}/${repo}/pull/${number}`, state: publishedState,
          headBranch: "feature", baseBranch: "main", headCommit: publishedHeadSha, headTreeSha: publishedHeadTreeSha, title: "Fix retry", body: "" },
          comments: number === 1 ? [comment("review:1"), ...inlineIds.map(comment)] : [comment("discussion:3")], threads: number === 1 ? [{ id: "thread-1", resolved, commentIds: inlineIds }] : [] };
      },
      saveWorkflow: async (_taskId: string, revision: number, next: WorkflowSnapshot) => {
        if (conflict) { conflict = false; workflow = { ...workflow, revision: workflow.revision + 1 }; currentBody = "newer edit after race"; throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" }); }
        if (revision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
        workflow = next;
      }, now,
    };
    return { module, input, reads, workflow: () => workflow,
      setPublishedHeadSha: (sha: string) => { publishedHeadSha = sha; workflow = WorkflowSnapshotSchema.parse({ ...workflow, pullRequests: workflow.pullRequests?.map(pr => ({ ...pr, headSha: sha })) }); },
      setRemotePr: (state: "open" | "merged", headSha: string, headTreeSha: string) => { publishedState = state; publishedHeadSha = headSha; publishedHeadTreeSha = headTreeSha; },
      edit: (body: string) => { currentBody = body; }, addInline: () => { inlineIds.push("review_comment:5"); }, reopen: () => { resolved = false; }, deleteInline: () => { inlineIds = []; }, conflict: () => { conflict = true; }, wrongScope: () => { wrongScope = true; } };
  }
  it("accepts a publication commit different from the checked workspace commit when GitHub confirms the exact candidate tree", async () => {
    const f = await fixture();
    f.setPublishedHeadSha("d".repeat(40));
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow().state).toBe("WAITING");
    expect(f.workflow().pullRequests?.map((pr) => pr.state)).toEqual(["OPEN", "OPEN"]);
  });
  it("does not complete when a linked PR changes candidate before it is merged", async () => {
    const f = await fixture();
    f.setRemotePr("merged", "d".repeat(40), "c".repeat(40));
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(f.workflow().pullRequests?.[0]?.state).not.toBe("MERGED");
  });
  it("recollects authoritative data after a concurrent revision conflict", async () => {
    const f = await fixture(); expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function"); f.conflict();
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.reads).toHaveLength(4);
  });
  it("keeps delayed events idempotent after every linked PR is observed merged", async () => {
    const f = await fixture();
    const getCurrentFeedback = (url: string, number: number) => f.input.getCurrentFeedback(url, number);
    const input = { ...f.input, getCurrentFeedback: async (url: string, number: number) => ({ ...(await getCurrentFeedback(url, number)), pullRequest: { ...(await getCurrentFeedback(url, number)).pullRequest, state: "merged" as const } }) };
    expect(await f.module.reconcileTaskPullRequestFeedback(input)).toBe(true);
    expect(f.workflow().stage).toBe("MERGED");
    const revision = f.workflow().revision;
    expect(await f.module.reconcileTaskPullRequestFeedback(input)).toBe(false);
    expect(f.workflow().revision).toBe(revision);
  });
  it("refuses current API results outside the pinned task PR scope without publishing bundles", async () => {
    const f = await fixture(); expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function"); f.wrongScope();
    await expect(f.module.reconcileTaskPullRequestFeedback(f.input)).rejects.toThrow(/scope/);
  });
});
