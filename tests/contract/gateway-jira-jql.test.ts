import { describe, expect, it } from "vitest";
import { limitJqlToProject, MAX_JQL_LENGTH } from "../../packages/gateway/src/index.js";

/** The query with quoted strings as S and every parenthesised group's inside removed. */
function skeleton(jql: string): string {
  let out = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]!;
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; if (depth === 0) out += "S"; continue; }
    if (char === "(") { if (depth === 0) out += "("; depth += 1; continue; }
    if (char === ")") { depth -= 1; if (depth === 0) out += ")"; continue; }
    if (depth === 0) out += char;
  }
  return out;
}
const LIMITED = /^project = S( AND \(\))?( order\s+by(\s[^()]*)?)?$/i;

/** Every accepted result keeps the project constraint and adds no boolean logic outside the group. */
function expectContained(jql: string): void {
  const result = limitJqlToProject(jql, "PAY");
  if ("refused" in result) {
    expect(result.refused.length).toBeGreaterThan(0);
    return;
  }
  expect(result.jql.startsWith('project = "PAY"')).toBe(true);
  const outside = skeleton(result.jql);
  expect(outside).toMatch(LIMITED);
  expect(outside.replace(/^project = S( AND \(\))?/, "")).not.toMatch(/\b(and|or|not)\b|[|&!]/i);
}

describe("JQL project limiter", () => {
  it.each([
    ["status = Open", 'project = "PAY" AND (status = Open)'],
    ["status = Open ORDER BY created DESC", 'project = "PAY" AND (status = Open) ORDER BY created DESC'],
    ["status = Open order by rank, created", 'project = "PAY" AND (status = Open) order by rank, created'],
    ["ORDER BY created", 'project = "PAY" ORDER BY created'],
    ["", 'project = "PAY"'],
    ["   ", 'project = "PAY"'],
    ["project = OPS", 'project = "PAY" AND (project = OPS)'],
    ["status = Open OR project = OPS", 'project = "PAY" AND (status = Open OR project = OPS)'],
    ['summary ~ "a) OR (b"', 'project = "PAY" AND (summary ~ "a) OR (b")'],
    ['summary ~ "order by me"', 'project = "PAY" AND (summary ~ "order by me")'],
    ["summary ~ 'it\\'s'", "project = \"PAY\" AND (summary ~ 'it\\'s')"],
    ["(status = Open) ORDER BY created", 'project = "PAY" AND ((status = Open)) ORDER BY created'],
    ["reorder = 1", 'project = "PAY" AND (reorder = 1)'],
  ])("wraps %j", (jql, expected) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ jql: expected });
  });

  it.each([
    ["status = Open) OR (project = OPS", "unbalanced parentheses"],
    ["(status = Open", "unbalanced parentheses"],
    ['summary ~ "unterminated', "an unterminated quoted string"],
    ["summary ~ a\\)b", "a backslash outside a quoted string"],
    ["(status = Open ORDER BY created)", "ORDER BY inside parentheses"],
    ["status = Open ORDER BY created ORDER BY rank", "more than one ORDER BY"],
    ["status = Open ORDER BY created, (rank)", "parentheses after ORDER BY"],
    ["a".repeat(8_193), "JQL is longer than 8192 characters"],
  ])("refuses %j", (jql, reason) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ refused: reason });
  });

  it("refuses an invalid project key rather than build JQL from it", () => {
    expect(limitJqlToProject("status = Open", 'PAY" OR project = "OPS')).toEqual({ refused: "invalid project key" });
  });

  it("never lets model text escape the parenthesised group, for 5,000 generated queries", () => {
    const tokens = ["(", ")", '"', "'", "\\", " OR ", " AND ", " NOT ", "project = OPS", " ORDER BY x", "order by", "a", " ", "~"];
    let seed = 42;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed; };
    let accepted = 0;
    for (let run = 0; run < 5_000; run += 1) {
      const length = next() % 12;
      const jql = Array.from({ length }, () => tokens[next() % tokens.length]).join("");
      const result = limitJqlToProject(jql, "PAY");
      if ("refused" in result) { expect(result.refused.length).toBeGreaterThan(0); continue; }
      accepted += 1;
      expect(result.jql.startsWith('project = "PAY"')).toBe(true);
      expect(skeleton(result.jql)).toMatch(LIMITED);
    }
    expect(accepted).toBeGreaterThan(500);
  });
});

describe("JQL project limiter, adversarial", () => {
  it("accepts exactly the maximum length", () => {
    expect(MAX_JQL_LENGTH).toBe(8_192);
    expect("jql" in limitJqlToProject("a".repeat(MAX_JQL_LENGTH), "PAY")).toBe(true);
  });

  it.each([
    ["pay"],
    [""],
    ["P"],
    ["PAYMENTSTEAM"],
    ["1PAY"],
    ["PAY)"],
    ["PAY "],
    ["ＰＡＹ"],
    ["PAY\n"],
  ])("refuses project key %j", (key) => {
    expect(limitJqlToProject("status = Open", key)).toEqual({ refused: "invalid project key" });
  });

  it.each([
    // quote and escape tricks, agreed with the JQL lexer
    ['summary ~ "a\\\\" ) OR project = OPS OR ( "b"', "unbalanced parentheses"],
    ['summary ~ "abc\\"', "an unterminated quoted string"],
    ["summary ~ 'abc\\'", "an unterminated quoted string"],
    ['summary ~ "a\' ) OR (project = OPS', "an unterminated quoted string"],
    // a quote glued to a word, where a lexer could read it as a literal character
    ['a"b ) OR project = OPS OR ( c"', "a quote joined to a word"],
    ["summary ~ x'y ) OR project = OPS OR ( z'", "a quote joined to a word"],
    ['summary ~ "x"y', "a quote joined to a word"],
    // comments, in case the upstream parser ever honours them
    ["status = Open /* ( */ ) OR project = OPS OR (x = 1 /* ) */", "a comment marker"],
    ["status = Open -- ) OR (project = OPS", "a comment marker"],
    ["status = Open // ) OR (project = OPS", "a comment marker"],
    // ORDER BY smuggling boolean logic outside the group
    ["status = Open ORDER BY created OR project = OPS", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created DESC AND project = OPS", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created || project = OPS", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created, not", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created,", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created = 1", "an ORDER BY clause that is not a list of fields"],
    ["status = Open ORDER BY created (", "parentheses after ORDER BY"],
    ["ORDER BY created) OR (project = OPS", "parentheses after ORDER BY"],
    // unicode look-alikes and control characters
    ["status = Open ） OR project = OPS OR （ x", "a look-alike of a JQL special character"],
    ['summary ~ ＂a＂', "a look-alike of a JQL special character"],
    ["status = Open ﹚ OR project = OPS OR ﹙ x", "a look-alike of a JQL special character"],
    ['summary ~ "a＂ ) OR project = OPS OR ( ＂b"', "a look-alike of a JQL special character"],
    ["status = Open\u0000", "a control character"],
    ['summary ~ "a\n) OR project = OPS OR (\nb"', "a control character"],
    ['summary ~ "a ) OR (b"', "a control character"],
    ["status = Open‮", "a control character"],
  ])("refuses %j", (jql, reason) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ refused: reason });
  });

  it.each([
    ["status = Open\nORDER BY\tcreated", 'project = "PAY" AND (status = Open) ORDER BY\tcreated'],
    ["status = Open Order  By created asc, rank DESC", 'project = "PAY" AND (status = Open) Order  By created asc, rank DESC'],
    ['ORDER BY "Story Points" DESC', 'project = "PAY" ORDER BY "Story Points" DESC'],
    ["ORDER BY cf[10010] ASC", 'project = "PAY" ORDER BY cf[10010] ASC'],
    ['summary ~ "it\'s"', 'project = "PAY" AND (summary ~ "it\'s")'],
    ['summary ~ "\\u0022) OR (project = OPS"', 'project = "PAY" AND (summary ~ "\\u0022) OR (project = OPS")'],
    ['status in ("Open","Done")', 'project = "PAY" AND (status in ("Open","Done"))'],
    ['status="Open"', 'project = "PAY" AND (status="Open")'],
    ["summary ~ café", 'project = "PAY" AND (summary ~ café)'],
    ["created >= -1d", 'project = "PAY" AND (created >= -1d)'],
    // a non-ASCII space is not a JQL separator, so this is not an ORDER BY and stays inside the group
    ["status = Open order by created", 'project = "PAY" AND (status = Open order by created)'],
    ["(x)ORDER BY created", 'project = "PAY" AND ((x)) ORDER BY created'],
    ["project = OPS OR project = PAY) OR (project = PAY", undefined],
  ])("handles %j", (jql, expected) => {
    const result = limitJqlToProject(jql, "PAY");
    if (expected === undefined) expect("refused" in result).toBe(true);
    else expect(result).toEqual({ jql: expected });
    expectContained(jql);
  });

  it("never throws and never leaks, for 20,000 queries over a hostile alphabet", () => {
    const tokens = [
      "(", ")", '"', "'", "\\", "\\\\", '\\"', " OR ", " or ", " AND ", " NOT ", "||", "&&", "!", "project = OPS",
      " ORDER BY ", "order\tby", "ORDER\nBY", " x", " DESC", ",", "a", " ", "~", "/*", "*/", "--", "\n", "\u0000",
      "（", "）", "＂", " ", " ", "é", "cf[1]", "=", "-", "*",
    ];
    let seed = 7;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed; };
    let accepted = 0;
    for (let run = 0; run < 20_000; run += 1) {
      const length = next() % 14;
      const jql = Array.from({ length }, () => tokens[next() % tokens.length]).join("");
      expect(() => limitJqlToProject(jql, "PAY")).not.toThrow();
      if ("jql" in limitJqlToProject(jql, "PAY")) accepted += 1;
      expectContained(jql);
    }
    expect(accepted).toBeGreaterThan(1_000);
  });
});
