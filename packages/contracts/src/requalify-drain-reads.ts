/**
 * The attributes the renewal's drain reads (AR-3), and nothing more. One list per read; `requalifyDrainStatus` builds each read's
 * ProjectionExpression from its list, and the renewal role's `DrainRead` statement (infra/lib/runtime-requalify.ts) allows exactly the union
 * (`dynamodb:Attributes`) and only reads that name their attributes (`dynamodb:Select`). A test runs the real reads and compares.
 *
 * A read that names attributes outside its list, or none at all, is refused by IAM; the drain then throws and never counts 0.
 */
export const REQUALIFY_DRAIN_READS = {
  /** The READY sessions, read through the bySessionState index (it projects ALL attributes, so any of these is available there). */
  sessions: ["workspaceId"],
  /** A workspace's operations: the kind, the mode, the admission's kind, the status and the two times that tell a stale one. */
  operations: ["entityType", "workflowMode", "workflowE2EAdmission", "status", "updatedAt", "createdAt"],
  /** The setup-run markers the drain finds the running setups by. */
  setupMarkers: ["setupExecutionId", "until"],
  /** A setup execution's record: only its state. */
  setupExecution: ["state"],
} as const satisfies Record<string, readonly string[]>;

export type RequalifyDrainRead = keyof typeof REQUALIFY_DRAIN_READS;

/** The union of every read's attributes, sorted: what the IAM statement allows. */
export const REQUALIFY_DRAIN_READ_ATTRIBUTES: readonly string[] = [...new Set(Object.values(REQUALIFY_DRAIN_READS).flat())].sort();

/**
 * The ProjectionExpression of one drain read. Every attribute is aliased (`#drain0`, ...): `status` and `state` are DynamoDB reserved words, and one rule for all keeps a new
 * attribute from needing a special case.
 */
export function requalifyDrainProjection(read: RequalifyDrainRead): { ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> } {
  const names: Record<string, string> = {};
  REQUALIFY_DRAIN_READS[read].forEach((attribute, index) => { names[`#drain${index}`] = attribute; });
  return { ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names };
}
