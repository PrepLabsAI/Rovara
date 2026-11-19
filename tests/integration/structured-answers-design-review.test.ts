// Structured answers for the design review: a reviewer and the merge step answer through a tool Pi checks, delivered to the orchestration as the block its reader reads (design-review-answers.ts,
// design-review-sessions.ts). Real Pi session on the faux model. Offline.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DESIGN_MERGE_INFO_STRING, DESIGN_REVIEW_INFO_STRING, READ_ONLY_TOOLS, REVIEWER_ROLES, readDesignMerge, readDesignReview, type ModelSelection } from "../../packages/contracts/src/index.js";
import { DESIGN_REVIEW_LOST_FINDINGS_PROBLEM, sentAsRendered, type OpenDesignReviewSession } from "../../packages/worker/src/design-review.js";
import { designReviewAnswerSpec } from "../../packages/worker/src/design-review-answers.js";
import { createReviewSessionOpener } from "../../packages/worker/src/design-review-sessions.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { ANSWER_TOOL_OVERHEAD_TOKENS, BYTES_PER_TOKEN, FIRST_CALL_OVERHEAD_TOKENS, estimateInputTokens } from "../../packages/broker/src/core/design-review/packet.js";
import { answerToolInstruction } from "../../packages/worker/src/structured-answer.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ROLE_PROMPT = "You are the critic reviewer of a design.";
const MODEL = { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId } as unknown as ModelSelection;
const finding = { id: "f1", severity: "major", section: "§3", text: "The retry limit is not stated.", citations: [{ kind: "design", section: "§3" }] };

async function opener(responses: FauxResponseStep[], structuredAnswers?: boolean) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const rootPath = await mkdtemp(join(tmpdir(), "structured-design-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return createReviewSessionOpener({
    rootPath, localFileTools: true, ...(structuredAnswers === undefined ? {} : { structuredAnswers }),
    runtimeFor: () => ({ model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: adapter }),
  });
}
const reviewer = (extra: Partial<OpenDesignReviewSession> = {}): OpenDesignReviewSession => ({ purpose: "reviewer", keySlot: "slot-a", model: MODEL, system: ROLE_PROMPT, tools: READ_ONLY_TOOLS, role: "critic", withParaphrase: false, ...extra });
const toolNamesOf = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name);
const lastMessage = (context: TranscriptContext) => { const last = context.messages.at(-1) as { role: string; content?: unknown } | undefined; return { role: last?.role, text: JSON.stringify(last?.content) }; };

describe("a design-review reviewer answers through a tool", () => {
  it("hands the orchestration the block its reader reads, after one model call, with the role prompt still first in the system text", async () => {
    const offered: string[][] = [];
    const open = await opener([(context) => { offered.push(toolNamesOf(context)); return fauxAssistantMessage([fauxToolCall("submit_design_review", { findings: [finding] }, { id: "c1" })], { stopReason: "toolUse" }); }]);
    const session = await open(reviewer());
    const answer = await session.prompt("The packet's one user message.");
    expect(offered[0]).toContain("submit_design_review");
    const read = readDesignReview(answer ?? "", "critic");
    expect(read.ok && read.findings.map((entry) => entry.text)).toEqual(["The retry limit is not stated."]);
    expect(answer).toContain(`\`\`\`${DESIGN_REVIEW_INFO_STRING}`);
    const first = session.firstRequest();
    expect(sentAsRendered(first, { system: ROLE_PROMPT, user: "The packet's one user message." })).toBe(true);
    expect(first?.system).toContain("submit_design_review");
    // The report lists everything the model had: the read-only file tools and the answer tool (the broker's read-only check names it).
    expect(session.tools()).toEqual([...READ_ONLY_TOOLS, "submit_design_review"]);
    session.dispose();
  });

  it("has a finding without a citation refused and retried by Pi in the same run (the contract's reader is the check)", async () => {
    const seen: Array<{ role: string | undefined; text: string }> = [];
    const open = await opener([
      (context) => { seen.push(lastMessage(context)); return fauxAssistantMessage([fauxToolCall("submit_design_review", { findings: [{ ...finding, citations: [] }] }, { id: "c1" })], { stopReason: "toolUse" }); },
      (context) => { seen.push(lastMessage(context)); return fauxAssistantMessage([fauxToolCall("submit_design_review", { findings: [finding] }, { id: "c2" })], { stopReason: "toolUse" }); },
    ]);
    const session = await open(reviewer());
    const answer = await session.prompt("user");
    expect(seen[1]?.role).toBe("toolResult");
    expect(seen[1]?.text).toContain("Validation failed for tool");
    expect(readDesignReview(answer ?? "", "critic").ok).toBe(true);
    session.dispose();
  });

  it("refuses, in the check, a block whose findings the reader would lose (the orchestration's own rule), with the same fixed words", () => {
    const spec = designReviewAnswerSpec("critic");
    const lost = spec.render({ findings: [{ ...finding, citations: [{ kind: "source", ref: "<<<>>>" }] }] });
    expect(spec.check(lost)).toBe(DESIGN_REVIEW_LOST_FINDINGS_PROBLEM);
    expect(spec.check(spec.render({ findings: [finding] }))).toBeUndefined();
  });

  it("has only the comprehension reviewer (and the Light critic) write a paraphrase, as the contract says", () => {
    const paraphrase = { proposes: "A retry limit.", today: "No limit." };
    expect(designReviewAnswerSpec("comprehension").check(designReviewAnswerSpec("comprehension").render({ paraphrase, findings: [] }))).toBeUndefined();
    expect(designReviewAnswerSpec("comprehension").check(designReviewAnswerSpec("comprehension").render({ findings: [] }))).toContain("paraphrase");
    expect(designReviewAnswerSpec("critic").check(designReviewAnswerSpec("critic").render({ paraphrase, findings: [] }))).toContain("Only the comprehension reviewer");
    expect(designReviewAnswerSpec("critic", { withParaphrase: true }).check(designReviewAnswerSpec("critic", { withParaphrase: true }).render({ paraphrase, findings: [] }))).toBeUndefined();
  });

  it("falls back to the text the model wrote when it does not call the tool: the orchestration's own retry then applies", async () => {
    const text = `Findings below.\n\n\`\`\`${DESIGN_REVIEW_INFO_STRING}\n${JSON.stringify({ findings: [finding] })}\n\`\`\`\n`;
    const open = await opener([fauxAssistantMessage(text)]);
    const session = await open(reviewer());
    const answer = await session.prompt("user");
    expect(answer?.trim()).toBe(text.trim());
    session.dispose();
  });

  it("flips back with structuredAnswers off: no tool, and the system text is the role prompt alone", async () => {
    const offered: string[][] = [];
    const open = await opener([(context) => { offered.push(toolNamesOf(context)); return fauxAssistantMessage("No findings."); }], false);
    const session = await open(reviewer());
    expect(await session.prompt("user")).toBe("No findings.");
    expect(offered[0]).not.toContain("submit_design_review");
    expect(session.firstRequest()?.system).not.toContain("submit_design_review");
    expect(session.tools()).toEqual([...READ_ONLY_TOOLS]);
    session.dispose();
  });

  it("is counted in the broker's first-call estimate, so a small packet is not voided as first_call_mismatch", () => {
    // The estimate carries the answer tool's tokens beside the read-only tools' ...
    expect(estimateInputTokens(4_000)).toBe(1_000 + FIRST_CALL_OVERHEAD_TOKENS + ANSWER_TOOL_OVERHEAD_TOKENS);
    // ... and that allowance stays above what the tool really adds (its schema, its description and the line in the system text), for every reviewer.
    for (const role of REVIEWER_ROLES) {
      for (const withParaphrase of [false, true]) {
        const spec = designReviewAnswerSpec(role, { withParaphrase });
        const bytes = Buffer.byteLength(JSON.stringify({ name: spec.name, description: spec.description, parameters: spec.parameters }) + answerToolInstruction(spec.name), "utf8");
        expect(Math.ceil(bytes / BYTES_PER_TOKEN), `${role} ${String(withParaphrase)}`).toBeLessThanOrEqual(ANSWER_TOOL_OVERHEAD_TOKENS);
      }
    }
  });
});

describe("the design-review merge step answers through a tool", () => {
  it("hands over the merge block its reader reads", async () => {
    const group = { rawIds: ["critic-f1"], severity: "major", section: "§3", text: "The retry limit is not stated." };
    const open = await opener([fauxAssistantMessage([fauxToolCall("submit_design_merge", { merged: [group] }, { id: "m1" })], { stopReason: "toolUse" })]);
    const session = await open({ purpose: "merge", keySlot: "slot-m", model: MODEL, system: "You merge findings.", tools: [] });
    const answer = await session.prompt("<findings untrusted=\"true\">[]</findings>");
    expect(answer).toContain(`\`\`\`${DESIGN_MERGE_INFO_STRING}`);
    expect(readDesignMerge(answer ?? "")).toMatchObject({ ok: true, merged: [{ rawIds: ["critic-f1"], severity: "major", section: "§3" }] });
    session.dispose();
  });
});

void randomUUID;
