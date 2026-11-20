import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { describe, expect, it, vi } from "vitest";
import { invokeCoreOutbox } from "../../packages/broker/src/aws/core-outbox-stream.js";

const record = (sequence = "1") => ({ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: sequence, NewImage: { pk: { S: "ORG#org_staging0000000000001#OUTBOX#id" }, outboxState: { S: "PENDING#org_staging0000000000001" } } } });
const reply = (body: unknown) => ({ StatusCode: 200, Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ ...(body as object), requestId: "core-engine" }) })) });
const client = (send: unknown) => ({ send }) as Pick<LambdaClient, "send">;

describe("L9 synchronous forwarding boundary", () => {
  it("sends the batch once to the pinned broker, with a shared abort signal and validated failures", async () => {
    const send = vi.fn(async () => reply({ batchItemFailures: [{ itemIdentifier: "1" }] }));
    expect(await invokeCoreOutbox(client(send), "broker", [record()])).toEqual({ batchItemFailures: [{ itemIdentifier: "1" }] });
    expect(send).toHaveBeenCalledOnce();
    const [command, options] = send.mock.calls[0] as unknown as [InvokeCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input.FunctionName).toBe("broker");
    expect(command.input.InvocationType).toBe("RequestResponse");
    const payload = command.input.Payload;
    if (!Buffer.isBuffer(payload)) throw new Error("expected byte payload");
    expect(JSON.parse(payload.toString("utf8"))).toEqual({ Records: [record()] });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("refuses oversized, malformed and non-INSERT input before any invocation", async () => {
    const send = vi.fn();
    for (const records of [Array.from({ length: 101 }, () => record()), [{ ...record(), eventName: "MODIFY" }], [{ ...record(), dynamodb: {} }], [record("private-value")], [{ ...record(), padding: "x".repeat(6 * 1024 * 1024) }]]) {
      await expect(invokeCoreOutbox(client(send), "broker", records)).rejects.toThrow(/^core outbox relay unavailable$/u);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses all failed, unreadable or uncorrelated responses in fixed words", async () => {
    for (const response of [
      { ...reply({ batchItemFailures: [] }), StatusCode: 202 }, { ...reply({ batchItemFailures: [] }), FunctionError: "private cause" },
      { StatusCode: 200, Payload: Buffer.from("private payload") },
      { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ statusCode: 500, body: "private body" })) },
      reply({}), reply({ batchItemFailures: [{ itemIdentifier: "2" }] }), reply({ batchItemFailures: [{ itemIdentifier: "private" }] }),
      reply({ batchItemFailures: "wrong" }), reply({ batchItemFailures: [], unexpected: "private" }),
      { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ batchItemFailures: [], requestId: "core-engine" }), padding: "x".repeat(64_001) })) },
    ]) await expect(invokeCoreOutbox(client(async () => response), "broker", [record()])).rejects.toThrow(/^core outbox relay unavailable$/u);
    await expect(invokeCoreOutbox(client(async () => { throw new Error("private network cause"); }), "broker", [record()])).rejects.toThrow(/^core outbox relay unavailable$/u);
  });

});
