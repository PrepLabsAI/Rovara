import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, recordExpectedWorkflowPullRequests } from "../../packages/contracts/src/task-workflow.js";
import { claimGithubWebhookDelivery, completeGithubWebhookDelivery, findLinkedGithubWorkflowPullRequest, processGithubWebhookDelivery, receiveGithubWebhook, reconcileGithubWorkflowPullRequest, recordLinkedGithubWorkflowFeedback, reserveGithubWebhookDelivery, verifyGithubWebhookSignature } from "../../packages/broker/src/aws/github-webhooks.js";

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
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ candidateDigest: candidate.digest, role: role as "CRITIC" | "SECURITY", provider: "reviewer", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" })),
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
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ candidateDigest: candidate.digest, role: role as "CRITIC" | "SECURITY", provider: "reviewer", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" })),
    };
    let workflow = recordExpectedWorkflowPullRequests(ready, [
      { repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", candidateDigest: candidate.digest, required: true },
    ], "2026-10-05T12:03:00.000Z");
    const index = { pk: "GITHUB_PR#acme/demo", sk: "PR#0000000042", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/demo", repositoryId: "demo", number: 42, url: "https://github.com/acme/demo/pull/42", taskId, workspaceId: "workspace-1", candidateDigest: candidate.digest };
    const documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: index };
      if (command.constructor.name === "UpdateCommand") {
        const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
        workflow = values[":workflow"] as typeof workflow;
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    } };
    await recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "created",
      comment: { id: 1, body: "Handle null input", url: "https://github.com/acme/demo/pull/42#discussion_r1", author: "reviewer" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:04:00.000Z",
    });
    await recordLinkedGithubWorkflowFeedback({
      documentClient, tableName: "state", repositoryFullName: "acme/demo", number: 42, action: "created",
      comment: { id: 2, body: "Keep the error message stable", url: "https://github.com/acme/demo/pull/42#discussion_r2", author: "reviewer" },
      loadWorkflow: async () => workflow, now: "2026-10-05T12:05:00.000Z",
    });
    expect(workflow.feedback?.comments.map((comment) => comment.id)).toEqual(["1", "2"]);
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
        const values = value.input.ExpressionAttributeValues;
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
    await reserveGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, installationId: 777, repositoryId: 1234, eventHash: "d".repeat(64), now: "2026-10-05T12:00:00.000Z" });
    const event = { delivery: "ACCEPTED" as const, deliveryId, event: { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 } };
    let attempts = 0;
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: event, now: () => "2026-10-05T12:00:01.000Z",
      process: async () => { attempts += 1; throw new Error("transient GitHub API failure"); },
    })).rejects.toThrow(/transient/);
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: event, now: () => "2026-10-05T12:00:02.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("PROCESSED");
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received: { ...event, delivery: "DUPLICATE" }, now: () => "2026-10-05T12:00:03.000Z",
      process: async () => { attempts += 1; },
    })).resolves.toBe("DUPLICATE");
    expect(attempts).toBe(2);
  });

});
