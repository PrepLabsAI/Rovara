// ConverseStream answers for the Rovara's AI tests (DEC 243c), framed as AWS's event stream (shapes as AWS documents them).
import { crc32 } from "node:zlib";

export function frame(headers: Record<string, string>, payload: Buffer): Buffer {
  const head = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name); const v = Buffer.from(value); const h = Buffer.alloc(4 + n.length + v.length);
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length); h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length); return h;
  }));
  const total = 12 + head.length + payload.length + 4;
  const prelude = Buffer.alloc(8); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(head.length, 4);
  const pc = Buffer.alloc(4); pc.writeUInt32BE(crc32(prelude) >>> 0, 0);
  const body = Buffer.concat([prelude, pc, head, payload]); const mc = Buffer.alloc(4); mc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, mc]);
}
export const converseEvent = (type: string, payload: Record<string, unknown>) => frame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, Buffer.from(JSON.stringify({ ...payload, p: "abcdef" })));
/** A ConverseStream answer that asks for one tool call: text, then a toolUse block, then usage. */
export function toolCallStream(): Buffer {
  return Buffer.concat([
    converseEvent("messageStart", { role: "assistant" }),
    converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Checking." } }),
    converseEvent("contentBlockStop", { contentBlockIndex: 0 }),
    converseEvent("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tooluse_abc123", name: "read_file" } } }),
    converseEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":' } } }),
    converseEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '"a.ts"}' } } }),
    converseEvent("contentBlockStop", { contentBlockIndex: 1 }),
    converseEvent("messageStop", { stopReason: "tool_use" }),
    converseEvent("metadata", { usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }, metrics: { latencyMs: 10 } }),
  ]);
}
