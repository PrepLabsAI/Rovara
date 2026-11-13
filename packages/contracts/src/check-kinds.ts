// The registry of check kinds and the trust classes of an evidence pack (TE-A2, design testing-build-plan section 3.1; owner decisions O51 and DECISIONS 156).
// A check kind is an id, not a closed list: the v1 pack's eight kinds are registered here, and a new kind (an eval, a benchmark, a visual diff) is one more row. Each row has the words a reader prints,
// the result parts a check of that kind may carry, and whether a passing check of that kind counts toward the proof that the change works (`countsTowardProof`). A kind this build does not know is not an error
// for a READER (`checkKindInfo` gives undefined and `checkKindWords` gives generic words); only the pack WRITER's strict schema refuses it.
// Browser-safe and pure: nothing here imports another module.

/** The result parts a check can carry. The first four are v1's; `measures` and `pairs` are new in v2. */
export const CHECK_PARTS = ["tests", "coverage", "findings", "migrations", "measures", "pairs"] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];

/** A kind id: lower-case words joined by underscores, so it is safe to print and to use as a key. */
export const CHECK_KIND_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

export interface CheckKindInfo {
  readonly id: string;
  /** The word a reader prints before the label ("Tests", "Lint"). */
  readonly words: string;
  /** The parts a check of this kind may carry. */
  readonly parts: readonly CheckPart[];
  /** Whether a passing check of this kind counts toward the proof that the change works. A lint, a type check, a scan, a build or a migration check passes whatever the change is, so it never proves one. */
  readonly countsTowardProof: boolean;
}

const ALL_PARTS: readonly CheckPart[] = CHECK_PARTS;
/** The parts a v1 pack's check can carry. The v1 builder attaches tests, coverage, findings and migrations by what the check's report held, whatever its kind (core/proof/evidence-pack.ts), so every v1 kind allows every one. */
const V1_PARTS: readonly CheckPart[] = ["tests", "coverage", "findings", "migrations"];

/** Replaces: the v1 pack's closed kind list (`CHECK_KINDS` in evidence.ts stays, and every one of its kinds is a row here). */
const REGISTRY_ROWS: CheckKindInfo[] = [
  { id: "test", words: "Tests", parts: [...V1_PARTS, "measures"], countsTowardProof: true },
  { id: "e2e", words: "End-to-end tests", parts: ["tests", "pairs", "measures"], countsTowardProof: true },
  { id: "eval", words: "Eval", parts: ["tests", "measures"], countsTowardProof: true },
  { id: "lint", words: "Lint", parts: V1_PARTS, countsTowardProof: false },
  { id: "typecheck", words: "Type check", parts: V1_PARTS, countsTowardProof: false },
  { id: "security", words: "Security scan", parts: V1_PARTS, countsTowardProof: false },
  { id: "migration", words: "Migrations", parts: V1_PARTS, countsTowardProof: false },
  { id: "build", words: "Build", parts: V1_PARTS, countsTowardProof: false },
  { id: "smoke", words: "Smoke test", parts: [...V1_PARTS, "pairs"], countsTowardProof: false },
  { id: "benchmark", words: "Benchmark", parts: ["measures"], countsTowardProof: false },
  { id: "visual", words: "Visual check", parts: ["pairs"], countsTowardProof: false },
  { id: "other", words: "Check", parts: ALL_PARTS, countsTowardProof: false },
];
export const CHECK_KIND_REGISTRY: readonly CheckKindInfo[] = Object.freeze(REGISTRY_ROWS.map((info) => Object.freeze(info)));

const BY_ID: ReadonlyMap<string, CheckKindInfo> = new Map(CHECK_KIND_REGISTRY.map((info) => [info.id, info]));

export function checkKindInfo(id: string): CheckKindInfo | undefined {
  return BY_ID.get(id);
}
export function isRegisteredCheckKind(id: string): boolean {
  return BY_ID.has(id);
}

/** What a reader that does not know the kind prints. */
export const UNKNOWN_CHECK_KIND_WORDS = "Newer check kind";
export function checkKindWords(id: string): string {
  return BY_ID.get(id)?.words ?? UNKNOWN_CHECK_KIND_WORDS;
}

/** The parts in `present` that a check of this kind does not carry. An unregistered kind has no rule, so none are outside it. */
export function partsOutsideKind(id: string, present: readonly string[]): string[] {
  const info = BY_ID.get(id);
  return info === undefined ? [] : present.filter((part) => !(info.parts as readonly string[]).includes(part));
}

// ---- trust classes (O51)

/**
 * How what answered a dependency, or a check, should be trusted. Real: a real service or a vendor test mode answered. Recorded: a recording of a real answer (with the day it was recorded).
 * Simulated: an in-process fake or scripted replies. Made by Rovara: a mock Rovara wrote. No outside calls: the tests called nothing outside the process. A recording is never Real (O11).
 */
export const EVIDENCE_TRUST_CLASSES = ["real", "recorded", "simulated", "made_by_rovara", "no_outside_calls"] as const;
export type EvidenceTrustClass = (typeof EVIDENCE_TRUST_CLASSES)[number];
export const EVIDENCE_TRUST_CLASS_WORDS: Record<EvidenceTrustClass, string> = {
  real: "Real",
  recorded: "Recorded",
  simulated: "Simulated",
  made_by_rovara: "Made by Rovara",
  no_outside_calls: "No outside calls",
};

/** What a change was proven with, when that is not the ordinary way (DECISIONS 156). */
export const PROOF_BASES = ["scripted_ai_replies"] as const;
export type ProofBasis = (typeof PROOF_BASES)[number];
/** An AI product's change counts as proven when the new tests fail on main and pass with the change against scripted model replies. The label is this and never "Real". */
export const SCRIPTED_AI_PROOF_WORDS = "proven with scripted AI replies";
export const PROOF_BASIS_WORDS: Record<ProofBasis, string> = { scripted_ai_replies: SCRIPTED_AI_PROOF_WORDS };

/** The words for a check's or dependency's trust. A proof basis wins over the trust class, so scripted replies can never read as "Real". Undefined when there is nothing to say. */
export function trustLabelWords(trust: EvidenceTrustClass | undefined, proofBasis?: ProofBasis): string | undefined {
  if (proofBasis !== undefined) return PROOF_BASIS_WORDS[proofBasis];
  return trust === undefined ? undefined : EVIDENCE_TRUST_CLASS_WORDS[trust];
}

// ---- what counts toward the proof, and the words of the first line (TE-A3; O11, O31, O51, DECISIONS 156 and 161)

/** The first line's words when readiness found the project's CI running on fakes. Words only: the renderer prints them when the pack says so (the field comes with the readiness lane). */
export const CI_USES_FAKES_WORDS = "real check: your CI (uses fakes)";

/**
 * Who wrote the scripted AI replies a proof ran against (DECISIONS 161). Only replies that were in the project's reply set before the task started, or that an independent reply agent wrote (it sees the prompt, the
 * expected answer shape and real examples, never the code change or the tests), count. Replies the coding agent wrote or edited are allowed, but never count.
 */
export const SCRIPTED_REPLY_SOURCES = ["project_set", "independent_agent", "coding_agent"] as const;
export type ScriptedReplySource = (typeof SCRIPTED_REPLY_SOURCES)[number];
export const SCRIPTED_REPLY_SOURCE_WORDS: Record<ScriptedReplySource, string> = {
  project_set: "scripted replies from before this task",
  independent_agent: "scripted replies written independently in this task",
  coding_agent: "scripted replies added in this task (not counted)",
};
const SCRIPTED_REPLIES_COUNTED: readonly ScriptedReplySource[] = ["project_set", "independent_agent"];

/** Whether scripted replies from this source can prove a change. A source this build does not know, or none, never counts (fail closed). */
export function scriptedRepliesCountTowardProof(source: string | undefined): boolean {
  return source !== undefined && (SCRIPTED_REPLIES_COUNTED as readonly string[]).includes(source);
}

/** Whether an answer of this trust class can stand behind a proof. A mock Rovara made never does (O31): it is shown with its label and stays out of the proof. A class this build does not know, or none, does not count. */
export function trustClassCountsTowardProof(trust: string | undefined): boolean {
  return trust !== undefined && (EVIDENCE_TRUST_CLASSES as readonly string[]).includes(trust) && trust !== "made_by_rovara";
}

/**
 * Whether a passing check counts toward the proof that the change works: its kind proves (`countsTowardProof` of its row), the trust class of what answered it counts, and a check proven with scripted AI replies names
 * a source whose replies count. A kind this build does not know does not count; a check with no trust class is judged by its kind alone.
 */
export function checkCountsTowardProof(check: { kind: string; trust?: string | undefined; proofBasis?: string | undefined; scriptedReplies?: string | undefined }): boolean {
  if (BY_ID.get(check.kind)?.countsTowardProof !== true) return false;
  if (check.trust !== undefined && !trustClassCountsTowardProof(check.trust)) return false;
  if (check.proofBasis !== undefined) return check.proofBasis === "scripted_ai_replies" && scriptedRepliesCountTowardProof(check.scriptedReplies);
  return true;
}
