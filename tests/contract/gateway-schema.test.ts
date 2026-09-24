import { describe, expect, it } from "vitest";
import { flattenSchema } from "../../packages/gateway/src/index.js";

describe("vendor schema flattening", () => {
  it("inlines local $defs references and drops the definitions", () => {
    const result = flattenSchema({
      type: "object",
      properties: { team: { $ref: "#/$defs/Team" }, labels: { type: "array", items: { $ref: "#/definitions/Label" } } },
      required: ["team"],
      $defs: { Team: { type: "string", description: "Team ID" } },
      definitions: { Label: { type: "string" } },
    });
    expect(result).toEqual({ schema: {
      type: "object",
      properties: { team: { type: "string", description: "Team ID" }, labels: { type: "array", items: { type: "string" } } },
      required: ["team"],
    } });
  });

  it("merges allOf object parts and lets a $ref's sibling annotations win", () => {
    const result = flattenSchema({
      allOf: [
        { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        { type: "object", properties: { body: { $ref: "#/$defs/Text", description: "Issue body" } }, additionalProperties: false },
      ],
      $defs: { Text: { type: "string", description: "Markdown" } },
    });
    expect(result).toEqual({ schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string", description: "Issue body" } },
      required: ["title"],
    } });
  });

  it("keeps properties named definitions or $defs", () => {
    const result = flattenSchema({ type: "object", properties: { definitions: { type: "string" }, $defs: { type: "number" } } });
    expect(result).toEqual({ schema: { type: "object", properties: { definitions: { type: "string" }, $defs: { type: "number" } } } });
  });

  it("refuses recursive, external, unresolvable and conflicting schemas", () => {
    expect(flattenSchema({ type: "object", properties: { node: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } }))
      .toEqual({ unsupported: "recursive reference #/$defs/Node" });
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "https://example.test/a.json" } } }))
      .toEqual({ unsupported: "external reference https://example.test/a.json" });
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "#/$defs/Missing" } } }))
      .toEqual({ unsupported: "unresolvable reference #/$defs/Missing" });
    expect(flattenSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { a: { type: "number" } } }] }))
      .toEqual({ unsupported: "conflicting definitions of property a" });
    expect(flattenSchema({ allOf: [{ type: "object" }, { type: "array" }] }))
      .toEqual({ unsupported: "conflicting type" });
  });

  it("treats the same property defined with keys in a different order as one definition", () => {
    const result = flattenSchema({ allOf: [
      { type: "object", properties: { a: { type: "string", description: "A" } } },
      { type: "object", properties: { a: { description: "A", type: "string" } } },
    ] });
    expect(result).toEqual({ schema: { type: "object", properties: { a: { type: "string", description: "A" } } } });
  });

  it("resolves references into arrays", () => {
    const result = flattenSchema({ type: "object", properties: { a: { $ref: "#/$defs/choices/1" } }, $defs: { choices: [{ type: "number" }, { type: "string" }] } });
    expect(result).toEqual({ schema: { type: "object", properties: { a: { type: "string" } } } });
  });

  it("names anchor and boolean-schema references accurately", () => {
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "#T" } } }))
      .toEqual({ unsupported: "anchor reference #T" });
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "#/$defs/Any", description: "x" } }, $defs: { Any: true } }))
      .toEqual({ unsupported: "reference to a boolean schema #/$defs/Any" });
  });

  it("refuses a malformed reference instead of throwing", () => {
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "#/$defs/100%" } }, $defs: { "100%": { type: "string" } } }))
      .toEqual({ unsupported: "malformed reference #/$defs/100%" });
  });

  it("drops identifiers that would repeat once a definition is inlined twice", () => {
    const result = flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/T" }, b: { $ref: "#/$defs/T" } },
      $defs: { T: { $id: "https://vendor.test/T", $anchor: "t", type: "string" } },
    });
    expect(result).toEqual({ schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } } });
  });

  it("refuses a reference graph that expands beyond the size bound", () => {
    const $defs: Record<string, unknown> = { L0: { type: "string", description: "x".repeat(64) } };
    for (let level = 1; level <= 16; level += 1) {
      $defs[`L${level}`] = { type: "object", properties: { a: { $ref: `#/$defs/L${level - 1}` }, b: { $ref: `#/$defs/L${level - 1}` } } };
    }
    expect(flattenSchema({ type: "object", properties: { root: { $ref: "#/$defs/L16" } }, $defs }))
      .toEqual({ unsupported: "flattened schema exceeds 20000 nodes" });
  });
});
