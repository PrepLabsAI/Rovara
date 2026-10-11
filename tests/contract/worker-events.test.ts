// The worker's event log batches (packages/worker/src/events.ts): an event the control plane stores as one table item is
// kept far below DynamoDB's 400 KB item limit, whatever a model or tool put in it.
import { describe, expect, it } from "vitest";
import { EventBatcher, WORKER_EVENT_PAYLOAD_MAX_BYTES, type WorkerEvent } from "../../packages/worker/src/events.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function appended(payload: unknown): Promise<WorkerEvent> {
  const sent: WorkerEvent[] = [];
  const batcher = new EventBatcher(async (events) => { sent.push(...events); }, 1);
  await batcher.append("tool_start", payload);
  return sent[0]!;
}

describe("worker event payloads", () => {
  it("keeps a small event as it is", async () => {
    const payload = { type: "tool_execution_start", toolName: "write", args: { path: "a.ts", content: "export const a = 1;\n" } };
    expect((await appended(payload)).payload).toEqual(payload);
  });

  it("cuts a whole large file write in a tool call's arguments, and says so", async () => {
    const content = "x".repeat(500_000);
    const event = await appended({ type: "tool_execution_start", toolName: "write", args: { path: "big.ts", content } });
    expect(bytes(event)).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES + 1_024);
    const args = (event.payload as { toolName: string; args: { path: string; content: string } }).args;
    expect((event.payload as { toolName: string }).toolName).toBe("write");
    expect(args.path).toBe("big.ts");
    expect(args.content.startsWith("x".repeat(1_000))).toBe(true);
    expect(args.content).toMatch(/… \[AgentX cut \d+ more characters\]$/);
  });

  it("drops the details of an event that is still too large after cutting its long strings, keeping its type", async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => `line ${index} ${"y".repeat(40)}`);
    const event = await appended({ type: "message_end", message: { content: many } });
    expect(bytes(event)).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES + 1_024);
    expect(event.payload).toEqual({ type: "message_end", truncated: true, note: "This event was too large to keep, so AgentX dropped its details." });
  });
});
