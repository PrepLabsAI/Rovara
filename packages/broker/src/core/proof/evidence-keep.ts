// Proof and evidence (wire-proof): where the broker assembles the evidence pack for a task and keeps it, and where it reads it back. Assembly runs ONCE per verification (CHECKS) run, when its result is accepted
// (aws/broker/workflow-items.ts, after the verification is recorded), and only while the proof switch is on:
//   1. read the worker's `evidence-raw.json` of that operation (an object under the operation's own key prefix, bounded);
//   2. the data guard drops every check part that holds personal data, a credential or production data (evidence-guard.ts), BEFORE the builder sees it;
//   3. `buildEvidencePack` binds it to the candidate digest and checks every count against the broker's own check report;
//   4. the data guard looks at the built pack and its output tails again, because the builder adds labels and paths of its own;
//   5. the output tails are stored (content addressed, tagged for retention, under the task), then the pack is stored at a key that names the task and the candidate digest.
// Informational: a fault anywhere only means there is no pack for this code, and the pull request and the page say what they always said. Nothing here can change a verdict, block a publication or hold a callback
// past its bound. Video, trace, screenshots and API samples are not gathered by this path (their capture lane is separate): the builder is given no media gate, so none is ever kept.
import {
  EVIDENCE_NOT_TESTED_MAX, EVIDENCE_RAW_ARTIFACT, EVIDENCE_RAW_MAX_BYTES, EvidencePackReadSchema, EvidencePackSchema, EvidenceRawSchema, TEST_PROOF_ARTIFACT, TestProofSchema, evidenceIsFor,
  type CheckEntry, type CheckKind, type EvidenceEnvironment, type EvidenceNotTested, type EvidencePack, type EvidenceRaw, type TestEnvProdDeny, type TestProofWeakening,
} from "@agentx/contracts";
import type { TestProofActions } from "../../developer/test-proof-lines.js";
import { storeEvidenceArtifacts, type EvidenceArtifactStore } from "./evidence-artifacts.js";
import type { EvidenceBlobStore } from "./evidence-blob-store.js";
import type { PinnedDependency } from "./dependency-evidence.js";
import { buildEvidencePack, type EvidenceProblem } from "./evidence-pack.js";
import { NO_PROD_DENY, dataGuardScanWorks, guardPack, guardRaw, type DataGuardScan } from "./evidence-guard.js";
import { kindOfRawCheck } from "./evidence-risk.js";

export interface EvidenceTask { ownerKey: string; workspaceId: string; taskId: string }

/** The pack is kept at a key that names its task and the exact code it is for; a reader asks for the current candidate's digest only. */
export const evidencePackKey = (task: EvidenceTask, candidateDigest: string): string => `private/${task.ownerKey}/${task.workspaceId}/evidence-pack/${task.taskId}/${candidateDigest}.json`;
const DIGEST = /^[a-f0-9]{64}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PACK_READ_BYTES = 4 * 1_048_576;

/** What the sandbox without an approved test environment is: the project's own checks in the task's sandbox. Test environments are a later lane; this says so in the pack instead of claiming a setup. */
export const DEFAULT_EVIDENCE_ENVIRONMENT: EvidenceEnvironment = { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] };
const NO_ENVIRONMENT_ITEM: EvidenceNotTested = { kind: "environment", id: "test_environment", text: "No approved test environment: the project's own test setup was used", reason: "not set up" };
const NOT_CAPTURED_ITEM: EvidenceNotTested = { kind: "environment", id: "evidence_capture", text: "Test details were not captured for this run", reason: "the worker reported none" };
const WITHHELD_ITEM: EvidenceNotTested = { kind: "environment", id: "data_guard", text: "Some test details were left out", reason: "personal or production data found" };

export interface KeepEvidenceInput {
  /** The org the task belongs to: the first pack an org keeps marks it, so an erase for an org that never kept evidence costs one read. */
  orgId: string;
  task: EvidenceTask;
  operationId: string;
  candidateDigest: string;
  /** The broker's own check entries for this code (the truth for labels and outcomes). */
  checks: readonly CheckEntry[];
  /** Each check's kind from the approved policy, by `readiness:<index>`. */
  policyKinds?: ReadonlyMap<string, CheckKind> | undefined;
  environment?: EvidenceEnvironment | undefined;
  deny?: TestEnvProdDeny | undefined;
  /** Test environment (wire-testenv): what to say instead of "No approved test environment" when the project has one that was not applied to this task. */
  environmentNote?: EvidenceNotTested | undefined;
  /** Test services: the dependencies the broker pinned for the run (see `PinnedDependency`). */
  dependencies?: readonly PinnedDependency[] | undefined;
  /** FIX-0518: fixed items the broker adds to the pack's "not tested" list as they are (the laptop's "model hosts allowed in the test sandbox by project setting"). Words from code, never from a repository. */
  extraNotTested?: readonly EvidenceNotTested[] | undefined;
}

export interface KeepEvidenceDeps {
  /** The synthetic data guard's scan (required: evidence is never kept unscanned). */
  scan: DataGuardScan;
  actions: Pick<TestProofActions, "artifacts" | "readArtifact">;
  store: EvidenceArtifactStore;
  /** Marks that the org has kept evidence, for an erase that walks only the orgs that hold some (Cloud's company close). Called BEFORE anything is stored, and nothing is stored if it fails. Code needs none: its erase is by task or workspace prefix. */
  markStored?(orgId: string): Promise<void>;
  /** An abandoned call (its time has run out) writes nothing more. */
  late?: (() => boolean) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export type KeepEvidenceResult =
  | { kept: true; problems: EvidenceProblem[]; guardedParts: number }
  | { kept: false; reason: "not_bound" | "withheld" | "invalid" | "fault" };

/** The raw file's text for this operation, or undefined (none, not under the operation's own prefix, unreadable). Over the cap it returns the cap plus one byte, which the builder refuses whole. */
async function readRaw(deps: KeepEvidenceDeps, input: KeepEvidenceInput): Promise<string | undefined> {
  const artifact = (await deps.actions.artifacts(input.task.workspaceId, input.operationId)).find((entry) => entry.name === EVIDENCE_RAW_ARTIFACT);
  const prefix = `private/${input.task.ownerKey}/${input.task.workspaceId}/${input.operationId}/`;
  if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) return undefined;
  return deps.actions.readArtifact(artifact.objectKey, EVIDENCE_RAW_MAX_BYTES + 1);
}

const TEST_PROOF_READ_BYTES = 256 * 1024;

/**
 * TE-B3: what the worker's run on the original code showed about each check's untouched tests (skips that rose, tests that ran before and are gone), read from the operation's `test-proof.json`: an object under the operation's own
 * key prefix, bounded, parsed against its schema and bound to this code's digest. Informational: anything else is no facts. They come from the same worker as the raw file and are as untrusted: the caller merges them into the raw
 * file BEFORE the data guard and the builder, so both check them like every other test name.
 */
async function readWeakeningFacts(deps: KeepEvidenceDeps, input: KeepEvidenceInput): Promise<ReadonlyMap<string, TestProofWeakening>> {
  try {
    const artifact = (await deps.actions.artifacts(input.task.workspaceId, input.operationId)).find((entry) => entry.name === TEST_PROOF_ARTIFACT);
    const prefix = `private/${input.task.ownerKey}/${input.task.workspaceId}/${input.operationId}/`;
    if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) return new Map();
    const parsed = TestProofSchema.safeParse(JSON.parse(await deps.actions.readArtifact(artifact.objectKey, TEST_PROOF_READ_BYTES)) as unknown);
    if (!parsed.success || parsed.data.candidateDigest !== input.candidateDigest) return new Map();
    return new Map((parsed.data.weakening ?? []).map((item) => [item.checkId, item] as const));
  } catch {
    return new Map();
  }
}

/** The raw file with the weakening facts put into each check's `tests` part; the raw file's own numbers win, and a result that no longer fits the raw schema is not used. */
function withWeakeningFacts(raw: EvidenceRaw, facts: ReadonlyMap<string, TestProofWeakening>): EvidenceRaw {
  if (facts.size === 0) return raw;
  const checks = raw.checks.map((check) => {
    const fact = facts.get(check.checkId);
    if (check.tests === undefined || fact === undefined) return check;
    const tests = { ...check.tests };
    // Written only when there is something to say (a skip count that really rose, at least one test that ran before and is gone): a pack with nothing to flag has none of these keys, so a reader built before them still reads it.
    // Both skip counts or neither; the skips among untouched tests are some of the skips.
    if (tests.skippedBefore === undefined && tests.skippedAfter === undefined && fact.skippedAfter > fact.skippedBefore && fact.skippedAfter <= tests.skipped) { tests.skippedBefore = fact.skippedBefore; tests.skippedAfter = fact.skippedAfter; }
    if (tests.absentOnNew === undefined && tests.absentOnNewCount === undefined && fact.absentOnNewCount > 0) { tests.absentOnNew = [...fact.absentOnNew]; tests.absentOnNewCount = fact.absentOnNewCount; }
    return { ...check, tests };
  });
  const merged = EvidenceRawSchema.safeParse({ ...raw, checks });
  return merged.success ? merged.data : raw;
}

/** Assembles and keeps the pack for a verification run. Never throws. */
export async function keepEvidence(deps: KeepEvidenceDeps, input: KeepEvidenceInput): Promise<KeepEvidenceResult> {
  try {
    if (!DIGEST.test(input.candidateDigest) || !TASK_ID.test(input.task.taskId)) return { kept: false, reason: "invalid" };
    // A scan that finds nothing for a card number, a credential and an address is not the data guard: nothing is kept unscanned.
    if (!dataGuardScanWorks(deps.scan)) return { kept: false, reason: "withheld" };
    const deny = input.deny ?? NO_PROD_DENY;
    let rawText = await readRaw(deps, input);
    let guarded = 0;
    // No raw file (an older worker was sent no request, or the checks named no report): recorded as NOT CAPTURED, in the log and on the pack itself, so the pull request and the Evidence tab can tell it from
    // evidence that expired or from a switch that was off. The pack then holds only what the broker knows itself (its own verdict for each check).
    if (rawText === undefined) deps.log?.("evidence.not_captured", { reason: "no_raw_file" });
    // The guard works on a raw file that parses (a file that does not is refused whole by the builder: it would never have been used).
    let parsedRaw: EvidenceRaw | undefined;
    if (rawText !== undefined) {
      try { const parsed = EvidenceRawSchema.safeParse(JSON.parse(rawText)); parsedRaw = parsed.success ? parsed.data : undefined; } catch { parsedRaw = undefined; }
    }
    if (parsedRaw !== undefined && parsedRaw.candidateDigest !== input.candidateDigest) return { kept: false, reason: "not_bound" };
    if (parsedRaw !== undefined) {
      // TE-B3: the facts from the run on the original code join the raw file first, so the data guard and the builder check them like every other test name.
      parsedRaw = withWeakeningFacts(parsedRaw, await readWeakeningFacts(deps, input));
      const guard = guardRaw(parsedRaw, deny, deps.scan);
      guarded += guard.dropped.parts;
      rawText = JSON.stringify(guard.raw);
      parsedRaw = guard.raw;
    }
    // A check whose raw part carries a test report is a test check; the approved policy's kind wins where it names one.
    const kinds = new Map<string, CheckKind>(input.policyKinds ?? []);
    for (const entry of parsedRaw?.checks ?? []) if (entry.tests !== undefined && !kinds.has(entry.checkId)) kinds.set(entry.checkId, "test");
    // P4: migration evidence marks a migration check, and findings mark a security scan (a known scanner) or a lint check; the approved policy's kind still wins.
    for (const entry of parsedRaw?.checks ?? []) { const kind = kindOfRawCheck(entry); if (kind !== undefined && !kinds.has(entry.checkId)) kinds.set(entry.checkId, kind); }
    const environment = input.environment ?? DEFAULT_EVIDENCE_ENVIRONMENT;
    const built = buildEvidencePack({
      candidateDigest: input.candidateDigest, rawText, checks: input.checks, checkKinds: kinds, environment, ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
      notTested: [...(input.extraNotTested ?? []), ...(environment.envRevision === 0 ? [input.environmentNote ?? NO_ENVIRONMENT_ITEM] : []), ...(rawText === undefined ? [NOT_CAPTURED_ITEM] : []), ...(guarded > 0 ? [WITHHELD_ITEM] : [])], storedArtifacts: new Map(),
    });
    if (built.pack === undefined) return { kept: false, reason: "invalid" };
    const guardedPack = guardPack(built.pack, built.newArtifacts, deny, deps.scan);
    guarded += guardedPack.dropped.parts;
    if (guardedPack.pack === undefined) return { kept: false, reason: "withheld" };
    let pack = guardedPack.pack;
    if (guardedPack.dropped.parts > 0 && !pack.notTested.some((item) => item.id === WITHHELD_ITEM.id)) {
      pack = { ...pack, notTested: [...pack.notTested, WITHHELD_ITEM].slice(0, EVIDENCE_NOT_TESTED_MAX) };
    }
    if (deps.late?.() === true) return { kept: false, reason: "fault" };
    // The org is marked before the first object is stored, so an erase never skips an org that holds evidence.
    await deps.markStored?.(input.orgId);
    // The tails are stored first: a pack never names a file the store does not hold.
    const owner = { ownerKey: input.task.ownerKey, workspaceId: input.task.workspaceId, taskId: input.task.taskId };
    const stored = await storeEvidenceArtifacts(deps.store, owner, guardedPack.newArtifacts.map((artifact) => ({ kind: "log_txt" as const, bytes: Buffer.from(artifact.text, "utf8"), sha256: artifact.ref.sha256 })));
    pack = { ...pack, checks: pack.checks.map((check) => {
      if (check.outputTailRef === undefined || stored.has(check.outputTailRef.sha256)) return check;
      const { outputTailRef: _lost, ...withoutTail } = check;
      void _lost;
      return withoutTail;
    }) };
    const checked = EvidencePackSchema.safeParse(pack);
    if (!checked.success) return { kept: false, reason: "invalid" };
    if (deps.late?.() === true) return { kept: false, reason: "fault" };
    // The stored pack is kept like the tails (`evidence-std`): it expires with them and is deleted with them on erasure.
    await deps.store.blobs.put(evidencePackKey(input.task, input.candidateDigest), Buffer.from(JSON.stringify(checked.data), "utf8"), { contentType: "application/json", metadata: { kind: "evidence-pack" }, retention: "evidence-std" },
      // One pack per task and candidate digest: re-keeping the same candidate (a re-check, a retried keep) writes the pack again, so this caller overwrites on purpose.
      { overwrite: true });
    return { kept: true, problems: built.problems, guardedParts: guarded };
  } catch (error) {
    deps.log?.("evidence.keep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return { kept: false, reason: "fault" };
  }
}

/** The pack kept for exactly this code of this task; undefined when there is none, it does not parse or is for other code. Never throws. */
export async function loadEvidencePack(blobs: Pick<EvidenceBlobStore, "get">, task: EvidenceTask, candidateDigest: string | undefined): Promise<EvidencePack | undefined> {
  if (candidateDigest === undefined || !DIGEST.test(candidateDigest) || !TASK_ID.test(task.taskId)) return undefined;
  try {
    const bytes = await blobs.get(evidencePackKey(task, candidateDigest), PACK_READ_BYTES);
    if (bytes === undefined) return undefined;
    const parsed = EvidencePackReadSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
    return parsed.success && evidenceIsFor(parsed.data, candidateDigest) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The kinds the approved check policy names, by the id the worker reports (`readiness:<index>`, in selected order). */
export function policyKindsOf(selected: ReadonlyArray<{ kind?: CheckKind | undefined }>): Map<string, CheckKind> {
  const kinds = new Map<string, CheckKind>();
  selected.forEach((check, index) => { if (check.kind !== undefined) kinds.set(`readiness:${String(index)}`, check.kind); });
  return kinds;
}

