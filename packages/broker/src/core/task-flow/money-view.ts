// Read-only money redaction. The stored workflow and the engine's accounting stay intact.
// Recurse through the design review, including archived rounds and approval history.
export function withoutDesignReviewMoney<T extends { designReview?: unknown }>(workflow: T, revealMoney: boolean): T {
  if (revealMoney || workflow.designReview === undefined) return workflow;
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !/Usd(?:PerTask)?$/u.test(key)).map(([key, field]) => [key, strip(field)])) : value;
  // This is a read projection, never parsed back into a stored workflow.
  return { ...workflow, designReview: strip(workflow.designReview) };
}
