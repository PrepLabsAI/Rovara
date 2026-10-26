import { ParameterNotFound, type GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_AMI_ID_PATTERN,
  WORKER_QUALIFIED_AMI_SETTING,
  isStaleWorkerAmi,
  readQualifiedWorkerAmi,
  workerQualifiedAmiParameterName,
} from "../../packages/broker/src/aws/worker-ami.js";

const NAME = "/agentx/test/worker-qualified-ami";
const ssmReturning = (outcome: { value?: string; error?: Error }) => ({
  send: vi.fn<(command: GetParameterCommand) => Promise<{ Parameter: { Value: string | undefined } }>>(async () => {
    if (outcome.error !== undefined) throw outcome.error;
    return { Parameter: { Value: outcome.value } };
  }),
});

describe("worker AMI pin parameter", () => {
  it("lives under the environment's worker settings prefix, outside the worker's own settings", () => {
    expect(WORKER_QUALIFIED_AMI_SETTING).toBe("worker-qualified-ami");
    expect(workerQualifiedAmiParameterName("/agentx/test/")).toBe(NAME);
    expect(workerQualifiedAmiParameterName("/agentx/production/")).toBe("/agentx/production/worker-qualified-ami");
  });

  it.each(["ami-0123456789abcdef0", "ami-01234567"])("accepts the AMI ID %s", (value) => {
    expect(WORKER_AMI_ID_PATTERN.test(value)).toBe(true);
  });

  it.each(["", "ami-", "ami-xyz", "ami-0123456789abcdef0 ", "ami-0123456789abcdef01", "AMI-0123456789abcdef0", "resolve:ssm:/aws/service/x", "ami-0123456789abcdef0\nami-1"])("rejects %j", (value) => {
    expect(WORKER_AMI_ID_PATTERN.test(value)).toBe(false);
  });
});

describe("readQualifiedWorkerAmi", () => {
  it("reads the pinned AMI with one plain GetParameter, never decrypting", async () => {
    const ssm = ssmReturning({ value: "ami-0123456789abcdef0" });
    expect(await readQualifiedWorkerAmi(ssm, NAME)).toBe("ami-0123456789abcdef0");
    expect(ssm.send).toHaveBeenCalledTimes(1);
    const input = ssm.send.mock.calls[0]![0].input;
    expect(input).toEqual({ Name: NAME });
  });

  it("is undefined before the first automatic requalification (no parameter yet)", async () => {
    const notFound = new ParameterNotFound({ message: "x", $metadata: {} });
    expect(await readQualifiedWorkerAmi(ssmReturning({ error: notFound }), NAME)).toBeUndefined();
  });

  it("fails closed on a malformed value instead of treating it as no pin", async () => {
    await expect(readQualifiedWorkerAmi(ssmReturning({ value: "ami-not-real" }), NAME)).rejects.toThrow("WORKER_AMI_PARAMETER_MALFORMED");
    await expect(readQualifiedWorkerAmi(ssmReturning({}), NAME)).rejects.toThrow("WORKER_AMI_PARAMETER_MALFORMED");
  });

  it("does not hide other SSM faults as 'not pinned'", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    await expect(readQualifiedWorkerAmi(ssmReturning({ error: denied }), NAME)).rejects.toThrow("denied");
  });
});

describe("isStaleWorkerAmi", () => {
  it("is stale only when both AMIs are known and differ", () => {
    expect(isStaleWorkerAmi("ami-0123456789abcdef0", "ami-0fedcba9876543210")).toBe(true);
    expect(isStaleWorkerAmi("ami-0123456789abcdef0", "ami-0123456789abcdef0")).toBe(false);
    expect(isStaleWorkerAmi(undefined, "ami-0fedcba9876543210")).toBe(false);
    expect(isStaleWorkerAmi("ami-0123456789abcdef0", undefined)).toBe(false);
  });
});
