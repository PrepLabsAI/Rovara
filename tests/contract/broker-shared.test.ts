// tests/contract/broker-shared.test.ts
// Spec 025 C19: which AWS errors the broker treats as temporary.
import { describe, expect, it } from "vitest";
import { isTemporaryAwsError } from "../../packages/broker/src/aws/broker-shared.js";

describe("isTemporaryAwsError (spec 025 C19)", () => {
  it("names throttling and 5xx answers temporary, and nothing else", () => {
    const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("x"), { name, ...extra });
    for (const name of ["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException", "InternalServerError", "ServiceUnavailable", "TransactionConflictException"]) {
      expect(isTemporaryAwsError(named(name))).toBe(true);
    }
    expect(isTemporaryAwsError(named("SomethingNew", { $metadata: { httpStatusCode: 503 } }))).toBe(true);
    for (const error of [named("ResourceNotFoundException"), named("ValidationException", { $metadata: { httpStatusCode: 400 } }), named("TransactionCanceledException"), "ThrottlingException", undefined]) {
      expect(isTemporaryAwsError(error)).toBe(false);
    }
  });
});
