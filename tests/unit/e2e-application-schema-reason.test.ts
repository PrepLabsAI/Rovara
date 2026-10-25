import { describe, expect, it } from "vitest";
import { z } from "zod";
import { E2EApplicationCollectionSchema, e2eApplicationErrorReason, e2eApplicationSchemaReason } from "../../packages/verifier/src/application-result-adapter.js";

// Task FU2 (AGENTZODKEY): a schema refusal is stored and logged as a fixed code and a path of our own schema's keys, never a key the sender chose.
const SECRET_KEY = "hunter2-secret-key";

describe("the reason a schema refusal is stored under", () => {
  it("an unknown key's name is not in the reason; zod's own issue code and the path to the object are", () => {
    const error = new z.ZodError([{ code: "unrecognized_keys", keys: [SECRET_KEY], path: ["shards", 0], message: `Unrecognized key: "${SECRET_KEY}"` }]);
    // What was stored before: the issue's own message, which names the key.
    expect(error.issues[0]!.message).toContain(SECRET_KEY);
    expect(e2eApplicationSchemaReason(error)).toBe("schema-error: unrecognized_keys at shards.[]");
  });

  it("a key under a record in the path is replaced, and so is any key our schemas do not declare; an index is not a name", () => {
    const error = new z.ZodError([{ code: "invalid_type", expected: "string", path: ["shards", 3, "fixedAssetDigests", SECRET_KEY, "deeper", "nested-sender-key"], message: "Invalid input" }]);
    const reason = e2eApplicationSchemaReason(error);
    expect(reason).toBe("schema-error: invalid_type at shards.[].fixedAssetDigests.*.*.*");
    expect(reason).not.toContain(SECRET_KEY);
  });

  it("a real refusal of the collection schema, by an unknown key at the top and under a shard, carries neither", () => {
    for (const value of [{ [SECRET_KEY]: 1 }, { shards: [{ [SECRET_KEY]: 1 }] }, { shards: [{ fixedAssetDigests: { [SECRET_KEY]: "not-a-digest" } }] }]) {
      const parsed = E2EApplicationCollectionSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      for (const issue of parsed.error!.issues) {
        const reason = e2eApplicationSchemaReason(new z.ZodError([issue]));
        // A `custom` issue is a sentence our own schema wrote; every other issue is a code and a path.
        if (issue.code !== "custom") expect(reason).toMatch(/^schema-error: [a-z_]+( at [A-Za-z.[\]*]+)?$/);
        expect(reason).not.toContain(SECRET_KEY);
      }
      expect(e2eApplicationErrorReason(parsed.error)).not.toContain(SECRET_KEY);
      // The whole message of the error (what a catch of `error.message` used to store) did name it, or the issues around it did.
      if (JSON.stringify(parsed.error!.issues).includes(SECRET_KEY)) expect(parsed.error!.message).toContain(SECRET_KEY);
    }
  });

  it("a refusal our own schema words keeps its sentence; unreadable JSON quotes nothing of the input", () => {
    expect(e2eApplicationSchemaReason(new z.ZodError([{ code: "custom", path: ["agentModel"], message: "model-receipts-mismatch: the model evidence is not for a group with AI navigation steps under the admitted route" }])))
      .toBe("model-receipts-mismatch: the model evidence is not for a group with AI navigation steps under the admitted route");
    let syntax: unknown;
    try { JSON.parse(`{"a": ${SECRET_KEY}`); } catch (error) { syntax = error; }
    expect(syntax).toBeInstanceOf(SyntaxError);
    expect(e2eApplicationErrorReason(syntax)).toBe("schema-error: unreadable-json");
    expect(e2eApplicationErrorReason(new Error("a fixed sentence of ours"))).toBe("a fixed sentence of ours");
    expect(e2eApplicationErrorReason("not an error", "fallback")).toBe("fallback");
  });
});
