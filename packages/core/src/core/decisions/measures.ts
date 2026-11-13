// Decision measures (design 3.7, S2 15.4): decisions per person per day, median time to decide, approvals later reversed, cards answered by a rule. METRIC style, like
// `feedback-review-measures.ts`: one structured line per event, fixed fields only, nothing a person or a repository wrote. A person is a short hash that cannot be read back to them.
import { createHash } from "node:crypto";
import type { DecisionKind, DecisionRisk } from "@rovara-code/contracts";

export type DecisionMeasureName = "decision_made" | "decision_reversed" | "decision_answered_by_rule";
export interface DecisionMeasure {
  event: "decision.measure";
  measure: DecisionMeasureName;
  kind: DecisionKind;
  risk: DecisionRisk;
  outcome?: "approved" | "rejected";
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Twelve hex characters of a hash of the org and person; the same person is the same value, nothing more. */
  person: string;
  /** Whole seconds from the card's creation to the decision (decision_made only). */
  seconds?: number;
  count: 1;
  at: string;
}

export const personHash = (orgId: string, developerId: string): string => createHash("sha256").update(`decision-measure\0${orgId}\0${developerId}`).digest("hex").slice(0, 12);
const instant = (value: string): number | undefined => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : undefined; };

interface Who { orgId: string; developerId: string }
interface What { kind: DecisionKind; risk: DecisionRisk }

/** One decision was made. Undefined when a time does not parse or the decision came before the card (never a negative duration). */
export function decisionMadeMeasure(who: Who, what: What, input: { outcome: "approved" | "rejected"; createdAt: string; at: string }): DecisionMeasure | undefined {
  const created = instant(input.createdAt);
  const at = instant(input.at);
  if (created === undefined || at === undefined || at < created) return undefined;
  return { event: "decision.measure", measure: "decision_made", ...what, outcome: input.outcome, day: new Date(at).toISOString().slice(0, 10), person: personHash(who.orgId, who.developerId), seconds: Math.floor((at - created) / 1000), count: 1, at: new Date(at).toISOString() };
}

/** An approval was later undone (a merge reverted, a plan sent back after approval). `who` is the person who approved. */
export function decisionReversedMeasure(who: Who, what: What, at: string): DecisionMeasure | undefined {
  const ms = instant(at);
  return ms === undefined ? undefined : { event: "decision.measure", measure: "decision_reversed", ...what, day: new Date(ms).toISOString().slice(0, 10), person: personHash(who.orgId, who.developerId), count: 1, at: new Date(ms).toISOString() };
}

/** A standing rule answered a card. Never for a high card (the projector refuses it); this refuses too. */
export function ruleAnsweredMeasure(who: Who, what: What, at: string): DecisionMeasure | undefined {
  const ms = instant(at);
  if (ms === undefined || what.risk === "high") return undefined;
  return { event: "decision.measure", measure: "decision_answered_by_rule", ...what, day: new Date(ms).toISOString().slice(0, 10), person: personHash(who.orgId, who.developerId), count: 1, at: new Date(ms).toISOString() };
}

export interface DecisionSummary {
  /** Decisions per person per day, as `person|day` to the count. */
  perPersonPerDay: Record<string, number>;
  /** The median seconds from card to decision, or undefined with no decisions. */
  medianSeconds: number | undefined;
  reversed: number;
  answeredByRule: number;
}

/** The four numbers the design asks for, from a list of measure lines. */
export function summarizeDecisionMeasures(measures: readonly DecisionMeasure[]): DecisionSummary {
  const perPersonPerDay: Record<string, number> = {};
  const seconds: number[] = [];
  let reversed = 0;
  let answeredByRule = 0;
  for (const measure of measures) {
    if (measure.measure === "decision_made") {
      const key = `${measure.person}|${measure.day}`;
      perPersonPerDay[key] = (perPersonPerDay[key] ?? 0) + 1;
      if (measure.seconds !== undefined) seconds.push(measure.seconds);
    } else if (measure.measure === "decision_reversed") reversed += 1;
    else answeredByRule += 1;
  }
  seconds.sort((a, b) => a - b);
  const middle = Math.floor(seconds.length / 2);
  const medianSeconds = seconds.length === 0 ? undefined : seconds.length % 2 === 1 ? seconds[middle] : ((seconds[middle - 1] ?? 0) + (seconds[middle] ?? 0)) / 2;
  return { perPersonPerDay, medianSeconds, reversed, answeredByRule };
}
