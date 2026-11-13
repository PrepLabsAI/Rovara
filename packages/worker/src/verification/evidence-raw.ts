// Proof and evidence (wire-proof): what a CHECKS run writes as `evidence-raw.json`, the worker's half of the evidence. For each project check whose own command already writes a test report (a vitest/jest JSON
// or a JUnit XML file at a path its arguments name: the same rule as TESTPROOF, AgentX never alters a customer's command) the report is read in the workspace and turned into totals, test names and the tests
// the change added or changed (`parseTestReport`, `evidenceTests`); a failed check also keeps the end of its output. Nothing else is claimed: no coverage, findings or migrations (those parsers are not built),
// and the selection is "the whole check command ran" only for a run that read at least one report.
//
// The file is UNTRUSTED by the broker, which binds it to the candidate's digest, checks every count against the check report it holds itself and the data guard before anything is kept
// (broker/src/rovara-code/evidence-keep.ts). This module only has to be bounded and never throw: a fault leaves the file out, and the round goes on as it would have.
import { EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_RAW_ARTIFACT, EVIDENCE_RAW_MAX_BYTES, EvidenceRawSchema, createCandidateManifest, redactText, type CandidateRepository, type CheckEntry, type TestServicesUsageRecord, type EvidenceRaw, type ProjectCommand } from "@rovara-code/contracts";
import type { ArtifactSink } from "../artifacts.js";
import type { CheckPlan } from "./checks.js";
import { coveragePart, readChangedCoverage, type RepositoryChanges } from "./cobertura-lcov-coverage.js";
import { lineCoverageAsParsed, repositoryOfCheck } from "./line-coverage-join.js";
import { listRepositoryFiles, readRepositoryFile } from "../test-env-detect.js";
import { readGoModuleRoots } from "../env-detect/go.js";
import { candidateChanges } from "./diff.js";
import { changedMigrationFiles, migrationDirectionOf, migrationEvidence } from "./migration-check.js";
import { readContainedReport } from "./report-file.js";
import { SARIF_REPORT_MAX_BYTES, findingsPart, newFindings, parseSarif, readsPrebuiltState, sameFindings, sarifPathOf, unverifiedPart, type ParsedSarif } from "./sarif.js";
import { AgentFilesRestoreError } from "./original-code.js";
import { runBaselineScans, type BaselineRun, type BaselineScan } from "./sarif-baseline.js";
import { changedTestFiles, readCheckReport, type TestProofRepository } from "./test-proof.js";
import { withIsolatedGit } from "../isolated-git.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { evidenceTests, parseTestReport } from "./test-report.js";
import { withTestIds } from "./test-ids.js";

export interface CollectEvidenceInput {
  /** The workspace root, where a check's report path is resolved from its cwd. */
  rootPath: string;
  /** The project checks that were run, in order: check `readiness:<index>` is `commands[index]`. */
  commands: readonly ProjectCommand[];
  /** The round's entries on the candidate. */
  entries: readonly CheckEntry[];
  /** The digest of the candidate the checks ran on (the broker discards a file for any other). */
  candidateDigest: string;
  /** Where the task started, for the tests the change added or changed. A repository that cannot be read leaves its tests out of "new". */
  repositories: readonly TestProofRepository[];
  /** When the check round began (ms since the epoch). A report (coverage, SARIF) older than this was not written by this round, so without it none is read. */
  roundStartedAtMs?: number | undefined;
  /** False when some repository of the task could not be given to `repositories` (no start commit or no checked tree): changed lines are then not known for all of the change, so no coverage or migration is claimed. Default true. */
  repositoriesComplete?: boolean | undefined;
  /**
   * P4: runs the given SARIF-writing commands once more on the code the task started from and returns the SARIF text each wrote, by command index. Absent, or a command missing from the answer, means
   * there is no baseline, and then no finding of that scan is reported (there is no "new" without one).
   */
  baselineScans?: ((scans: readonly BaselineScan[]) => Promise<ReadonlyMap<number, string>>) | undefined;
  /** The `coveragePath` the maintainer approved for each command (by command index; the test environment's checks come first): read as a named report. */
  coveragePaths?: ReadonlyArray<string | undefined> | undefined;
  /** What test selection decided (test environment, wire-testenv): used as it is when it ran fewer tests than the whole, otherwise only its fallback reason is kept and the counts are what the reports measured. */
  selection?: EvidenceSelection | undefined;
  /**
   * Test services: the usage record of the run's dependencies for this round (`TestServicesRun.usageRecord()`), kept in the raw file as FACTS the broker labels (evidence-pack.ts). It is kept even when no check left a
   * report: a round that ran against Postgres says so whether or not a test report was read.
   */
  testServices?: TestServicesUsageRecord | undefined;
}

type EvidenceSelection = NonNullable<EvidenceRaw["selection"]>;
/** The selection the raw file reports: the plan's when it narrowed the tests, the whole check (counted by the reports) with the plan's reason when it fell back, and the whole check when nothing was planned. */
function selectionOf(planned: EvidenceSelection | undefined, measured: number): EvidenceSelection | undefined {
  if (planned !== undefined && planned.selected < planned.total) return planned;
  if (measured <= 0) return undefined;
  return { method: "full", selected: measured, total: measured, ...(planned?.fallbackReason === undefined ? {} : { fallbackReason: planned.fallbackReason }) };
}

const OUTPUT_TAIL_BYTES = Math.min(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt, 16 * 1024);

/** The end of an output, cut from its start until it fits, redacted again; a cut in the middle of a surrogate pair drops the lone half. */
export function outputTailOf(output: string, maxBytes = OUTPUT_TAIL_BYTES): string | undefined {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is taken out of a tail
  let tail = redactText(output).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, " ");
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(Math.max(1, Math.ceil((Buffer.byteLength(tail, "utf8") - maxBytes) / 4)));
  tail = tail.replace(/^[\uDC00-\uDFFF]/u, "").trim();
  return tail === "" ? undefined : tail;
}

const COMMIT_OR_TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** A changed file's text from the checked tree (object store only, no link followed), or undefined. Bounded to 256 KiB. */
async function readTreeText(repository: TestProofRepository, path: string): Promise<string | undefined> {
  if (!COMMIT_OR_TREE.test(repository.candidateTreeSha) || path.startsWith("-") || path.includes("\0")) return undefined;
  return withIsolatedGit(repository.directory, "read", (git) => git.text(["cat-file", "blob", `${repository.candidateTreeSha}:${path}`], { index: "none", maxBuffer: 256 * 1024 })).catch(() => undefined);
}

interface CheckParts {
  index: number;
  entry: CheckEntry;
  tests?: ReturnType<typeof evidenceTests>;
  coverage?: ReturnType<typeof coveragePart>;
  outputTail?: string;
  migrations?: NonNullable<EvidenceRaw["checks"][number]["migrations"]>;
}

/** The raw evidence, or undefined when there is nothing to say (no check named a readable report and none failed). Never throws. */
export async function collectEvidenceRaw(input: CollectEvidenceInput): Promise<EvidenceRaw | undefined> {
  try {
    const changedTestPaths: string[] = [];
    for (const repository of input.repositories) {
      try { changedTestPaths.push(...(await changedTestFiles(repository)).present); } catch { /* a repository that cannot be read: its tests are not marked new */ }
    }
    let measured = 0;
    // The diff (P3, P4) is read once, and only if some check needs it. An incomplete set of repositories, or any repository whose diff cannot be read, means the changed lines are not known: nothing is claimed.
    let changes: Promise<RepositoryChanges[] | undefined> | undefined;
    const diffs = (): Promise<RepositoryChanges[] | undefined> => (changes ??= input.repositoriesComplete === false ? Promise.resolve(undefined) : Promise.all(input.repositories.map(async (repository) => ({
      repositoryId: repository.repositoryId, directory: repository.directory,
      changes: await candidateChanges({ directory: repository.directory, baseCommitSha: repository.startCommit, treeSha: repository.candidateTreeSha }, { exactLines: true }),
    }))).then((read) => (read.length === 0 ? undefined : read), () => undefined));
    const usedReports = new Set<string>();
    const entryOf = (index: number) => input.entries.find((candidate) => candidate.id === `readiness:${String(index)}`);
    const ended = (entry: CheckEntry | undefined): entry is CheckEntry => entry?.after === "passed" || entry?.after === "failed";
    const partials: CheckParts[] = [];
    const scans: Array<BaselineScan & { candidate: ParsedSarif }> = [];
    // Directories an absolute address in a scanner's file is made relative to.
    const roots = [...new Set([resolve(input.rootPath), await realpath(input.rootPath).catch(() => resolve(input.rootPath)), ...input.repositories.map((repository) => resolve(repository.directory))])];

    for (const [index, command] of input.commands.entries()) {
      const entry = entryOf(index);
      if (entry === undefined) continue;
      const read = await readCheckReport(input.rootPath, command).catch(() => undefined);
      const reported = read === undefined ? undefined : parseTestReport(read.text, read.kind);
      // The tests in ID form (contracts `test-id.ts`), the same strings the nightly run and the known-failing marks use.
      const parsed = reported === undefined ? undefined : await withTestIds(reported, { root: input.rootPath, cwd: command.cwd });
      const partial: CheckParts = { index, entry };
      if (parsed !== undefined) { partial.tests = evidenceTests(parsed, { changedTestPaths }); measured += parsed.total; }
      if (entry.after === "failed") { const tail = outputTailOf(entry.output); if (tail !== undefined) partial.outputTail = tail; }
      // A timed-out, stopped or never-run check may have left an older report on disk: only a check that ended is read.
      if (ended(entry)) {
        const covered = await readChangedCoverage({ rootPath: input.rootPath, command, repositories: diffs, notBeforeMs: input.roundStartedAtMs, used: usedReports, approvedPath: input.coveragePaths?.[index], lineCoverage: (text, repositories) => placeLineCoverage(text, input.rootPath, command.cwd, repositories) });
        if ("coverage" in covered) partial.coverage = coveragePart(covered.coverage, input.repositories.length);
        const argument = sarifPathOf(command);
        if (argument !== undefined) {
          const sarif = await readContainedReport({ root: input.rootPath, cwd: command.cwd, argument, maxBytes: SARIF_REPORT_MAX_BYTES, notBeforeMs: input.roundStartedAtMs });
          const candidate = sarif.ok ? parseSarif(sarif.bytes.toString("utf8"), roots) : undefined;
          if (sarif.ok && candidate !== undefined) scans.push({ index, command, argument, path: sarif.path, candidateBytes: Buffer.from(sarif.bytes), candidate });
        }
      }
      partials.push(partial);
    }

    // P4, findings: new ones are those the scan has now and its run on the original code did not. Without a usable baseline nothing is called new, and the high findings are counted as not compared.
    const findings = new Map<number, NonNullable<EvidenceRaw["checks"][number]["findings"]>>();
    // A scan with no finding at all has none that is new, whatever the baseline says: it costs no working-tree swap, no second scan and none of the test proof's time.
    for (const scan of scans) if (scan.candidate.findings.length === 0) findings.set(scan.index, findingsPart(scan.candidate.tool, []));
    // A scan that reads state an earlier step built (CodeQL's database) would compare the candidate with itself on the original source: no baseline is run for it.
    const withFindings = scans.filter((scan) => scan.candidate.findings.length > 0);
    const asking = withFindings.filter((scan) => !readsPrebuiltState(scan.command));
    let baselines: ReadonlyMap<number, string> = new Map<number, string>();
    if (asking.length > 0 && input.baselineScans !== undefined) {
      baselines = await input.baselineScans(asking.map((scan): BaselineScan => ({ index: scan.index, command: scan.command, argument: scan.argument, path: scan.path, candidateBytes: scan.candidateBytes }))).catch((error: unknown) => {
        // The one fault that must stop the task is not swallowed: the agent's files are not back.
        if (error instanceof AgentFilesRestoreError) throw error;
        return new Map<number, string>();
      });
    }
    let changedPaths: Set<string> | undefined;
    for (const scan of withFindings) {
      const text = asking.includes(scan) ? baselines.get(scan.index) : undefined;
      const baseline = text === undefined ? undefined : parseSarif(text, roots);
      let trusted = baseline !== undefined;
      // The same findings, lines and messages on the original code as on this one, in files the change touched, is how a scan that read the candidate's own build looks: not a comparison.
      if (baseline !== undefined && sameFindings(scan.candidate.findings, baseline.findings)) {
        changedPaths ??= new Set((await diffs() ?? []).flatMap((repository) => repository.changes.filter((change) => change.status !== "DELETED").map((change) => change.path)));
        const known = (await diffs()) !== undefined;
        if (!known || scan.candidate.findings.some((finding) => changedPaths!.has(finding.path))) trusted = false;
      }
      // No baseline (none ran, it could not run, or it cannot be trusted): nothing is called new, and the high findings are counted as not compared.
      const part = baseline !== undefined && trusted ? findingsPart(scan.candidate.tool, newFindings(scan.candidate.findings, baseline.findings)) : unverifiedPart(scan.candidate.tool, scan.candidate.findings);
      if (part !== undefined) findings.set(scan.index, part);
    }

    // P4, migrations: what the change adds or edits, when the project's own apply command passed; whether its rollback command passed.
    const migrations = new Map<number, NonNullable<EvidenceRaw["checks"][number]["migrations"]>>();
    const directions = input.commands.map((command) => migrationDirectionOf(command));
    const upIndexes = directions.flatMap((direction, index) => (direction === "up" && entryOf(index)?.after === "passed" ? [index] : []));
    if (upIndexes.length > 0) {
      const repositories = await diffs();
      const files = (repositories ?? []).flatMap((repository) => changedMigrationFiles(repository.changes).map((path) => ({ repositoryId: repository.repositoryId, path })));
      if (files.length > 0) {
        const downEntries = directions.flatMap((direction, index) => (direction === "down" ? [entryOf(index)] : []));
        for (const index of upIndexes) {
          const evidence = await migrationEvidence({
            upEntry: entryOf(index), downEntries, changedFiles: files.map((file) => file.path),
            readFile: async (path) => {
              const found = files.find((file) => file.path === path);
              const repository = input.repositories.find((candidate) => candidate.repositoryId === found?.repositoryId);
              return repository === undefined ? undefined : readTreeText(repository, path);
            },
          });
          if (evidence !== undefined) migrations.set(index, evidence);
        }
      }
    }

    const checks: EvidenceRaw["checks"] = [];
    for (const partial of partials) {
      const finding = findings.get(partial.index);
      const migration = migrations.get(partial.index);
      if (partial.tests === undefined && partial.coverage === undefined && partial.outputTail === undefined && finding === undefined && migration === undefined) continue;
      checks.push({
        checkId: partial.entry.id,
        ...(partial.tests === undefined ? {} : { tests: partial.tests }),
        ...(partial.coverage === undefined ? {} : { coverage: partial.coverage }),
        ...(finding === undefined ? {} : { findings: finding }),
        ...(migration === undefined ? {} : { migrations: migration }),
        ...(partial.outputTail === undefined ? {} : { outputTail: partial.outputTail }),
      });
    }
    if (checks.length === 0 && input.testServices === undefined) return undefined;
    const raw: EvidenceRaw = {
      schemaVersion: 1, candidateDigest: input.candidateDigest, checks,
      ...(input.testServices === undefined ? {} : { testServices: input.testServices }),
      ...(selectionOf(input.selection, measured) === undefined ? {} : { selection: selectionOf(input.selection, measured)! }),
    };
    const parsed = EvidenceRawSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > EVIDENCE_RAW_MAX_BYTES ? undefined : parsed.data;
  } catch (error) {
    if (error instanceof AgentFilesRestoreError) throw error;
    return undefined;
  }
}

/**
 * The CHECKS run's hook (run-task.ts, only when the invocation carries `evidenceCapture`): reads the reports of the round's project checks BEFORE the test proof runs the original code, and saves the result as
 * `evidence-raw.json`. Informational: a fault or a failed save is only a missing file, never a failed round. The candidate digest is the one the test proof is bound to (the code the checks ran on).
 */
/** A Go cover profile or a JaCoCo report named by a check, placed in the repository the check runs in (its files are read through the setup detectors' bounded, link-refusing reader). */
async function placeLineCoverage(text: string, rootPath: string, cwd: string, repositories: readonly RepositoryChanges[]) {
  const repository = repositoryOfCheck(rootPath, cwd, repositories);
  if (repository === undefined) return undefined;
  const paths = await listRepositoryFiles(repository.directory);
  return lineCoverageAsParsed(text, repository, { paths, goModules: () => readGoModuleRoots({ paths, read: (path) => readRepositoryFile(repository.directory, path) }) });
}

export async function saveEvidenceRaw(input: {
  sink: ArtifactSink; rootPath: string; plan: CheckPlan; entries: readonly CheckEntry[];
  repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>; candidateBefore: ReadonlyArray<CandidateRepository>;
  selection?: EvidenceSelection | undefined;
  /** The `coveragePath` approved for each command, by index (see `collectEvidenceRaw`). */
  coveragePaths?: ReadonlyArray<string | undefined> | undefined;
  /** When the check round began: a report (coverage, SARIF) must have been written at or after it. */
  roundStartedAtMs?: number | undefined;
  /** P4: what the baseline run of the SARIF-writing checks on the original code needs. Absent: no baseline, so no finding is reported. */
  baseline?: Pick<BaselineRun, "runners" | "signal" | "budgetMs" | "originalCode" | "capMs"> | undefined;
  /** Test services: the round's usage record (see `CollectEvidenceInput.testServices`). Absent for a task without dependencies: then the file is what it always was. */
  testServices?: TestServicesUsageRecord | undefined;
}): Promise<boolean> {
  try {
    if (input.plan.source !== "project" || input.plan.readiness === undefined) return false;
    const placed = input.repositories.map((repository) => ({
      repositoryId: repository.repositoryId, directory: repository.directory, startCommit: repository.baseCommitSha ?? "",
      candidateTreeSha: input.candidateBefore.find((entry) => entry.repositoryId === repository.repositoryId)?.treeSha ?? "",
    })).filter((repository) => COMMIT_OR_TREE.test(repository.startCommit) && repository.candidateTreeSha !== "");
    // Showing the original code in only some repositories would mix two states: the baseline needs every repository's start commit (as the test proof does).
    const complete = placed.length === input.repositories.length;
    const baseline = input.baseline;
    const raw = await collectEvidenceRaw({
      rootPath: input.rootPath, commands: input.plan.readiness, entries: input.entries, candidateDigest: createCandidateManifest(input.candidateBefore).digest, roundStartedAtMs: input.roundStartedAtMs,
      repositories: placed, repositoriesComplete: complete,
      selection: input.selection, coveragePaths: input.coveragePaths,
      ...(input.testServices === undefined ? {} : { testServices: input.testServices }),
      ...(baseline === undefined || !complete ? {} : {
        baselineScans: (scans: readonly BaselineScan[]) => runBaselineScans(scans, { ...baseline, rootPath: input.rootPath, repositories: placed.map((repository) => ({ directory: repository.directory, commit: repository.startCommit })) }),
      }),
    });
    if (raw === undefined) return false;
    await input.sink({ name: EVIDENCE_RAW_ARTIFACT, mediaType: "application/json", content: JSON.stringify(raw) });
    return true;
  } catch (error) {
    // The one fault that must stop the task: the agent's files are not back.
    if (error instanceof AgentFilesRestoreError) throw error;
    return false;
  }
}
