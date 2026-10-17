import { createHash } from "node:crypto";
import { canonicalJson, copyBoundedE2EJsonData, copyBoundedE2ESourceBytes, type E2EScenario } from "@agentx/contracts";
import { projectE2EModuleExportNames } from "./result-adapter.js";

const MAX_RESPONSE_FRAME_BYTES = 262_144;
const MAX_ASSERTIONS = 20;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type E2EIndependentAssertionReceipt = Readonly<{
  assertionIndex: number;
  assertionDigest: string;
  responseSha256: string;
  outcome: "passed" | "failed";
}>;

/** Compare every immutable host expectation with one original, bounded candidate response frame. */
export function evaluateE2EAssertions(input: Readonly<{ responseBytes: Uint8Array; assertions: readonly Readonly<{ index: number; digest: string; expectedResponse: unknown }>[]; mode?: "literal" | "module-export-inspection" }>): readonly E2EIndependentAssertionReceipt[] {
  const responseBytes = copyBoundedE2ESourceBytes(input.responseBytes, MAX_RESPONSE_FRAME_BYTES);
  let response: unknown;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).sort().join(",") === "output,wireId" && typeof (parsed as Record<string, unknown>).wireId === "string" && /^[a-f0-9]{48}$/.test((parsed as Record<string, unknown>).wireId as string)) response = copyBoundedE2EJsonData((parsed as Record<string, unknown>).output, { maxBytes: MAX_RESPONSE_FRAME_BYTES, maxDepth: 64, maxNodes: 65_536 });
    else response = copyBoundedE2EJsonData(parsed, { maxBytes: MAX_RESPONSE_FRAME_BYTES, maxDepth: 64, maxNodes: 65_536 });
  } catch {
    throw new TypeError("candidate response is not bounded UTF-8 JSON");
  }
  if (input.mode === "module-export-inspection") response = projectE2EModuleExportNames(response);
  if (!Array.isArray(input.assertions) || input.assertions.length < 1 || input.assertions.length > MAX_ASSERTIONS) throw new TypeError("approved assertion index set is invalid");
  const responseSha256 = sha256(responseBytes);
  const canonicalResponse = canonicalJson(response);
  const receipts: E2EIndependentAssertionReceipt[] = [];
  for (let index = 0; index < input.assertions.length; index += 1) {
    const assertion = input.assertions[index] as Readonly<{ index: number; digest: string; expectedResponse: unknown }> | undefined;
    if (!assertion || assertion.index !== index || !/^[a-f0-9]{64}$/.test(assertion.digest)) throw new TypeError("approved assertion indices are missing, duplicated, unordered, or unbound");
    const expected = copyBoundedE2EJsonData(assertion.expectedResponse, { maxBytes: 65_536, maxDepth: 32 });
    receipts.push(Object.freeze({ assertionIndex: index, assertionDigest: assertion.digest, responseSha256, outcome: canonicalResponse === canonicalJson(expected) ? "passed" : "failed" }));
  }
  return Object.freeze(receipts);
}

/** Assertion semantics come from the source-bound compiled scenario, never from the candidate response shape. */
export function evaluateE2EAssertionsForScenario(input: Readonly<{ responseBytes: Uint8Array; scenario: E2EScenario; assertions: readonly Readonly<{ index: number; digest: string; expectedResponse: unknown }>[] }>): readonly E2EIndependentAssertionReceipt[] {
  const mode = input.scenario.steps[0]?.kind === "inspect-contract" ? "module-export-inspection" : "literal";
  return evaluateE2EAssertions({ responseBytes: input.responseBytes, assertions: input.assertions, mode });
}
