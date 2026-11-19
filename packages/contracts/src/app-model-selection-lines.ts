// The model setting's state as plain lines, for the terminal and for an AI tool: one per step, then the default for checking steps. The model names are data; the sentences are Rovara's. Browser-safe.
// It reads the shape structurally, so a client that reads the state with the forward-compatible reader (a stage or a reason this build does not know reads as text) can use it too.

export interface ModelSelectionLinesInput {
  steps: ReadonlyArray<{
    stage: string;
    setting: unknown;
    effective?: {
      model: { provider: string; modelId: string };
      thinkingLevel: string | null;
      sameModelAsChecked: boolean;
      fallback?: { wanted: string | null } | undefined;
      priceUsdPerMillion?: { input: number; output: number } | undefined;
    } | undefined;
    refusal?: { words: string } | undefined;
  }>;
  reviewDefault: string;
  runLimit: { enforced: boolean };
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  understand: "understand", plan: "plan", plan_check: "plan check", build: "build", code_review: "code review", security_review: "security review", pull_request: "pull request feedback",
};
const plain = (text: string): string => text.replace(/\p{Cc}+/gu, " ");
const modelLabel = (model: { provider: string; modelId: string }): string => plain(`${model.provider}:${model.modelId}`);

export function modelSelectionLines(state: ModelSelectionLinesInput): string[] {
  const lines = state.steps.map((step) => {
    const label = STAGE_LABELS[step.stage] ?? plain(step.stage);
    const { effective } = step;
    if (effective === undefined) return `${label}: no model can be used (${plain(step.refusal?.words ?? "unknown")})`;
    const price = effective.priceUsdPerMillion === undefined ? "no price" : `$${effective.priceUsdPerMillion.input.toFixed(2)} in, $${effective.priceUsdPerMillion.output.toFixed(2)} out per million tokens`;
    const notes = [
      step.setting === null ? "default" : "set by you", ...(effective.sameModelAsChecked ? ["the same model as the step it checks"] : []),
      ...(effective.thinkingLevel === null ? [] : [`thinking ${plain(effective.thinkingLevel)}`]),
      ...(effective.fallback === undefined ? [] : [`fell back from ${plain(effective.fallback.wanted ?? "its first choice")}`]),
    ];
    return `${label}: ${modelLabel(effective.model)} (${notes.join(", ")}; ${price})`;
  });
  return [
    ...lines,
    state.reviewDefault === "different-company" ? "Checking steps nobody set use the strongest model of a different AI company than the step they check." : "Checking steps nobody set use this install's model.",
    state.runLimit.enforced ? "A run limit is held, so a model with no price is not used." : "No run limit is held; a model with no price can be used and its cost shows as unknown.",
  ];
}
