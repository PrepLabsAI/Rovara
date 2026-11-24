// Lane L14: the words each step is given must tell a real model the format its reader requires. For every prompt: a realistic model answer shaped as the prompt says is accepted by the real reader, and
// the prompt text carries the format (so a change to a reader fails here, not on a laptop). The coding and review prompts need no block of their own: the worker adds the "AgentX result" rule to the
// coder's system prompt, and builds the reviewers' prompts itself.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE, INTENT_BLOCK_INFO_STRING, WORKFLOW_PLAN_MAX_BYTES, lastFencedBlock, parseAgentClaim, readIntentBlock, UNDERSTAND_UNREADABLE_MESSAGE,
  type WorkflowArtifact, type WorkflowIntent, type WorkflowSnapshot,
} from "@agentx/contracts";
import { readIntentArtifact } from "@agentx/contracts";
import { settleUnderstanding } from "../../packages/worker/src/understand.js";
import { DEFAULT_PROMPTS, PLAN_EARLIER_HEADER, PLAN_PREVIOUS_HEADER, PLAN_SECTIONS, planRules } from "../../packages/broker/src/core/task-flow/step-prompts.js";
import { planContextOf } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { UNDERSTAND_REQUEST_HEADER, PLAN_UNDERSTANDING_HEADER, ANSWERS_BLOCK_HEADER } from "../../packages/broker/src/rovara-code/understand.js";
import { approvedCodingPlan } from "../../packages/broker/src/core/build-step/plan-input.js";
import { TEXT_FILE_NEWLINE_NOTE, implementPrompt, sendBackPrompt } from "../../packages/broker/src/core/build-step/prompts.js";
import { LINE_COUNT_GUIDANCE, planChecksInstructions } from "../../packages/broker/src/developer/plan-instructions.js";
import { documentSummary } from "../../packages/broker/src/core/decisions/plan-summary.js";
import { planFactsOf } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { loadWorkflowDocument } from "../../packages/broker/src/developer/plan-document-reader.js";

const REQUEST = "Add a --json flag to the status command so it prints its result as JSON.";
const fence = (info: string, body: string): string => `\`\`\`${info}\n${body}\n\`\`\``;

describe("the Understand prompt", () => {
  const prompt = DEFAULT_PROMPTS.understand({ requestText: REQUEST });

  it("its own example is read by the real reader", () => {
    const example = lastFencedBlock(prompt, INTENT_BLOCK_INFO_STRING);
    expect(typeof example).toBe("string");
    const read = readIntentBlock(fence(INTENT_BLOCK_INFO_STRING, example as string));
    expect(read.ok).toBe(true);
  });

  it("accepts a realistic ready, questions and answer reply, each ending with the block", () => {
    const ready = `I read the status command in packages/cli/src/status.ts. It prints text only.\n\n${fence(INTENT_BLOCK_INFO_STRING, JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Add --json to status.", assumptions: ["Text output stays the default."] }))}`;
    const questions = `Two readings are possible.\n\n${fence(INTENT_BLOCK_INFO_STRING, JSON.stringify({ kind: "questions", restatement: "Add JSON output.", questions: [{ id: "q1", text: "Which command?", options: [{ id: "a", label: "status" }, { id: "b", label: "list" }], recommended: "a" }] }))}`;
    const answer = `Here is why.\n\n${fence(INTENT_BLOCK_INFO_STRING, JSON.stringify({ kind: "answer", restatement: "Why status is slow.", answer: "It reads every file.", sources: [{ repository: "app", path: "src/status.ts", line: 12 }] }))}`;
    for (const reply of [ready, questions, answer]) expect(readIntentBlock(reply).ok).toBe(true);
  });

  it("the placeholder failure: a list of create_file lines is no understanding (the retry then fails with the fixed words)", async () => {
    const wrong = "create_file src/a.ts\ncreate_file src/b.ts";
    expect(readIntentBlock(wrong).ok).toBe(false);
    await expect(settleUnderstanding(wrong, async () => wrong)).rejects.toThrow(UNDERSTAND_UNREADABLE_MESSAGE);
  });

  it("carries the answers people gave, as information", () => {
    const intent = {
      rounds: 1, answers: [{ round: 1, source: "app", by: { name: "Dana" }, answers: [{ questionId: "q1", optionId: "a" }], questions: [{ id: "q1", text: "Which command?", options: [{ id: "a", label: "status" }, { id: "b", label: "list" }] }] }],
    } as unknown as WorkflowIntent;
    const withAnswers = DEFAULT_PROMPTS.understand({ requestText: REQUEST, intent });
    expect(withAnswers).toContain(ANSWERS_BLOCK_HEADER);
    expect(withAnswers).toContain("status");
  });

});

const sectionsOf = (kind: "plan" | "requirements" | "design"): string => PLAN_SECTIONS[kind].map((name) => `## ${name}\n- ${name === "Files" ? "`src/status.ts`: add the flag" : name === "Decisions" || name === "Risks" || name === "Not changing" ? "None" : "Print the result as JSON when --json is set."}`).join("\n\n");

describe("the plan prompt", () => {
  const ready = { restatement: "Add --json to status.", assumptions: ["Text stays the default."] };

  it("asks for Markdown with the sections of each document, in order, and no publishing steps", () => {
    for (const [path, phase, kind] of [["QUICK", undefined, "plan"], ["FULL", "REQUIREMENTS", "requirements"], ["FULL", "DESIGN", "design"], ["FULL", "IMPLEMENTATION_PLAN", "plan"]] as const) {
      const prompt = DEFAULT_PROMPTS.plan({ requestText: REQUEST, path, phase, ...ready });
      let at = -1;
      for (const name of PLAN_SECTIONS[kind]) {
        const found = prompt.indexOf(`## ${name}:`);
        expect(found, `${path} ${String(phase)} ${name}`).toBeGreaterThan(at);
        at = found;
      }
      expect(prompt).toContain("Do not include steps to push a branch, open a pull request");
      expect(prompt).toContain(WORKFLOW_PLAN_MAX_BYTES.toLocaleString("en-US"));
      expect(prompt).toContain(PLAN_UNDERSTANDING_HEADER);
      expect(prompt).toContain(UNDERSTAND_REQUEST_HEADER);
    }
    expect(planRules("plan")).toContain("Your final message IS the document");
  });

  it("a coding plan shaped as the prompt says is read by the real readers: loaded, summarised, its files found, and handed to the coder", async () => {
    const text = `Add a --json flag to the status command.\n\n${sectionsOf("plan")}`;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(WORKFLOW_PLAN_MAX_BYTES);
    const artifact = { id: "a1", type: "plan", version: 1, sha256: createHash("sha256").update(text, "utf8").digest("hex"), producer: "agentx-worker-untrusted", objectKey: "k/plan.md", createdAt: "2026-11-09T00:00:00.000Z", format: "markdown" } as unknown as WorkflowArtifact;
    const read = async (): Promise<string | undefined> => text;
    const loaded = await loadWorkflowDocument(read, artifact, {});
    expect(loaded?.format).toBe("markdown");
    const summary = documentSummary(loaded);
    expect(summary?.needed).toContain("Add a --json flag");
    expect(summary?.lines.length).toBeGreaterThan(0);
    expect(planFactsOf(loaded).files).toContain("src/status.ts");
    const approved = await approvedCodingPlan({ get: async () => new TextEncoder().encode(text) }, { artifacts: [artifact], decisions: [] });
    expect(approved.text).toBe(text);
    expect(implementPrompt(approved)).toContain(text);
  });

  it("gives the owner's feedback, the approved earlier documents and the earlier version as information", () => {
    const prompt = DEFAULT_PROMPTS.plan({
      requestText: REQUEST, path: "FULL", phase: "DESIGN", ...ready, feedback: ["Keep the text output the default."],
      earlier: [{ kind: "requirements", markdown: "Print JSON.\n```js\nx\n```" }], previous: "Old design.",
    });
    expect(prompt).toContain("- Keep the text output the default.");
    expect(prompt).toContain(PLAN_EARLIER_HEADER);
    expect(prompt).toContain(PLAN_PREVIOUS_HEADER);
    expect(prompt).toContain("Old design.");
    expect(prompt.indexOf(PLAN_EARLIER_HEADER)).toBeLessThan(prompt.indexOf("## How it works:"));
  });

  it("reads the earlier documents of a Full task from the artifacts, and the previous version of the current one", async () => {
    const store = new Map<string, string>();
    const artifact = (type: "requirements" | "design", text: string): WorkflowArtifact => {
      store.set(`k/${type}`, text);
      return { id: type, type, version: 1, sha256: createHash("sha256").update(text, "utf8").digest("hex"), producer: "agentx-worker-untrusted", objectKey: `k/${type}`, createdAt: "2026-11-09T00:00:00.000Z", format: "markdown" } as unknown as WorkflowArtifact;
    };
    const artifacts = { get: async (key: string) => (store.has(key) ? new TextEncoder().encode(store.get(key)) : undefined) };
    const workflow = { path: "FULL", reviewPhase: "DESIGN", artifacts: [artifact("requirements", "R text"), artifact("design", "D text")] } as unknown as WorkflowSnapshot;
    expect(await planContextOf({ artifacts }, workflow)).toEqual({ earlier: [{ kind: "requirements", markdown: "R text" }], previous: "D text" });
    expect(await planContextOf({ artifacts }, { ...workflow, path: "QUICK" })).toEqual({ earlier: [] });
    expect(await planContextOf({}, workflow)).toEqual({ earlier: [] });
  });
});

describe("the coding, send-back and review prompts", () => {

  it("the coder's reply format is the worker's own system prompt: its last line is read by parseAgentClaim", () => {
    expect(AGENTX_PREAMBLE).toContain("\"AgentX result: done\"");
    expect(AGENTX_PREAMBLE).toContain("\"AgentX result: not done\"");
    expect(parseAgentClaim("I added the flag and ran the tests.\nAgentX result: done")).toBe("success");
    expect(parseAgentClaim("I could not finish.\nAgentX result: not done\n")).toBe("failure");
  });

  it("the saved understanding artifact the broker reads back is the same shape the prompt asks for", () => {
    expect(readIntentArtifact(JSON.stringify({ kind: "ready", path: "FULL", restatement: "x", assumptions: [] })).ok).toBe(true);
  });
});

describe("CHECK-AND-WORDING: files end with a newline, and a line-count check does not depend on one", () => {
  const plan = { text: "Create notes.txt with one line: hello", sha256: "a".repeat(64) };

  it("asks the coder to end every text file with a newline, unless the task says otherwise, in every coding prompt", () => {
    expect(TEXT_FILE_NEWLINE_NOTE).toMatch(/newline/u);
    expect(TEXT_FILE_NEWLINE_NOTE).toMatch(/unless the task asks for no trailing newline/u);
    expect(implementPrompt(plan)).toContain(TEXT_FILE_NEWLINE_NOTE);
    expect(implementPrompt(plan, false)).toContain(TEXT_FILE_NEWLINE_NOTE);
    expect(sendBackPrompt({ problems: "x", plan, constraints: "" })).toContain(TEXT_FILE_NEWLINE_NOTE);
    expect(sendBackPrompt({ problems: "x", plan, constraints: "", approved: false })).toContain(TEXT_FILE_NEWLINE_NOTE);
  });

  it("tells the planner to count lines robustly, and no longer offers wc -l as a robust check command", () => {
    const text = planChecksInstructions(["repo"]);
    expect(text).toContain(LINE_COUNT_GUIDANCE);
    expect(LINE_COUNT_GUIDANCE).toContain("Never use `wc -l`");
    expect(LINE_COUNT_GUIDANCE).toContain("awk");
    expect(LINE_COUNT_GUIDANCE).toContain("last line without a newline");
    expect(LINE_COUNT_GUIDANCE).toContain("unless the task asks for one");
    expect(text).not.toMatch(/robust check commands \([^)]*wc -l/u);
  });
});
