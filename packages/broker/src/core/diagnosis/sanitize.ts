// Fix with agent: the broker reads a diagnosis again. A model's answer (the light turn's text, or the deep worker's) is untrusted: it may be misled by text planted in a log, a check's output or a
// repository file. Nothing it says is ever applied. This module turns the text into the closed set of proposals (`parseDiagnosisProposals`: an unknown kind or field drops the proposal whole, a
// settings change off the allow-list is dropped) and makes every free-text field redacted, one line, inert (no mention, link, tag or issue reference) and short.
import {
  DIAGNOSIS_ANSWER_MAX_CHARS, DIAGNOSIS_PROPOSALS_MAX, parseDiagnosisCitation, parseDiagnosisProposals, redactText,
  type DiagnosisProposal,
} from "@agentx/contracts";
import { inertLine } from "../proof/inert-text.js";

export interface SanitizedDiagnosis {
  /** The first is the summary as an `explain` proposal when the answer had one; at most `DIAGNOSIS_PROPOSALS_MAX`. */
  proposals: DiagnosisProposal[];
  /** Proposals dropped (unknown kind or field, off the allow-list, over the limit). */
  dropped: number;
  /** The answer says the cause is in the code, so a deep diagnosis may be asked for. */
  needsCode: boolean;
  /** False when the answer was not the JSON object asked for: its text is then shown as one explanation and nothing else. */
  structured: boolean;
}

const SUMMARY_MAX_CHARS = 1_900;
/** The most characters of an unstructured answer that is shown (as one explanation). */
const UNSTRUCTURED_MAX_CHARS = 1_900;

/** The JSON object in a model's text: the whole text, a fenced block, or the span from the first `{` to the last `}`. Undefined when there is none. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* try the next */ }
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Makes the free text of one raw proposal safe, leaving its shape alone (so the closed schema still sees every key the model wrote and drops a proposal with one it does not know). A settings
 * change keeps its values and its citations exactly: they are checked, not rewritten (the allow-list checks the values; the citations must parse, hold nothing a secret redaction would change, and
 * are read again before the change is ever raised). Anything that is not a plain object passes through to be dropped by the schema.
 */
function cleanProposal(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const text = (value: unknown, max: number): unknown => (typeof value === "string" ? inertLine(value, max) : value);
  switch (raw["kind"]) {
    case "explain": return { ...raw, text: text(raw["text"], 1_900) };
    case "retry_with_note": return { ...raw, note: text(raw["note"], 1_900) };
    case "redirect": return { ...raw, text: text(raw["text"], 1_900) };
    case "new_task": return { ...raw, request: text(raw["request"], 3_900) };
    case "admin_steps": return { ...raw, steps: Array.isArray(raw["steps"]) ? raw["steps"].map((step) => text(step, 480)) : raw["steps"] };
    case "settings_change": {
      const citations = raw["citations"];
      if (!Array.isArray(citations)) return raw;
      // A citation that is not one of the two forms, or that a redaction would change (it holds something secret-shaped), is left out; a change with none left is dropped by the schema.
      const kept = citations.filter((citation): citation is string => typeof citation === "string" && redactText(citation) === citation && parseDiagnosisCitation(citation) !== undefined);
      return { ...raw, citations: kept };
    }
    default: return raw;
  }
}

/**
 * Reads a diagnosis answer. Never throws and never trusts the answer's shape: the result is always a bounded list of closed-schema proposals.
 * Text that is not the JSON object asked for becomes one inert explanation; an object whose `summary` is missing simply has no summary line.
 */
export function sanitizeDiagnosis(answer: unknown): SanitizedDiagnosis {
  const text = typeof answer === "string" ? answer.slice(0, DIAGNOSIS_ANSWER_MAX_CHARS) : "";
  const object = extractJsonObject(text);
  if (object === undefined) {
    const shown = inertLine(text, UNSTRUCTURED_MAX_CHARS);
    return { proposals: shown === "" ? [] : [{ kind: "explain", text: shown }], dropped: 0, needsCode: false, structured: false };
  }
  const summary = typeof object["summary"] === "string" ? inertLine(object["summary"], SUMMARY_MAX_CHARS) : "";
  const rawList = Array.isArray(object["proposals"]) ? object["proposals"] : [];
  // The summary takes one place; the model's own proposals fill the rest, and the extras are counted.
  const room = summary === "" ? DIAGNOSIS_PROPOSALS_MAX : DIAGNOSIS_PROPOSALS_MAX - 1;
  const parsed = parseDiagnosisProposals(rawList.map(cleanProposal));
  const kept = parsed.proposals.slice(0, room);
  return {
    proposals: [...(summary === "" ? [] : [{ kind: "explain" as const, text: summary }]), ...kept],
    dropped: parsed.dropped + (parsed.proposals.length - kept.length),
    needsCode: object["needsCode"] === true,
    structured: true,
  };
}

/** The counts of a sanitised answer by kind, for the audit event (numbers only). */
export function proposalCounts(proposals: readonly DiagnosisProposal[]): { explain: number; retryWithNote: number; redirect: number; settingsChange: number; newTask: number; adminSteps: number; contactSupport: number } {
  const count = (kind: DiagnosisProposal["kind"]) => proposals.filter((proposal) => proposal.kind === kind).length;
  return { explain: count("explain"), retryWithNote: count("retry_with_note"), redirect: count("redirect"), settingsChange: count("settings_change"), newTask: count("new_task"), adminSteps: count("admin_steps"), contactSupport: count("contact_support") };
}
