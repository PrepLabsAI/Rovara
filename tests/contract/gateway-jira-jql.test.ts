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
    ["status = Open order by rank, created", 'project = "PAY" AND (status = Open) order by rank, created'],
  ])("wraps %j", (jql, expected) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ jql: expected });
  });

  it.each([
    ["a".repeat(8_193), "JQL is longer than 8192 characters"],
  ])("refuses %j", (jql, reason) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ refused: reason });
  });

  it("refuses an invalid project key rather than build JQL from it", () => {
    expect(limitJqlToProject("status = Open", 'PAY" OR project = "OPS')).toEqual({ refused: "invalid project key" });
  });

});

describe("JQL project limiter, adversarial", () => {
  it("accepts exactly the maximum length", () => {
    expect(MAX_JQL_LENGTH).toBe(8_192);
    expect("jql" in limitJqlToProject("a".repeat(MAX_JQL_LENGTH), "PAY")).toBe(true);
  });



  it.each([
    ['ORDER BY "Story Points" DESC', 'project = "PAY" ORDER BY "Story Points" DESC'],
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
