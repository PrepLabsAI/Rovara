// Proof and evidence P5: the broker builds the EvidencePack. The worker's `evidence-raw.json` is UNTRUSTED input: it is read against its schema, bound to the candidate's digest, checked against the check
// report the broker holds itself and against the artifacts the store really holds, and every free text is redacted again. Labels, outcomes and classes come from the broker's own check report, the
// environment from the approved setting, never from the raw file. Anything that does not hold up is dropped and named in `problems` (fixed codes), and a drop never makes a check look better: a missing
// report is "not measured", never "passed".
//
// Pure apart from hashing: the caller reads the raw file (bounded), lists the stored artifacts, stores `newArtifacts` and persists the pack. The wiring into the task view is one hot-file hunk (see the report).
import { createHash } from "node:crypto";
import { dependencyEvidenceOf, type PinnedDependency } from "./dependency-evidence.js";
import {
  ArtifactLinkSchema, ArtifactRefSchema, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, EVIDENCE_CHECKS_MAX, EVIDENCE_NOT_TESTED_MAX, EVIDENCE_RAW_MAX_BYTES, EvidencePackSchema, EvidenceRawSchema, EvidenceViewSchema,
  redactText,
  TEST_ID_MAX,
  isValidTestId,
  type ArtifactLink, type ArtifactRef, type CheckEntry, type CheckKind, type EvidenceArtifactKind, type EvidenceEnvironment, type EvidenceNotTested, type EvidencePack, type EvidenceWithheldReason, type EvidenceRaw, type EvidenceView,
} from "@agentx/contracts";

/** Why part of the raw evidence was dropped or ignored. Fixed codes only: never the worker's text. */
export type EvidenceProblem =
  | "raw_too_large"
  | "raw_unreadable"
  | "raw_for_other_code"
  | "unknown_check_ignored"
  | "tests_not_trusted"
  | "tests_disagree_with_check"
  | "tests_names_exceed_counts"
  | "coverage_inconsistent"
  | "findings_inconsistent"
  | "findings_disagree_with_check"
  | "selection_inconsistent"
  | "artifact_missing"
  | "media_not_allowed"
  | "pack_invalid";

export interface StoredArtifact {
  kind: EvidenceArtifactKind;
  bytes: number;
}

export interface EvidenceBuildInput {
  /** The digest of the code the checks ran on (the workflow's candidate). */
  candidateDigest: string;
  /** The worker's `evidence-raw.json` as text, or undefined when there is none (an older worker, or a run that wrote none). */
  rawText?: string | undefined;
  /** The broker's own check entries for this code: the truth for labels, outcomes, classes and durations. */
  checks: readonly CheckEntry[];
  /** Each check's kind, from the approved policy or environment; a check with none is `other`. */
  checkKinds?: ReadonlyMap<string, CheckKind> | undefined;
  /** From the approved test environment and what the run used, never from the raw file. */
  environment: EvidenceEnvironment;
  /** Test services: the dependencies the broker pinned for this run. The pack's `environment.dependencies` and the "blocked by environment" item are built from them and the raw file's usage record (labels are the broker's). Absent: today's pack. */
  dependencies?: readonly PinnedDependency[] | undefined;
  /** Not-tested items the broker already has (the proof table's own, the environment's). */
  notTested?: readonly EvidenceNotTested[] | undefined;
  /** What the artifact store really holds, by sha256: a reference to anything else is dropped. */
  storedArtifacts: ReadonlyMap<string, StoredArtifact>;
  /**
   * The video/trace gate (design 3.4), every part defaulting to "no": `companyAllows` is the approved setting per kind; `revocationConfirmed` is the broker's own proof that the run's accounts were revoked
   * and their sessions ended; `tierAllowed` is the approved environment's tier rule (sandbox or per-task preview only). `gate` is the FULL publication gate result (`evaluatePublicationGate`: accounts, tier,
   * the data check, the company setting, the revocation proof): a file is kept only when `gate.allowed` says so for its kind, so the data check cannot be skipped here (Opus review I2). On top of these the
   * pack itself must show no long-lived (`registered`) account. Absent: nothing is kept.
   */
  media?: { companyAllows: { video: boolean; trace: boolean }; revocationConfirmed: boolean; tierAllowed: boolean; gate: { allowed: { video: boolean; trace: boolean }; reasons: { video?: EvidenceWithheldReason; trace?: EvidenceWithheldReason } } } | undefined;
}

export interface NewArtifact {
  ref: ArtifactRef;
  /** The text to store: a `log_txt` artifact the broker made from a check's output tail. */
  text: string;
}

export interface EvidenceBuildResult {
  pack: EvidencePack | undefined;
  problems: EvidenceProblem[];
  /** The output tails to store before the pack is kept (their refs are in the pack). */
  newArtifacts: NewArtifact[];
  /** Video and trace the gate withheld: the caller DELETES these from the store (design 3.4), so a withheld file cannot be fetched by its hash. */
  withheldArtifacts: ArtifactRef[];
}

/** One plain line, redacted again, cut. The raw file's text is never trusted to be redacted already. */
function plain(text: string, max: number, fallback = "-"): string {
  const line = redactText(text.replace(/[\p{Cc}\p{Cf}]+/gu, " ")).replace(/\s+/gu, " ").trim();
  const points = Array.from(line === "" ? fallback : line);
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * A test name in the pack (NH-1 re-check F2/F5): redacted again, and otherwise AS IT IS when it is a valid test id (contracts `test-id.ts`), so it is the same string the nightly's failing set and the marks hold. It is never cut
 * and its spaces are never changed. A name that is not valid (or that the worker already said is not) is shown as one plain line, cut with an ellipsis at the id limit, and marked `unlisted`: counted, never matched.
 */
function testNameOf(name: string, alreadyUnlisted: boolean): { name: string; unlisted?: true } {
  const redacted = redactText(name);
  if (!alreadyUnlisted && isValidTestId(redacted)) return { name: redacted };
  return { name: plain(redacted, TEST_ID_MAX, "test"), unlisted: true };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A tail cut from its start until it fits the cap in bytes, so what is kept is the end of the output. */
function tailWithin(text: string, maxBytes: number): string {
  let tail = text;
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(Math.max(1, Math.ceil((Buffer.byteLength(tail, "utf8") - maxBytes) / 4)));
  // A cut in the middle of a surrogate pair leaves a lone low surrogate at the start: drop it.
  return tail.replace(/^[\uDC00-\uDFFF]/u, "");
}

const SERVICE_WORDS: Record<EvidenceEnvironment["services"][number]["mode"], string> = { preprod: "pre-prod", mocked: "mocked", "live-forbidden": "live access refused" };

/**
 * Builds the pack for `candidateDigest`. A raw file that is too large, unreadable or for other code is ignored whole (the pack then holds only what the broker knows itself); parts of a good one that
 * disagree with the broker's own check report or with the store are dropped one by one. The result is checked against `EvidencePackSchema`: a pack that does not fit it is `undefined`.
 */
export function buildEvidencePack(input: EvidenceBuildInput): EvidenceBuildResult {
  const problems = new Set<EvidenceProblem>();
  const newArtifacts: NewArtifact[] = [];
  const withheldArtifacts: ArtifactRef[] = [];
  const raw = readRaw(input, problems);
  const rawByCheck = new Map((raw?.checks ?? []).map((entry) => [entry.checkId, entry] as const));
  for (const id of rawByCheck.keys()) if (!input.checks.some((entry) => entry.id === id)) problems.add("unknown_check_ignored");
  const media = input.media;
  const accountsOk = !input.environment.accounts.some((account) => account.kind === "registered") && (input.environment.tier !== "shared" || input.environment.accounts.length > 0);

  const checks = input.checks.slice(0, EVIDENCE_CHECKS_MAX).map((entry) => {
    const extra = rawByCheck.get(entry.id);
    const trusted = entry.after === "passed" || entry.after === "failed";
    let tests = extra?.tests;
    if (tests !== undefined && !trusted) {
      // A run that timed out, was stopped or never ran may have left an older report on disk.
      problems.add("tests_not_trusted");
      tests = undefined;
    }
    // A check's outcome is the broker's own: a passed check with failing tests, and a failed check whose report shows no failing test (a stale or partial report, a hook failure the report missed), both disagree.
    if (tests !== undefined && ((entry.after === "passed" && tests.failed + tests.errored > 0) || (entry.after === "failed" && tests.failed + tests.errored === 0))) {
      problems.add("tests_disagree_with_check");
      tests = undefined;
    }
    if (tests !== undefined && (["passed", "failed", "skipped", "errored"] as const).some((status) => tests!.names.filter((name) => name.status === status).length > tests![status]) ) {
      problems.add("tests_names_exceed_counts");
      tests = undefined;
    }
    let coverage = extra?.coverage;
    if (coverage !== undefined && coverage.files.reduce((sum, file) => sum + file.uncovered.length, 0) > coverage.linesChanged - coverage.linesCovered) {
      problems.add("coverage_inconsistent");
      coverage = undefined;
    }
    let findings = extra?.findings;
    if (findings !== undefined && findings.items.length > findings.newCount) {
      problems.add("findings_inconsistent");
      findings = undefined;
    }
    // A scan that failed with "0 new findings" is a scan whose findings were not read: never shown as clean.
    // (A scan that was already failing before the change, and fails for findings that were already there, legitimately has none that are new.)
    if (findings !== undefined && entry.after === "failed" && findings.newCount === 0 && entry.class !== "already_failing" && (findings.unverified ?? 0) === 0) {
      problems.add("findings_disagree_with_check");
      findings = undefined;
    }
    if (findings !== undefined && !trusted) {
      problems.add("tests_not_trusted");
      findings = undefined;
    }
    let outputTailRef: ArtifactRef | undefined;
    if (extra?.outputTail !== undefined && extra.outputTail !== "") {
      const text = tailWithin(redactText(extra.outputTail), EVIDENCE_ARTIFACT_MAX_BYTES.log_txt);
      outputTailRef = { kind: "log_txt", sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8"), retentionClass: EVIDENCE_ARTIFACT_RETENTION.log_txt };
      newArtifacts.push({ ref: outputTailRef, text });
    }
    return {
      checkId: entry.id,
      kind: input.checkKinds?.get(entry.id) ?? entry.kind ?? "other",
      label: plain(entry.label, 200),
      before: entry.before, after: entry.after, class: entry.class, durationMs: entry.durationMs,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      // TE-B3: the tests that ran before and are gone are named like the new ones: redacted again, a valid id as it is, anything else one plain cut line.
      ...(tests === undefined ? {} : { tests: { ...tests, names: tests.names.map((name) => ({ ...name, ...testNameOf(name.name, name.unlisted === true) })), newTests: tests.newTests.map((name) => testNameOf(name, false).name), ...(tests.absentOnNew === undefined ? {} : { absentOnNew: tests.absentOnNew.map((name) => testNameOf(name, false).name) }) } }),
      ...(coverage === undefined ? {} : { coverage: { ...coverage, files: coverage.files.map((file) => ({ ...file, path: plain(file.path, 500) })) } }),
      ...(findings === undefined ? {} : { findings: { ...findings, tool: plain(findings.tool, 60), items: findings.items.map((item) => ({ ...item, ruleId: plain(item.ruleId, 100), path: plain(item.path, 500), message: item.message === "" ? "" : plain(item.message, 300) })) } }),
      ...(extra?.migrations === undefined ? {} : { migrations: { applied: extra.migrations.applied.map((name) => plain(name, 100)), rolledBack: extra.migrations.rolledBack, schemaChanges: extra.migrations.schemaChanges.map((name) => plain(name, 200)) } }),
      ...(outputTailRef === undefined ? {} : { outputTailRef }),
    };
  });

  // The store's word beats the raw file's: a reference to an object the store does not hold with that kind and size is dropped.
  const held = (ref: ArtifactRef): boolean => {
    const stored = input.storedArtifacts.get(ref.sha256);
    const ok = stored !== undefined && stored.kind === ref.kind && stored.bytes === ref.bytes;
    if (!ok) problems.add("artifact_missing");
    return ok;
  };
  const api = (raw?.api ?? []).map((scenario) => ({ ...scenario, scenarioId: plain(scenario.scenarioId, 120), samples: scenario.samples.filter(held), changedPaths: scenario.changedPaths.map((path) => plain(path, 300)) }));
  const browser = (raw?.browser ?? []).map((scenario) => {
    const withheld: NonNullable<EvidenceRaw["browser"]>[number]["withheld"] & unknown[] = [];
    const kept = (artifact: "video" | "trace", ref: ArtifactRef | undefined): ArtifactRef | undefined => {
      if (ref === undefined) return undefined;
      // The first failing condition names the reason, in the design's order; each withheld file is also listed for deletion.
      const reason = !accountsOk ? "account_not_run_scoped" : media?.tierAllowed !== true ? "tier_not_allowed" : media.companyAllows[artifact] !== true ? "company_setting_off" : media.revocationConfirmed !== true ? "revocation_not_confirmed"
        : media.gate?.allowed?.[artifact] !== true ? (media.gate?.reasons?.[artifact] ?? "data_not_synthetic") : undefined;
      if (reason !== undefined) {
        withheld.push({ artifact, reason });
        withheldArtifacts.push(ref);
        problems.add("media_not_allowed");
        return undefined;
      }
      if (!held(ref)) { withheld.push({ artifact, reason: "upload_failed" }); return undefined; }
      return ref;
    };
    const video = kept("video", scenario.video);
    const trace = kept("trace", scenario.trace);
    return {
      scenarioId: plain(scenario.scenarioId, 120), ...(scenario.consoleErrors === undefined ? {} : { consoleErrors: scenario.consoleErrors }),
      strip: { before: scenario.strip.before.filter(held), after: scenario.strip.after.filter(held) },
      ...(video === undefined ? {} : { video }), ...(trace === undefined ? {} : { trace }),
      ...((scenario.withheld?.length ?? 0) + withheld.length === 0 ? {} : { withheld: dedupeWithheld([...(scenario.withheld ?? []).filter((item) => (item.artifact === "video" ? video : trace) === undefined), ...withheld]) }),
    };
  });

  const testChecks = checks.filter((entry) => entry.tests !== undefined);
  const measured = testChecks.reduce((sum, entry) => sum + (entry.tests?.total ?? 0), 0);
  // A selection that claims fewer tests than the reports measured cannot be true: it is dropped, and the pack says only what ran.
  const rawSelection = raw?.selection;
  if (rawSelection !== undefined && measured > 0 && rawSelection.selected < measured) problems.add("selection_inconsistent");
  const reported = rawSelection !== undefined && !(measured > 0 && rawSelection.selected < measured);
  const selection = reported ? rawSelection : { method: "full" as const, selected: measured, total: measured };

  const notTested = new Map<string, EvidenceNotTested>();
  const add = (item: EvidenceNotTested) => {
    if (notTested.size < EVIDENCE_NOT_TESTED_MAX && !notTested.has(`${item.kind}:${item.id}`)) notTested.set(`${item.kind}:${item.id}`, item);
  };
  for (const item of input.notTested ?? []) add({ kind: item.kind, id: plain(item.id, 64), text: item.text === "" ? "" : plain(item.text, 300), reason: plain(item.reason, 100) });
  if (!reported && checks.some((entry) => entry.kind === "test")) add({ kind: "not_selected", id: "selection", text: "Which tests ran was not reported", reason: "selection not reported" });
  if (selection.selected < selection.total) add({ kind: "not_selected", id: "selection", text: `${selection.total - selection.selected} of ${selection.total} tests were not run`, reason: `not selected (${selection.method.replace("_", " ")})` });
  for (const service of input.environment.services) {
    if (service.mode === "mocked") add({ kind: "mocked_service", id: plain(service.name, 64), text: `${plain(service.name, 80)} is mocked`, reason: service.unrecordedAnswered === undefined || service.unrecordedAnswered === 0 ? "answered from recorded responses" : `answered ${service.unrecordedAnswered} unrecorded requests` });
  }
  for (const entry of checks) {
    const tests = entry.tests;
    if (tests?.skippedBefore !== undefined && tests.skippedAfter !== undefined && tests.skippedAfter > tests.skippedBefore) add({ kind: "check", id: entry.checkId, text: entry.label, reason: "more tests skipped than before" });
    // TE-B3: a test that ran on the original code and is not in this code's report. The names are in the check's `tests` part; the row says how many.
    if (tests?.absentOnNewCount !== undefined && tests.absentOnNewCount > 0) add({ kind: "check", id: `absent:${entry.checkId}`.slice(0, 64), text: entry.label, reason: `${tests.absentOnNewCount} ${tests.absentOnNewCount === 1 ? "test" : "tests"} ran before and not now` });
  }
  if (input.rawText !== undefined && raw === undefined) add({ kind: "environment", id: "evidence", text: "Test, coverage and scan details", reason: "could not be read" });
  // Test services: the rows come from what the broker pinned and the worker's usage record; nothing is added for a run without dependencies.
  const dependencyEvidence = input.dependencies === undefined || input.dependencies.length === 0 ? undefined : dependencyEvidenceOf(input.dependencies, raw?.testServices);
  for (const item of dependencyEvidence?.notTested ?? []) add(item);

  const pack = {
    schemaVersion: 1 as const,
    candidateDigest: input.candidateDigest,
    environment: {
      ...input.environment,
      services: input.environment.services.map((service) => ({ ...service, name: plain(service.name, 80) })),
      accounts: input.environment.accounts.map((account) => ({ ...account, profileId: plain(account.profileId, 120) })),
      ...(dependencyEvidence === undefined ? {} : { dependencies: dependencyEvidence.dependencies }),
    },
    checks, selection, api, browser, notTested: [...notTested.values()],
  };
  const parsed = EvidencePackSchema.safeParse(pack);
  if (!parsed.success) {
    problems.add("pack_invalid");
    return { pack: undefined, problems: [...problems], newArtifacts: [], withheldArtifacts };
  }
  return { pack: parsed.data, problems: [...problems], newArtifacts, withheldArtifacts };
}

function dedupeWithheld<T extends { artifact: "video" | "trace" }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.artifact) && seen.add(item.artifact));
}

/** The raw file, read against its schema and bound to the candidate; undefined (with the reason noted) when it cannot be used. */
function readRaw(input: EvidenceBuildInput, problems: Set<EvidenceProblem>): EvidenceRaw | undefined {
  if (input.rawText === undefined) return undefined;
  if (Buffer.byteLength(input.rawText, "utf8") > EVIDENCE_RAW_MAX_BYTES) {
    problems.add("raw_too_large");
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(input.rawText);
  } catch {
    problems.add("raw_unreadable");
    return undefined;
  }
  const parsed = EvidenceRawSchema.safeParse(json);
  if (!parsed.success) {
    problems.add("raw_unreadable");
    return undefined;
  }
  if (parsed.data.candidateDigest !== input.candidateDigest) {
    problems.add("raw_for_other_code");
    return undefined;
  }
  return parsed.data;
}

// ---- the task page's view

export type EvidenceArtifactState = "available" | "expired" | "withheld";

/** The route that serves one stored artifact of a task, behind sign-in and a per-request access check (P6). */
export function evidenceHref(taskId: string, ref: Pick<ArtifactRef, "sha256">): string {
  return `/v1/app/tasks/${taskId}/evidence/${ref.sha256}`;
}

/**
 * The pack as the task page reads it: each artifact is a link while it is available, and `expired` or `withheld` (no link) when it is not. `stateOf` says, per artifact, whether the retention
 * period has passed or the store no longer holds it. It is required: there is no default, because "available" is a claim the caller must make. Undefined when the result does not fit the view's schema (never a partial view).
 */
export function evidenceViewOf(pack: EvidencePack, taskId: string, stateOf: (ref: ArtifactRef) => EvidenceArtifactState): EvidenceView | undefined {
  const link = (ref: ArtifactRef): ArtifactLink => {
    const state = stateOf(ref);
    return ArtifactLinkSchema.parse({ ...ArtifactRefSchema.parse(ref), state, ...(state === "available" ? { href: evidenceHref(taskId, ref) } : {}) });
  };
  try {
    const view = {
      ...pack,
      checks: pack.checks.map(({ outputTailRef, ...entry }) => ({ ...entry, ...(outputTailRef === undefined ? {} : { outputTailRef: link(outputTailRef) }) })),
      api: pack.api.map((scenario) => ({ ...scenario, samples: scenario.samples.map(link) })),
      browser: pack.browser.map(({ video, trace, ...scenario }) => ({
        ...scenario, strip: { before: scenario.strip.before.map(link), after: scenario.strip.after.map(link) },
        ...(video === undefined ? {} : { video: link(video) }), ...(trace === undefined ? {} : { trace: link(trace) }),
      })),
    };
    const parsed = EvidenceViewSchema.safeParse(view);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The environment's words for a service, as the pull request and the page say them. */
export function serviceModeWords(mode: EvidenceEnvironment["services"][number]["mode"]): string {
  return SERVICE_WORDS[mode];
}
