import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateE2EAssertions } from "../../packages/verifier/src/runtime-assertions.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("independent E2E assertion evaluation", () => {
  it("seals every approved index against one original response before a worker can throw", () => {
    const responseBytes = Buffer.from('{ "ok": false, "label": "café" }\n');
    const expected = Array.from({ length: 20 }, (_, index) => ({ index, digest: sha(`assertion-${index}`), expectedResponse: { ok: true } }));
    const receipts = evaluateE2EAssertions({ responseBytes, assertions: expected });
    expect(receipts).toHaveLength(20);
    expect(receipts.map((item) => item.assertionIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(receipts.every((item) => item.outcome === "failed")).toBe(true);
    expect(new Set(receipts.map((item) => item.responseSha256))).toEqual(new Set([sha(responseBytes.toString())]));
    expect(receipts[0]?.responseSha256).not.toBe(sha(JSON.stringify(JSON.parse(responseBytes.toString()))));
  });

  it("rejects malformed or oversized original response bytes", () => {
    expect(() => evaluateE2EAssertions({ responseBytes: Buffer.from([0xff]), assertions: [] })).toThrow(/UTF-8|response/i);
    expect(() => evaluateE2EAssertions({ responseBytes: Buffer.alloc(262_145), assertions: [] })).toThrow(/size|limit/i);
  });
});
