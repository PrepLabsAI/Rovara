import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, recordExpectedWorkflowPullRequests, requestWorkflowFeedback, WorkflowSnapshotSchema, type WorkflowSnapshot, type WorkflowFeedbackBundle } from "../../packages/contracts/src/task-workflow.js";
import { buildGithubFeedbackPlan, claimGithubWebhookDelivery, completeGithubWebhookDelivery, findLinkedGithubWorkflowPullRequest, listDueGithubWebhookDeliveries, processGithubWebhookDelivery, receiveGithubWebhook, reconcileGithubWorkflowPullRequest, reconcileTaskPullRequestFeedback, recordLinkedGithubWorkflowFeedback, reserveGithubWebhookDelivery, verifyGithubWebhookSignature, verifyTaskPullRequestFeedbackCurrent } from "../../packages/broker/src/aws/github-webhooks.js";
import type { ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";
import type { GitHubPullRequestFeedback } from "../../packages/broker/src/github-app.js";

function commandInput(command: unknown): { constructor: { name: string }; input: Record<string, unknown> } {
  return command as { constructor: { name: string }; input: Record<string, unknown> };
}

function objectInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
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

  it("reconciles a linked PR from GitHub's current state against its exact workflow candidate", async () => {
    const taskId = "550e8400-e29b-41d4-a716-446655440012";
    const ownerId = "a".repeat(64);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "b".repeat(40), treeSha: "c".repeat(40) }]);
    const created = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" });
    const workflow = {
      ...created,
      stage: "WAIT_FOR_MERGE" as const,
      state: "WAITING" as const,
      candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: role as "CRITIC" | "SECURITY", provider: "reviewer", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" })),
      pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", candidateDigest: candidate.digest, required: true, state: "UNKNOWN" as const }],
    };
    const index = { pk: "GITHUB_PR#acme/demo", sk: "PR#0000000042", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/demo", repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", taskId, workspaceId: "workspace-1", candidateDigest: candidate.digest };
    const saved: unknown[] = [];
    const changed = await reconcileGithubWorkflowPullRequest({
      documentClient: { send: async () => ({ Item: index }) }, tableName: "state", repositoryFullName: "acme/demo", number: 42,
      loadTask: async () => ({ project: "payments", startingRevision: 3, workflow }),
      repositoryUrl: async () => "https://github.com/acme/demo.git",
      getCurrentState: async () => "MERGED",
      saveWorkflow: async (_taskId, expectedRevision, next) => { saved.push({ expectedRevision, next }); },
      now: "2026-10-05T12:03:00.000Z",
    });
    expect(changed).toBe(true);
    expect(saved[0]).toMatchObject({ expectedRevision: 1, next: { stage: "MERGED", state: "COMPLETE", pullRequests: [{ state: "MERGED", candidateDigest: candidate.digest }] } });
  });

  it("records multiple linked PR comments against one candidate and invalidates approval when a comment is deleted", async () => {
    const taskId = "550e8400-e29b-41d4-a716-446655440013";
    const ownerId = "a".repeat(64);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "b".repeat(40), treeSha: "c".repeat(40) }]);
    const ready = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "PULL_REQUEST" as const, state: "READY" as const, candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: role as "CRITIC" | "SECURITY", provider: "reviewer", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" })),
    };
    let workflow = recordExpectedWorkflowPullRequests(ready, [
      { repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", candidateDigest: candidate.digest, required: true },
    ], "2026-10-05T12:03:00.000Z");
    const index = { pk: "GITHUB_PR#acme/demo", sk: "PR#0000000042", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/demo", repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", taskId, workspaceId: "workspace-1", candidateDigest: candidate.digest };
    let conflictNextUpdate = false;
    const documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: index };
      if (command.constructor.name === "UpdateCommand") {
        const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
        if (conflictNextUpdate) {
          conflictNextUpdate = false;
          workflow = requestWorkflowFeedback(workflow, {
            feedbackId: "f".repeat(64), repositoryId: "demo", number: 42, candidateDigest: candidate.digest,
            comments: [...(workflow.feedback?.comments ?? []), { id: "3", url: "https://github.com/acme/demo/pull/42#discussion_r3", author: "reviewer", body: "Concurrent feedback" }],
            proposedPlan: "Review the latest feedback and ask its owner before coding.",
          }, "2026-10-05T12:07:30.000Z");
          throw Object.assign(new Error("conditional conflict"), { name: "ConditionalCheckFailedException" });
        }
        workflow = values[":workflow"] as typeof workflow;
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    } };
    await recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "created",
      comment: { id: 1, body: "Handle null input", url: "https://github.com/acme/demo/pull/42#discussion_r1", author: "reviewer", updatedAt: "2026-10-05T12:04:00.000Z" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:04:00.000Z",
    });
    await recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "created",
      comment: { id: 2, body: "Keep the error message stable", url: "https://github.com/acme/demo/pull/42#discussion_r2", author: "reviewer" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:05:00.000Z",
    });
    expect(workflow.feedback?.comments.map((comment) => comment.id)).toEqual(["1", "2"]);
    const currentFeedback = workflow.feedback;
    await expect(recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "edited",
      comment: { id: 1, body: "stale text from an older edit", url: "https://github.com/acme/demo/pull/42#discussion_r1", author: "reviewer", updatedAt: "2026-10-05T12:03:00.000Z" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:07:00.000Z",
    })).resolves.toBe(false);
    expect(workflow.feedback).toEqual(currentFeedback);
    conflictNextUpdate = true;
    await expect(recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "created",
      comment: { id: 4, body: "Independent concurrent comment", url: "https://github.com/acme/demo/pull/42#discussion_r4", author: "reviewer" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:08:00.000Z",
    })).resolves.toBe(true);
    expect(workflow.feedback?.comments.map((comment) => comment.id)).toEqual(["1", "2", "3", "4"]);
    const beforeDelete = workflow;
    await recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "deleted",
      comment: { id: 1, body: "", url: "https://github.com/acme/demo/pull/42#discussion_r1", author: "reviewer" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:06:00.000Z",
    });
    expect(workflow.revision).toBe(beforeDelete.revision + 1);
    expect(workflow.feedback?.status).toBe("DISMISSED");
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
        const value = command as { constructor: { name: string }; input: Record<string, any> };
        const key = `${value.input.Key?.pk ?? value.input.Item?.pk}/${value.input.Key?.sk ?? value.input.Item?.sk}`;
        if (value.constructor.name === "PutCommand") {
          if (records.has(key)) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          records.set(key, value.input.Item);
          return {};
        }
        if (value.constructor.name === "UpdateCommand") {
          const record = records.get(key);
          if (!record) throw new Error("missing record");
          if (value.input.ExpressionAttributeValues[":completed"] === undefined) {
            if (record.status !== "RECEIVED" && record.status !== "RETRYABLE") throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
            record.status = "PROCESSING";
            record.leaseToken = value.input.ExpressionAttributeValues[":leaseToken"];
          } else {
            if (record.status !== "PROCESSING" || record.leaseToken !== value.input.ExpressionAttributeValues[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
            record.status = value.input.ExpressionAttributeValues[":completed"];
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
        const value = command as { constructor: { name: string }; input: Record<string, any> };
        const key = `${value.input.Key?.pk ?? value.input.Item?.pk}/${value.input.Key?.sk ?? value.input.Item?.sk}`;
        if (value.constructor.name === "PutCommand") {
          if (records.has(key)) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          records.set(key, value.input.Item);
          return {};
        }
        const record = records.get(key);
        if (!record) throw new Error("missing record");
        if (value.constructor.name === "GetCommand") return { Item: record };
        const values = value.input.ExpressionAttributeValues ?? {};
        if (values[":completed"] !== undefined) {
          if (record.status !== "PROCESSING" || record.leaseToken !== values[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "COMPLETED";
        } else if (values[":one"] === undefined && values[":retryable"] !== undefined) {
          if (record.status !== "PROCESSING" || record.leaseToken !== values[":leaseToken"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "RETRYABLE";
        } else {
          if (record.status !== "RECEIVED" && record.status !== "RETRYABLE") throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          record.status = "PROCESSING";
          record.leaseToken = values[":leaseToken"];
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
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: event, now: () => "2026-10-05T12:01:02.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("PROCESSED");
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: { ...event, delivery: "DUPLICATE" }, now: () => "2026-10-05T12:00:03.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("DUPLICATE");
    expect(attempts).toBe(2);
  });

  it("builds the owner proposal from the commented file and current PR diff", () => {
    const plan = buildGithubFeedbackPlan({ body: "Handle the empty-input case", path: "src/retry.ts", line: 22 }, [
      { filename: "src/retry.ts", status: "modified", additions: 12, deletions: 3, patch: "@@ -20,2 +20,5 @@\n+return input.length ? run(input) : []" },
      { filename: "README.md", status: "modified", additions: 2, deletions: 1 },
    ]);
    expect(plan).toContain("`src/retry.ts` near line 22");
    expect(plan).toContain("Current PR diff files");
    expect(plan).toContain("Relevant diff excerpt");
    expect(plan).toContain("Handle the empty-input case");
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

});

describe("task-wide current PR feedback reconciliation", () => {
  async function fixture() {
    const module = {
      reconcileTaskPullRequestFeedback: (input: ReconcileTaskPullRequestFeedbackInput) => reconcileTaskPullRequestFeedback(input),
      verifyTaskPullRequestFeedbackCurrent: (input: ReconcileTaskPullRequestFeedbackInput) => verifyTaskPullRequestFeedbackCurrent(input),
    };
    const taskId = "550e8400-e29b-41d4-a716-446655440012";
    const now = "2026-10-05T12:00:00.000Z";
    const candidate = createCandidateManifest(["api", "ui"].map(repositoryId => ({ repositoryId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) })));
    let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), candidate,
      stage: "WAIT_FOR_MERGE", state: "WAITING", verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: ["api", "ui"].map((repositoryId, i) => ({ repositoryId, number: i + 1, url: `https://github.com/acme/${repositoryId}/pull/${i + 1}`, candidateDigest: candidate.digest, required: true, state: i ? "UNKNOWN" : "OPEN" })) });
    const rows = new Map(["api", "ui"].map((repositoryId, i) => [`GITHUB_PR#acme/${repositoryId}`, { entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${repositoryId}`, repositoryId, number: i + 1, url: `https://github.com/acme/${repositoryId}/pull/${i + 1}`, taskId, workspaceId: "workspace", candidateDigest: candidate.digest }]));
    let currentBody = "current authoritative body";
    let inlineIds = ["review_comment:4"];
    let resolved = true;
    let conflict = false;
    let wrongScope = false;
    const artifacts: Array<{ bundle: WorkflowFeedbackBundle; bytes: string }> = [];
    const reads: string[] = [];
    const measures: Array<Record<string, unknown>> = [];
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
        return { pullRequest: { number, url: `https://github.com/${wrongScope ? "other" : "acme"}/${repo}/pull/${number}`, state: "open", headCommit: "a".repeat(40) },
          comments: number === 1 ? [comment("review:1"), ...inlineIds.map(comment)] : [comment("discussion:3")], threads: number === 1 ? [{ id: "thread-1", resolved, commentIds: inlineIds }] : [] };
      },
      persistBundle: async (bundle, bytes: string, sha256: string) => { artifacts.push({ bundle, bytes }); return `tasks/${taskId}/feedback/${sha256}.json`; },
      saveWorkflow: async (_taskId: string, revision: number, next: WorkflowSnapshot) => {
        if (conflict) { conflict = false; workflow = { ...workflow, revision: workflow.revision + 1 }; currentBody = "newer edit after race"; throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" }); }
        if (revision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
        workflow = next;
      }, measure: (entry: Record<string, unknown>) => measures.push(entry), now,
    };
    return { module, input, artifacts, reads, measures, workflow: () => workflow, setWorkflow: (next: WorkflowSnapshot) => { workflow = next; }, edit: (body: string) => { currentBody = body; }, addInline: () => { inlineIds.push("review_comment:5"); }, reopen: () => { resolved = false; }, deleteInline: () => { inlineIds = []; }, conflict: () => { conflict = true; }, wrongScope: () => { wrongScope = true; } };
  }
  it("persists both current PR bundles and ignores duplicate or delayed event bodies", async () => {
    const f = await fixture();
    expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function");
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow().feedbackReview?.status).toBe("COLLECTING");
    expect(f.workflow().feedbackReview?.bundleRefs.map((b) => b.repositoryId)).toEqual(["api", "ui"]);
    expect(f.artifacts[0]?.bundle.comments.map((c) => c.id)).toEqual(["review:1"]);
    expect(f.artifacts[1]?.bundle.comments[0].body).toBe("current authoritative body");
    const revision = f.workflow().revision;
    expect(await f.module.reconcileTaskPullRequestFeedback({ ...f.input, deliveryId: "delayed-old-event" })).toBe(false);
    expect(f.workflow().revision).toBe(revision);
    f.edit("edited current body");
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.artifacts.at(-1)?.bundle.comments[0].body).toBe("edited current body");
  });
  it("includes new activity on a resolved thread, reopened threads, and observes deletions", async () => {
    const f = await fixture(); expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function");
    await f.module.reconcileTaskPullRequestFeedback(f.input);
    f.addInline(); await f.module.reconcileTaskPullRequestFeedback(f.input);
    expect(f.artifacts.at(-2)?.bundle.comments.map((c) => c.id)).toEqual(["review:1", "review_comment:5"]);
    const revision = f.workflow().revision;
    expect(await f.module.reconcileTaskPullRequestFeedback(f.input)).toBe(false);
    expect(f.workflow().revision).toBe(revision);
    f.reopen(); await f.module.reconcileTaskPullRequestFeedback(f.input);
    expect(f.artifacts.at(-2)?.bundle.comments.map((c) => c.id)).toEqual(["review:1", "review_comment:4", "review_comment:5"]);
    f.deleteInline(); await f.module.reconcileTaskPullRequestFeedback(f.input);
    expect(f.artifacts.at(-2)?.bundle.comments.map((c) => c.id)).toEqual(["review:1"]);
  });
  it("counts reopened feedback only after a committed reconciliation, without comment or task data", async () => {
    const f = await fixture();
    await f.module.reconcileTaskPullRequestFeedback(f.input); // establish the resolved-thread baseline
    f.addInline();
    await f.module.reconcileTaskPullRequestFeedback(f.input);
    expect(f.measures).toEqual([{ event: "feedback_review.measure", measure: "feedback_reopened", count: 1, at: f.input.now }]);
    expect(JSON.stringify(f.measures)).not.toMatch(/task|reviewer|comment|diff|current authoritative body/i);
    await f.module.reconcileTaskPullRequestFeedback(f.input); // duplicate/replay does not increment the count
    expect(f.measures).toHaveLength(1);
  });
  it("recollects authoritative data after a concurrent revision conflict", async () => {
    const f = await fixture(); expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function"); f.conflict();
    await f.module.reconcileTaskPullRequestFeedback(f.input);
    expect(f.artifacts.at(-1)?.bundle.comments[0].body).toBe("newer edit after race");
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
  it("rechecks current PR heads and normalized comment digests at worker start", async () => {
    const f = await fixture();
    await f.module.reconcileTaskPullRequestFeedback(f.input);
    const current = f.workflow();
    const review = current.feedbackReview;
    if (!review || review.status !== "COLLECTING") throw new Error("feedback review was not collected");
    const selectedCommentIds = review.bundleRefs.flatMap((bundle) => bundle.comments.map((comment) => comment.id));
    const approval = { taskId: current.taskId, requestId: "550e8400-e29b-41d4-a716-446655440099", ownerId: current.ownerId,
      decisionWorkflowRevision: current.revision, activeWorkflowRevision: current.revision + 1, reviewDigest: "c".repeat(64),
      proposalDigest: "d".repeat(64), bundleDigests: review.bundleRefs.map((ref) => ref.sha256), candidateDigest: current.candidate.digest,
      selectedFindingIds: ["finding-1"], selectedCommentIds };
    f.setWorkflow({ ...current, revision: approval.activeWorkflowRevision, stage: "IMPLEMENT", state: "RUNNING",
      feedbackReview: { ...review, status: "APPROVED", reviewRef: { sha256: approval.reviewDigest, proposalDigest: approval.proposalDigest } },
      feedbackDispatchApproval: approval, feedbackDecisions: [{ requestId: approval.requestId, workflowRevision: approval.decisionWorkflowRevision,
        decision: "APPROVE", actorId: current.ownerId, actorRole: "TASK_OWNER", reviewDigest: approval.reviewDigest,
        proposalDigest: approval.proposalDigest, bundleDigests: approval.bundleDigests, selectedFindingIds: approval.selectedFindingIds,
        selectedCommentIds, candidates: [], at: "2026-10-05T12:00:00.000Z" }] });
    const candidateIsCurrent = await f.module.verifyTaskPullRequestFeedbackCurrent(f.input);
    expect(candidateIsCurrent).toBe(true);
    f.edit("changed after approval");
    expect(await f.module.verifyTaskPullRequestFeedbackCurrent(f.input)).toBe(false);
  });
  it("routes broker feedback events into immutable bundles before saving the collection", async () => {
    const f = await fixture();
    await (await import("../support/slack-broker.js")).loadSlackBroker();
    const broker = await import("../../packages/broker/src/aws/broker.js");
    expect(broker.processGithubWorkflowEvent).toBeTypeOf("function");
    const stored = new Map<string, string>();
    const dependencies = {
      tableName: "state", artifactBucketName: "artifacts",
      documentClient: { send: async (rawCommand: unknown) => {
        const command = commandInput(rawCommand);
        if (command.constructor.name === "UpdateCommand") {
          const values = objectInput(command.input.ExpressionAttributeValues);
          if (typeof values[":revision"] !== "number") throw new Error("missing workflow revision");
          await f.input.saveWorkflow("task", values[":revision"], WorkflowSnapshotSchema.parse(values[":workflow"])); return {};
        }
        const key = objectInput(command.input.Key);
        if (typeof key.pk === "string" && key.pk.startsWith("DEVTASK#")) return { Item: { ...(await f.input.loadTask("task")), ownerKey: "owner", workspaceId: "workspace" } };
        if (typeof key.pk === "string" && key.pk.startsWith("PROJECT#")) return { Item: { definition: { repositories: ["api", "ui"].map(name => ({ name, url: `https://github.com/acme/${name}.git` })) } } };
        return f.input.documentClient.send(command);
      } },
      s3: { send: async (rawCommand: unknown) => {
        const input = commandInput(rawCommand).input;
        if (typeof input.Key !== "string" || typeof input.Body !== "string") throw new Error("invalid artifact command");
        expect(input.IfNoneMatch).toBe("*"); stored.set(input.Key, input.Body); return {};
      } },
      githubPullRequests: { getPullRequestFeedback: (url: string, number: number) => f.input.getCurrentFeedback(url, number) },
    };
    await broker.processGithubWorkflowEvent(dependencies as never, { kind: "PR_COMMENT", action: "edited", installationId: 7, repositoryId: 9,
      fullName: "acme/api", number: 1, comment: { id: 999, source: "review", body: "stale webhook body", truncated: false, url: "https://github.com/acme/api/pull/1#pullrequestreview-999", author: "reviewer" } }, "delivery-1");
    expect(f.workflow().feedbackReview?.bundleRefs).toHaveLength(2);
    expect(f.workflow().feedback).toBeUndefined();
    expect(stored.size).toBe(2);
    expect([...stored.values()].every(bytes => !bytes.includes("stale webhook body"))).toBe(true);
  });
  it("refuses current API results outside the pinned task PR scope without publishing bundles", async () => {
    const f = await fixture(); expect(f.module.reconcileTaskPullRequestFeedback).toBeTypeOf("function"); f.wrongScope();
    await expect(f.module.reconcileTaskPullRequestFeedback(f.input)).rejects.toThrow(/scope/);
    expect(f.artifacts).toHaveLength(0);
  });
});
