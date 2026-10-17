import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateE2EAssertions, evaluateE2EAssertionsForScenario } from "../../packages/verifier/src/runtime-assertions.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("independent E2E assertion evaluation", () => {
  const inventory = { protocol: "registered-module-export-inventory/v1", exports: [{ name: "hello", kind: "callable" }] };

  it("compares inventory-shaped feature JSON literally", () => {
    const responseBytes = Buffer.from(JSON.stringify(inventory));
    const receipts = evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("feature"), expectedResponse: inventory }] });
    expect(receipts[0]?.outcome).toBe("passed");
  });

  it("keeps unequal inventory-shaped feature JSON unequal", () => {
    const responseBytes = Buffer.from(JSON.stringify(inventory));
    const receipts = evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("feature"), expectedResponse: { ...inventory, exports: [{ name: "other", kind: "callable" }] } }], mode: "literal" });
    expect(receipts[0]?.outcome).toBe("failed");
  });

  it("projects names only for an approved module inspection", () => {
    const responseBytes = Buffer.from(JSON.stringify(inventory));
    const receipts = evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("inspection"), expectedResponse: ["hello"] }], mode: "module-export-inspection" });
    expect(receipts[0]?.outcome).toBe("passed");
  });

  it("rejects malformed inventory during an approved module inspection", () => {
    const responseBytes = Buffer.from(JSON.stringify({ protocol: "registered-module-export-inventory/v1", exports: [{ name: "hello", kind: "unknown" }] }));
    expect(() => evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("inspection"), expectedResponse: ["hello"] }], mode: "module-export-inspection" })).toThrow(/inventory|export name/i);
  });

  it("rejects a non-inventory response during an approved module inspection", () => {
    const responseBytes = Buffer.from(JSON.stringify(["hello"]));
    expect(() => evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("inspection"), expectedResponse: ["hello"] }], mode: "module-export-inspection" })).toThrow(/inventory|protocol/i);
  });

  it("wires compiled feature and inspection scenarios to their distinct assertion modes", () => {
    const responseBytes = Buffer.from(JSON.stringify(inventory));
    const assertions = [{ index: 0, digest: sha("runtime-wiring"), expectedResponse: inventory }];
    const featureReceipts = evaluateE2EAssertionsForScenario({ responseBytes, assertions, scenario: { steps: [{ kind: "invoke-contract" }] } as never });
    const inspectionReceipts = evaluateE2EAssertionsForScenario({ responseBytes, assertions: [{ ...assertions[0]!, expectedResponse: ["hello"] }], scenario: { steps: [{ kind: "inspect-contract" }] } as never });
    expect(featureReceipts[0]?.outcome).toBe("passed");
    expect(inspectionReceipts[0]?.outcome).toBe("passed");
  });

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
