import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateE2EAssertions, evaluateE2EAssertionsForScenario } from "../../packages/verifier/src/runtime-assertions.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("independent E2E assertion evaluation", () => {
  const inventory = { protocol: "registered-module-export-inventory/v1", exports: [{ name: "hello", kind: "callable" }] };

  it("keeps unequal inventory-shaped feature JSON unequal", () => {
    const responseBytes = Buffer.from(JSON.stringify(inventory));
    const receipts = evaluateE2EAssertions({ responseBytes, assertions: [{ index: 0, digest: sha("feature"), expectedResponse: { ...inventory, exports: [{ name: "other", kind: "callable" }] } }], mode: "literal" });
    expect(receipts[0]?.outcome).toBe("failed");
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

  it("rejects malformed or oversized original response bytes", () => {
    expect(() => evaluateE2EAssertions({ responseBytes: Buffer.from([0xff]), assertions: [] })).toThrow(/UTF-8|response/i);
    expect(() => evaluateE2EAssertions({ responseBytes: Buffer.alloc(262_145), assertions: [] })).toThrow(/size|limit/i);
  });
});
