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
 * It never holds a typed value, a key, an option label, a scroll direction, a test id, a digest or anything the model wrote. A `type` action is named by its element (role and name, the label the
 * page gives it) and the kind of action, never by what was typed; a navigation is named by its app-relative path. `modelCalls` counts the receipts the verified ledger names.
 * An element whose name contains one of the run's seeded credentials (`seededCredentials`, matched case-insensitively) keeps its role and is shown under a fixed placeholder name, whatever
 * action it took: a page can echo a password into a label, and the label is not ours to print.
 */

/** The ledger's directory name under `agent/`, as the executor files it (`agentCaseDirectoryName` in the verifier): the first 16 hex of the SHA-256 of the case id. */
export const agentCaseDirectory = (caseId: string): string => createHash("sha256").update(caseId, "utf8").digest("hex").slice(0, 16);

const LEDGER_MAX_BYTES = 65_536;
const MAX_STEPS = 3;
const MAX_ACTED_ON = 8;
const ELEMENT_NAME_LIMIT = 60;
/** What an element's name is shown as when it holds one of the run's seeded credentials; the role is kept. */
const CREDENTIAL_NAME_PLACEHOLDER = "[hidden]";

type AssertionKind = (typeof E2E_DISPLAY_ASSERTION_KINDS)[number];

export function agentNavigationOf(input: {
  ledgerBytes: Uint8Array | null; valueKey: string; runId: string; caseId: string;
  /** Every AI navigation step of the case's approved scenario, by its declared step index, with its approved goal. */
  agentSteps: ReadonlyArray<Readonly<{ declaredStepIndex: number; goal: string }>>;
  /** The worker's receipts for this case. */
  receipts: readonly E2EModelReceipt[];
  routeId: string;
  /** The run's seeded credentials: an element name holding one is shown as a fixed placeholder. */
  seededCredentials?: readonly string[];
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
    const credentials = (input.seededCredentials ?? []).filter((value) => value !== "").map((value) => value.toLowerCase());
    const elementName = (name: string): string => (credentials.some((credential) => name.toLowerCase().includes(credential)) ? CREDENTIAL_NAME_PLACEHOLDER : displayText(name, ELEMENT_NAME_LIMIT));
    const verified = parseVerifiedE2EAgentActionLedger(raw, { goals, valueKey: input.valueKey, runId: input.runId, caseId: input.caseId });
    if (!verified.ok) return undefined;
    if (!crossCheckE2EAgentLedgerReceipts(verified.ledger, input.receipts).ok) return undefined;
    const steps = [...verified.ledger.steps].sort((left, right) => left.stepIndex - right.stepIndex).slice(0, MAX_STEPS).map((step) => {
      const actedOn: Array<{ role: string; name: string; did: (typeof step.actions)[number]["tool"] }> = [];
      for (const action of step.actions) {
        if (action.outcome !== "ok") continue;
        // A navigation has no element: it is named by its app-relative path (no query, no fragment). Any other action is named by its element's role and name; a scroll with no element is not named.
        const target = action.tool === "navigate" ? (action.url === null ? undefined : { role: "page", name: displayText(action.url, ELEMENT_NAME_LIMIT) })
          : action.node === null ? undefined : { role: action.node.role, name: elementName(action.node.name) };
        if (target === undefined || target.name === "") continue;
        const previous = actedOn.at(-1);
        if (previous !== undefined && previous.role === target.role && previous.name === target.name && previous.did === action.tool) continue;
        if (actedOn.length < MAX_ACTED_ON) actedOn.push({ ...target, did: action.tool });
      }
      return { goal: displayText(goals.get(step.stepIndex) ?? "", 120) || "step", actedOn, stop: step.verdict };
    });
    const decidedBy = E2E_DISPLAY_ASSERTION_KINDS.filter((kind) => input.decidedBy.includes(kind));
    return { steps, modelCalls: verified.ledger.steps.reduce((total, step) => total + step.receiptIds.length, 0), routeId: displayText(input.routeId, 120) || "route", ...(decidedBy.length === 0 ? {} : { decidedBy }) };
  } catch { return undefined; }
}
