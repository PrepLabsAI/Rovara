// Agent knowledge, step (a): how a lesson reads. Title = one imperative statement, description = why, body starts "When ...:". Golden text, and a SOFT check that warns and never rejects.
import { describe, expect, it } from "vitest";
import { LESSON_WORDING_HINTS, LESSON_WORDING_PROMPT_LINES, lessonWordingWarnings } from "@agentx/contracts";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { lessonsUsedLines } from "../../../packages/broker/src/core/proof/pull-request-body.js";
import { reflectSubject, type ReflectDeps } from "../../../packages/broker/src/lessons/reflect.js";
import { Audit, Clock, ScriptedModel, Spend, candidateJson, memberSpan, reply, settings, subject } from "../lessons/lesson-helpers.js";

describe("the wording hints (one text in one place, for the drafter and for the Keep and Edit screens)", () => {
  it("are pinned word for word", () => {
    expect(LESSON_WORDING_HINTS).toEqual({
      title: "Say what to do, in one sentence that starts with a verb. Example: \"Build the client with makeFakeBilling() in tests.\" or \"Do not call the billing API from tests; use FakeBilling.\"",
      description: "Say why, in one sentence. The reason lets an agent judge edge cases.",
      body: "Start with when it applies, like \"When writing a test under src/billing/:\", then say what to do. Put the files or folders it applies to in the scope, as globs.",
    });
  });
  it("the drafter is told the same three things, in fixed lines", () => {
    expect(LESSON_WORDING_PROMPT_LINES).toEqual([
      "How a lesson reads: \"title\" is one imperative sentence of at most 80 characters (\"Do X.\" or \"Do not do Y; do Z.\"), one idea only.",
      "\"description\" is the reason in one sentence of at most 160 characters; it is not a second statement.",
      "\"body\" starts with when it applies, \"When <situation>:\", then what to do (at most 600 characters). Put the files or folders where it applies in scope.paths as globs.",
    ]);
  });
});

describe("the soft check", () => {
  const good = { title: "Build the client with makeFakeBilling() in tests.", description: "Real calls charge the sandbox account.", body: "When writing a test under src/billing/: build the client with makeFakeBilling().", scope: { paths: ["src/billing/**"] } };
  it("a lesson written to the shape has no warning", () => {
    expect(lessonWordingWarnings(good)).toEqual([]);
    expect(lessonWordingWarnings({ ...good, title: "Do not call the billing API from tests; use FakeBilling." })).toEqual([]);
  });
  it("warns, with fixed codes, about each way a lesson departs from the shape", () => {
    expect(lessonWordingWarnings({ ...good, title: "The billing client is slow" })).toEqual(["title_not_imperative"]);
    expect(lessonWordingWarnings({ ...good, title: "Using FakeBilling in tests" })).toEqual(["title_not_imperative"]);
    expect(lessonWordingWarnings({ ...good, description: "" })).toEqual(["no_reason"]);
    expect(lessonWordingWarnings({ ...good, description: good.title })).toEqual(["no_reason"]);
    expect(lessonWordingWarnings({ ...good, body: "Build the client with makeFakeBilling()." })).toEqual(["body_no_when"]);
    expect(lessonWordingWarnings({ ...good, body: "When it matters build it right" })).toEqual(["body_no_when"]);
    expect(lessonWordingWarnings({ title: "The old way", description: "", body: "no trigger" })).toEqual(["title_not_imperative", "no_reason", "body_no_when"]);
  });
  it("never rejects an old lesson: it only returns codes, for any text, and never throws", () => {
    for (const text of ["", " ", "\u0000", "x".repeat(10_000), "When:", "when x:y"]) expect(() => lessonWordingWarnings({ title: text, description: text, body: text })).not.toThrow();
    expect(lessonWordingWarnings({ title: "x".repeat(10_000), description: "d", body: "b" }).every((code) => /^[a-z_]+$/u.test(code))).toBe(true);
  });
});

describe("the drafting prompt (golden)", () => {
  it("carries the wording lines in both prompt styles, right before the JSON shape", () => {
    for (const promptStyle of [undefined, "repo_only" as const]) {
      const input = buildReflectorInput(subject([memberSpan("Use withRetry for retries.")], promptStyle === undefined ? {} : { promptStyle }));
      if (!input.eligible) throw new Error("expected eligible");
      const lines = input.system.split("\n");
      const first = lines.findIndex((line) => line === LESSON_WORDING_PROMPT_LINES[0]);
      expect(first).toBeGreaterThan(0);
      expect(lines.slice(first, first + 3)).toEqual([...LESSON_WORDING_PROMPT_LINES]);
      expect(lines[first + 3]).toMatch(/^Reply with one JSON object and nothing else:/u);
    }
  });
});

describe("the drafter's output is kept whatever its wording", () => {
  it("a lesson that departs from the shape is still drafted unchanged, and only a count of fixed codes says so", async () => {
    const counts: Array<{ name: string; tags: Record<string, string> | undefined }> = [];
    const metrics = { count: (name: string, tags?: Record<string, string>) => { counts.push({ name, tags }); } };
    const clock = new Clock();
    const d: ReflectDeps = { model: new ScriptedModel([reply(candidateJson({ title: "The retry helper", description: "", body: "Wrap network calls in withRetry." }))]), spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: clock.now, newId: () => "run-1", metrics };
    const result = await reflectSubject(d, subject([memberSpan("Use withRetry for HTTP retries in api.")]));
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ title: "The retry helper", body: "Wrap network calls in withRetry." });
    expect(counts.filter((entry) => entry.name === "learning.lesson_wording_warning").map((entry) => entry.tags)).toEqual([{ code: "title_not_imperative" }, { code: "no_reason" }, { code: "body_no_when" }]);
    expect(JSON.stringify(counts)).not.toContain("withRetry");
  });
});

describe("the pull request's 'Lessons used' line shows each lesson as a statement and its reason", () => {
  const link = "https://app.example.test/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
  it("a private repository's entry is the title, then Why: and the reason, then the not-helpful link; no reason, no Why (byte for byte as before)", () => {
    const lines = lessonsUsedLines({ count: 2, taskUrl: link, entries: [
      { title: "Build the client with makeFakeBilling() in tests.", why: "Real calls charge the sandbox account.", notHelpfulUrl: `${link}?notHelpful=les_a1` },
      { title: "Keep money in cents.", notHelpfulUrl: `${link}?notHelpful=les_b2` },
    ] }, 30);
    expect(lines.slice(2, 4)).toEqual([
      `- Build the client with makeFakeBilling() in tests. Why: Real calls charge the sandbox account. ([not helpful](${link}?notHelpful=les_a1))`,
      `- Keep money in cents. ([not helpful](${link}?notHelpful=les_b2))`,
    ]);
  });
  it("the reason goes through the same inert-line cleaning as the title: no mention, link or hidden text", () => {
    const [entry] = lessonsUsedLines({ count: 1, taskUrl: link, entries: [{ title: "Use FakeBilling.", why: "Ask @octocat or see https://evil.example/x\u200b now", notHelpfulUrl: "" , number: 1 }] }, 30).slice(2, 3);
    expect(entry).toContain("Why:");
    expect(entry).not.toMatch(/@octocat|https:\/\/evil|\u200b/u);
  });
  it("a public or unknown repository still gets the count and the link only: no title, no reason", () => {
    const out = lessonsUsedLines({ count: 3, taskUrl: link, entries: [] }, 30).join("\n");
    expect(out).toContain("Rovara used 3 lessons");
    expect(out).not.toContain("Why:");
  });
});
