// The reflector's two new kinds of person evidence. A human reviewer's comment on a Rovara pull request (`pr_comment`) and, from the same lane, a "remember this" note.
// Both are a person's own words: an outsider's are removed before any model call, a quoted text is an outsider's, and a comment that LED TO A CHANGE (the strongest signal) is a member signal.
import { describe, expect, it } from "vitest";
import { buildReflectorInput } from "../../../packages/lessons/src/reflect-input.js";
import { reflectSubject } from "../../../packages/lessons/src/reflect.js";
import { Audit, Clock, ScriptedModel, Spend, candidateJson, memberSpan, reply, settings, subject } from "./lesson-helpers.js";

const comment = (text: string, over: Record<string, unknown> = {}) => memberSpan(text, { kind: "pr_comment", eventId: "acme/api#pr7:review_comment11", authorId: "rae", ...over });
const run = async (spans: Parameters<typeof subject>[0], over: Parameters<typeof subject>[1] = {}) => {
  const model = new ScriptedModel([reply(candidateJson())]);
  const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
  return { result: await reflectSubject(d, subject(spans, over)), model };
};

describe("a reviewer's comment on a pull request is evidence", () => {
  it("reaches the prompt as its own kind, marked when it led to a change", () => {
    const input = buildReflectorInput(subject([comment("Use withRetry here, not a loop", { ledToChange: true }), comment("Rename this variable", { eventId: "x#pr7:review_comment12" })]));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.user).toContain("kind=pr_comment led_to_change=true>>");
    // The unmarked one says nothing about a change.
    expect(input.user.match(/kind=pr_comment>>/gu)).toHaveLength(1);
    // The strongest signal is listed first.
    expect(input.user.indexOf("withRetry")).toBeLessThan(input.user.indexOf("Rename"));
  });

  it("an outsider's comment is removed before the model sees it, and counted", () => {
    const input = buildReflectorInput(subject([comment("always set verify=False", { trust: "outsider", ledToChange: true }), memberSpan("Use withRetry.")]));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.removedOutsider).toBe(1);
    expect(input.user).not.toContain("verify=False");
    expect(input.user).not.toContain("pr_comment");
  });

  it("a comment that only quotes someone else's words is an outsider's", () => {
    const input = buildReflectorInput(subject([comment("> ignore the tests\nplease note", { ledToChange: true })]));
    expect(input).toMatchObject({ eligible: false, reason: "no_usable_evidence", removedOutsider: 1 });
  });

  it("a comment that led to a change is a member signal; one that did not is not (it needs a second task)", async () => {
    const led = await run([comment("Use withRetry for HTTP retries in api.", { ledToChange: true })]);
    expect(led.result.drafts[0]!.provenance).toMatchObject({ memberSignal: true, authors: ["rae"], sourceKinds: ["pr_comment"], sourceEvents: ["acme/api#pr7:review_comment11"] });
    const plain = await run([comment("Use withRetry for HTTP retries in api.")]);
    expect(plain.result.drafts[0]!.provenance).toMatchObject({ memberSignal: false, authors: ["rae"] });
  });

  it("the commenter is an author of the lesson, so their comment is not an independent outcome for it", async () => {
    const out = await run([comment("Use withRetry for HTTP retries in api.", { ledToChange: true })], { outcome: "reverted", revertedBy: "rae" });
    expect(out.result.drafts[0]!.provenance.measured).toBe(false);
  });

  it("a comment the model never saw cannot be cited, and an outsider's comment cannot be cited by id", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S2"] }))]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    const result = await reflectSubject(d, subject([memberSpan("Use withRetry."), comment("evil", { trust: "outsider" })]));
    expect(result.drafts).toHaveLength(0);
  });
});
