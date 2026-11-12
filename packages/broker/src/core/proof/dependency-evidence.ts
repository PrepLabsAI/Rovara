// Test services, slice 1 T4 (design test-services.md 2.4, 8.1 and 9.3): the evidence rows of a round's dependencies, built by the BROKER from what it pinned and what the worker reported.
//
// The label is the broker's: it comes from the approved backing (`evidenceDependencyLabelFor`), never from the worker. The worker's usage record only says whether a dependency really ran
// and for how long. A dependency the record does not show started and healthy is NOT shown as running ("not available", fell back: did not start): a missing or broken record never makes a result look better.
// The names the sealed tests asked for that no dependency answers are counted as registrable domain + count in one "Blocked by environment" line, never with a path, a query or a value.
import { TEST_SERVICES_AWS_USAGE_WORDS, TEST_SERVICES_FAKE_USAGE_WORDS, awsEmulatorEvidenceLines, evidenceDependencyLabelFor, testServicesAwsUsageVerdict, testServicesFakeUsageVerdict, testServicesUnknownCallCount, type EvidenceDependency, type EvidenceNotTested, type EvidenceRaw } from "@agentx/contracts";
import { inertLine } from "./inert-text.js";

/** A dependency as the broker pinned it for the run (from the approved environment's backing, not from the worker). */
export interface PinnedDependency {
  id: string;
  name: string;
  /** `local`: real software from the catalog. `emulated` (slice 2): Rovara local AWS. `fake` (slice 3): a fake server serving an approved fixture set. */
  backing: "local" | "emulated" | "fake";
  /** True when a company-approved substitute image was pinned (not used in slice 1). */
  substituteImage?: boolean;
  /** `emulated` only: the AWS services the plan asked Rovara local AWS for (the broker's own; the worker's ledger is judged against them). */
  awsServices?: readonly string[];
  /** `fake` only: what the broker's fixture store says about the set the plan pinned (never the worker's words). `recordedAt` is the set's own, and only a recorded set has one. */
  fake?: { origin: "recorded" | "hand_written"; revision?: number; recordedAt?: string };
}

export const BLOCKED_CALLS_ITEM_ID = "blocked-calls";
/** The not-tested item that says a fake was asked for something it had no recording for, or that its requests could not be checked (slice 3). */
export const FAKE_USAGE_ITEM_ID = "fake-usage";
/** The not-tested item that says the AWS usage was not clean or could not be checked (slice 2). */
export const AWS_USAGE_ITEM_ID = "aws-usage";
/** Rovara local AWS does not enforce IAM (design 2.4 and 4.2). One fixed item for the Evidence tab; the pull request says it through `dependencyLines`, from the same label. */
export const AWS_PERMISSIONS_ITEM_ID = "aws-permissions";
export const AWS_PERMISSIONS_NOT_CHECKED = "AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM";
/** The not-tested item of one emulated service: what emulated it and how far that matches AWS (the table's score), or the operations of it the run called that the emulator does not support. */
export const AWS_FIDELITY_ITEM_PREFIX = "aws-fidelity-";
export const AWS_PERMISSIONS_NOT_CHECKED_SHORT = "AWS permissions not checked (no IAM)";
export const NO_USAGE_RECORD_ITEM: EvidenceNotTested = { kind: "environment", id: "test-services", text: "What the test services did was not reported", reason: "no usage record" };
const BLOCKED_LISTED = 5;

export interface DependencyEvidence { dependencies: EvidenceDependency[]; notTested: EvidenceNotTested[] }

const plain = (text: string, max: number): string => inertLine(text, max);

/** One fake that ran: its label and facts are the broker's (the store's set, the pinned plan); the worker's record gives only the start time and the ledger's counts. */
function fakeRow(dependency: PinnedDependency, name: string, startedMs: number, usage: RawUsage): EvidenceDependency {
  const set = dependency.fake;
  // A recorded fake states when it was recorded; one whose date is not known is shown as the less trusted word.
  const recorded = set?.origin === "recorded" && set.recordedAt !== undefined;
  const label = evidenceDependencyLabelFor({ backing: "fake", recorded });
  const counts = usage?.fakes?.find((entry) => entry.id === dependency.id);
  const read = counts?.ledger === "read" ? counts : undefined;
  return {
    name, backing: "fake", label, startedMs,
    ...(set?.revision === undefined ? {} : { fixtureRevision: set.revision }),
    ...(recorded ? { recordedAt: set.recordedAt! } : {}),
    ...(read === undefined ? {} : { usage: { requests: read.matched + read.unmatched + read.synthesized, unmatched: read.unmatched, faults: read.faults } }),
    ...(read === undefined || read.synthesized === 0 ? {} : { madeUpAnswers: read.synthesized }),
  };
}

/** The pack's dependency rows and the not-tested items for a round. Pure. */
/** The worker's record of the round, as the raw evidence file carries it (`EvidenceRaw["testServices"]`). Only the evidence build reads it. */
export type RawUsage = EvidenceRaw["testServices"];

export function dependencyEvidenceOf(pinned: readonly PinnedDependency[], usage: RawUsage): DependencyEvidence {
  const taken = new Set<string>();
  const dependencies = pinned.map((dependency): EvidenceDependency => {
    // A pack's dependency names are unique; two with the same words are told apart by their ids.
    let name = plain(dependency.name, 80);
    if (name === "" || taken.has(name)) name = plain(`${name === "" ? "dependency" : name} (${dependency.id})`, 80);
    taken.add(name);
    const used = usage?.dependencies.find((entry) => entry.id === dependency.id);
    const ran = used !== undefined && used.started && used.healthy && used.failure === undefined;
    // A fake that did not start is "not available" with no fallback story: the pack's fallback is from real software, Rovara local AWS or a test account to a fake or nothing, never from a fake.
    if (!ran) return { name, backing: "none", label: "not_available", ...(dependency.backing === "fake" ? {} : { fellBack: { from: dependency.backing, reason: "did_not_start" as const } }) };
    if (dependency.backing === "fake") return fakeRow(dependency, name, used.startMs, usage);
    if (dependency.backing === "emulated") return { name, backing: "emulated", label: evidenceDependencyLabelFor({ backing: "emulated" }), startedMs: used.startMs };
    return { name, backing: "local", label: evidenceDependencyLabelFor({ backing: "local", ...(dependency.substituteImage === true ? { substituteImage: true } : {}) }), startedMs: used.startMs };
  });
  const notTested: EvidenceNotTested[] = [];
  if (dependencies.some((dependency) => dependency.label === "rovara_local_aws")) notTested.push({ kind: "environment", id: AWS_PERMISSIONS_ITEM_ID, text: AWS_PERMISSIONS_NOT_CHECKED, reason: "emulated" });
  if (usage === undefined) notTested.push(NO_USAGE_RECORD_ITEM);
  else {
    const total = testServicesUnknownCallCount(usage);
    if (total > 0) {
      const listed = usage.unknownCalls.domains.slice(0, BLOCKED_LISTED).map((entry) => `${entry.domain} (${entry.count})`);
      const others = total - usage.unknownCalls.domains.slice(0, BLOCKED_LISTED).reduce((sum, entry) => sum + entry.count, 0);
      const text = `Blocked by environment: ${total} ${total === 1 ? "call" : "calls"} to names no dependency answers${listed.length === 0 ? "" : `: ${listed.join(", ")}`}${others > 0 && listed.length > 0 ? ` and ${others} more` : ""}`;
      notTested.push({ kind: "environment", id: BLOCKED_CALLS_ITEM_ID, text: text.slice(0, 300), reason: "blocked by environment" });
    }
  }
  // Slice 2: with Rovara local AWS in the plan, a result is never shown as a clean run when its AWS usage could not be checked or was not clean. The words are fixed; a service named is a plain key, made inert.
  const emulated = pinned.filter((dependency) => dependency.backing === "emulated");
  if (emulated.length > 0 && usage !== undefined) {
    const verdict = testServicesAwsUsageVerdict(usage, emulated.flatMap((dependency) => dependency.awsServices ?? []));
    if (!verdict.ok) {
      const named = verdict.services.slice(0, BLOCKED_LISTED).map((service) => plain(service, 40)).filter((service) => service !== "");
      const text = `${TEST_SERVICES_AWS_USAGE_WORDS[verdict.problem]}${named.length === 0 ? "" : `: ${named.join(", ")}`}`;
      notTested.push({ kind: "environment", id: AWS_USAGE_ITEM_ID, text: text.slice(0, 300), reason: verdict.problem === "unsupported" ? "unsupported by Rovara local AWS" : "aws usage" });
    }
  }
  // Per planned AWS service: what emulated it, how far that matches AWS, and the operations the run called that the emulator does not support (`awsEmulatorEvidenceLines`, table values and fixed words only).
  if (emulated.length > 0 && dependencies.some((dependency) => dependency.label === "rovara_local_aws")) {
    const lines = awsEmulatorEvidenceLines(emulated.flatMap((dependency) => dependency.awsServices ?? []), usage?.aws?.ledger === "read" ? usage.aws.unsupportedOperations : []);
    lines.forEach((text, index) => notTested.push({ kind: "environment", id: `${AWS_FIDELITY_ITEM_PREFIX}${String(index + 1)}`, text: plain(text, 300), reason: "emulated" }));
  }
  // Slice 3: with a fake in the plan, a result is never shown as a clean run when its requests could not be checked or the tests asked it for something it had no recording for. The words are fixed; a dependency named is a name
  // made inert.
  const fakes = pinned.filter((dependency) => dependency.backing === "fake");
  if (fakes.length > 0 && usage !== undefined) {
    const verdict = testServicesFakeUsageVerdict(usage, fakes.map((dependency) => dependency.id));
    if (!verdict.ok) {
      const named = verdict.ids.flatMap((id) => { const found = dependencies[pinned.findIndex((dependency) => dependency.id === id)]; return found === undefined ? [] : [found.name]; }).slice(0, BLOCKED_LISTED);
      const text = `${TEST_SERVICES_FAKE_USAGE_WORDS[verdict.problem]}${named.length === 0 ? "" : `: ${named.join(", ")}`}`;
      notTested.push({ kind: "environment", id: FAKE_USAGE_ITEM_ID, text: text.slice(0, 300), reason: verdict.problem === "unmatched" ? "no recording" : "fake usage" });
    }
  }
  return { dependencies, notTested };
}
