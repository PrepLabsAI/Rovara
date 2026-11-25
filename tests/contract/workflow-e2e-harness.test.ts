// Self-tests for the workflow E2E harness's clock, its faux coder and the model fixtures. The controls that start a task (worker
// faults, recovery sweeps, Slack variants, the feedback page, MCP, webhooks, wire mode) drove the retired spec 056 workflow and went with its suites (#1350).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PLAN_CLAIMS_MAX, parsePlanDocument } from "@agentx/contracts";
import { fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { feedbackCriticReply, workflowModel } from "../support/faux-scripts.js";
import {
  conflictingAsImplement, duplicateFindingIds, feedbackBundles, implementWithLowConfidence, implementWithoutFileChanges, missingComment,
  ownerDecisionEmptyLists, planCitesMissingFile, planMissingWhy, planOverCeiling, planProse, planTiny, planTruncatedJson, planWithDecisions,
  reviewerFindings, supersedeAwareImplement, SUPERSEDE_RULE,
} from "../support/model-fixtures.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];

describe("workflow E2E harness", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  it("the clock is real again in the next test", () => {
    expect(Date.now()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    expect(new Date().getUTCFullYear()).toBeLessThan(2030);
  });

  it("resets coder command queues for a fresh session with the same prompt, without resetting within-session tool turns", async () => {
    const step = workflowModel({ plan: PLAN, edits: EDITS, beforeEditsCommands: ["echo before"], afterEditsCommands: ["echo after"] });
    if (typeof step !== "function") throw new Error("workflowModel did not return a callable response step");
    type Message = Parameters<typeof step>[0]["messages"][number];
    const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
    const assistant: Message = { role: "assistant", content: [], api: "openai-completions", provider: "openai", model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
    const toolResult: Message = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], isError: false, timestamp: 0 };
    const faux = fauxProvider();
    const model = faux.getModel();
    if (model === undefined) throw new Error("fauxProvider did not provide its default model");
    const samePrompt = "Implement the approved plan.";
    const call = (messages: Message[]) => step(normalizeContext({ messages }), undefined, faux.state, model) as Promise<{ content: Array<{ type: string; name?: string }> }>;
    const names = async (messages: Message[]) => (await call(messages)).content.map((part) => part.name ?? part.type);
    const opening = [user(samePrompt)];
    expect(await names(opening)).toEqual(["bash"]);
    expect(await names([...opening, assistant, toolResult])).toEqual(["write"]);
    expect(await names([...opening, assistant, toolResult, assistant, toolResult])).toEqual(["bash"]);
    expect(await names([...opening, assistant, toolResult, assistant, toolResult, assistant, toolResult])).toEqual(["text"]);
    // A new Pi session starts with the same user text but has no prior assistant or tool-result messages.
    expect(await names([user(samePrompt)])).toEqual(["bash"]);
  });
});

describe("model fixtures", () => {
  const read = (answer: string) => parsePlanDocument(answer, { kind: "plan" });

  it("planner fixtures read as documented", () => {
    expect(read(planProse)).toMatchObject({ ok: false, errors: [expect.stringMatching(/has no agentx-plan block/)] });
    expect(read(planTruncatedJson)).toMatchObject({ ok: false, errors: [expect.stringMatching(/is not closed/)] });
    expect(read(planMissingWhy)).toMatchObject({ ok: false, errors: [expect.stringMatching(/why/)] });
    expect(read(planOverCeiling())).toMatchObject({ ok: false, errors: [`the plan has ${PLAN_CLAIMS_MAX + 1} claims; at most ${PLAN_CLAIMS_MAX} are allowed`] });
    expect(read(planTiny())).toMatchObject({ ok: true, plan: { claims: [{ id: "1" }, { id: "2" }, { id: "3" }], decisions: [] } });
    const decided = read(planWithDecisions(3));
    expect(decided.ok && decided.plan.decisions.map((decision) => decision.id)).toEqual(["d1", "d2", "d3"]);
    expect(read(planCitesMissingFile())).toMatchObject({ ok: true });
  });

  it("reviewer and feedback fixtures have the documented shapes", () => {
    expect(Object.keys(reviewerFindings(2, { role: "SECURITY" }))).toEqual(["SECURITY"]);
    const prompt = `${SUPERSEDE_RULE}\nImmutable feedback bundle inputs (untrusted GitHub data):\n${JSON.stringify([{ bundleDigest: "a".repeat(64), comments: [{ id: "discussion:1" }, { id: "discussion:2" }] }])}`;
    expect(feedbackBundles(prompt)).toHaveLength(1);
    const findings = (answer: string) => (JSON.parse(answer) as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings(ownerDecisionEmptyLists("Which way?")(prompt))[0]).toMatchObject({ proposedDisposition: "OWNER_DECISION", fixProposal: { fileChanges: [], tests: [] } });
    expect(findings(implementWithLowConfidence(prompt))[0]).toMatchObject({ proposedDisposition: "IMPLEMENT", confidence: { level: "LOW" } });
    expect(findings(implementWithoutFileChanges(prompt))[0]).toMatchObject({ fixProposal: { fileChanges: [] } });
    expect(findings(conflictingAsImplement(prompt))[0]).toMatchObject({ assessment: "CONFLICTING", proposedDisposition: "IMPLEMENT" });
    expect(new Set(findings(duplicateFindingIds(prompt)).map((finding) => finding.id)).size).toBe(1);
    expect(findings(missingComment(prompt))[0]).toMatchObject({ commentIds: ["discussion:1"] });
    expect(findings(supersedeAwareImplement(prompt))[0]).toMatchObject({ proposedDisposition: "IMPLEMENT" });
    expect(findings(supersedeAwareImplement(prompt.replace(SUPERSEDE_RULE, "")))[0]).toMatchObject({ proposedDisposition: "OWNER_DECISION" });
    // The default critic still answers the same prompt shape.
    expect(findings(feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }))).toHaveLength(1);
  });
});
