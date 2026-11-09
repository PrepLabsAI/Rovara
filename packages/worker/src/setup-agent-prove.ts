// Setup agent (design setup-test-health 3.1 step 4 and 3.2, task SH10): after the agent has run things, its findings are merged into the detectors' proposal and the result is PROVED in a fresh sandbox the
// agent never touched, by the existing `proveEnvironment` (prove.ts). The agent's own machine working proves nothing; a new machine running the final commands proves the setup repeats.
//
// Two parts:
//   - `mergeAgentFindings`: code first. A detected command is replaced only when the journal shows running it FAILED (and it never succeeded afterwards), and only by a command that the journal shows
//     WORKED. Every other detected command stays as it was. What the agent found that code did not is added as a gap-filler (cited `observed:<run>#<n>` when it worked, `model` when it never ran).
//     Every replacement is reported as "detected X, replaced by Y because X failed (journal #n)". A command that downloads and runs code is never an environment command.
//   - `proveAfterAgent`: removes the agent's sandbox first, refuses a "fresh" sandbox that is the agent's own (same id or same workspace), runs the Prove sequence only through the fresh sandbox's ports,
//     and removes it again. The agent's sandbox is handed over as a bare `{ id, rootPath, dispose }`: it has no way to run a command, so the proof cannot be run in it by mistake.
// Nothing here trusts the agent's words for a verdict: the Prove report is bound to the digest of the exact environment that was run, and the broker reads it again.
import {
  TestEnvironmentBodySchema, TestEnvironmentProposalSchema, formatCommandLine, SETUP_PERSON_SOURCE, observedSource, parseCommandLine, remoteCodeReason, testEnvDigest, testEnvIsProved,
  type ProjectCommand, type SetupDraft, type SetupJournalEntry, type SetupProposal, type SetupReplacement, type TestEnvProveReport, type TestEnvValueSource, type TestEnvironmentProposal,
} from "@agentx/contracts";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { EnvironmentDraft } from "./env-detect/propose.js";
import { proveEnvironment, type ProvePorts } from "./prove.js";
import { stepKeyOf } from "./setup-agent-journal.js";

const MAX_SETUP_COMMANDS = 20;
const MAX_CHECKS = 32;

// ---- reading the journal

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const oneSpace = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Whether the journal's command text ran `line` and nothing more: the whole command, starting the line or a shell step (after `&&`, `;`, `|` or `(`, and any `NAME=value` words), and ending the line, a shell
 * separator or a redirection. `uv sync --frozen --extra x` is a different command from `uv sync --frozen`, and `python -m pytest -q` is not `pytest -q`. Text is bounded (2,000 characters).
 */
export function ranCommand(entryCommand: string, line: string): boolean {
  const wanted = oneSpace(line);
  if (wanted === "" || wanted.length > 1_100) return false;
  return new RegExp(`(?:^|[;&|(])\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*${escapeRegExp(wanted)}\\s*(?:$|[;&|)<]|[0-9]?>)`, "u").test(oneSpace(entryCommand).slice(0, 2_000));
}

type Fate = { failedAtN: number } | { workedAtN: number } | "not_run";

/**
 * How a journal command ran `line`, judged only from text the shell gives a trustworthy exit code for. A command line is evidence only when it holds none of: `||`, `;`, a single `&`, a pipe, a quote,
 * `#`, a backtick, `$(`, `<(` or a newline, ANYWHERE (not only in the step that matters): each of them can change the exit code or hide the text that decides it (`a && b || echo failed` exits 0 when
 * `b` fails, `a && b; true` always does, `echo 'x && a && y'` ran no `a`, `ls # && a` is a comment). What is left is `&&` chains, and:
 *   - `alone`: the line is the whole command (after `NAME=value` words and `2>&1`), so its exit code is the line's own;
 *   - `chain`: the line is one step of an `&&` chain, or follows a `cd <dir> &&`. An exit of 0 means every step worked; a non-zero exit says nothing about this step (it may be the `cd` that failed,
 *     or another step);
 *   - undefined: anything else, or the line is not one whole step.
 */
function evidenceOf(entryCommand: string, line: string): "alone" | "chain" | undefined {
  if (entryCommand.length > 2_000 || /\|\||;|\||['"#`\n\r]|\$\(|<\(/u.test(entryCommand.replace(/\s2>&1(?=\s|$)/gu, " ").replace(/&&/gu, "  "))) return undefined;
  const text = oneSpace(entryCommand.replace(/\s2>&1(?=\s|$)/gu, " "));
  // What is left of `&` after `&&` and `2>&1` are gone is a background job.
  if (/&/u.test(text.replace(/&&/gu, ""))) return undefined;
  const wanted = oneSpace(line);
  if (wanted === "") return undefined;
  const raw = text.split("&&").map((step) => step.trim());
  if (raw.some((step) => step === "")) return undefined;
  const steps = raw.map((step) => step.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u, ""));
  if (!steps.includes(wanted)) return undefined;
  // A `cd` step, or any other step, makes the line one of a chain: only a success is evidence then.
  return steps.length === 1 ? "alone" : "chain";
}

/**
 * What running `line` came to in the journal: the last failing run (when nothing worked after it), the first run that worked, or that it never ran. Only the agent's own, unflagged commands count:
 * a command that downloads and runs code ran code nobody approved, so what it did or did not work is no evidence about the line (its `&& npm ci` may have worked only because of what it ran).
 * A failure counts only when the line ran alone; a success counts alone or in an `&&` chain.
 */
function fateOf(journal: readonly SetupJournalEntry[], line: string): Fate {
  let failed: number | undefined;
  let worked: number | undefined;
  for (const entry of journal) {
    if (entry.source !== "agent" || entry.flagged) continue;
    const how = evidenceOf(entry.command, line);
    if (how === undefined) continue;
    if (entry.exitCode === 0 && !entry.timedOut) { worked = entry.n; failed = undefined; } else if (how === "alone") { failed = entry.n; worked = undefined; }
  }
  if (worked !== undefined) return { workedAtN: worked };
  return failed !== undefined ? { failedAtN: failed } : "not_run";
}

/** The first run of `line` that worked (see `fateOf` for what counts). */
function firstWorked(journal: readonly SetupJournalEntry[], line: string): number | undefined {
  return journal.find((entry) => entry.source === "agent" && !entry.flagged && entry.exitCode === 0 && !entry.timedOut && evidenceOf(entry.command, line) !== undefined)?.n;
}

const sameProgram = (left: ProjectCommand, right: ProjectCommand): boolean => left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);

// ---- merging

export interface AgentFindings {
  /** The run's id, for `observed:<run>#<n>` sources. */
  runId: string;
  proposal: SetupProposal;
  journal: readonly SetupJournalEntry[];
}

export interface MergeInput {
  /** The repository the environment is for (the detected environment holds one). The agent's commands for any other repository are not used. */
  repo: string;
  /** The working directory of a command the agent added (a detected command keeps its own). */
  cwd: string;
}

export interface MergedEnvironment {
  draft: EnvironmentDraft;
  replacements: SetupReplacement[];
  /** Fixed sentences about what was left out or not used; never repository text. */
  notes: string[];
}

function sourceAt(valueSources: EnvironmentDraft["valueSources"], field: string, source: TestEnvValueSource): void {
  const at = valueSources.findIndex((entry) => entry.field === field);
  if (at >= 0) valueSources[at] = { field, source }; else valueSources.push({ field, source });
}

/**
 * Merges what the agent found into the detectors' draft, code first (see the top of the file). Pure: the same inputs always give the same environment. The result is still only a PROPOSAL: it is
 * proved in a fresh sandbox, and a person confirms it.
 */
export function mergeAgentFindings(detected: EnvironmentDraft, findings: AgentFindings, input: MergeInput): MergedEnvironment {
  const environment = structuredClone(detected.environment);
  const repo = environment.repos[0]!;
  const valueSources = detected.valueSources.map((entry) => ({ ...entry }));
  const replacements: SetupReplacement[] = [];
  const notes = [...detected.notes];
  const flagged = new Set(findings.proposal.flaggedCommands.map((item) => oneSpace(item.command)));
  const journal = findings.journal;
  let leftOut = 0;

  /** The agent's lines for this repository that can be commands: one program, not flagged, not a download-and-run. */
  const usable = (lines: ReadonlyArray<{ line: string; place?: { path: string; line: number } }>): Array<{ line: string; command: ProjectCommand; place?: { path: string; line: number } }> => lines.flatMap(({ line, place }) => {
    if (flagged.has(oneSpace(line)) || remoteCodeReason(line) !== undefined) { leftOut += 1; return []; }
    try { return [{ line, command: parseCommandLine(line, input.cwd, 900), ...(place === undefined ? {} : { place }) }]; } catch { leftOut += 1; return []; }
  });
  /** The agent's command lines for this repository, each with the first file and line the item cited (kept when the line never ran, so the card still says where it came from). */
  const agentLines = (items: SetupProposal["setup"]): Array<{ line: string; place?: { path: string; line: number } }> => items.filter((item) => item.value.repo === input.repo).flatMap((item) => {
    const cited = item.from.find((place) => place.repo === input.repo && typeof place.path === "string" && typeof place.line === "number");
    const place = cited === undefined ? undefined : { path: cited.path!, line: cited.line! };
    return item.value.commands.map((line) => ({ line, ...(place === undefined ? {} : { place }) }));
  });
  const otherRepos = [...findings.proposal.setup, ...findings.proposal.tests].filter((item) => item.value.repo !== input.repo).length;
  if (otherRepos > 0) notes.push("The setup run proposed commands for another repository; they are not part of this environment.");

  /**
   * One list of commands: `current` are the detected ones (with their field names), `proposed` the agent's. Replaces a detected command that FAILED by an agent command that WORKED (same step first,
   * then in order), adds the agent's other commands, and leaves every other detected command alone.
   */
  function mergeList(
    current: Array<{ command: ProjectCommand; field: string }>,
    proposed: Array<{ line: string; command: ProjectCommand; place?: { path: string; line: number } }>,
    replace: (at: number, command: ProjectCommand) => void,
    add: (command: ProjectCommand, source: TestEnvValueSource) => void,
    capacity: () => number,
    timeoutSeconds: number,
  ): void {
    const failed = current.flatMap((existing, at) => {
      // A value a person set stays: the setup run never replaces, re-sources or re-cites it, whatever the journal says.
      if (valueSources.some((entry) => entry.field === existing.field && entry.source === SETUP_PERSON_SOURCE)) return [];
      const fate = fateOf(journal, formatCommandLine(existing.command));
      return typeof fate === "object" && "failedAtN" in fate ? [{ at, failedAtN: fate.failedAtN }] : [];
    });
    // Code first: a candidate that is a detected command already adds nothing. A candidate for the same step as a detected command can only REPLACE it (below), and only if that one failed.
    const fresh = proposed.filter((candidate) => !current.some((existing) => sameProgram(existing.command, candidate.command)));
    const detectedSteps = current.map((existing) => stepKeyOf(formatCommandLine(existing.command)));
    const used = new Set<number>();
    for (const old of failed) {
      const existing = current[old.at]!;
      const stepKey = stepKeyOf(formatCommandLine(existing.command));
      const works = (index: number) => !used.has(index) && firstWorked(journal, fresh[index]!.line) !== undefined;
      const sameStep = fresh.findIndex((candidate, index) => works(index) && stepKeyOf(candidate.line) === stepKey);
      // Only a command for the SAME step can take its place: a different command that happens to work is another step, not a fix for this one.
      const choice = sameStep;
      if (choice < 0) { notes.push("A detected command failed when the setup run ran it, and the run found no command that works instead; it is kept so the proof shows the failure."); continue; }
      used.add(choice);
      const candidate = fresh[choice]!;
      const workedAtN = firstWorked(journal, candidate.line)!;
      const command: ProjectCommand = { ...candidate.command, cwd: existing.command.cwd, timeoutSeconds: existing.command.timeoutSeconds };
      replace(old.at, command);
      sourceAt(valueSources, existing.field, observedSource(findings.runId, workedAtN));
      replacements.push({ field: existing.field, detected: formatCommandLine(existing.command), replacedBy: formatCommandLine(command), failedAtN: old.failedAtN, workedAtN });
    }
    fresh.forEach((candidate, index) => {
      if (used.has(index)) return;
      if (capacity() <= 0 || detectedSteps.includes(stepKeyOf(candidate.line))) { leftOut += 1; return; }
      // A command the run ran and that did not work is not proposed.
      const fate = fateOf(journal, candidate.line);
      if (typeof fate === "object" && "failedAtN" in fate) { leftOut += 1; return; }
      const workedAtN = firstWorked(journal, candidate.line);
      add({ ...candidate.command, timeoutSeconds }, workedAtN !== undefined ? observedSource(findings.runId, workedAtN) : candidate.place ?? "model");
    });
  }

  // setup commands
  mergeList(
    repo.setupCommands.map((command, at) => ({ command, field: `repos[0].setupCommands[${String(at)}]` })),
    usable(agentLines(findings.proposal.setup)),
    (at, command) => { repo.setupCommands[at] = command; },
    (command, source) => { sourceAt(valueSources, `repos[0].setupCommands[${String(repo.setupCommands.length)}]`, source); repo.setupCommands.push(command); },
    () => MAX_SETUP_COMMANDS - repo.setupCommands.length,
    900,
  );

  // test commands: the detected checks of kind test, and the agent's test commands as new checks
  const testChecks = repo.checks.flatMap((check, at) => (check.kind === "test" ? [{ command: check.command, field: `repos[0].checks[${String(at)}]`, at }] : []));
  let counter = 0;
  mergeList(
    testChecks,
    usable(agentLines(findings.proposal.tests)),
    (position, command) => { repo.checks[testChecks[position]!.at] = { ...repo.checks[testChecks[position]!.at]!, command }; },
    (command, source) => {
      counter += 1;
      let id = `agent-${String(counter)}`;
      while (repo.checks.some((check) => check.id === id)) { counter += 1; id = `agent-${String(counter)}`; }
      sourceAt(valueSources, `repos[0].checks[${String(repo.checks.length)}]`, source);
      repo.checks.push({ id, label: `Test command ${String(counter)}`, command, kind: "test" });
    },
    () => MAX_CHECKS - repo.checks.length,
    1_800,
  );
  if (leftOut > 0) notes.push(`${String(leftOut)} command${leftOut === 1 ? "" : "s"} from the setup run ${leftOut === 1 ? "was" : "were"} left out: not one program, downloads and runs code, flagged, did not work, repeats a detected step, or over a limit.`);

  return { draft: { ...detected, environment, valueSources: valueSources.slice(0, 400), notes }, replacements, notes };
}

// ---- the proposal

/** The legacy draft fields of a `TestEnvironmentProposal`, from the agent's proposal and the final environment's own command lines. */
function setupDraftOf(proposal: SetupProposal, environment: EnvironmentDraft["environment"]): SetupDraft {
  const repo = environment.repos[0]!;
  const lines = (commands: readonly ProjectCommand[]) => commands.map((command) => formatCommandLine(command)).filter((text) => text.length <= 1_024);
  const container = proposal.devcontainer?.value;
  return {
    basedOnRevision: proposal.basedOnRevision,
    setupCommands: lines(repo.setupCommands).slice(0, 20),
    testCommands: lines(repo.checks.filter((check) => check.kind === "test").map((check) => check.command)).slice(0, 20),
    ...(container === undefined ? {} : { devcontainer: { repository: container.repository, configPath: container.configPath, exists: container.exists, ...(container.proposedContent === undefined ? {} : { proposedContent: container.proposedContent }) } }),
    allowedDomains: proposal.allowedDomains.map((item) => item.value).slice(0, 100),
    secretsNeeded: proposal.secretsNeeded.map((item) => ({ name: item.value.name, why: item.value.why, foundIn: item.from[0] === undefined ? "" : `${item.from[0].path ?? ""}${item.from[0].line === undefined ? "" : `:${String(item.from[0].line)}`}`.slice(0, 500) })),
    flaggedCommands: proposal.flaggedCommands.map((item) => ({ command: item.command, reason: item.reason })),
    notes: proposal.notes.slice(0, 2_000),
  };
}

export type AgentProposalResult = { ok: true; proposal: TestEnvironmentProposal; replacements: SetupReplacement[] } | { ok: false; reason: "invalid_environment" | "invalid_proposal" };

/** The test-environment proposal after the run: the merged environment, the value sources (with `observed:`), and the agent's own items (hosts, secret names, flagged commands, dev container). */
export function agentProposalOf(detected: EnvironmentDraft, findings: AgentFindings, input: MergeInput): AgentProposalResult {
  const merged = mergeAgentFindings(detected, findings, input);
  const environment = TestEnvironmentBodySchema.safeParse(merged.draft.environment);
  if (!environment.success) return { ok: false, reason: "invalid_environment" };
  const proposal = TestEnvironmentProposalSchema.safeParse({ ...setupDraftOf(findings.proposal, environment.data), environment: environment.data, valueSources: merged.draft.valueSources.slice(0, 400) });
  return proposal.success ? { ok: true, proposal: proposal.data, replacements: merged.replacements } : { ok: false, reason: "invalid_proposal" };
}

// ---- the fresh proof

/** The agent's sandbox, as the proof sees it: an identity and a way to remove it. It cannot run a command. */
export interface AgentSandboxHandle {
  id: string;
  rootPath: string;
  dispose(): Promise<void>;
}

/** A new sandbox on a new, clean workspace. `ports` run commands there; `dispose` removes the sandbox and its workspace. */
export interface FreshSandbox {
  id: string;
  rootPath: string;
  ports: ProvePorts;
  dispose(): Promise<void>;
}

export type ProveAfterAgentResult =
  | { ok: true; report: TestEnvProveReport; proved: boolean; agentSandboxRemoved: boolean }
  | { ok: false; reason: "not_fresh" | "fresh_sandbox_failed" | "prove_failed"; agentSandboxRemoved: boolean };

/**
 * Proves the final environment in a fresh sandbox. Order: the agent's sandbox is removed first (a removal that fails is reported, and does not stop the proof, since the fresh sandbox has its own
 * workspace); then the fresh sandbox is made, and refused (`not_fresh`) if it shares the agent's id or workspace; then `proveEnvironment` runs through the fresh sandbox's ports only; then the fresh
 * sandbox is removed, whatever happened. The report is for the digest of `environment`, recomputed here, and `proved` is the contract's own `testEnvIsProved`.
 */
export async function proveAfterAgent(input: {
  agent: AgentSandboxHandle;
  makeFresh: () => Promise<FreshSandbox>;
  environment: EnvironmentDraft["environment"];
  signal: AbortSignal;
  /** The most the whole proof may take, in milliseconds. */
  deadlineMs: number;
  /** Test seam for the workspace comparison. Default: the real path (links followed); a path that does not exist is compared as written. */
  realPath?: (path: string) => Promise<string>;
}): Promise<ProveAfterAgentResult> {
  const agentSandboxRemoved = await input.agent.dispose().then(() => true, () => false);
  let fresh: FreshSandbox | undefined;
  try {
    try { fresh = await input.makeFresh(); } catch { return { ok: false, reason: "fresh_sandbox_failed", agentSandboxRemoved }; }
    if (fresh.id === input.agent.id || await sharesWorkspace(fresh.rootPath, input.agent.rootPath, input.realPath ?? defaultRealPath)) return { ok: false, reason: "not_fresh", agentSandboxRemoved };
    try {
      // The digest is recomputed from the environment that is run, and an environment that does not read gets no proof.
      const digest = testEnvDigest(input.environment);
      const report = await proveEnvironment(fresh.ports, { proposalDigest: digest, environment: input.environment, signal: input.signal, deadlineMs: input.deadlineMs });
      return { ok: true, report, proved: testEnvIsProved(report, digest, input.environment), agentSandboxRemoved };
    } catch {
      return { ok: false, reason: "prove_failed", agentSandboxRemoved };
    }
  } finally {
    await fresh?.dispose().catch(() => undefined);
  }
}

export const defaultRealPath = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

/**
 * Whether two workspaces are the same folder, or one is inside the other, after links are followed and the paths are written out in full (a link, `..` or a trailing slash does not make a folder new).
 * The agent's `.git/config`, hooks and untracked files live in its workspace, so a fresh sandbox must share none of it.
 */
export async function sharesWorkspace(left: string, right: string, real: (path: string) => Promise<string>): Promise<boolean> {
  const [a, b] = await Promise.all([real(left).then((path) => resolve(path)), real(right).then((path) => resolve(path))]);
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`) || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}
