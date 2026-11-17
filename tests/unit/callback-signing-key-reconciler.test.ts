// The sessions reconciler's two sweeps that sign a cancel (the stuck-cancel retry and the unwaited-task backstop) get the callback signing key from its one secret, when they run, and
// never sign without it. A run that cannot read the key still does everything that needs none (the reaping), and says so by error name only.
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { stubCallbackSigningKeySecret, TEST_CALLBACK_SIGNING_KEY_SECRET_ID } from "../support/callback-key.js";

const KEY = "kk-reconciler-key-0123456789-abcdefghijklmnopqrstuvwxyz";
let logs: string[];

beforeEach(() => {
  logs = [];
  vi.resetModules();
  vi.stubEnv("STATE_TABLE_NAME", "state");
  vi.stubEnv("AGENTX_METRICS_NAMESPACE", "test");
  vi.stubEnv("ENVIRONMENT_TAG", "test");
  vi.spyOn(DynamoDBDocumentClient, "from").mockReturnValue(new FakeDynamoDb() as never);
  vi.spyOn(EC2Client.prototype, "send").mockImplementation((async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [] };
    if (command.constructor.name === "DescribeVolumesCommand") return { Volumes: [] };
    return {};
  }) as never);
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

const named = () => {
  vi.stubEnv("SLACK_THREADS_TABLE_NAME", "threads");
  vi.stubEnv("SLACK_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf");
};
const run = async () => ((await import("../../packages/broker/src/aws/session-reconciler.js")).handler as unknown as () => Promise<Record<string, unknown>>)();
const events = () => logs.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });

describe("the reconciler's callback signing key", () => {
  it("reads exactly the named secret, once for the container, and logs nothing of it", async () => {
    named();
    const secret = stubCallbackSigningKeySecret(KEY);
    await run();
    expect(secret.reads).toEqual([{ SecretId: TEST_CALLBACK_SIGNING_KEY_SECRET_ID }]);
    expect(events().map((entry) => entry.event)).not.toContain("reconciler.callback_signing_key_unavailable");
    expect(events().map((entry) => entry.event)).not.toContain("reconciler.unwaited_task_sweep_failed");
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("without the secret named, the backstop is half-wired and nothing signs; the run still completes, and the plain variable is no way around it", async () => {
    named();
    vi.stubEnv("CALLBACK_SIGNING_KEY", KEY);
    const send = vi.spyOn(SecretsManagerClient.prototype, "send");
    await expect(run()).resolves.toBeDefined();
    expect(send).not.toHaveBeenCalled();
    const seen = events();
    expect(seen).toContainEqual(expect.objectContaining({ event: "reconciler.unwaited_task_backstop_partial", missing: "CALLBACK_SIGNING_KEY_SECRET_ID" }));
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("with an unreadable secret, the stuck-cancel retry is unavailable and the backstop sweep fails (counted), but the run completes and says only the error name", async () => {
    named();
    vi.stubEnv("CALLBACK_SIGNING_KEY_SECRET_ID", TEST_CALLBACK_SIGNING_KEY_SECRET_ID);
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => { throw Object.assign(new Error(`AccessDenied ${KEY} ${TEST_CALLBACK_SIGNING_KEY_SECRET_ID}`), { name: "AccessDeniedException" }); }) as never);
    await expect(run()).resolves.toBeDefined();
    const seen = events();
    expect(seen).toContainEqual({ component: "session-reconciler", event: "reconciler.callback_signing_key_unavailable", errorName: "CallbackSigningKeyUnavailable" });
    expect(seen).toContainEqual({ component: "session-reconciler", event: "reconciler.unwaited_task_sweep_failed", errorName: "CallbackSigningKeyUnavailable" });
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain("AccessDenied");
  });

  it("reads nothing where the deployment has no signing key for the reconciler (the legacy template)", async () => {
    const send = vi.spyOn(SecretsManagerClient.prototype, "send");
    await run();
    expect(send).not.toHaveBeenCalled();
  });

  it("offers the stuck-cancel retry only with a key read from the secret: none where nothing is wired or the read fails", async () => {
    const { stuckCancelRetryFor } = await import("../../packages/broker/src/aws/session-reconciler.js");
    const state = { client: new FakeDynamoDb() as never, tableName: "state" };
    const log = vi.fn();
    expect(await stuckCancelRetryFor({}, state, log)).toBeUndefined();
    expect(await stuckCancelRetryFor({ CALLBACK_SIGNING_KEY: KEY }, state, log)).toBeUndefined();
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => { throw new Error(KEY); }) as never);
    expect(await stuckCancelRetryFor({ CALLBACK_SIGNING_KEY_SECRET_ID: TEST_CALLBACK_SIGNING_KEY_SECRET_ID }, state, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith({ event: "reconciler.callback_signing_key_unavailable", errorName: "CallbackSigningKeyUnavailable" });
    vi.restoreAllMocks();
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => ({ SecretString: KEY })) as never);
    expect(await stuckCancelRetryFor({ CALLBACK_SIGNING_KEY_SECRET_ID: TEST_CALLBACK_SIGNING_KEY_SECRET_ID }, state, log)).toBeTypeOf("function");
  });
});
