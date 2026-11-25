// REDACT-BLOCK-REASON scope 4: when the dispatcher gives up on a worker start, the reason stored on the operation (and shown to the people of the task) is fixed words with a stable code. The error's own text
// (an SDK message, up to 512 characters of the worker's HTTP body, an ARN, a private address) goes to the dispatcher's log only, scrubbed and bounded.
import { randomUUID } from "node:crypto";
import { DISPATCH_GAVE_UP_CODES, DISPATCH_GAVE_UP_WORDS, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDispatcherHandler, type DispatchLogEntry } from "../../packages/broker/src/aws/dispatcher.js";
import { DeliveryFailure, DeliveryRefusal } from "../../packages/broker/src/aws/ec2-delivery.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
// D1-2: the combined-checks refusal sentence went with the old workflow engine's application admissions; any broker-written refusal sentence stands for it here.
const COMBINED_CHECKS_WORKER_REFUSAL = "This worker can't run combined browser and API checks yet; retry once it restarts.";
const ARN = "arn:aws:sqs:us-east-1:111122223333:other-company-queue";
const PRIVATE_IP = "10.0.3.14";

function outbox() {
  const operationId = randomUUID();
  const workspaceId = randomUUID();
  return {
    deploymentMode: "ec2-ebs" as const, id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId,
    invocation: { protocolVersion: 1, operationId, workspaceId, kind: "resume", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {} },
  } as const;
}

/** Runs one message that fails on its last attempt; answers what the dispatcher stored and what it logged. */
async function giveUp(failure: unknown, attempt = 3): Promise<{ stored: string; logs: DispatchLogEntry[] }> {
  const markFailed = vi.fn(async () => undefined);
  const logs: DispatchLogEntry[] = [];
  const handler = createDispatcherHandler({
    deliverEc2: vi.fn(async () => { throw failure; }), markDispatching: vi.fn(async () => undefined), markDelivered: vi.fn(async () => undefined), markFailed,
    maxAttempts: 3, log: (entry) => logs.push(entry),
  });
  const result = await handler({ Records: [{ messageId: "m", body: JSON.stringify(outbox()), attributes: { ApproximateReceiveCount: String(attempt) } }] });
  expect(result).toEqual({ batchItemFailures: [] });
  expect(markFailed).toHaveBeenCalledOnce();
  return { stored: (markFailed.mock.calls[0] as unknown as [unknown, string])[1], logs };
}

describe("a dispatch that is given up on", () => {
  it("stores fixed words and a code for a worker HTTP answer, and keeps its body for the log", async () => {
    const body = `{"error":"cannot reach ${ARN} from ${PRIVATE_IP}","token":"${token()}","detail":"${"x".repeat(900)}"}`;
    const { stored, logs } = await giveUp(new DeliveryFailure("EC2 worker returned HTTP 502", body, 502));
    expect(stored).toBe(`RUNTIME_UNAVAILABLE: worker dispatch failed after 3 attempts (WORKER_ANSWERED_ERROR HTTP 502): ${DISPATCH_GAVE_UP_WORDS.WORKER_ANSWERED_ERROR}`);
    for (const planted of [ARN, PRIVATE_IP, token(), "111122223333", "cannot reach"]) expect(stored).not.toContain(planted);
    // The log line has the worker's words, scrubbed and within 512 characters.
    expect(logs).toHaveLength(1);
    const logged = logs[0]!;
    expect(logged).toMatchObject({ event: "dispatch.attempt_failed", terminal: true, httpStatusCode: 502, errorName: "AgentXError" });
    expect(logged.errorMessage).toContain("EC2 worker returned HTTP 502");
    expect(logged.errorMessage).toContain(PRIVATE_IP);
    expect(logged.errorMessage).not.toContain(token());
    expect(logged.errorMessage!.length).toBeLessThanOrEqual(512);
  });

  it("stores a fixed sentence for a ping that did not answer, with the cause in the log only", async () => {
    const { stored, logs } = await giveUp(new DeliveryFailure("could not ask the EC2 worker which invocation fields it parses", `connect ECONNREFUSED ${PRIVATE_IP}:8080`));
    expect(stored).toBe(`RUNTIME_UNAVAILABLE: worker dispatch failed after 3 attempts (WORKER_NOT_REACHED): ${DISPATCH_GAVE_UP_WORDS.WORKER_NOT_REACHED}`);
    expect(stored).not.toContain(PRIVATE_IP);
    expect(logs[0]!.errorMessage).toContain(`ECONNREFUSED ${PRIVATE_IP}`);
  });

  it("stores a fixed sentence for any other error (an SDK failure naming a queue and an account)", async () => {
    const sdk = Object.assign(new Error(`User: arn:aws:sts::111122223333:assumed-role/dispatcher is not authorized to perform sqs:SendMessage on ${ARN}`), { name: "AccessDeniedException", code: "AccessDenied" });
    const { stored, logs } = await giveUp(sdk);
    expect(stored).toBe(`RUNTIME_UNAVAILABLE: worker dispatch failed after 3 attempts (WORKER_START_FAILED): ${DISPATCH_GAVE_UP_WORDS.WORKER_START_FAILED}`);
    expect(stored).not.toMatch(/arn:|111122223333|AccessDenied/u);
    expect(logs[0]).toMatchObject({ errorName: "AccessDeniedException", errorCode: "AccessDenied" });
    expect(logs[0]!.errorMessage).toContain(ARN);
  });

  it("stores a thrown value that is not an Error the same way", async () => {
    const { stored } = await giveUp(`plain text with ${token()}`);
    expect(stored).toBe(`RUNTIME_UNAVAILABLE: worker dispatch failed after 3 attempts (WORKER_START_FAILED): ${DISPATCH_GAVE_UP_WORDS.WORKER_START_FAILED}`);
  });

  it("keeps the broker's own refusal words, and the words the pull request update reads its cause from", async () => {
    const combined = await giveUp(new DeliveryRefusal("RUNTIME_UNAVAILABLE", COMBINED_CHECKS_WORKER_REFUSAL));
    expect(combined.stored).toBe(`RUNTIME_UNAVAILABLE: worker dispatch failed after 3 attempts (WORKER_REFUSED): ${COMBINED_CHECKS_WORKER_REFUSAL}`);
    const outdated = await giveUp(new DeliveryRefusal("RUNTIME_UNAVAILABLE", WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED));
    // outbox-failure.ts and broker.ts read the cause with `includes`.
    expect(outdated.stored).toContain(WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED);
    expect(outdated.stored).toContain("(WORKER_REFUSED)");
  });

  it("redacts a refusal's words too, in case a secret was ever put into one", async () => {
    const { stored } = await giveUp(new DeliveryRefusal("CONFIG_INVALID", `this worker needs ${token()}`));
    expect(stored).not.toContain(token());
    expect(stored).toContain("[REDACTED]");
  });

  async function staleLog(body: string): Promise<{ stale: DispatchLogEntry[]; message: ReturnType<typeof outbox> }> {
    const logs: DispatchLogEntry[] = [];
    const message = outbox();
    const handler = createDispatcherHandler({
      deliverEc2: vi.fn(async () => { throw new DeliveryFailure("EC2 worker returned HTTP 401", body, 401, { privateIp: PRIVATE_IP, generation: 4 }); }),
      markDispatching: vi.fn(async () => undefined), markDelivered: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined), maxAttempts: 3, log: (entry) => logs.push(entry),
    });
    await expect(handler({ Records: [{ messageId: "m", body: JSON.stringify(message), attributes: { ApproximateReceiveCount: "1" } }] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "m" }] });
    return { stale: logs.filter((entry) => entry.event === "dispatch.stale_address"), message };
  }
  const OTHER_WORKSPACE = "9f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9";

  it("logs one structured stale-address line when a worker answers wrong_workspace, with both workspaces, and still retries", async () => {
    const { stale, message } = await staleLog(`{"error":"invocation is not authorized","reason":"wrong_workspace","workspaceId":"${OTHER_WORKSPACE}","generation":7}`);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      level: "error", operationId: message.operationId, workspaceId: message.workspaceId, workerWorkspaceId: OTHER_WORKSPACE, workerGeneration: 7, workerReason: "wrong_workspace",
      sessionId: `${message.workspaceId}#4`, instanceId: "unknown", privateIp: PRIVATE_IP, attempt: 1, maxAttempts: 3, terminal: false,
    });
    // The line holds no body text.
    expect(JSON.stringify(stale[0])).not.toContain("not authorized");
  });

  it("logs the same line for wrong_generation (this workspace's id, another machine's generation), and 'unknown' when the worker names nothing", async () => {
    const same = await staleLog(`{"error":"invocation is not authorized","reason":"wrong_generation","workspaceId":"${outbox().workspaceId}","generation":2}`);
    expect(same.stale).toHaveLength(1);
    expect(same.stale[0]).toMatchObject({ workerReason: "wrong_generation", workerGeneration: 2, sessionId: `${same.message.workspaceId}#4` });
    const older = await staleLog("{\"error\":\"invocation is not authorized\",\"reason\":\"wrong_workspace\"}");
    expect(older.stale[0]).toMatchObject({ workerReason: "wrong_workspace", workerWorkspaceId: "unknown", workerGeneration: "unknown" });
    // A malformed id is not trusted into the line.
    const bad = await staleLog("{\"reason\":\"wrong_workspace\",\"workspaceId\":\"not an id; rm -rf\",\"generation\":-3}");
    expect(bad.stale[0]).toMatchObject({ workerWorkspaceId: "unknown", workerGeneration: "unknown" });
  });

  it("does not log it for another 401 reason, another status, or a body that is not the worker's JSON", async () => {
    for (const body of ["{\"reason\":\"expired\"}", "{\"reason\":\"bad_signature\"}", "<html>wrong_workspace</html>", "[\"wrong_workspace\"]"]) {
      expect((await staleLog(body)).stale, body).toHaveLength(0);
    }
  });

  it("redacts the worker's text before it cuts it to 512 characters, so a secret at the cut is not left half shown", () => {
    const failure = new DeliveryFailure("EC2 worker returned HTTP 500", `${"y".repeat(495)} ${token()} and more text after it`, 500);
    expect(failure.upstreamText!.length).toBeLessThanOrEqual(512);
    expect(failure.upstreamText).not.toContain("ghp_");
    expect(failure.upstreamText).toContain("[REDACTED]");
    // The answer is read from the text as it came: a long body does not hide a 401's fixed word.
    const long = new DeliveryFailure("EC2 worker returned HTTP 401", `{"error":"x","reason":"wrong_workspace","pad":"${"p".repeat(3_000)}"}`, 401);
    expect(long.workerReason).toBe("wrong_workspace");
  });

  it("keeps the attempt count and does not store anything before the last attempt", async () => {
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({
      deliverEc2: vi.fn(async () => { throw new DeliveryFailure("EC2 worker returned HTTP 500", "boom", 500); }), markDispatching: vi.fn(async () => undefined), markDelivered: vi.fn(async () => undefined), markFailed,
      maxAttempts: 3, log: () => undefined,
    });
    await expect(handler({ Records: [{ messageId: "m", body: JSON.stringify(outbox()), attributes: { ApproximateReceiveCount: "2" } }] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "m" }] });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("has words for every code, and none of them holds a placeholder for upstream text", () => {
    for (const code of DISPATCH_GAVE_UP_CODES) {
      expect(DISPATCH_GAVE_UP_WORDS[code], code).toMatch(/^[A-Z][^${}<>]+\.$/u);
    }
  });
});
