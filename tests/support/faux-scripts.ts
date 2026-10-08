// Realistic scripted model turns for planners, coders and reviewers, so a test drives the real worker
// code paths (plan, edit, review) on Pi's faux provider instead of injecting results by hand.
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";

export const DONE = "AgentX result: done";

type Message = TranscriptContext["messages"][number];
export type WorkflowTurn = { role: "PLAN" | "CODE" | "SECURITY" | "CODER"; userText: string };
type ReviewRole = "CODE" | "SECURITY";
type ReviewFinding = { text: string; origin: "INTRODUCED" | "PRE_EXISTING"; severity?: "HIGH" | "MEDIUM" | "LOW"; file?: string; line?: number } | string;

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

export function workflowModel(script: {
  /** The plan text, or a function of the latest user message (a revision request reaches the planner as a later turn). */
  plan: string | ((latestUserText: string) => string);
  edits: Array<{ path: string; content: string }>;
  reviews?: { CODE?: FauxResponseStep[]; SECURITY?: FauxResponseStep[] };
  prompts?: string[];
  /** One entry per model call (not per session): which turn it was and the latest user message it saw. */
  turns?: WorkflowTurn[];
}): FauxResponseStep {
  // Copied so that shifting never changes the caller's arrays.
  const queues: Record<ReviewRole, FauxResponseStep[]> = { CODE: [...(script.reviews?.CODE ?? [])], SECURITY: [...(script.reviews?.SECURITY ?? [])] };
  return async (context, options, state, model) => {
    const prompt = firstUserText(context);
    // Only a session's opening call is recorded; later calls in the session (tool results, a format retry) repeat the same first message.
    if (!context.messages.some((message) => ["assistant", "toolResult"].includes((message as { role?: string }).role ?? ""))) script.prompts?.push(prompt);
    const latestUserText = textOf([...context.messages].reverse().find((message) => (message as { role?: string }).role === "user"));
    // The implementation turn reopens the planning conversation, so the planner is chosen by the latest user turn.
    if (latestUserText.includes("Planning phase only")) {
      script.turns?.push({ role: "PLAN", userText: latestUserText });
      return fauxAssistantMessage(typeof script.plan === "function" ? script.plan(latestUserText) : script.plan);
    }
    const role = reviewRole(prompt);
    if (role !== undefined) {
      script.turns?.push({ role, userText: latestUserText });
      const queue = queues[role];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const step = next ?? reviewerReply.pass();
      return typeof step === "function" ? step(context, options, state, model) : step;
    }
    script.turns?.push({ role: "CODER", userText: latestUserText });
    // With no edits there is nothing to call a tool for, so the coder reports done straight away.
    if (lastIsToolResult(context) || script.edits.length === 0) return fauxAssistantMessage(`Done.\n\n${DONE}`);
    return fauxAssistantMessage(
      script.edits.map((edit, index) => fauxToolCall("write", { path: edit.path, content: edit.content }, { id: `edit-${index}` })),
      { stopReason: "toolUse" },
    );
  };
}
