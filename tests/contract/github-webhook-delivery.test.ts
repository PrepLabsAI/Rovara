import { describe, expect, it } from "vitest";
import { assertDynamoExpressionAttributes } from "../support/validating-document-client.js";


describe("the validating document client", () => {
  it("refuses unused and undefined expression attributes as DynamoDB does", () => {
    const base = { UpdateExpression: "SET a = :a", ConditionExpression: "#s = :s", ExpressionAttributeNames: { "#s": "status" } };
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1, ":s": "x" } })).not.toThrow();
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1, ":s": "x", ":unused": 2 } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeNames: { "#s": "status", "#extra": "x" }, ExpressionAttributeValues: { ":a": 1, ":s": "x" } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": undefined, ":s": "x" } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1 } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
  });
});
