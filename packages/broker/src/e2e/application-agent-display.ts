import { createHash } from "node:crypto";
import { E2E_DISPLAY_ASSERTION_KINDS, crossCheckE2EAgentLedgerReceipts, parseVerifiedE2EAgentActionLedger, type E2EDisplayAgentNavigation, type E2EModelReceipt } from "@agentx/contracts";
import { displayText } from "./application-display.js";

/**
 * M1.4 Task 4.4b: how the AI navigated, for the row of an AI-navigated scenario. It is read from the action ledger the executor wrote and from nothing the worker or the model says: the
 * ledger is verified here exactly as the collector verifies it (`parseVerifiedE2EAgentActionLedger`: this run, this case, this run's value key, the approved goals, every typed literal
 * held to its keyed digest), and held to the worker's receipts for the case (`crossCheckE2EAgentLedgerReceipts`: every receipt it names is one the worker wrote for the same step). A
 * ledger that is not both gives no block, and the row is still shown.
 *
 * What a block holds: the approved goal (the owner wrote it), the role and name of the page elements the model acted on, how each step ended, the number of model calls and the route.
 * It never holds a typed value, a key, an option label, a scroll direction, a test id, a url, a digest or anything the model wrote; the node of a `type` action is left out altogether,
 * because the element a value was typed into is not something the model "clicked" and its name is the page's, not the owner's.
 */

/** The ledger's directory name under `agent/`, as the executor files it (`agentCaseDirectoryName` in the verifier): the first 16 hex of the SHA-256 of the case id. */
export const agentCaseDirectory = (caseId: string): string => createHash("sha256").update(caseId, "utf8").digest("hex").slice(0, 16);

const LEDGER_MAX_BYTES = 65_536;
const MAX_STEPS = 3;
const MAX_ACTED_ON = 8;
const ELEMENT_NAME_LIMIT = 60;

type AssertionKind = (typeof E2E_DISPLAY_ASSERTION_KINDS)[number];

export function agentNavigationOf(input: {
  ledgerBytes: Uint8Array | null; valueKey: string; runId: string; caseId: string;
  /** Every AI navigation step of the case's approved scenario, by its declared step index, with its approved goal. */
  agentSteps: ReadonlyArray<Readonly<{ declaredStepIndex: number; goal: string }>>;
  /** The worker's receipts for this case. */
  receipts: readonly E2EModelReceipt[];
  routeId: string;
  /** The kinds of approved assertion of the scenario, which decide the row. */
  decidedBy: readonly AssertionKind[];
}): E2EDisplayAgentNavigation | undefined {
  try {
    if (input.ledgerBytes === null || input.ledgerBytes.byteLength === 0 || input.ledgerBytes.byteLength > LEDGER_MAX_BYTES) return undefined;
    const raw: unknown = JSON.parse(Buffer.from(input.ledgerBytes).toString("utf8"));
    // A case that stopped at its first AI step never reached a later one: the goals are those of the steps the ledger has (each is still held to its approved goal's digest below).
    const have = new Set((typeof raw === "object" && raw !== null && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : [])
      .map((step) => (typeof step === "object" && step !== null ? (step as { stepIndex?: unknown }).stepIndex : undefined)));
    const goals = new Map(input.agentSteps.filter((step) => have.has(step.declaredStepIndex)).map((step) => [step.declaredStepIndex, step.goal] as const));
    if (goals.size === 0) return undefined;
    const verified = parseVerifiedE2EAgentActionLedger(raw, { goals, valueKey: input.valueKey, runId: input.runId, caseId: input.caseId });
    if (!verified.ok) return undefined;
    if (!crossCheckE2EAgentLedgerReceipts(verified.ledger, input.receipts).ok) return undefined;
    const steps = [...verified.ledger.steps].sort((left, right) => left.stepIndex - right.stepIndex).slice(0, MAX_STEPS).map((step) => {
      const actedOn: Array<{ role: string; name: string }> = [];
      for (const action of step.actions) {
        if (action.outcome !== "ok" || action.node === null || action.tool === "type") continue;
        const name = displayText(action.node.name, ELEMENT_NAME_LIMIT);
        const previous = actedOn.at(-1);
        if (name === "" || (previous !== undefined && previous.role === action.node.role && previous.name === name)) continue;
        if (actedOn.length < MAX_ACTED_ON) actedOn.push({ role: action.node.role, name });
      }
      return { goal: displayText(goals.get(step.stepIndex) ?? "", 120) || "step", actedOn, stop: step.verdict };
    });
    const decidedBy = E2E_DISPLAY_ASSERTION_KINDS.filter((kind) => input.decidedBy.includes(kind));
    return { steps, modelCalls: input.receipts.length, routeId: displayText(input.routeId, 120) || "route", ...(decidedBy.length === 0 ? {} : { decidedBy }) };
  } catch { return undefined; }
}
