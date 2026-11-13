// Task actions (owner decision 198, DECISIONS 201): who accepted review findings, and by what way. The workflow keeps each accepted finding with its reason, the owner's id and the time; it has no field for the way
// (the workflow schema is shared with Cloud and is strict), so the person's name and the method are kept beside it, written in the decision's own transaction, and read when the pull request's description is made, so a
// reader of the pull request sees that an AI tool holding the API token accepted a finding for a person, and not only the reason.
import { INDEX_EXPIRY_ATTRIBUTE, queryAll, redactText, when, type DocumentKey, type DocumentStore, type TransactItem } from "@agentx/contracts";

/** How the accept reached Rovara: a tool or script that holds the API token (an AI tool among them), or the person on the task's own page. */
export type FindingAcceptMethod = "api-token" | "page";

const KEEP_SECONDS = 400 * 86_400;
const PREFIX = "FINDING_ACCEPT#";
const NAME_MAX = 60;

export const findingAcceptKey = (taskId: string, requestId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `${PREFIX}${requestId}` });

/** A person's name as the pull request may show it: redacted, one line, cut. */
const shownName = (name: string): string => redactText(name).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, NAME_MAX) || "the owner";

/** The step that keeps who accepted which findings and how. Written once with the decision. */
export function findingAcceptItem(input: { taskId: string; requestId: string; person: { personId: string; displayName: string }; method: FindingAcceptMethod; fingerprints: readonly string[]; at: string; now: Date }): TransactItem {
  return {
    kind: "put",
    item: {
      ...findingAcceptKey(input.taskId, input.requestId), entityType: "FINDING_ACCEPT", taskId: input.taskId, requestId: input.requestId, personId: input.person.personId, name: shownName(input.person.displayName),
      method: input.method, fingerprints: [...input.fingerprints], at: input.at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.now.getTime() / 1000) + KEEP_SECONDS,
    },
    condition: when.absent(),
  };
}

/** For each accepted finding (by fingerprint), "<name> via <method>", for the pull request's description. Undefined when nothing was recorded (an accept from before this was kept). */
export async function acceptedByOf(store: Pick<DocumentStore, "get" | "query">, taskId: string): Promise<Record<string, string> | undefined> {
  const rows = await queryAll(store,{ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: PREFIX } });
  const by: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row["name"] !== "string" || (row["method"] !== "api-token" && row["method"] !== "page") || !Array.isArray(row["fingerprints"])) continue;
    for (const fingerprint of row["fingerprints"]) if (typeof fingerprint === "string") by[fingerprint] = `${row["name"]} via ${row["method"] === "page" ? "the task page" : "the API token (a tool)"}`;
  }
  return Object.keys(by).length === 0 ? undefined : by;
}
