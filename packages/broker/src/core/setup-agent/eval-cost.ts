// L4-EVC (DEC 254zzz20 D8): the eval's cost as the setup card says it, in plain dollars. Pure: no store, no clock, no model. One function works out the figures from the numbers the BROKER holds (the
// question count and the per-question bounds the confirmed suite carries, and the company's monthly cap), and the same words are used on every surface (the setup page, the hosted card, the "Needs
// approval" line), so a person is never shown one figure and asked to approve another. No calls, tokens or micro-dollars reach a sentence.
import { EVAL_BEDROCK_COST_WORDS, EVAL_BEDROCK_ROW, type EvalSpendDollars, type EvalSpendPlan } from "@agentx/contracts";

/** How many changed cases a check re-asks (the question rule's ten down and ten up), each three times on both sides. */
const REASK_CASES_MAX = 20;
const REASK_RUNS = 6;

/**
 * The dollars of one confirmed suite. `low` is one run of every case (what an ordinary check costs); `high` is the most a check can cost: three runs of every case at their bounds (a first look, a second
 * look and the re-asks of the changed cases), never above the approved per-check ceiling `maximumMicros`. `monthlyCapMicros` is the company's monthly cap the item was held to. Whole numbers only;
 * undefined for a figure that is not one (the confirm then refuses before anything is proposed).
 */
export function evalDollarsOf(input: { questions: number; costMicrosPerQuestion: number; maximumMicros: number; monthlyCapMicros: number }): EvalSpendDollars | undefined {
  const whole = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (![input.questions, input.costMicrosPerQuestion, input.maximumMicros, input.monthlyCapMicros].every(whole)) return undefined;
  const low = input.questions * input.costMicrosPerQuestion;
  const natural = input.costMicrosPerQuestion * (3 * input.questions + REASK_RUNS * Math.min(input.questions, REASK_CASES_MAX));
  const high = Math.min(natural, input.maximumMicros);
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(natural) || low > high) return undefined;
  return { perCheckLowMicros: low, perCheckHighMicros: high, monthlyCapMicros: input.monthlyCapMicros };
}

/** Dollars as a person reads them: cents, or "under $0.01" for a figure too small to show. */
export function dollarsOf(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return "$0.00";
  if (micros > 0 && micros < 10_000) return "under $0.01";
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Dollars rounded UP to the cent: a figure that stands for a most (a ceiling, a cap) is never shown below what is approved. */
export function dollarsUpOf(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return "$0.00";
  if (micros > 0 && micros < 10_000) return "under $0.01";
  return `$${(Math.ceil(micros / 10_000) / 100).toFixed(2)}`;
}

/** "about $A-$B": the range as one phrase; "about $A" when both read the same; "up to $B" when the low end is too small to show. */
export function dollarRangeOf(lowMicros: number, highMicros: number): string {
  const low = dollarsOf(lowMicros); const high = dollarsUpOf(highMicros);
  if (highMicros < 10_000) return "under $0.01";
  if (low === high) return `about ${low}`;
  return lowMicros < 10_000 ? `up to ${high}` : `about ${low}-${high}`;
}

/**
 * The card's one sentence (DEC 254zzz20 D8), in dollars only. RF-5: for the Bedrock row the same sentence says whose cap counts the money (the dollars are the company's own AWS bill; the eval's own cost line reads 0 for Bedrock calls).
 */
export function evalApprovalSentence(dollars: EvalSpendDollars, catalogRowId?: string): string {
  const where = catalogRowId === EVAL_BEDROCK_ROW ? ` ${EVAL_BEDROCK_COST_WORDS}` : "";
  return `Running your evals on each AI change will cost ${dollarRangeOf(dollars.perCheckLowMicros, dollars.perCheckHighMicros)} per PR, at most ${dollarsUpOf(dollars.monthlyCapMicros)} a month.${where} Approve?`;
}

/** The opt-in health run's button words (DEC 254zzz20 D5): three runs of every case on the project's main code, shown with its cost. */
export function evalHealthButtonLabel(plan: Pick<EvalSpendPlan, "estimate">): string {
  return `Check my evals now (about ${dollarsOf(plan.estimate.costMicros)})`;
}

/** The fixed reasons an approval asks again (DEC 254zzz20 D6). The first carries the approved ceiling it grew past. */
export function evalAsksAgainWords(asks: { reason: "grew" | "changed"; approvedHighMicros?: number | undefined }): string {
  if (asks.reason === "grew") return asks.approvedHighMicros === undefined ? "Needs approval: your eval set grew past the approved limit" : `Needs approval: your eval set grew past the approved ${dollarsUpOf(asks.approvedHighMicros)}`;
  return "Needs approval: the model, judge or command of your eval changed";
}
