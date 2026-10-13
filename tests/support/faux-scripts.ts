// Realistic scripted model turns for planners, coders and reviewers, so a test drives the real worker
// code paths (plan, edit, review) on Pi's faux provider instead of injecting results by hand.
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";

export const DONE = "AgentX result: done";

/** Named, documented model answers for the workflow E2E suites. */
export * from "./model-fixtures.js";

type Message = TranscriptContext["messages"][number];
export type WorkflowTurn = { role: "PLAN" | "CODE" | "SECURITY" | "CODER" | "FEEDBACK"; userText: string };
type ReviewRole = "CODE" | "SECURITY";
type ReviewFinding = { text: string; origin: "INTRODUCED" | "PRE_EXISTING"; severity?: "HIGH" | "MEDIUM" | "LOW"; file?: string; line?: number; advisory?: boolean } | string;
const PI_SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
const INERT_COMPACTION_CHECKPOINT = "Earlier conversation context was summarized. Continue the existing task from its original request and later messages. This checkpoint makes no workflow or evidence claims.";

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: unknown }).text).filter((text): text is string => typeof text === "string").join("");
}

/** The text of the first user message in the transcript (the session's prompt). */
export function firstUserText(context: TranscriptContext): string {
  return textOf(context.messages.find((message) => (message as { role?: string }).role === "user"));
}

/** True when the model is being called again after its own tool call returned. */
export function lastIsToolResult(context: TranscriptContext): boolean {
  return (context.messages.at(-1) as { role?: string } | undefined)?.role === "toolResult";
}

/** Pi builds compaction requests with this trusted system prompt and exactly one user prompt. */
function isPiCompactionContext(context: TranscriptContext): boolean {
  const [system, request] = context.messages;
  return context.messages.length === 2
    && (system as { role?: string }).role === "system"
    && textOf(system) === PI_SUMMARIZATION_SYSTEM_PROMPT
    && (request as { role?: string }).role === "user";
}

export const reviewerReply = {
  pass: (): FauxResponseStep => fauxAssistantMessage(JSON.stringify({ findings: [] })),
  json: (findings: ReviewFinding[]): FauxResponseStep => fauxAssistantMessage(JSON.stringify({ findings })),
  // A reviewer that ignores the JSON-only instruction and answers in prose (seen live).
  prose: (): FauxResponseStep => fauxAssistantMessage("I reviewed the change carefully. Overall it looks good and I found nothing blocking."),
  // A reviewer that answers with a verdict table whose PASS rows would read as findings (seen live).
  verdictRows: (): FauxResponseStep => fauxAssistantMessage("| Check | Verdict |\n|---|---|\n| Input validation | PASS: handled |\n| Authorization | PASS: unchanged |"),
};

function reviewRole(prompt: string): ReviewRole | undefined {
  const named = /Review role: (CODE|SECURITY)/.exec(prompt);
  if (named !== null) return named[1] as ReviewRole;
  if (/Read-only critic review/.test(prompt)) return "CODE";
  if (/Read-only security review/.test(prompt)) return "SECURITY";
  return undefined;
}

/** The PR feedback critic's prompt names its input bundles as JSON after this line. */
const FEEDBACK_INPUTS = "Immutable feedback bundle inputs (untrusted GitHub data):\n";

/**
 * A feedback critic that recommends fixing every comment it was given: one finding per bundle, proposing a change to
 * `path` (which must exist in the reviewed code) and a new test file `testPath` (which must not).
 */
export function feedbackCriticReply(prompt: string, proposal: { repositoryId: string; path: string; testPath: string }): string {
  const start = prompt.indexOf(FEEDBACK_INPUTS);
  const inputs = JSON.parse(prompt.slice(start + FEEDBACK_INPUTS.length)) as Array<{ bundleDigest: string; comments: Array<{ id: string }> }>;
  return JSON.stringify({ findings: inputs.filter((input) => input.comments.length > 0).map((input, index) => ({
    id: `finding-${index + 1}`, bundleDigest: input.bundleDigest, commentIds: input.comments.map((comment) => comment.id),
    priority: "SHOULD_FIX", assessment: "ACTIONABLE", recommended: true,
    evidence: [{ source: "code", reference: `${proposal.repositoryId}/${proposal.path}` }],
    rationale: "The reviewer's request is reasonable and small.", confidence: { level: "HIGH", reason: "The change is local." },
    proposedDisposition: "IMPLEMENT",
    fixProposal: { summary: "Apply the requested change.",
      fileChanges: [{ repositoryId: proposal.repositoryId, path: proposal.path, operation: "MODIFY", change: "Apply the requested change." }],
      tests: [{ repositoryId: proposal.repositoryId, path: proposal.testPath, operation: "ADD", behavior: "Covers the requested change." }] },
  })) });
}

/**
 * A feedback critic that leaves every comment to the owner, as the 0.2.8 live test's reviewer did: one OWNER_DECISION
 * finding per bundle, not recommended, with `question` (the question and its options) as the proposal's summary.
 */
export function feedbackOwnerDecisionReply(prompt: string, question: string): string {
  const start = prompt.indexOf(FEEDBACK_INPUTS);
  const inputs = JSON.parse(prompt.slice(start + FEEDBACK_INPUTS.length)) as Array<{ bundleDigest: string; comments: Array<{ id: string }> }>;
  return JSON.stringify({ findings: inputs.filter((input) => input.comments.length > 0).map((input, index) => ({
    id: `finding-${index + 1}`, bundleDigest: input.bundleDigest, commentIds: input.comments.map((comment) => comment.id),
    priority: "SHOULD_FIX", assessment: "NEEDS_OWNER_DECISION", recommended: false,
    evidence: [{ source: "code", reference: "demo/greeting.ts" }],
    rationale: "The comment can be read two ways.", confidence: { level: "MEDIUM", reason: "Both readings fit the code." },
    proposedDisposition: "OWNER_DECISION", fixProposal: { summary: question, fileChanges: [], tests: [] },
  })) });
}

/**
 * A feedback critic that leaves the first comment of the first bundle to the owner (`question`) and recommends fixing the
 * rest in `path`, with a new test file `testPath`: a review with both a question and a recommended fix.
 */
export function feedbackMixedReply(prompt: string, question: string, proposal: { repositoryId: string; path: string; testPath: string }): string {
  const start = prompt.indexOf(FEEDBACK_INPUTS);
  const inputs = JSON.parse(prompt.slice(start + FEEDBACK_INPUTS.length)) as Array<{ bundleDigest: string; comments: Array<{ id: string }> }>;
  const input = inputs.find((candidate) => candidate.comments.length > 1)!;
  const [first, ...rest] = input.comments;
  const common = { bundleDigest: input.bundleDigest, priority: "SHOULD_FIX", evidence: [{ source: "code", reference: `${proposal.repositoryId}/${proposal.path}` }] };
  return JSON.stringify({ findings: [
    { ...common, id: "finding-1", commentIds: [first!.id], assessment: "NEEDS_OWNER_DECISION", recommended: false,
      rationale: "The comment can be read two ways.", confidence: { level: "MEDIUM", reason: "Both readings fit the code." },
      proposedDisposition: "OWNER_DECISION", fixProposal: { summary: question, fileChanges: [], tests: [] } },
    { ...common, id: "finding-2", commentIds: rest.map((comment) => comment.id), assessment: "ACTIONABLE", recommended: true,
      rationale: "The reviewer's request is reasonable and small.", confidence: { level: "HIGH", reason: "The change is local." },
      proposedDisposition: "IMPLEMENT", fixProposal: { summary: "Apply the requested change.",
        fileChanges: [{ repositoryId: proposal.repositoryId, path: proposal.path, operation: "MODIFY", change: "Apply the requested change." }],
        tests: [{ repositoryId: proposal.repositoryId, path: proposal.testPath, operation: "ADD", behavior: "Covers the requested change." }] } },
  ] });
}

export function workflowModel(script: {
  /** The plan text, or a function of the latest user message (a revision request reaches the planner as a later turn). */
  plan: string | ((latestUserText: string) => string);
  /** The coder's file writes, or a function of the latest user message (a PR feedback fix reaches the coder as a later turn). */
  edits: Array<{ path: string; content: string }> | ((latestUserText: string) => Array<{ path: string; content: string }>);
  /** Real worker bash commands to run one at a time before file writes in each coder session. */
  beforeEditsCommands?: readonly string[];
  /** Real worker bash commands to run one at a time after file writes in each coder session. */
  afterEditsCommands?: readonly string[];
  /**
   * The PR feedback critic's answer to its prompt (or a response step, such as `reviewerHangs`); absent, it recommends fixing
   * every comment in repo/demo's greeting.ts.
   */
  feedback?: (prompt: string) => string | FauxResponseStep;
  reviews?: { CODE?: FauxResponseStep[]; SECURITY?: FauxResponseStep[] };
  prompts?: string[];
  /** One entry per model call (not per session): which turn it was and the latest user message it saw. */
  turns?: WorkflowTurn[];
}): FauxResponseStep {
  // Copied so that shifting never changes the caller's arrays.
  let lastPlan: string | undefined;
  let beforeEdits: string[] = [];
  let afterEdits: string[] = [];
  let lastCoderUserText: string | undefined;
  let editsStarted = false;
  let toolCallSequence = 0;
  const reviewRolesBySession = new Map<string, ReviewRole>();
  const queues: Record<ReviewRole, FauxResponseStep[]> = { CODE: [...(script.reviews?.CODE ?? [])], SECURITY: [...(script.reviews?.SECURITY ?? [])] };
  return async (context, options, state, model) => {
    if (isPiCompactionContext(context)) return fauxAssistantMessage(INERT_COMPACTION_CHECKPOINT);
    const prompt = firstUserText(context);
    const openingCall = !context.messages.some((message) => ["assistant", "toolResult"].includes((message as { role?: string }).role ?? ""));
    // Only a session's opening call is recorded; later calls in the session (tool results, a format retry) repeat the same first message.
    if (openingCall) script.prompts?.push(prompt);
    const latestUserText = textOf([...context.messages].reverse().find((message) => (message as { role?: string }).role === "user"));
    const sessionId = options?.sessionId;
    const rememberedRole = sessionId === undefined ? undefined : reviewRolesBySession.get(sessionId);
    const role = rememberedRole ?? reviewRole(prompt);
    if (role !== undefined && sessionId !== undefined && rememberedRole === undefined) reviewRolesBySession.set(sessionId, role);
    if (role !== undefined) {
      script.turns?.push({ role, userText: latestUserText });
      const queue = queues[role];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const step = next ?? reviewerReply.pass();
      return typeof step === "function" ? step(context, options, state, model) : step;
    }
    // The implementation turn reopens the planning conversation, so the planner is chosen by the latest user turn.
    if (latestUserText.includes("Planning phase only")) {
      script.turns?.push({ role: "PLAN", userText: latestUserText });
      lastPlan = typeof script.plan === "function" ? script.plan(latestUserText) : script.plan;
      return fauxAssistantMessage(lastPlan);
    }
    // The worker asks a planner whose answer it could not read to answer again; this planner repeats its answer.
    if (lastPlan !== undefined && latestUserText.includes("could not be read as an AgentX plan")) {
      script.turns?.push({ role: "PLAN", userText: latestUserText });
      return fauxAssistantMessage(lastPlan);
    }
    // The worker asks a planner whose answer was too long to answer again; the plan script is asked for the shorter one.
    if (latestUserText.includes("Your answer is too long")) {
      script.turns?.push({ role: "PLAN", userText: latestUserText });
      lastPlan = typeof script.plan === "function" ? script.plan(latestUserText) : script.plan;
      return fauxAssistantMessage(lastPlan);
    }
    if (prompt.includes("independent PR-feedback critic")) {
      script.turns?.push({ role: "FEEDBACK", userText: latestUserText });
      const answer = script.feedback?.(prompt) ?? feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" });
      if (typeof answer === "string") return fauxAssistantMessage(answer);
      return typeof answer === "function" ? answer(context, options, state, model) : answer;
    }
    script.turns?.push({ role: "CODER", userText: latestUserText });
    // Reopened implementation turns may retain planning/history messages; a genuinely fresh transcript is also a
    // boundary even when its first user message matches the prior coder turn.
    if (openingCall || latestUserText !== lastCoderUserText) {
      beforeEdits = [...(script.beforeEditsCommands ?? [])];
      afterEdits = [...(script.afterEditsCommands ?? [])];
      editsStarted = false;
      lastCoderUserText = latestUserText;
    }
    if (beforeEdits.length > 0) {
      const command = beforeEdits.shift()!;
      return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `before-edit-${toolCallSequence++}` })], { stopReason: "toolUse" });
    }
    const edits = typeof script.edits === "function" ? script.edits(latestUserText) : script.edits;
    // With no edits there is nothing to call a tool for, so the coder reports done straight away.
    if (lastIsToolResult(context) && editsStarted && afterEdits.length > 0) {
      const command = afterEdits.shift()!;
      return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `after-edit-${toolCallSequence++}` })], { stopReason: "toolUse" });
    }
    if ((lastIsToolResult(context) && editsStarted) || edits.length === 0) return fauxAssistantMessage(`Done.\n\n${DONE}`);
    editsStarted = true;
    return fauxAssistantMessage(
      edits.map((edit) => fauxToolCall("write", { path: edit.path, content: edit.content }, { id: `edit-${toolCallSequence++}` })),
      { stopReason: "toolUse" },
    );
  };
}
