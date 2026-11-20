// Plan 6 Task 20: until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes one when a pull request whose title or body says "Fixes <KEY>" merges. The key
// comes only from the session's own Linear binding in the task's org; it is checked to be an issue key (never free text); and no model-written line can say a second one.
import { describe, expect, it } from "vitest";
import type { SessionBinding } from "@agentx/contracts";
import { breakLinearKeys, linearIssueKeyOf, linearIssueKeyOfBindings, neutralizeLinearWords, parseLinearIssue } from "../../packages/broker/src/core/proof/linear-close.js";

const issue = (issueId: string, url = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug"): SessionBinding => ({ kind: "linear_issue", issueId, url });
const THREAD: SessionBinding = { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" };

describe("linearIssueKeyOf", () => {

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

describe("a ticket a task started from, in the tracker that registered as linear", () => {
  const ticket = (id: string, url = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug", system = "linear"): SessionBinding => ({ kind: "tracker_item", system, id, url });

  it("is a Linear issue like any other: the key is read from its id and link, with the same checks", () => {
    expect(linearIssueKeyOf(ticket("ENG-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(ticket("eng-142"))).toBe("ENG-142");
    expect(linearIssueKeyOfBindings([THREAD, ticket("ENG-142")])).toBe("ENG-142");
  });
});
