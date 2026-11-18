// Real check RC2 (contract): the GraphQL reader (only `query` operations are a read) and the strict JSON reader (a repeated key is a refusal).
import { describe, expect, it } from "vitest";
import { parseGraphqlDocument, parseStrictJson, REAL_CHECK_GRAPHQL_LIMITS } from "../../packages/contracts/src/real-check-graphql.js";

const code = (source: unknown) => {
  const verdict = parseGraphqlDocument(source);
  return verdict.ok ? "ok" : verdict.code;
};

describe("parseGraphqlDocument", () => {
  it("accepts queries: the shorthand, named, with variables, directives and fragments", () => {
    expect(code("{ viewer { id } }")).toBe("ok");
    expect(code("query { viewer { id } }")).toBe("ok");
    expect(code("query Videos($first: Int = 10, $filter: In = {a: [1, 2], b: \"x\"}) @cached(ttl: 5) { videos(first: $first) { ...F } } fragment F on Video { id title }")).toBe("ok");
    expect(code("query A { a } query B { b }")).toBe("ok");
    expect(parseGraphqlDocument("query A { a } { b }")).toEqual({ ok: true, operations: 2 });
  });

  it("refuses a mutation, however it is spelled or placed", () => {
    expect(code("mutation { deleteAll }")).toBe("mutation");
    expect(code("mutation Delete($id: ID!) { delete(id: $id) { ok } }")).toBe("mutation");
    expect(code("query A { a } mutation B { b }")).toBe("mutation");
    expect(code("mutation { a } query A { a }")).toBe("mutation");
    expect(code("# a comment\n  mutation { a }")).toBe("mutation");
    expect(code("fragment F on T { id } mutation { a }")).toBe("mutation");
    expect(code("﻿mutation{a}")).toBe("mutation");
    expect(code("query A { a },,, mutation B { b }")).toBe("mutation");
    expect(code("query A { a }\r\nmutation B { b }")).toBe("mutation");
  });

  it("refuses a subscription and a type-system document", () => {
    expect(code("subscription { events }")).toBe("subscription");
    expect(code("query A { a } subscription S { s }")).toBe("subscription");
    for (const source of ["type Query { a: Int }", "schema { query: Q }", "extend type Q { a: Int }", "directive @x on FIELD", "scalar Date", "\"desc\" type Q { a: Int }"]) expect(code(source), source).toBe("not_an_operation");
  });

  it("does not read a keyword inside a string, a block string, a comment, a name or a nested selection as an operation", () => {
    expect(code('query { a(x: "mutation { z }") }')).toBe("ok");
    expect(code('query { a(x: """ mutation { z } """) }')).toBe("ok");
    expect(code('query { a(x: """ \\""" mutation { z } """) }')).toBe("ok");
    expect(code("query { a } # mutation { z }")).toBe("ok");
    expect(code("query mutation { a }")).toBe("ok");
    expect(code("query { mutation { subscription } }")).toBe("ok");
    expect(code("query { a(x: \"}}} mutation {\") }")).toBe("ok");
  });

  it("refuses what does not lex or whose brackets do not match", () => {
    for (const source of ["", "   ", "query {", "query { a ", "{ a } }", "query { a(x: [1) }", "query { a(x: \"open) }", 'query { a(x: """open) }', "query { a } %", "query { a(x: 1.) }", "query { a(x: 1a) }", "query { a } \u0000", "query ($a) { a }}", "query @ { a }", "query A B { a }", "fragment on T { a }", "fragment F T { a }", "query (", "}", "...", "query { a } ."]) {
      expect(code(source), JSON.stringify(source)).toMatch(/unreadable|not_an_operation/u);
      expect(code(source)).not.toBe("ok");
    }
    expect(code("query { a } %")).toBe("unreadable");
    expect(code(undefined)).toBe("unreadable");
    expect(code(42)).toBe("unreadable");
  });

  it("a document with only a fragment has no operation", () => {
    expect(code("fragment F on T { a }")).toBe("not_an_operation");
  });

  it("is bounded: a long document, a deep one and a huge token count are refused without hanging", () => {
    expect(code(`query { ${"a ".repeat(REAL_CHECK_GRAPHQL_LIMITS.documentChars)} }`)).toBe("unreadable");
    expect(code(`query ${"{ a ".repeat(REAL_CHECK_GRAPHQL_LIMITS.depth + 5)}${"}".repeat(REAL_CHECK_GRAPHQL_LIMITS.depth + 5)}`)).toBe("unreadable");
    const many = `query { ${"a ".repeat(REAL_CHECK_GRAPHQL_LIMITS.tokens + 10)} }`;
    expect(many.length).toBeLessThan(REAL_CHECK_GRAPHQL_LIMITS.documentChars + 1);
    expect(code(many)).toBe("unreadable");
    const start = Date.now();
    code(`query { ${"a(b: [".repeat(30)}${"]) ".repeat(30)} }`);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("parseStrictJson", () => {
  it("reads ordinary JSON", () => {
    expect(parseStrictJson('{"a":1,"b":[true,null,"x"],"c":{"d":-1.5e3}}')).toEqual({ ok: true, value: { a: 1, b: [true, null, "x"], c: { d: -1500 } } });
    expect(parseStrictJson(" [ ] ")).toEqual({ ok: true, value: [] });
    expect(parseStrictJson("{}")).toEqual({ ok: true, value: {} });
    expect(parseStrictJson('"\\u00e9\\n"')).toEqual({ ok: true, value: "é\n" });
  });

  it("refuses a repeated key at any depth", () => {
    expect(parseStrictJson('{"query":"{a}","query":"mutation{b}"}').ok).toBe(false);
    expect(parseStrictJson('{"a":{"b":1,"b":2}}').ok).toBe(false);
    expect(parseStrictJson('[{"a":1,"a":1}]').ok).toBe(false);
    expect(parseStrictJson('{"a":1,"\\u0061":2}').ok).toBe(false);
  });

  it("refuses what JSON refuses, trailing bytes and deep nesting", () => {
    for (const text of ["", "{", '{"a":}', "{'a':1}", "[1,]", '{"a":1,}', "01", "1.", "NaN", "undefined", '{"a":1} x', '"\u0001"', "[1] [2]", '{"a" 1}']) expect(parseStrictJson(text).ok, text).toBe(false);
    expect(parseStrictJson(`${"[".repeat(REAL_CHECK_GRAPHQL_LIMITS.jsonDepth + 2)}${"]".repeat(REAL_CHECK_GRAPHQL_LIMITS.jsonDepth + 2)}`).ok).toBe(false);
    expect(parseStrictJson(`${"[".repeat(5)}${"]".repeat(5)}`).ok).toBe(true);
  });

  it("keeps a __proto__ key as a plain member", () => {
    const result = parseStrictJson('{"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (result.ok) expect(Object.keys(result.value as object)).toEqual(["__proto__"]);
  });
});
