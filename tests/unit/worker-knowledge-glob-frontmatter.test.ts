import { describe, expect, it } from "vitest";
import { expandBraces, matchesGlob, MAX_GLOB_PATTERN_LENGTH } from "../../packages/worker/src/knowledge/glob.js";
import { asPatternList, parseFrontMatter } from "../../packages/worker/src/knowledge/frontmatter.js";
import { expectLinearScaling } from "../support/scaling.js";

describe("knowledge glob matcher", () => {
  it("matches the patterns rule files use", () => {
    expect(matchesGlob("**/*.py", "src/match/rank.py")).toBe(true);
    expect(matchesGlob("**/*.py", "rank.py")).toBe(true);
    expect(matchesGlob("**/*.py", "src/match/rank.ts")).toBe(false);
    expect(matchesGlob("src/ui/**", "src/ui/a/b.tsx")).toBe(true);
    expect(matchesGlob("src/ui/**", "src/uix/a.tsx")).toBe(false);
    expect(matchesGlob("components/**/*.tsx", "components/a/b/c.tsx")).toBe(true);
    expect(matchesGlob("**/*.{ts,tsx}", "a/b.tsx")).toBe(true);
    expect(matchesGlob("**/*.{ts,tsx}", "a/b.js")).toBe(false);
    expect(matchesGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/[a-c].ts", "src/b.ts")).toBe(true);
    expect(matchesGlob("src/[!a-c].ts", "src/b.ts")).toBe(false);
  });

  it("matches a pattern with no slash against the file name at any depth, and a trailing slash as everything below", () => {
    expect(matchesGlob("*.tsx", "src/ui/a.tsx")).toBe(true);
    expect(matchesGlob("*.tsx", "src/ui/a.ts")).toBe(false);
    expect(matchesGlob("docs/", "docs/a/b.md")).toBe(true);
    expect(matchesGlob("./src/*.ts", "src/a.ts")).toBe(true);
  });

  it("expands braces, with a bound", () => {
    expect(expandBraces("a.{x,y}")).toEqual(["a.x", "a.y"]);
    expect(expandBraces("{a,b}{c,d}")?.toSorted()).toEqual(["ac", "ad", "bc", "bd"]);
    expect(expandBraces("{a,b,c,d,e}{a,b,c,d,e}{a,b,c,d,e}")).toBeUndefined();
    expect(matchesGlob("{a,b,c,d,e}{a,b,c,d,e}{a,b,c,d,e}", "aaa")).toBe(false);
  });

  it("refuses what is too long and is not caught by catastrophic patterns", () => {
    expect(matchesGlob("a".repeat(MAX_GLOB_PATTERN_LENGTH + 1), "a")).toBe(false);
    const nasty = `${"*a".repeat(60)}b`;
    const deep = "**/**/**/**/**/**/**/x";
    expect(matchesGlob(nasty, `${"a".repeat(200)}`)).toBe(false);
    expect(matchesGlob(deep, `${"d/".repeat(60)}y`)).toBe(false);
    // Catastrophic patterns must cost about eight times as much for eight times the path (the pattern stays as hostile as before), not sixty-four times or more.
    let matched = true;
    expectLinearScaling((length) => { const path = "a".repeat(length); return () => { matched = matchesGlob(nasty, path); }; }, { n: 25, label: "glob with many stars over a long segment" });
    expect(matched).toBe(false);
    expectLinearScaling((segments) => { const path = `${"d/".repeat(segments)}y`; return () => { matched = matchesGlob(deep, path); }; }, { n: 7, label: "glob with many ** over a deep path" });
    expect(matched).toBe(false);
  });

  it("matches nothing for an empty pattern or path", () => {
    expect(matchesGlob("", "a")).toBe(false);
    expect(matchesGlob("*", "")).toBe(false);
  });
});

describe("knowledge front matter", () => {
  it("reads strings, booleans, inline lists and block lists", () => {
    const parsed = parseFrontMatter('---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.py", \'src/**\']\nname: "Py style"\nalwaysApply: false\npaths:\n  - a/**\n  - b/**\n---\nBody\n');
    expect(parsed).toEqual({
      ok: true,
      present: true,
      data: { inclusion: "fileMatch", fileMatchPattern: ["**/*.py", "src/**"], name: "Py style", alwaysApply: false, paths: ["a/**", "b/**"] },
      body: "Body\n",
    });
  });

  it("keeps a quoted true as a string and accepts a byte-order mark and CRLF", () => {
    expect(parseFrontMatter('﻿---\r\nname: "true"\r\nflag: true\r\n---\r\nx')).toMatchObject({ ok: true, data: { name: "true", flag: true }, body: "x" });
  });

  it("refuses what is not a small subset of YAML", () => {
    expect(parseFrontMatter("---\na: b\n")).toEqual({ ok: false, reason: "unterminated" });
    expect(parseFrontMatter("---\na: &x b\n---\n")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter("---\na: !!str b\n---\n")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter("---\na: |\n  text\n---\n")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter("---\na:\n  b: c\n---\n")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter("---\na: b\na: c\n---\n")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter('---\na: "unterminated\n---\n')).toEqual({ ok: false, reason: "unsupported" });
    expect(parseFrontMatter(`---\n${"x".repeat(9000)}: y\n---\n`)).toEqual({ ok: false, reason: "too_large" });
  });

  it("makes pattern lists, splitting commas outside braces only when asked", () => {
    expect(asPatternList("**/*.{ts,tsx}, docs/**", { splitCommas: true })).toEqual(["**/*.{ts,tsx}", "docs/**"]);
    expect(asPatternList("a,b", { splitCommas: false })).toEqual(["a,b"]);
    expect(asPatternList(["a", "b"], { splitCommas: true })).toEqual(["a", "b"]);
    expect(asPatternList("", { splitCommas: true })).toBeUndefined();
    expect(asPatternList(true, { splitCommas: true })).toBeUndefined();
  });
});
