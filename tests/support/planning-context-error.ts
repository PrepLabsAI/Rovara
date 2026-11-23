// Builds the failure text for a journey whose core did not offer application planning context. The reason is the
// planning context's own `reason` (set on "unknown" results), so a CI log says which branch fired.
export function planningContextUnavailableMessage(context: unknown): string {
  if (context === undefined || context === null) return "core did not offer application planning context: absent (no reason given)";
  const status = typeof (context as { status?: unknown }).status === "string" ? (context as { status: string }).status : "unknown-shape";
  const reason = typeof (context as { reason?: unknown }).reason === "string" ? (context as { reason: string }).reason : "no reason given";
  return `core did not offer application planning context: ${status} (${reason})`;
}
