import { describe, expect, it } from "vitest";
import { assertNoReservedWords } from "../support/fake-dynamodb.js";

describe("FakeDynamoDB expression validation", () => {
  it("rejects reserved attribute names in nested document paths", () => {
    expect(() => assertNoReservedWords(
      "workflow.revision = :revision AND workflow.stage = :stage AND workflow.state = :running",
    )).toThrow(/reserved keyword: state/i);
  });
});
