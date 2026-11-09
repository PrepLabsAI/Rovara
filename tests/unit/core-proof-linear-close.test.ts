// Plan 6 Task 20: until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes one when a pull request whose title or body says "Fixes <KEY>" merges. The key
// comes only from the session's own Linear binding in the task's org; it is checked to be an issue key (never free text); and no model-written line can say a second one.
import { describe, expect, it } from "vitest";
import type { SessionBinding } from "@agentx/contracts";
import { inertLine } from "../../packages/broker/src/core/proof/inert-text.js";
import { breakLinearKeys, linearCloseLine, linearIssueKeyOf, linearIssueKeyOfBindings, neutralizeLinearWords, parseLinearIssue, sealLinearText } from "../../packages/broker/src/core/proof/linear-close.js";

const issue = (issueId: string, url = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug"): SessionBinding => ({ kind: "linear_issue", issueId, url });
const THREAD: SessionBinding = { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" };

describe("linearIssueKeyOf", () => {
  it("reads the key from the issue id, or from the issue's link", () => {
    expect(linearIssueKeyOf(issue("ENG-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("eng-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app/acme/issue/eng-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("ENG-142", "https://linear.app/acme/issue/ENG-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("A2-7", "https://linear.app/acme/issue/A2-7/x"))).toBe("A2-7");
  });

  it("is nothing for a Slack thread, an id and a link that disagree, a link that is not Linear's, or anything that is not an issue key", () => {
    expect(linearIssueKeyOf(THREAD)).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-142", "https://linear.app/acme/issue/OPS-9/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://evil.example/acme/issue/ENG-142/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app.evil.example/acme/issue/ENG-142/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app/acme/project/ENG-142"))).toBeUndefined();
    for (const id of ["ENG", "ENG-", "-142", "ENG-0", "ENG_142", "ENG-142x", "ENG-12345678901", "TOOLONGTEAMKEY-1"]) {
      expect(linearIssueKeyOf(issue(id, "https://linear.app/acme/team/all")), id).toBeUndefined();
    }
  });

  it("says Fixes <KEY>", () => {
    expect(linearCloseLine("ENG-142")).toBe("Fixes ENG-142");
  });
});

describe("linearIssueKeyOfBindings", () => {
  // Reading the bindings from the session store, in the task's own company, is the sessions module's (lane L6b); this takes what it read.
  it("is the key of the session's Linear issue, whichever binding comes first", () => {
    expect(linearIssueKeyOfBindings([THREAD, issue("ENG-142")])).toBe("ENG-142");
    expect(linearIssueKeyOfBindings([issue("ENG-142"), THREAD])).toBe("ENG-142");
  });

  it("is nothing without a Linear binding, and nothing for a binding that is not usable", () => {
    expect(linearIssueKeyOfBindings([])).toBeUndefined();
    expect(linearIssueKeyOfBindings([THREAD])).toBeUndefined();
    expect(linearIssueKeyOfBindings([issue("ENG-142", "https://evil.example/acme/issue/ENG-142/x")])).toBeUndefined();
    expect(linearIssueKeyOfBindings([issue("ENG-142", "https://linear.app/acme/issue/OPS-9/x")])).toBeUndefined();
  });
});

/** Every Linear-key-shaped token in a text. */
const keys = (text: string) => text.match(/[A-Za-z][A-Za-z0-9]*-\d+/gu) ?? [];
/**
 * What Linear's reader acts on: one of its magic words (closing: close, fix, resolve, complete, implement; linking: ref, references, part of, contributes to, towards, updates, related to) as a whole word,
 * then an issue key within a few characters of punctuation, markup or an entity. The test's own list, written out from Linear's documentation, not shared with the code.
 */
const MAGIC = /(?<![A-Za-z0-9])(?:close[sd]?|closing|fix(?:es|ed|ing)?|resolve[sd]?|resolving|complete[sd]?|completing|implement(?:s|ed|ing)?|refs?|references|towards?|updates|part\s+of|contributes\s+to|contribute\s+to|relates?\s+to|related\s+to)(?![A-Za-z0-9])(?:[^A-Za-z0-9]|&[a-z]+;|&#x?[0-9a-f]+;){0,12}[A-Za-z][A-Za-z0-9]*\\?-\d/giu;
const linked = (text: string) => text.match(MAGIC) ?? [];
const JOINER = "\u200D";

describe("a model-written line cannot close or link a Linear issue", () => {
  it.each([
    "Fixes ENG-142", "fixes eng-142", "Closes ENG-142.", "closed ENG-142", "Resolves: ENG-142", "Completes   ENG-142", "fixing ENG-142", "Fix ENG-142 properly", "Implements ENG-142", "implemented ENG-1",
    "Fixes ENG-1, ENG-2", "closes ENG-1 and OPS-2", "resolves ENG-1 & OPS-2", "(fixes ENG-1)",
    // Linking words, which move an issue though they do not close it.
    "Part of ENG-1", "part  of ENG-1", "Contributes to ENG-1", "Related to ENG-1", "Relates to ENG-1", "Towards ENG-1", "Updates ENG-1", "Refs ENG-1", "References ENG-1", "ref: ENG-1",
    // Markdown, code spans, brackets, entities and punctuation between the word and the key.
    "_Fixes ENG-1_", "__Fixes__ ENG-1", "**Fixes** ENG-1", "Fixes **ENG-1**", "Fixes `ENG-1`", "Fixes (ENG-1)", "Fixes - ENG-1", "Fixes #ENG-1", "Fix-ENG-1", "~~Fixes~~ ENG-1",
    "Fixes&nbsp;ENG-1", "Fixes&#32;ENG-1", "Fixes\nENG-1", "Fixes\r\n\r\nENG-1", "Fixes OPS\\-12", "FIXES ENG-1", "fIxEs ENG-1",
    // More than one key, with any separator.
    "Fixes ENG-1 ENG-2", "Fixes ENG-1, and ENG-2", "fixes ENG-1;OPS-2", "Fixes ENG-1/ENG-2", "Fixes ENG-1\tENG-2",
    // A long team key, a key with a digit and one that follows a letter or an underscore.
    "Fixes ABCDEFGHIJKLM-12", "Fixes A2-7", "Fixes _ENG-1_", "Fixes abc9ENG-1", "Fixes ENG-0142", "closes UTF-8",
  ])("neutralizes the magic word in %j, keeps the key as it was, and keeps the text readable", (line) => {
    expect(linked(line).length).toBeGreaterThan(0);
    const out = neutralizeLinearWords(line);
    expect(linked(out), out).toEqual([]);
    expect(keys(out)).toEqual(keys(line));
    expect(out.replaceAll(JOINER, "")).toBe(line);
  });

  it.each(["_ENG-1_", "~~ENG-1~~", "[ENG-1](x)", "<ENG-1>", "\"ENG-1\"", "ENG-1|ENG-2", "ENG-1", "ABCDEFGHIJKLM-12", "A2-7", "x_ENG-1", "See https://linear.app/acme/issue/ENG-1/slug", "Ships ENG-1", "Relates ENG-1"])(
    "leaves %j exactly as it is: no magic word is in it", (line) => {
      expect(neutralizeLinearWords(line)).toBe(line);
    });

  it("leaves technical text byte for byte: UTF-8, SHA-256, node-22, x86-64, ISO-8601, paths, versions and dates", () => {
    for (const line of [
      "UTF-8", "SHA-256", "node-22", "x86-64", "ISO-8601", "python-3.11", "TLS-1.3", "COVID-19", "CVE-2024-1234", "iPhone-15", "2026-10-26", "v1.2.3", "12-34",
      "src/utf-8-handler.ts", "db/V1-2__init.sql", "docs/ADR-0007.md", "git checkout feature-2", "npm i node-22 && sha256sum -c SHA-256.txt", "Use UTF-8 and SHA-256 for the digest",
      "```sh\nnpm i node-22\nopenssl dgst -sha-256 file\n```", "`git checkout feature-2`", "- Passed: Unit tests (x86-64)",
    ]) {
      expect(neutralizeLinearWords(line), line).toBe(line);
    }
  });

  it("changes only the magic word inside code and fences, and leaves the rest of them", () => {
    const fenced = "```\nfixes ENG-1\nnode-22\n```";
    const out = neutralizeLinearWords(fenced);
    expect(linked(out)).toEqual([]);
    expect(out).toContain("node-22");
    expect(out.replaceAll(JOINER, "")).toBe(fenced);
    const span = neutralizeLinearWords("run `closes UTF-8` now");
    expect(linked(span)).toEqual([]);
    expect(span).toContain("UTF-8");
  });

  it("leaves ordinary use of the words alone: no key follows", () => {
    for (const line of ["Fixes the null check", "The fix for UTF8 is done", "Closes the connection", "This updates the docs", "Completed the migration", "Fixes #12", "Fixes nothing", "part of the plan", "a ref to the base", "Fixes from PR feedback", "Prefixes ENG-1", "Postfix ENG-1", "Fixture ENG-1", "Fixesing ENG-1", "Closeness ENG-1", "Transfixes ENG-1", "Fixture-1", "Closeness-2", "Refer-3"]) {
      expect(neutralizeLinearWords(line), line).toBe(line);
    }
  });

  it("is what inertLine does to every line it makes inert, and does not mangle a path", () => {
    for (const line of ["_Fixes OPS-3_ by retrying", "Fixes `OPS-3`", "Part of OPS-3", "see (OPS-3)"]) expect(linked(inertLine(line, 200)), line).toEqual([]);
    expect(inertLine("_Fixes OPS-3_ by retrying", 200).replaceAll(JOINER, "")).toBe("_Fixes OPS-3_ by retrying");
    expect(inertLine("db/V1-2__init.sql and UTF-8 and node-22", 200)).toBe("db/V1-2__init.sql and UTF-8 and node-22");
  });

  it("runs in time proportional to the text, however it is shaped", () => {
    const started = Date.now();
    for (const text of ["fix ".repeat(50_000), `fix ${"a".repeat(200_000)}-1`, "fixes &".repeat(30_000), `${"a1".repeat(100_000)}-5`]) neutralizeLinearWords(text);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("seals every line but Rovara's own Fixes line", () => {
    const lines = ["Fixes ENG-142", "- note: fixes ENG-142 too", "Fixes ENG-142 ", "fixes ENG-142", "Fixes ENG-1432", "Part of ENG-142"];
    const sealed = sealLinearText(lines, "ENG-142");
    expect(sealed[0]).toBe("Fixes ENG-142");
    for (const line of sealed.slice(1)) expect(linked(line), line).toEqual([]);
    expect(sealLinearText(lines, undefined).every((line) => linked(line).length === 0)).toBe(true);
    expect(sealLinearText(["Fixes ENG-142"], undefined)).not.toEqual(["Fixes ENG-142"]);
  });
});

describe("breakLinearKeys, for a pull request's title", () => {
  it.each(["ENG-142", "ENG-0142", "ENG-0", "eng-9", "Fixes ENG-1", "_ENG-1_", "(OPS-2)", "ABCDEFGHIJKLM-12", "x_ENG-1", "ENG-1 ENG-2"])("breaks every key in %j and keeps it readable", (line) => {
    const broken = breakLinearKeys(line);
    expect(keys(broken), broken).toEqual([]);
    expect(broken.replaceAll(JOINER, "")).toBe(line);
  });

  it("leaves text with no key alone", () => {
    for (const line of ["Add a retry flag", "ENG 142", "ENG-", "-142", "2026-10-26", "12-34"]) expect(breakLinearKeys(line), line).toBe(line);
  });
});

describe("parseLinearIssue", () => {
  it("keeps only the key and Linear's short link: a typed workspace is dropped, as the company's own workspace is not known", () => {
    expect(parseLinearIssue("eng-142")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://linear.app/othercorp/issue/ENG-142/slug?x=1#y")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://linear.app/issue/ENG-142")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://evil.example/acme/issue/ENG-142")).toBeUndefined();
  });
});

describe("a binding whose link is not Linear's", () => {
  it("names no issue, even when its id is a key", () => {
    expect(linearIssueKeyOf(issue("ENG-5", "https://evil.com/acme/issue/ENG-6"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app.evil.example/acme/issue/ENG-5"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app/acme/issue/ENG-5"))).toBe("ENG-5");
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app/issue/ENG-5"))).toBe("ENG-5");
  });
});
